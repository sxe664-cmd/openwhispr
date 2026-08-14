from __future__ import annotations

from pathlib import Path
import re
from typing import Iterable

import yaml

from receptionist.reminders.identity import normalize_email
from receptionist.reminders.models import ReminderRecipient
from receptionist.reminders.phone import normalize_us_phone


def load_contacts(path: str | Path) -> list[ReminderRecipient]:
    """Load structured reminder recipients from YAML.

    The first supported production/local surface is intentionally explicit:
    calendar events may help match a contact, but they are not the source of
    SMS consent.
    """
    p = Path(path)
    if not p.exists():
        return []
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    rows = raw.get("contacts", raw if isinstance(raw, list) else [])
    contacts: list[ReminderRecipient] = []
    for row in rows:
        phone = normalize_us_phone(row.get("phone"))
        keys = set(str(v).strip().lower() for v in row.get("match_keys", []) if v)
        if row.get("email"):
            keys.add(str(row["email"]).strip().lower())
        if phone:
            keys.add(phone.lower())
        contacts.append(
            ReminderRecipient(
                recipient_id=str(row["recipient_id"]),
                display_name=str(row.get("display_name") or row.get("name") or row["recipient_id"]),
                email=row.get("email"),
                phone=phone,
                preferred_channels=tuple(row.get("preferred_channels", ["email", "sms"])),
                sms_consent_status=(
                    row.get("sms_consent_status")
                    or ("opted_in" if phone else "unknown")
                ),
                consent_source=row.get("consent_source"),
                consent_timestamp=row.get("consent_timestamp"),
                phone_source=row.get("phone_source"),
                suppressed=bool(row.get("suppressed", False)),
                match_keys=tuple(sorted(keys)),
            )
        )
    return contacts


def upsert_booking_contact(
    path: str | Path,
    *,
    event_id: str,
    caller_name: str,
    callback_number: str,
    caller_email: str | None,
    sms_consent_status: str = "opted_in",
    consent_source: str | None = None,
    consent_timestamp: str | None = None,
) -> ReminderRecipient:
    """Create/update a structured contact row for an AI-booked appointment.

    This bridges the live booking flow to demo reminder delivery: when the AI
    has a caller name + phone number, confirmations/reminders can match the
    just-created Google event without requiring the operator to pre-create a
    contacts YAML row by hand.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) if p.exists() else None
    if isinstance(raw, list):
        rows = raw
        raw = {"contacts": rows}
    elif isinstance(raw, dict):
        rows = raw.setdefault("contacts", [])
    else:
        raw = {"contacts": []}
        rows = raw["contacts"]

    recipient_id = f"booking-{_slug(event_id)}"
    email = caller_email.strip().lower() if caller_email else None
    phone = normalize_us_phone(callback_number) if callback_number else None
    if callback_number and phone is None:
        raise ValueError("booking contact requires a valid US phone number")
    match_keys = {event_id.strip().lower(), recipient_id.lower()}
    if email:
        match_keys.add(email)
    if phone:
        match_keys.add(phone.lower())

    row = None
    for candidate in rows:
        candidate_keys = {
            str(v).strip().lower()
            for v in candidate.get("match_keys", [])
            if v
        }
        if (
            str(candidate.get("recipient_id", "")).lower() == recipient_id.lower()
            or event_id.strip().lower() in candidate_keys
            or (email and str(candidate.get("email", "")).strip().lower() == email)
            or (
                phone
                and normalize_us_phone(candidate.get("phone")) == phone
            )
        ):
            row = candidate
            break
    if row is None:
        row = {"recipient_id": recipient_id}
        rows.append(row)

    existing_status = row.get("sms_consent_status")
    effective_status = (
        existing_status
        if existing_status in {"opted_out", "unknown"}
        else sms_consent_status
    )
    row.update(
        {
            "display_name": caller_name.strip() or "Caller",
            "email": email,
            "phone": phone,
            "phone_source": "ai_booking",
            "preferred_channels": ["email", "sms"],
            "sms_consent_status": effective_status,
            "match_keys": sorted(match_keys),
        }
    )
    if consent_source and effective_status == sms_consent_status:
        row["consent_source"] = consent_source
    if consent_timestamp and effective_status == sms_consent_status:
        row["consent_timestamp"] = consent_timestamp

    p.write_text(yaml.safe_dump(raw, sort_keys=False, allow_unicode=True), encoding="utf-8")
    return ContactResolver(load_contacts(p)).by_key[recipient_id.lower()]


def upsert_calendar_event_contact(
    path: str | Path,
    *,
    calendar_id: str,
    event_id: str,
    event_uid: str,
    display_name: str,
    email: str | None,
    phone: str,
    phone_source: str,
) -> ReminderRecipient:
    """Persist a phone parsed from a calendar event description locally."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) if p.exists() else None
    if isinstance(raw, list):
        rows = raw
        raw = {"contacts": rows}
    elif isinstance(raw, dict):
        rows = raw.setdefault("contacts", [])
    else:
        raw = {"contacts": []}
        rows = raw["contacts"]

    phone = normalize_us_phone(phone)
    if phone is None:
        raise ValueError("calendar event contact requires a valid US phone number")
    normalized_email = normalize_email(email)
    recipient_id = f"calendar-{_slug(calendar_id)}-{_slug(event_id)}"
    new_keys = {
        value.strip().lower()
        for value in (
            event_id,
            event_uid,
            f"{calendar_id}:{event_id}",
            f"{calendar_id}:{event_uid}",
            normalized_email,
            phone,
        )
        if value and value.strip()
    }
    row = None
    for candidate in rows:
        candidate_keys = {
            str(value).strip().lower()
            for value in candidate.get("match_keys", [])
            if value
        }
        if (
            str(candidate.get("recipient_id", "")).lower() == recipient_id.lower()
            or event_id.strip().lower() in candidate_keys
            or event_uid.strip().lower() in candidate_keys
        ):
            row = candidate
            break

    if row is None:
        row = {"recipient_id": recipient_id}
        rows.append(row)

    existing_keys = {
        str(value).strip().lower()
        for value in row.get("match_keys", [])
        if value
    }
    existing_keys = {
        value
        for value in existing_keys
        if not (normalize_us_phone(value) and normalize_us_phone(value) != phone)
    }
    existing_status = row.get("sms_consent_status")
    row.update(
        {
            "display_name": display_name.strip() or "Calendar contact",
            "email": normalized_email or row.get("email"),
            "phone": phone,
            "preferred_channels": row.get("preferred_channels") or ["email", "sms"],
            "sms_consent_status": existing_status or "opted_in",
            "match_keys": sorted(existing_keys | new_keys),
            "phone_source": f"calendar_description:{phone_source}",
        }
    )
    p.write_text(yaml.safe_dump(raw, sort_keys=False, allow_unicode=True), encoding="utf-8")
    target_id = str(row["recipient_id"])
    for contact in load_contacts(p):
        if contact.recipient_id == target_id:
            return contact
    raise RuntimeError("calendar contact was not persisted")


def invalidate_calendar_event_contact(
    path: str | Path,
    *,
    calendar_id: str,
    event_id: str,
    event_uid: str,
    phone_source: str,
) -> ReminderRecipient | None:
    """Invalidate a stale/ambiguous event phone without changing explicit opt-out."""
    p = Path(path)
    if not p.exists():
        return None
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    if isinstance(raw, list):
        rows = raw
        raw = {"contacts": rows}
    elif isinstance(raw, dict):
        rows = raw.setdefault("contacts", [])
    else:
        return None
    recipient_id = f"calendar-{_slug(calendar_id)}-{_slug(event_id)}"
    event_keys = {
        event_id.strip().lower(),
        event_uid.strip().lower(),
        f"{calendar_id}:{event_id}".strip().lower(),
        f"{calendar_id}:{event_uid}".strip().lower(),
    }
    target = None
    for candidate in rows:
        keys = {str(value).strip().lower() for value in candidate.get("match_keys", []) if value}
        if str(candidate.get("recipient_id", "")).lower() == recipient_id.lower() or event_keys & keys:
            target = candidate
            break
    if target is None:
        return None
    old_phone = normalize_us_phone(target.get("phone"))
    target["phone"] = None
    if target.get("sms_consent_status") not in {"opted_out", "unknown"}:
        target["sms_consent_status"] = "unknown"
    target["phone_source"] = f"calendar_description:{phone_source}"
    target["match_keys"] = sorted(
        value for value in target.get("match_keys", [])
        if not old_phone or str(value).strip().lower() != old_phone.lower()
    )
    p.write_text(yaml.safe_dump(raw, sort_keys=False, allow_unicode=True), encoding="utf-8")
    return next((contact for contact in load_contacts(p) if contact.recipient_id == target.get("recipient_id")), None)


def _slug(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-") or "event"


class ContactResolver:
    def __init__(self, contacts: Iterable[ReminderRecipient]) -> None:
        self.contacts = list(contacts)
        self.by_key: dict[str, ReminderRecipient] = {}
        for contact in self.contacts:
            self.by_key[contact.recipient_id.lower()] = contact
            for key in contact.match_keys:
                self.by_key[key.lower()] = contact

    def match_event(self, attendee_emails: Iterable[str]) -> ReminderRecipient | None:
        for email in attendee_emails:
            contact = self.by_key.get(email.strip().lower())
            if contact:
                return contact
        return None
