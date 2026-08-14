"""Small JSON helper API used by the Electron desktop console.

This module intentionally keeps the desktop app thin: Electron handles the
window/process controls, while Python owns YAML parsing and AppConfig
validation so the UI reports the same errors the agent would hit at runtime.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import yaml
from dotenv import load_dotenv

from receptionist.booking.auth import build_credentials
from receptionist.booking.appointments import AppointmentChangeError, AppointmentChangeService
from receptionist.booking.client import GoogleCalendarClient
from receptionist.config import AppConfig, ConfigError, load_app_config
from receptionist.reminders.contacts import ContactResolver, load_contacts
from receptionist.reminders.identity import (
    normalize_contact_keys,
    normalize_email,
    normalize_emails,
    split_stored_values,
)
from receptionist.reminders.__main__ import _load_configured_events
from receptionist.reminders.phone import extract_phone, normalize_us_phone
from receptionist.reminders.models import AppointmentEvent
from receptionist.reminders.scheduler import parse_now, sync_events
from receptionist.reminders.store import ReminderStore
from receptionist.reminders.service import (
    send_appointment_email as send_manual_appointment_email,
    send_appointment_sms as send_manual_appointment_sms,
)
from receptionist.reminders.templates import post_followup_template
from receptionist.runtime import app_config_path, ensure_app_runtime

PROJECT_ROOT = Path(
    os.environ.get("RECEPTIONIST_DESKTOP_ROOT") or Path(__file__).resolve().parents[1]
).expanduser().resolve()
ENV_LOCAL_PATH = PROJECT_ROOT / ".env.local"

load_dotenv(PROJECT_ROOT / ".env.local")
load_dotenv(PROJECT_ROOT / ".env")


def _canonical_path() -> Path:
    ensure_app_runtime()
    return app_config_path()

def _load_app_config():
    ensure_app_runtime()
    return load_app_config()

def _to_project_path(path: str | Path) -> Path:
    raw = Path(path)
    resolved = raw if raw.is_absolute() else PROJECT_ROOT / raw
    return resolved.resolve()


def _rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(PROJECT_ROOT)).replace("\\", "/")
    except ValueError:
        return str(path)


def _claim_manual_reminder(config, event: AppointmentEvent, channel: str):
    claim = ReminderStore(config.reminders.store_path).claim_manual_slot(
        event=event,
        channel=channel,
    )
    if claim is None or claim.get("already_sent"):
        raise ValueError(f"appointment {channel} reminder was already sent")
    if claim.get("busy"):
        raise RuntimeError(f"appointment {channel} reminder is already being sent")
    return ReminderStore(config.reminders.store_path), claim


def _manual_result_detail(result: dict[str, Any]) -> str:
    return json.dumps(result, default=str, sort_keys=True)


def _read_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise ConfigError("Business YAML must be a mapping at the top level")
    return data


def _normalize_business_mode(path: Path) -> None:
    try:
        data = _read_yaml(path)
    except Exception:
        return
    if data.get("mode") == "production":
        return
    text = path.read_text(encoding="utf-8")
    text = _set_top_level_scalar(text, "mode", "production")
    path.write_text(text, encoding="utf-8")


def _safe_get(data: dict[str, Any], *keys: str, default: Any = None) -> Any:
    current: Any = data
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            return default
        current = current[key]
    return current


def _coerce_bool(value: Any, *, default: bool = False) -> bool:
    """Interpret YAML booleans and their string form consistently for the UI."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "yes", "on", "1"}:
            return True
        if normalized in {"false", "no", "off", "0", ""}:
            return False
    if value is None:
        return default
    return bool(value)


def _snapshot(path: Path) -> dict[str, Any]:
    _normalize_business_mode(path)
    data = _read_yaml(path)
    valid = True
    error = None
    try:
        validated = _load_app_config()
    except Exception as exc:  # UI should show validation failures, not crash.
        valid = False
        error = str(exc)
        validated = None

    sms_provider = _safe_get(data, "sms", "provider", default={}) or {}
    if not isinstance(sms_provider, dict):
        sms_provider = {}
    reminders = _safe_get(data, "reminders", default={}) or {}
    if not isinstance(reminders, dict):
        reminders = {}
    post_appointment = reminders.get("post_appointment", {}) or {}
    if not isinstance(post_appointment, dict):
        post_appointment = {}
    calendar = _safe_get(data, "calendar", default={}) or {}
    if not isinstance(calendar, dict):
        calendar = {}
    email = _safe_get(data, "email", default={}) or {}
    if not isinstance(email, dict):
        email = {}

    raw_templates = data.get("message_templates", {}) or {}
    if not isinstance(raw_templates, dict):
        raw_templates = {}
    if validated is not None:
        template_data = dict(raw_templates)
        template_data["post_followups"] = {
            preset: post_followup_template(validated, preset)
            for preset in ("thank_you_review", "thank_you_only", "book_next_appointment")
        }
    else:
        template_data = raw_templates
    followups = []
    if validated is not None:
        followups = [item.model_dump() for item in (validated.reminders.post_appointment.follow_ups or [])]
    else:
        followups = post_appointment.get("follow_ups", []) if isinstance(post_appointment.get("follow_ups", []), list) else []

    post_appointment_snapshot = {
        "enabled": _coerce_bool(post_appointment.get("enabled"), default=True),
        "offset_days_after": int(post_appointment.get("offset_days_after", 1)),
    }
    if validated is not None or "follow_ups" in post_appointment:
        post_appointment_snapshot["follow_ups"] = followups

    return {
        "path": _rel(path),
        "slug": "canonical",
        "valid": valid,
        "error": error,
        "config": {
            "mode": "production",
            "business_name": data.get("name", path.stem),
            "timezone": data.get("timezone", "America/New_York"),
            "communications": data.get("communications", {}) or {},
            "message_templates": template_data,
            "reminders": {
                "enabled": _coerce_bool(reminders.get("enabled"), default=False),
                "channels": reminders.get("channels", []),
                "email_provider": reminders.get("email_provider"),
                "offset_days": reminders.get("offset_days", [4, 1]),
                "post_appointment": post_appointment_snapshot,
            },
            "calendar": {
                "enabled": bool(calendar.get("enabled", False)),
                "calendar_id": calendar.get("calendar_id"),
                "oauth_token_set": bool(
                    validated
                    and validated.calendar
                    and validated.calendar.enabled
                    and getattr(validated.calendar.auth, "oauth_token_file", None)
                    and Path(validated.calendar.auth.oauth_token_file).expanduser().exists()
                ),
            },
            "receptionist": {
                "description": (data.get("receptionist", {}) or {}).get("description", ""),
                "services": (data.get("receptionist", {}) or {}).get("services", []),
                "escalation_rules": (data.get("receptionist", {}) or {}).get("escalation_rules", []),
                "prohibited_claims": (data.get("receptionist", {}) or {}).get("prohibited_claims", []),
                "greeting": data.get("greeting", ""),
                "after_hours_message": data.get("after_hours_message", ""),
                "hours": data.get("hours", {}),
                "faqs": data.get("faqs", []),
                "routing": data.get("routing", []),
                "default_transfer_number": (data.get("communications", {}) or {}).get("default_transfer_number", ""),
                "idle": ((data.get("voice", {}) or {}).get("idle", {})),
                "recording": {
                    "configured": isinstance(data.get("recording"), dict),
                    "enabled": bool((data.get("recording", {}) or {}).get("enabled", False)),
                },
                "incoming_routing": {
                    "configured": False,
                    "detail": "Inbound phone routing is managed in Twilio and LiveKit Cloud, not in this desktop app.",
                },
            },
            "sms_provider": {
                "type": sms_provider.get("type", "fake"),
                "from_number": sms_provider.get("from_number"),
                "messaging_service_sid": sms_provider.get("messaging_service_sid"),
            },
            "email": {
                "from": email.get("from") or email.get("from_"),
                "configured": bool(email),
                "sender_type": validated.email.sender.type if validated and validated.email else None,
                "smtp_username_set": bool(_env_value("SMTP_USERNAME")),
                "smtp_password_set": bool(_env_value("SMTP_PASSWORD")),
                "gmail_oauth_token_set": bool(
                    validated
                    and validated.email
                    and validated.email.sender.type == "gmail_oauth"
                    and Path(validated.email.sender.gmail_oauth.oauth_token_file).expanduser().exists()
                ),
            },
            "validated_business_name": validated.name if validated else None,
        },
    }


def get_config(args: argparse.Namespace) -> None:
    _print_json(_snapshot(_canonical_path()))


def post_workspace(args: argparse.Namespace) -> None:
    """Return a renderer-safe summary of post-appointment follow-ups."""
    config = _load_app_config()
    post = config.reminders.post_appointment
    store = ReminderStore(config.reminders.store_path)
    jobs = store.list_jobs(phase="post", limit=20)
    display_names = {
        "thank_you_review": "Thank you + review",
        "thank_you_only": "Thank you",
        "book_next_appointment": "Book your next appointment",
    }
    jobs_by_preset: dict[str, list] = {}
    for job in jobs:
        jobs_by_preset.setdefault(job.post_followup_id or "thank_you_review", []).append(job)
    followup_rows = []
    safe_reasons = {
        "missed_due_time", "missing_recipient", "missing_email", "missing_phone",
        "sms_consent_required", "suppressed", "event_cancelled", "provider_deleted",
        "event_rescheduled", "event_revision_changed", "invalid_configuration",
    }
    for item in post.follow_ups or []:
        preset = item.preset
        template = post_followup_template(config, preset)
        preview = template.get("email_text") or template.get("sms") or ""
        followup_rows.append(
            {
                "preset": preset,
                "display_name": display_names.get(preset, preset),
                "enabled": bool(item.enabled),
                "offset_days_after": int(item.offset_days_after),
                "channels": list(item.channels),
                "template_configured": any(bool(value) for value in template.values()),
                "preview": preview[:240],
                "jobs": [
                    {
                        "summary": job.event_summary or "Appointment",
                        "due_at": job.due_at,
                        "channel": job.channel,
                        "status": job.status,
                        "reason": job.reason if job.reason in safe_reasons else None,
                    }
                    for job in jobs_by_preset.get(preset, [])
                ],
            }
        )
    _print_json(
        {
            "enabled": bool(post.enabled),
            "follow_ups": followup_rows,
        }
    )


def _appointment_sms_available(appointment: dict[str, Any], contacts) -> bool:
    event_id = str(appointment.get("event_id") or "").strip()
    event_uid = str(appointment.get("event_uid") or "").strip()
    calendar_id = str(appointment.get("calendar_id") or "primary").strip()
    contact_keys = (
        event_id,
        event_uid,
        f"{calendar_id}:{event_id}",
        f"{calendar_id}:{event_uid}",
        str(appointment.get("contact_email") or "").strip(),
        *(str(value).strip() for value in appointment.get("attendee_emails", []) if value),
    )
    recipient = ContactResolver(contacts).match_event(contact_keys)
    # The button is an eligibility signal, not a parser preview. A parsed
    # phone is usable only after sync has created an event-linked contact and
    # that contact passes every channel/suppression/consent check.
    if recipient is None:
        return False
    if (
        "sms" not in recipient.preferred_channels
        or recipient.suppressed
        or recipient.sms_consent_status != "opted_in"
    ):
        return False
    if normalize_us_phone(recipient.phone) is not None:
        if (
            str(recipient.phone_source or "").startswith("calendar_description:")
            and not extract_phone(appointment.get("notes") or "").phone
        ):
            return False
        return True
    extraction = extract_phone(appointment.get("notes") or "")
    # A stale/invalid stored phone may be repaired from the current event
    # description, but only after the linked contact has already passed the
    # consent/channel/suppression checks above.
    return bool(extraction.phone and not extraction.ambiguous)


_DESKTOP_APPOINTMENT_FIELDS = (
    "source",
    "calendar_id",
    "event_id",
    "event_uid",
    "summary",
    "start_iso",
    "end_iso",
    "timezone",
    "attendee_emails",
    "contact_email",
    "recurring",
    "sms_available",
    "appointment_changes_enabled",
    "can_reschedule",
    "can_cancel",
)

def _safe_https_url(value: str | None) -> tuple[str, str, str] | None:
    if not value:
        return None
    try:
        parsed = urlparse(value)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
    ):
        return None
    return value, parsed.hostname.lower(), parsed.path or "/"


def _calendar_feed_link(value: str | None) -> str | None:
    """Return only a Google Calendar HTTPS link safe for renderer use."""
    safe = _safe_https_url(value)
    if not safe:
        return None
    candidate, host, path = safe
    if host == "calendar.google.com":
        return candidate
    if host == "www.google.com" and path.startswith("/calendar/"):
        return candidate
    return None


def _calendar_feed_conference_url(value: str | None) -> str | None:
    """Keep direct conference URLs distinct from the Calendar event page."""
    safe = _safe_https_url(value)
    if not safe:
        return None
    candidate, host, path = safe
    is_zoom = (host == "zoom.us" or host.endswith(".zoom.us")) and path.startswith("/j/")
    is_google_meet = host == "meet.google.com"
    is_teams = (
        (host == "teams.microsoft.com" and path.startswith("/l/meetup-join"))
        or (host == "teams.live.com" and path.startswith("/meet/"))
    )
    is_webex = host.endswith(".webex.com")
    is_chime = host == "chime.aws"
    return candidate if is_zoom or is_google_meet or is_teams or is_webex or is_chime else None


def _calendar_feed_event(
    event: Any,
    *,
    contacts: list[Any] | None = None,
    appointment_changes: Any | None = None,
    include_private_provenance: bool = False,
) -> dict[str, Any]:
    """Project a synced appointment event into a safe or bridge-private feed.

    Keep this separate from the desktop appointment projection: reminder
    workflows need raw descriptions and recovered contact fields internally,
    but neither belongs in either feed. The default is safe for Hira; the
    calendar-events command explicitly opts into the private bridge fields.
    """
    start_iso = event.start.isoformat()
    projected = {
        "occurrence_id": f"{event.calendar_id}:{event.event_id}:{start_iso}",
        "calendar_id": event.calendar_id,
        "event_id": event.event_id,
        "event_uid": event.event_uid,
        "start_iso": start_iso,
        "end_iso": event.end.isoformat(),
        "timezone": event.timezone,
        "title": event.summary,
        "attendees": list(event.attendee_emails),
        "recurring": bool(event.recurring),
        "all_day": bool(event.all_day),
        "status": event.status,
        "conference_url": _calendar_feed_conference_url(event.conference_url),
        "html_link": _calendar_feed_link(event.html_link),
    }
    if include_private_provenance:
        # The sidecar is the only component allowed to inspect descriptions.
        # Export a bounded, validated patient block when present; never raw notes.
        from receptionist.reminders.identity import extract_patient_metadata

        patient_metadata = extract_patient_metadata(event.notes)
        if patient_metadata:
            projected["patient_metadata"] = patient_metadata
        self_attendee_present = getattr(event, "has_self_attendee", None)
        projected["self_attendee_present"] = (
            self_attendee_present if type(self_attendee_present) is bool else None
        )
    if contacts is not None:
        appointment = {
            "event_id": event.event_id,
            "event_uid": event.event_uid,
            "calendar_id": event.calendar_id,
            "attendee_emails": list(event.attendee_emails),
            "contact_email": event.contact_email,
            "notes": event.notes,
        }
        changes_enabled = bool(getattr(appointment_changes, "enabled", False))
        projected.update(
            {
                "sms_available": _appointment_sms_available(appointment, contacts),
                "appointment_changes_enabled": changes_enabled,
                "can_reschedule": changes_enabled,
                "can_cancel": changes_enabled,
            }
        )
    return projected


def _calendar_window(
    config: Any,
    current: datetime,
    events: list[dict[str, Any]],
    tombstones: list[dict[str, Any]],
    *,
    complete: bool,
    window_start: datetime | None = None,
    window_end: datetime | None = None,
) -> dict[str, Any]:
    window_start = window_start or current - timedelta(days=getattr(config.reminders, "lookback_days", 7))
    window_end = window_end or current + timedelta(days=getattr(config.reminders, "lookahead_days", 30))
    calendar_ids = {event["calendar_id"] for event in events if event.get("calendar_id")}
    calendar_ids.update(
        tombstone["calendar_id"] for tombstone in tombstones if tombstone.get("calendar_id")
    )
    configured_calendar_id = getattr(config.calendar, "calendar_id", None)
    if configured_calendar_id:
        calendar_ids.add(configured_calendar_id)
    return {
        "start_iso": window_start.astimezone(timezone.utc).isoformat(),
        "end_iso": window_end.astimezone(timezone.utc).isoformat(),
        "calendar_ids": sorted(calendar_ids),
        "complete": complete,
    }


def calendar_events(args: argparse.Namespace) -> None:
    """Fetch and cache calendar events without scheduling reminder jobs.

    This is the latency-sensitive desktop path. Reminder reconciliation is
    deliberately separate so browsing the calendar never waits on contact
    parsing, job upserts, or message delivery checks.
    """
    config = _load_app_config()
    if config.calendar is None or not config.calendar.enabled:
        raise ValueError("calendar-events requires calendar.enabled")

    limit = max(1, min(int(args.limit), 500))
    store = ReminderStore(config.reminders.store_path)
    store.init_db()
    current = parse_now(args.now, config.business.timezone)
    load_kwargs: dict[str, Any] = {"current": current}
    start_iso = getattr(args, "start_iso", None)
    end_iso = getattr(args, "end_iso", None)
    if start_iso or end_iso:
        if not start_iso or not end_iso:
            raise ValueError("calendar-events requires both --start-iso and --end-iso")
        requested_start = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
        requested_end = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
        if requested_start.tzinfo is None:
            requested_start = requested_start.replace(tzinfo=current.tzinfo)
        if requested_end.tzinfo is None:
            requested_end = requested_end.replace(tzinfo=current.tzinfo)
        if requested_end <= requested_start:
            raise ValueError("calendar-events requires an end after the start")
        load_kwargs.update(window_start=requested_start, window_end=requested_end)
    batch = asyncio.run(_load_configured_events(config, **load_kwargs))
    contacts = load_contacts(config.reminders.contacts_path)
    for tombstone in batch.tombstones:
        store.cancel_event(
            source=tombstone.source,
            calendar_id=tombstone.calendar_id,
            event_id=tombstone.event_id,
            reason="provider_deleted",
        )
    for event in batch.events:
        store.upsert_event(event)

    events = sorted(
        (
            _calendar_feed_event(
                event,
                contacts=contacts,
                appointment_changes=getattr(config, "appointment_changes", None),
                include_private_provenance=True,
            )
            for event in batch.events
        ),
        key=lambda event: (event["calendar_id"], event["event_id"], event["start_iso"]),
    )[:limit]
    tombstones = [
        {"calendar_id": tombstone.calendar_id, "event_id": tombstone.event_id}
        for tombstone in batch.tombstones
    ]
    window = _calendar_window(
        config,
        current,
        events,
        tombstones,
        complete=len(batch.events) <= limit,
        window_start=load_kwargs.get("window_start"),
        window_end=load_kwargs.get("window_end"),
    )
    _print_json(
        {
            "ok": True,
            "synced_at": current.isoformat(),
            "synced_events": len(batch.events),
            "events": events,
            "tombstones": tombstones,
            "window": window,
            "reminders_deferred": True,
        }
    )


def _stored_appointment_event(record: dict[str, Any]) -> AppointmentEvent:
    stored_attendees = record.get("attendee_emails") or ()
    attendee_values = (
        split_stored_values(stored_attendees)
        if isinstance(stored_attendees, str)
        else tuple(stored_attendees)
    )
    stored_contact_keys = record.get("contact_match_keys") or ()
    contact_key_values = (
        split_stored_values(stored_contact_keys)
        if isinstance(stored_contact_keys, str)
        else tuple(stored_contact_keys)
    )
    return AppointmentEvent(
        source=record.get("source") or "google",
        calendar_id=record.get("calendar_id") or "primary",
        event_id=record["event_id"],
        event_uid=record.get("event_uid") or record["event_id"],
        summary=record.get("summary") or "Appointment",
        notes=record.get("notes") or "",
        start=datetime.fromisoformat(record["start_iso"]),
        end=datetime.fromisoformat(record["end_iso"]),
        timezone=record.get("timezone") or "UTC",
        attendee_emails=normalize_emails(attendee_values),
        contact_match_keys=normalize_contact_keys(contact_key_values),
        has_self_attendee=(
            record.get("self_attendee_present")
            if type(record.get("self_attendee_present")) is bool
            else None
        ),
        contact_email=record.get("contact_email"),
        contact_email_source=record.get("contact_email_source"),
        contact_email_recovered_at=record.get("contact_email_recovered_at"),
        recurring=bool(record.get("recurring")),
    )


def reminders_sync(args: argparse.Namespace) -> None:
    """Reconcile reminder jobs from the already-cached local event ledger."""
    config = _load_app_config()
    store = ReminderStore(config.reminders.store_path)
    current = parse_now(args.now, config.business.timezone)
    lookback = current - timedelta(days=getattr(config.reminders, "lookback_days", 7))
    lookahead = current + timedelta(days=getattr(config.reminders, "lookahead_days", 30))
    records = store.list_events(
        limit=max(1, min(int(args.limit), 1000)),
        start_iso=lookback.astimezone(timezone.utc).isoformat(),
        end_iso=lookahead.astimezone(timezone.utc).isoformat(),
    )
    synced_events = sync_events(
        config=config,
        store=store,
        events=(_stored_appointment_event(record) for record in records),
        contacts=load_contacts(config.reminders.contacts_path),
        now=current,
    )
    _print_json({"ok": True, "synced_events": synced_events, "source": "local-cache"})


def calendar_feed(args: argparse.Namespace) -> None:
    """Sync configured calendar sources and emit a safe encounter feed.

    This is intentionally a one-way read contract for Hira.  It uses
    the reminder subsystem's bounded configured sync, updates its local
    reminder ledger, and exposes no raw event description, note, token, or
    credential data.
    """
    config = _load_app_config()
    if config.calendar is None or not config.calendar.enabled:
        raise ValueError("calendar-feed requires calendar.enabled")

    limit = max(1, min(int(args.limit), 500))
    store = ReminderStore(config.reminders.store_path)
    # Initialize once before the provider request. ReminderStore caches this
    # initialization for the rest of the feed, so each event/job write does
    # not repeat the schema migration and contact normalization pass.
    store.init_db()
    current = parse_now(args.now, config.business.timezone)
    batch = asyncio.run(_load_configured_events(config, current=current))
    # Calendar browsing is independent from reminder delivery. Persist the
    # normalized event projection even when reminder automation is disabled;
    # sync_events intentionally skips reminder jobs in that mode.
    for event in batch.events:
        store.upsert_event(event)
    synced_events = sync_events(
        config=config,
        store=store,
        events=batch.events,
        contacts=load_contacts(config.reminders.contacts_path),
        now=current,
        tombstones=batch.tombstones,
    )
    events = sorted(
        (_calendar_feed_event(event) for event in batch.events),
        key=lambda event: (event["calendar_id"], event["event_id"], event["start_iso"]),
    )[:limit]
    tombstones = [
        {
            "calendar_id": tombstone.calendar_id,
            "event_id": tombstone.event_id,
        }
        for tombstone in batch.tombstones
    ]
    window = _calendar_window(
        config,
        current,
        events,
        tombstones,
        complete=len(batch.events) <= limit,
    )
    _print_json(
        {
            "ok": True,
            "synced_at": current.isoformat(),
            "synced_events": synced_events,
            "events": events,
            "tombstones": tombstones,
            "window": window,
        }
    )


def _desktop_appointment_projection(appointment: dict[str, Any]) -> dict[str, Any]:
    """Return the allowlisted appointment shape exposed to Electron.

    The stored event includes the raw Google Calendar description in ``notes``
    because reminder and appointment-change workflows parse it. That internal
    field must not cross the desktop response boundary.
    """
    return {field: appointment.get(field) for field in _DESKTOP_APPOINTMENT_FIELDS}


def list_appointments(args: argparse.Namespace) -> None:
    config = _load_app_config()
    appointments = ReminderStore(config.reminders.store_path).list_events(
        limit=args.limit,
        start_iso=args.start_iso,
        end_iso=args.end_iso,
    )
    contacts = load_contacts(config.reminders.contacts_path)
    appointment_changes = getattr(config, "appointment_changes", None)
    for appointment in appointments:
        appointment["sms_available"] = _appointment_sms_available(appointment, contacts)
        appointment["appointment_changes_enabled"] = bool(
            getattr(appointment_changes, "enabled", False)
        )
        # The service distinguishes a recurring occurrence (which is safe to
        # change by its instance ID) from a series master (which it rejects).
        # Keep the action available for occurrences; the server remains the
        # final authority and fails closed for an unsupported master.
        appointment["can_reschedule"] = bool(appointment["appointment_changes_enabled"])
        appointment["can_cancel"] = bool(appointment["appointment_changes_enabled"])
    _print_json(
        {
            "appointments": [
                _desktop_appointment_projection(appointment)
                for appointment in appointments
            ]
        }
    )


def rename_appointment(args: argparse.Namespace) -> None:
    path = _canonical_path()
    config = _load_app_config()
    if config.calendar is None or not config.calendar.enabled:
        raise ValueError("appointment rename requires calendar.enabled")
    summary = (args.summary or "").strip()
    if not summary:
        raise ValueError("appointment rename requires a non-empty summary")

    creds = build_credentials(config.calendar.auth)
    calendar_id = args.calendar_id or config.calendar.calendar_id
    store = ReminderStore(config.reminders.store_path)
    if store.get_active_google_event(calendar_id=calendar_id, event_id=args.event_id) is None:
        raise ValueError("appointment rename requires one active stored Google event")
    client = GoogleCalendarClient(creds, calendar_id)
    raw = asyncio.run(client.get_event(event_id=args.event_id, show_deleted=True))
    if raw.get("status") == "cancelled":
        raise ValueError("appointment rename cannot modify a cancelled event")
    result = asyncio.run(
        client.rename_event(
            event_id=args.event_id,
            summary=summary,
            etag=raw.get("etag"),
        )
    )
    updated = store.rename_event(
        source="google",
        calendar_id=calendar_id,
        event_id=args.event_id,
        summary=summary,
    )
    _print_json(
        {
            "ok": True,
            "event_id": args.event_id,
            "calendar_id": calendar_id,
            "summary": result.get("summary", summary),
            "store_rows_updated": updated,
        }
    )


def delete_appointment(args: argparse.Namespace) -> None:
    # The legacy bulk-delete UI already asks for confirmation before invoking
    # this compatibility command. Keep that path routed through the same
    # service while preserving its existing command contract.
    args.confirmed = True
    cancel_appointment(args)


def cancel_appointment(args: argparse.Namespace) -> None:
    path = _canonical_path()
    config = _load_app_config()
    if config.calendar is None or not config.calendar.enabled:
        raise ValueError("appointment delete requires calendar.enabled")

    creds = build_credentials(config.calendar.auth)
    calendar_id = args.calendar_id or config.calendar.calendar_id
    client = GoogleCalendarClient(creds, calendar_id)
    service = AppointmentChangeService(
        config=config,
        client=client,
        store=ReminderStore(config.reminders.store_path),
    )
    result = asyncio.run(
        service.desktop_cancel(
            calendar_id=calendar_id,
            event_id=args.event_id,
            confirmed=bool(getattr(args, "confirmed", False)),
        )
    )
    _print_json(result)


def reschedule_appointment(args: argparse.Namespace) -> None:
    config = _load_app_config()
    if config.calendar is None or not config.calendar.enabled:
        raise ValueError("appointment reschedule requires calendar.enabled")
    try:
        new_start = datetime.fromisoformat(args.new_start_iso.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("appointment reschedule requires a valid ISO date/time") from exc
    creds = build_credentials(config.calendar.auth)
    calendar_id = args.calendar_id or config.calendar.calendar_id
    client = GoogleCalendarClient(creds, calendar_id)
    service = AppointmentChangeService(
        config=config,
        client=client,
        store=ReminderStore(config.reminders.store_path),
    )
    result = asyncio.run(
        service.desktop_reschedule(
            calendar_id=calendar_id,
            event_id=args.event_id,
            new_start=new_start,
            confirmed=bool(getattr(args, "confirmed", False)),
        )
    )
    _print_json(result)


def send_appointment_email(args: argparse.Namespace) -> None:
    attendee_email = normalize_email(args.attendee_email)
    if attendee_email is None:
        raise ValueError("appointment email requires a valid attendee email")
    config = _load_app_config()
    event = ReminderStore(config.reminders.store_path).get_active_google_event(
        calendar_id=args.calendar_id or "primary",
        event_id=args.event_id,
        event_uid=args.event_uid or None,
    )
    if event is None:
        raise ValueError("appointment email requires one active stored Google event")
    allowed_emails = set(event.attendee_emails)
    if event.contact_email:
        allowed_emails.add(event.contact_email)
    if attendee_email not in allowed_emails:
        raise ValueError("appointment email recipient is not an attendee or recovered contact for the stored event")
    store, claim = _claim_manual_reminder(config, event, "email")
    job = claim["job"]
    try:
        result = asyncio.run(
            send_manual_appointment_email(
                config=config,
                event=event,
                attendee_email=attendee_email,
            )
        )
    except Exception as exc:
        store.release_manual_slot(
            job_id=job.id or 0,
            claim_token=claim["claim_token"],
            previous_status=claim.get("previous_status"),
            previous_reason=claim.get("previous_reason"),
            created=bool(claim.get("created")),
            provider="email",
            detail=str(exc),
        )
        raise
    if not store.complete_manual_slot(
        job_id=job.id or 0,
        claim_token=claim["claim_token"],
        provider="email",
        detail=_manual_result_detail(result),
    ):
        raise RuntimeError("appointment email was sent but could not be recorded")
    _print_json(
        {
            "ok": True,
            "recipient_email": result["recipient_email"],
            "recipient_name": result["recipient_name"],
            "subject": result["subject"],
        }
    )


def send_appointment_sms(args: argparse.Namespace) -> None:
    config = _load_app_config()
    event = ReminderStore(config.reminders.store_path).get_active_google_event(
        calendar_id=args.calendar_id or "primary",
        event_id=args.event_id,
        event_uid=args.event_uid or None,
    )
    if event is None:
        raise ValueError("appointment SMS requires one active stored Google event")
    store, claim = _claim_manual_reminder(config, event, "sms")
    job = claim["job"]
    try:
        result = asyncio.run(
            send_manual_appointment_sms(
                config=config,
                event=event,
            )
        )
    except Exception as exc:
        store.release_manual_slot(
            job_id=job.id or 0,
            claim_token=claim["claim_token"],
            previous_status=claim.get("previous_status"),
            previous_reason=claim.get("previous_reason"),
            created=bool(claim.get("created")),
            provider="sms",
            detail=str(exc),
        )
        raise
    if not store.complete_manual_slot(
        job_id=job.id or 0,
        claim_token=claim["claim_token"],
        provider="sms",
        detail=_manual_result_detail(result),
    ):
        raise RuntimeError("appointment SMS was sent but could not be recorded")
    _print_json(
        {
            "ok": True,
            "recipient_name": result["recipient_name"],
            "recipient_phone": result["recipient_phone"],
        }
    )


def get_reminder_status(args: argparse.Namespace) -> None:
    config = _load_app_config()
    try:
        events = json.loads(args.events_json)
    except json.JSONDecodeError as exc:
        raise ValueError("reminder status requires valid event JSON") from exc
    if not isinstance(events, list):
        raise ValueError("reminder status requires an event array")
    statuses = ReminderStore(config.reminders.store_path).get_reminder_statuses(events)
    _print_json({"ok": True, "statuses": statuses})


def get_email_setup(args: argparse.Namespace) -> None:
    path = _canonical_path()
    snapshot = _snapshot(path)
    validated = None
    try:
        validated = _load_app_config()
    except Exception:
        pass
    sender_type = validated.email.sender.type if validated and validated.email else None
    gmail_token_file = (
        validated.email.sender.gmail_oauth.oauth_token_file
        if validated and validated.email and validated.email.sender.type == "gmail_oauth"
        else ""
    )
    smtp_username = _env_value("SMTP_USERNAME") or ""
    smtp_password_set = bool(_env_value("SMTP_PASSWORD"))
    if sender_type != "smtp":
        smtp_username = ""
        smtp_password_set = False
    _print_json({
        "from": _safe_get(_read_yaml(path), "email", "from")
        or _safe_get(_read_yaml(path), "communications", "email_from")
        or "",
        "sender_type": sender_type or "",
        "gmail_oauth_token_file": gmail_token_file,
        "gmail_oauth_token_set": bool(gmail_token_file and Path(gmail_token_file).expanduser().exists()),
        "smtp_username": smtp_username,
        "smtp_password_set": smtp_password_set,
        "config_valid": snapshot["valid"],
        "config_error": snapshot["error"],
    })


def update_email_setup(args: argparse.Namespace) -> None:
    path = _canonical_path()
    original = path.read_text(encoding="utf-8")
    text = original
    if args.from_address:
        if not re.search(r"^email\s*:\s*(?:#.*)?$", text, re.MULTILINE):
            text = text.rstrip() + (
                "\n\nemail:\n"
                f"  from: {_yaml_scalar(args.from_address)}\n"
                "  sender:\n"
                "    type: \"smtp\"\n"
                "    smtp:\n"
                "      host: \"smtp.gmail.com\"\n"
                "      port: 587\n"
                "      username: ${SMTP_USERNAME}\n"
                "      password: ${SMTP_PASSWORD}\n"
                "      use_tls: true\n"
                "  triggers:\n"
                "    on_message: true\n"
                "    on_call_end: false\n"
                "    on_booking: false\n"
            )
        text = _set_mapping_value(text, "communications", "email_from", args.from_address)
        text = _set_mapping_value(text, "email", "from", args.from_address)

    env_updates = {}
    if args.smtp_username:
        env_updates["SMTP_USERNAME"] = args.smtp_username
    if args.smtp_password:
        env_updates["SMTP_PASSWORD"] = args.smtp_password
    if env_updates:
        _write_env_local(env_updates)
        for key, value in env_updates.items():
            os.environ[key] = value

    backup_path = _backup(path)
    path.write_text(text, encoding="utf-8")
    snapshot = _snapshot(path)
    snapshot["backup_path"] = _rel(backup_path)
    _print_json(snapshot)


def _env_value(key: str) -> str | None:
    value = os.environ.get(key)
    return value if value else None


def _quote_env(value: str) -> str:
    if re.search(r"\s|#|=|\"", value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def _write_env_local(values: dict[str, str]) -> None:
    ENV_LOCAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines = ENV_LOCAL_PATH.read_text(encoding="utf-8").splitlines() if ENV_LOCAL_PATH.exists() else []
    seen = set()
    out = []
    for line in lines:
        match = re.match(r"^([A-Z_][A-Z0-9_]*)=", line)
        if match and match.group(1) in values:
            key = match.group(1)
            out.append(f"{key}={_quote_env(values[key])}")
            seen.add(key)
        else:
            out.append(line)
    for key, value in values.items():
        if key not in seen:
            out.append(f"{key}={_quote_env(value)}")
    ENV_LOCAL_PATH.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")


def _set_mapping_value(text: str, section: str, key: str, value: str) -> str:
    lines = text.splitlines()
    section_start = None
    for index, line in enumerate(lines):
        if re.match(rf"^{re.escape(section)}\s*:\s*(?:#.*)?$", line):
            section_start = index
            break
    if section_start is None:
        return text.rstrip() + f"\n\n{section}:\n  {key}: {_yaml_scalar(value)}\n"

    end = section_start + 1
    key_index = None
    while end < len(lines):
        line = lines[end]
        if line and not line.startswith((" ", "\t")) and not line.lstrip().startswith("#"):
            break
        if re.match(rf"^\s{{2}}{re.escape(key)}\s*:", line):
            key_index = end
        end += 1

    new_line = f"  {key}: {_yaml_scalar(value)}"
    if key_index is not None:
        lines[key_index] = new_line
    else:
        lines.insert(section_start + 1, new_line)
    return "\n".join(lines) + "\n"


def _backup(path: Path) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = path.with_suffix(path.suffix + f".{stamp}.bak")
    shutil.copy2(path, backup_path)
    return backup_path


def _yaml_scalar(value: str) -> str:
    dumped = yaml.safe_dump(value, default_flow_style=True, allow_unicode=True).strip()
    lines = [line for line in dumped.splitlines() if line.strip() != "..."]
    return " ".join(lines).strip() or "''"


def _yaml_mapping_lines(key: str, values: dict[str, str]) -> list[str]:
    lines = [f"{key}:"]
    for name, value in values.items():
        if "\n" in value:
            chomping = "|" if value.endswith("\n") else "|-"
            lines.append(f"  {name}: {chomping}")
            for line in value.splitlines():
                lines.append(f"    {line}")
            if value.endswith("\n"):
                lines.append("    ")
        else:
            lines.append(f"  {name}: {_yaml_scalar(value)}")
    return lines


def _set_top_level_scalar(text: str, key: str, value: str) -> str:
    line = f"{key}: {_yaml_scalar(value)}"
    pattern = re.compile(rf"^(?P<prefix>{re.escape(key)}\s*:\s*).*$", re.MULTILINE)
    if pattern.search(text):
        return pattern.sub(line, text, count=1)
    return line + "\n\n" + text


def _set_mapping_block(text: str, key: str, values: dict[str, str]) -> str:
    lines = text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if re.match(rf"^{re.escape(key)}\s*:\s*(?:#.*)?$", line):
            start = index
            break
    block_lines = _yaml_mapping_lines(key, values)
    if start is None:
        insert_at = 0
        for index, line in enumerate(lines):
            if re.match(r"^business\s*:\s*(?:#.*)?$", line):
                insert_at = index
                break
        return "\n".join(lines[:insert_at] + block_lines + [""] + lines[insert_at:]) + "\n"

    end = start + 1
    while end < len(lines):
        line = lines[end]
        if line and not line.startswith((" ", "\t")) and not line.lstrip().startswith("#"):
            break
        end += 1
    return "\n".join(lines[:start] + block_lines + lines[end:]) + "\n"


def _set_nested_mapping_block(
    text: str, parent: str, child: str, values: dict[str, str]
) -> str:
    """Replace a small two-level YAML mapping without reformatting the file."""
    lines = text.splitlines()
    parent_index = next(
        (i for i, line in enumerate(lines) if re.match(rf"^{re.escape(parent)}\s*:", line)),
        None,
    )
    child_line = f"  {child}:"
    block = [
        child_line,
        *[
            f"    {key}: {value.lower()}"
            if key == "enabled" and value.strip().lower() in {"true", "false"}
            else f"    {key}: {_yaml_scalar(value)}"
            for key, value in values.items()
        ],
    ]
    if parent_index is None:
        return text.rstrip() + "\n\n" + parent + ":\n" + "\n".join(block) + "\n"
    parent_value = lines[parent_index].split(":", 1)[1].strip()
    if parent_value and not parent_value.startswith("#"):
        parsed = yaml.safe_load(parent_value)
        if isinstance(parsed, dict):
            expanded = [f"{parent}:"]
            for key, value in parsed.items():
                expanded.append(f"  {key}: {_yaml_scalar(value) if not isinstance(value, (dict, list)) else yaml.safe_dump(value, default_flow_style=True).strip()}")
            lines[parent_index:parent_index + 1] = expanded
    parent_end = parent_index + 1
    while parent_end < len(lines):
        line = lines[parent_end]
        if line and not line.startswith((" ", "\t")) and not line.lstrip().startswith("#"):
            break
        parent_end += 1
    child_index = next(
        (
            i
            for i in range(parent_index + 1, parent_end)
            if re.match(rf"^\s{{2}}{re.escape(child)}\s*:", lines[i])
        ),
        None,
    )
    if child_index is None:
        lines[parent_index + 1:parent_index + 1] = block
    else:
        child_end = child_index + 1
        while child_end < parent_end:
            line = lines[child_end]
            if line and re.match(r"^\s{2}\S", line):
                break
            child_end += 1
        lines[child_index:child_end] = block
    return "\n".join(lines) + "\n"


def _set_nested_object_block(
    text: str, parent: str, child: str, values: dict[str, Any]
) -> str:
    """Replace a nested YAML object while keeping surrounding config readable."""
    lines = text.splitlines()
    parent_index = next(
        (i for i, line in enumerate(lines) if re.match(rf"^{re.escape(parent)}\s*:", line)),
        None,
    )
    if parent_index is None:
        payload = yaml.safe_dump({child: values}, sort_keys=False, allow_unicode=True).splitlines()
        return text.rstrip() + f"\n\n{parent}:\n" + "\n".join("  " + line for line in payload) + "\n"
    parent_value = lines[parent_index].split(":", 1)[1].strip()
    if parent_value and not parent_value.startswith("#"):
        parsed = yaml.safe_load(parent_value)
        if isinstance(parsed, dict):
            expanded = [f"{parent}:"]
            for key, value in parsed.items():
                scalar = _yaml_scalar(str(value)) if not isinstance(value, (dict, list)) else yaml.safe_dump(value, default_flow_style=True).strip()
                expanded.append(f"  {key}: {scalar}")
            lines[parent_index:parent_index + 1] = expanded
    parent_end = parent_index + 1
    while parent_end < len(lines):
        if lines[parent_end] and not lines[parent_end].startswith((" ", "\t")):
            break
        parent_end += 1
    child_index = next(
        (i for i in range(parent_index + 1, parent_end) if re.match(rf"^\s{{2}}{re.escape(child)}\s*:", lines[i])),
        None,
    )
    child_end = child_index + 1 if child_index is not None else parent_index + 1
    if child_index is not None:
        while child_end < parent_end:
            if re.match(r"^\s{2}\S", lines[child_end]):
                break
            child_end += 1
    payload = yaml.safe_dump({child: values}, sort_keys=False, allow_unicode=True).splitlines()
    block = ["  " + line for line in payload]
    if child_index is None:
        lines[parent_index + 1:parent_index + 1] = block
    else:
        lines[child_index:child_end] = block
    return "\n".join(lines) + "\n"


def update_receptionist(args: argparse.Namespace) -> None:
    """Safely update the approved receptionist settings for future calls only."""
    path = _canonical_path()
    try:
        payload = json.loads(args.payload)
    except json.JSONDecodeError as exc:
        raise ValueError("receptionist update payload must be valid JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("receptionist update payload must be an object")

    allowed = {
        "name", "greeting", "after_hours_message", "description", "services", "hours", "faqs",
        "default_transfer_number", "routing", "escalation_rules",
        "prohibited_claims", "idle", "recording_enabled",
    }
    unknown = set(payload) - allowed
    if unknown:
        raise ValueError(f"unsupported receptionist settings: {', '.join(sorted(unknown))}")

    data = _read_yaml(path)
    if "name" in payload:
        data["name"] = payload["name"]
    if "greeting" in payload:
        data["greeting"] = payload["greeting"]
    if "after_hours_message" in payload:
        data["after_hours_message"] = payload["after_hours_message"]
    if "hours" in payload:
        data["hours"] = payload["hours"]
    if "faqs" in payload:
        data["faqs"] = payload["faqs"]
    if "routing" in payload:
        data["routing"] = payload["routing"]
    if "default_transfer_number" in payload:
        data.setdefault("communications", {})["default_transfer_number"] = payload["default_transfer_number"]

    receptionist = dict(data.get("receptionist") or {})
    for key in ("description", "services", "escalation_rules", "prohibited_claims"):
        if key in payload:
            receptionist[key] = payload[key]
    data["receptionist"] = receptionist

    if "idle" in payload:
        data.setdefault("voice", {}).setdefault("idle", {}).update(payload["idle"])
    if "recording_enabled" in payload:
        recording = data.get("recording")
        if not isinstance(recording, dict):
            raise ValueError("recording is not configured; enable it through a reviewed deployment config")
        recording["enabled"] = bool(payload["recording_enabled"])

    # Pydantic validates all edited and unchanged settings before anything is written.
    AppConfig.model_validate(data)
    backup_path = _backup(path)
    path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=False), encoding="utf-8")
    snapshot = _snapshot(path)
    snapshot["backup_path"] = _rel(backup_path)
    snapshot["restart_required"] = True
    snapshot["apply_note"] = "Saved for future calls. Restart/redeploy the agent before the change takes effect."
    _print_json(snapshot)


def update_config(args: argparse.Namespace) -> None:
    path = _canonical_path()
    _normalize_business_mode(path)
    original = path.read_text(encoding="utf-8")
    text = original
    if args.mode not in (None, "production"):
        raise ValueError("desktop only supports production mode")
    text = _set_top_level_scalar(text, "mode", "production")
    comms = {
        "default_transfer_number": args.default_transfer_number or "",
        "email_from": args.email_from or "",
        "sms_from_number": args.sms_from_number or "",
    }
    text = _set_mapping_block(text, "communications", comms)
    template_values = {
        "confirmation_email_subject": args.confirmation_email_subject or "",
        "confirmation_email_text": args.confirmation_email_text or "",
        "confirmation_sms": args.confirmation_sms or "",
        "reminder_email_subject": args.reminder_email_subject or "",
        "reminder_email_text": args.reminder_email_text or "",
        "reminder_sms": args.reminder_sms or "",
        "post_reminder_email_subject": getattr(args, "post_reminder_email_subject", "") or "",
        "post_reminder_email_text": getattr(args, "post_reminder_email_text", "") or "",
        "post_reminder_email_html": getattr(args, "post_reminder_email_html", "") or "",
        "post_reminder_sms": getattr(args, "post_reminder_sms", "") or "",
        "quick_sms": args.quick_sms or "",
        "quick_email": args.quick_email or "",
        "quick_call_script": args.quick_call_script or "",
        "message_email_subject": args.message_email_subject or "",
        "message_email_text": args.message_email_text or "",
        "message_email_html": args.message_email_html or "",
        "call_end_email_subject": args.call_end_email_subject or "",
        "call_end_email_text": args.call_end_email_text or "",
        "call_end_email_html": args.call_end_email_html or "",
        "booking_email_subject": args.booking_email_subject or "",
        "booking_email_text": args.booking_email_text or "",
        "booking_email_html": args.booking_email_html or "",
    }
    text = _set_mapping_block(text, "message_templates", template_values)
    current_data = yaml.safe_load(text) or {}
    current_post = ((current_data.get("reminders") or {}).get("post_appointment") or {})
    followups_payload = getattr(args, "post_followups_json", "") or ""
    if followups_payload:
        try:
            followups = json.loads(followups_payload)
        except json.JSONDecodeError as exc:
            raise ValueError("post follow-ups must be valid JSON") from exc
        if not isinstance(followups, list):
            raise ValueError("post follow-ups must be an array")
        # Validate the same contract used by the runtime before writing YAML.
        from receptionist.config import PostAppointmentConfig
        validated_post = PostAppointmentConfig(
            enabled=getattr(args, "post_appointment_enabled", "true") == "true",
            offset_days_after=int(getattr(args, "post_appointment_offset_days", 1) or 1),
            follow_ups=followups,
        )
        post_values: dict[str, Any] = {
            "enabled": validated_post.enabled,
            "offset_days_after": validated_post.offset_days_after,
            "follow_ups": [item.model_dump() for item in validated_post.follow_ups or []],
        }
        text = _set_nested_object_block(text, "reminders", "post_appointment", post_values)
    else:
        post_values = {
            "enabled": getattr(args, "post_appointment_enabled", "true") == "true",
            "offset_days_after": int(getattr(args, "post_appointment_offset_days", 1) or 1),
        }
        if isinstance(current_post, dict) and isinstance(current_post.get("follow_ups"), list):
            post_values["follow_ups"] = current_post["follow_ups"]
        text = _set_nested_object_block(text, "reminders", "post_appointment", post_values)

    nested_templates_payload = getattr(args, "post_followup_templates_json", "") or ""
    if nested_templates_payload:
        try:
            nested_templates = json.loads(nested_templates_payload)
        except json.JSONDecodeError as exc:
            raise ValueError("post follow-up templates must be valid JSON") from exc
        if not isinstance(nested_templates, dict):
            raise ValueError("post follow-up templates must be an object")
        text = _set_nested_object_block(text, "message_templates", "post_followups", nested_templates)

    # The desktop editor also controls the pre-appointment reminder policy.
    # Keep the JSON boundary explicit so channels and offsets remain typed
    # lists in the canonical YAML instead of becoming opaque strings.
    reminder_updates: dict[str, Any] = {}
    if getattr(args, "reminders_enabled", None) is not None:
        reminder_updates["enabled"] = args.reminders_enabled == "true"
    offset_payload = getattr(args, "reminder_offset_days_json", "") or ""
    if offset_payload:
        try:
            offsets = json.loads(offset_payload)
        except json.JSONDecodeError as exc:
            raise ValueError("reminder offsets must be valid JSON") from exc
        if not isinstance(offsets, list):
            raise ValueError("reminder offsets must be an array")
        reminder_updates["offset_days"] = offsets
    channel_payload = getattr(args, "reminder_channels_json", "") or ""
    if channel_payload:
        try:
            channels = json.loads(channel_payload)
        except json.JSONDecodeError as exc:
            raise ValueError("reminder channels must be valid JSON") from exc
        if not isinstance(channels, list):
            raise ValueError("reminder channels must be an array")
        reminder_updates["channels"] = channels
    if reminder_updates:
        final_data = yaml.safe_load(text) or {}
        reminders_data = final_data.setdefault("reminders", {})
        if not isinstance(reminders_data, dict):
            raise ValueError("reminders configuration must be a mapping")
        reminders_data.update(reminder_updates)
        text = yaml.safe_dump(final_data, sort_keys=False, allow_unicode=False)

    backup_path = _backup(path)
    path.write_text(text, encoding="utf-8")
    snapshot = _snapshot(path)
    snapshot["backup_path"] = _rel(backup_path)
    _print_json(snapshot)


def _print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AIReceptionist desktop console helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    get_parser = subparsers.add_parser("get")
    get_parser.set_defaults(func=get_config)

    post_workspace_parser = subparsers.add_parser("post-workspace")
    post_workspace_parser.set_defaults(func=post_workspace)

    appointments_parser = subparsers.add_parser("appointments")
    appointments_parser.add_argument("--limit", type=int, default=25)
    appointments_parser.add_argument("--start-iso", default=None)
    appointments_parser.add_argument("--end-iso", default=None)
    appointments_parser.set_defaults(func=list_appointments)

    calendar_feed_parser = subparsers.add_parser(
        "calendar-feed",
        help="Sync configured calendars and return a safe appointment feed",
    )
    calendar_feed_parser.add_argument("--limit", type=int, default=250)
    calendar_feed_parser.add_argument("--now", default=None)
    calendar_feed_parser.set_defaults(func=calendar_feed)

    calendar_events_parser = subparsers.add_parser(
        "calendar-events",
        help="Fetch and cache calendar events without scheduling reminders",
    )
    calendar_events_parser.add_argument("--limit", type=int, default=250)
    calendar_events_parser.add_argument("--now", default=None)
    calendar_events_parser.add_argument("--start-iso", default=None)
    calendar_events_parser.add_argument("--end-iso", default=None)
    calendar_events_parser.set_defaults(func=calendar_events)

    reminders_sync_parser = subparsers.add_parser(
        "reminders-sync",
        help="Reconcile reminder jobs from the local calendar event cache",
    )
    reminders_sync_parser.add_argument("--limit", type=int, default=500)
    reminders_sync_parser.add_argument("--now", default=None)
    reminders_sync_parser.set_defaults(func=reminders_sync)

    rename_parser = subparsers.add_parser("appointment-rename")
    rename_parser.add_argument("--calendar-id", default="primary")
    rename_parser.add_argument("--event-id", required=True)
    rename_parser.add_argument("--summary", required=True)
    rename_parser.set_defaults(func=rename_appointment)

    delete_parser = subparsers.add_parser("appointment-delete")
    delete_parser.add_argument("--calendar-id", default="primary")
    delete_parser.add_argument("--event-id", required=True)
    delete_parser.set_defaults(func=delete_appointment)

    cancel_parser = subparsers.add_parser("appointment-cancel")
    cancel_parser.add_argument("--calendar-id", default="primary")
    cancel_parser.add_argument("--event-id", required=True)
    cancel_parser.add_argument("--confirmed", action="store_true")
    cancel_parser.set_defaults(func=cancel_appointment)

    reschedule_parser = subparsers.add_parser("appointment-reschedule")
    reschedule_parser.add_argument("--calendar-id", default="primary")
    reschedule_parser.add_argument("--event-id", required=True)
    reschedule_parser.add_argument("--new-start-iso", required=True)
    reschedule_parser.add_argument("--confirmed", action="store_true")
    reschedule_parser.set_defaults(func=reschedule_appointment)

    send_email_parser = subparsers.add_parser("send-email")
    send_email_parser.add_argument("--event-id", required=True)
    send_email_parser.add_argument("--event-uid", default="")
    send_email_parser.add_argument("--calendar-id", default="primary")
    send_email_parser.add_argument("--summary", default="Appointment")
    send_email_parser.add_argument("--start-iso", required=True)
    send_email_parser.add_argument("--end-iso", required=True)
    send_email_parser.add_argument("--timezone", required=True)
    send_email_parser.add_argument("--attendee-email", default="")
    send_email_parser.set_defaults(func=send_appointment_email)

    send_sms_parser = subparsers.add_parser("send-sms")
    send_sms_parser.add_argument("--event-id", required=True)
    send_sms_parser.add_argument("--event-uid", default="")
    send_sms_parser.add_argument("--calendar-id", default="primary")
    send_sms_parser.set_defaults(func=send_appointment_sms)

    reminder_status_parser = subparsers.add_parser(
        "reminder-status",
        help="Read persisted pre-appointment reminder send status",
    )
    reminder_status_parser.add_argument("--events-json", required=True)
    reminder_status_parser.set_defaults(func=get_reminder_status)

    email_get_parser = subparsers.add_parser("email-setup")
    email_get_parser.set_defaults(func=get_email_setup)

    email_update_parser = subparsers.add_parser("email-update")
    email_update_parser.add_argument("--from-address", default="")
    email_update_parser.add_argument("--smtp-username", default="")
    email_update_parser.add_argument("--smtp-password", default="")
    email_update_parser.set_defaults(func=update_email_setup)

    receptionist_update_parser = subparsers.add_parser("receptionist-update")
    receptionist_update_parser.add_argument("--payload", required=True)
    receptionist_update_parser.set_defaults(func=update_receptionist)

    update_parser = subparsers.add_parser("update")
    update_parser.add_argument("--mode", choices=["demo", "production"])
    update_parser.add_argument("--default-transfer-number", default="")
    update_parser.add_argument("--email-from", default="")
    update_parser.add_argument("--sms-from-number", default="")
    update_parser.add_argument("--confirmation-email-subject", default="")
    update_parser.add_argument("--confirmation-email-text", default="")
    update_parser.add_argument("--confirmation-sms", default="")
    update_parser.add_argument("--reminder-email-subject", default="")
    update_parser.add_argument("--reminder-email-text", default="")
    update_parser.add_argument("--reminder-sms", default="")
    update_parser.add_argument("--post-reminder-email-subject", default="")
    update_parser.add_argument("--post-reminder-email-text", default="")
    update_parser.add_argument("--post-reminder-email-html", default="")
    update_parser.add_argument("--post-reminder-sms", default="")
    update_parser.add_argument("--post-appointment-enabled", choices=["true", "false"], default="true")
    update_parser.add_argument("--post-appointment-offset-days", type=int, default=1)
    update_parser.add_argument("--post-followups-json", default="")
    update_parser.add_argument("--post-followup-templates-json", default="")
    update_parser.add_argument("--reminders-enabled", choices=["true", "false"], default=None)
    update_parser.add_argument("--reminder-offset-days-json", default="")
    update_parser.add_argument("--reminder-channels-json", default="")
    update_parser.add_argument("--quick-sms", default="")
    update_parser.add_argument("--quick-email", default="")
    update_parser.add_argument("--quick-call-script", default="")
    update_parser.add_argument("--message-email-subject", default="")
    update_parser.add_argument("--message-email-text", default="")
    update_parser.add_argument("--message-email-html", default="")
    update_parser.add_argument("--call-end-email-subject", default="")
    update_parser.add_argument("--call-end-email-text", default="")
    update_parser.add_argument("--call-end-email-html", default="")
    update_parser.add_argument("--booking-email-subject", default="")
    update_parser.add_argument("--booking-email-text", default="")
    update_parser.add_argument("--booking-email-html", default="")
    update_parser.set_defaults(func=update_config)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except AppointmentChangeError as exc:
        print(
            json.dumps(
                {"ok": False, "error_code": exc.code, "error": exc.user_message},
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
