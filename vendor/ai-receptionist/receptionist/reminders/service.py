from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

from receptionist.config import (
    BusinessConfig,
    FakeSMSProviderConfig,
    TwilioSMSProviderConfig,
)
from receptionist.reminders.contacts import (
    ContactResolver,
    load_contacts,
    upsert_booking_contact,
    upsert_calendar_event_contact,
)
from receptionist.reminders.delivery import (
    FakeLog,
    ReminderDispatcher,
    TwilioSMSSender,
    build_email_sender,
)
from receptionist.reminders.identity import normalize_email, normalize_emails
from receptionist.reminders.models import AppointmentEvent, ReminderRecipient
from receptionist.reminders.phone import extract_phone, normalize_us_phone
from receptionist.reminders.scheduler import (
    schedule_event_confirmations,
    schedule_event_reminders,
)
from receptionist.reminders.store import ReminderStore
from receptionist.reminders.templates import build_reminder_email, build_reminder_sms

logger = logging.getLogger("receptionist")


def ensure_booking_reminders(
    *,
    config: BusinessConfig,
    event_id: str,
    start_iso: str,
    end_iso: str,
    caller_name: str | None = None,
    callback_number: str | None = None,
    caller_email: str | None = None,
    sms_consent_opted_in: bool = False,
) -> list[str]:
    """Idempotently ensure reminder jobs after a successful AI booking.

    This function is deliberately sync so the agent can call it after calendar
    creation without changing the lower-level calendar booking function.
    """
    if not config.reminders.enabled:
        return []
    if config.calendar is None:
        return []
    if callback_number:
        callback_number = normalize_us_phone(callback_number)
        if callback_number is None:
            raise ValueError("booking reminders require a valid US callback phone number")
    if caller_name and callback_number:
        upsert_booking_contact(
            config.reminders.contacts_path,
            event_id=event_id,
            caller_name=caller_name,
            callback_number=callback_number,
            caller_email=caller_email,
            sms_consent_status="opted_in",
            consent_source=(
                "demo_ai_booking"
                if config.mode == "demo"
                else "ai_booking_sms_opt_in"
                if sms_consent_opted_in
                else "default_sms_campaign"
            ),
            consent_timestamp=datetime.now().astimezone().isoformat(),
        )
    event = _booking_event(
        config=config,
        event_id=event_id,
        start_iso=start_iso,
        end_iso=end_iso,
        caller_name=caller_name,
        callback_number=callback_number,
        caller_email=caller_email,
    )
    contacts = load_contacts(config.reminders.contacts_path)
    store = ReminderStore(config.reminders.store_path)
    keys = schedule_event_reminders(
        config=config,
        store=store,
        event=event,
        resolver=ContactResolver(contacts),
    )
    keys.extend(
        schedule_event_reminders(
            config=config,
            store=store,
            event=event,
            resolver=ContactResolver(contacts),
            phase="post",
        )
    )
    logger.info(
        "booking reminders ensured: %d jobs for event %s",
        len(keys),
        event_id,
        extra={"component": "reminders.booking"},
    )
    return keys


async def send_booking_confirmation(
    *,
    config: BusinessConfig,
    event_id: str,
    start_iso: str,
    end_iso: str,
    caller_name: str | None = None,
    callback_number: str | None = None,
    caller_email: str | None = None,
    sms_consent_opted_in: bool = False,
) -> int:
    """Idempotently send immediate confirmation email/SMS after booking.

    Confirmations use the same structured contact and SMS consent model as
    reminders. The caller email is only used as a contact match key; SMS is
    never sent unless the matched structured contact is opted in.
    """
    if not config.reminders.enabled:
        return 0
    if config.calendar is None:
        return 0
    if callback_number:
        callback_number = normalize_us_phone(callback_number)
        if callback_number is None:
            raise ValueError("booking confirmation requires a valid US callback phone number")
    if caller_name and callback_number:
        upsert_booking_contact(
            config.reminders.contacts_path,
            event_id=event_id,
            caller_name=caller_name,
            callback_number=callback_number,
            caller_email=caller_email,
            sms_consent_status="opted_in",
            consent_source=(
                "demo_ai_booking"
                if config.mode == "demo"
                else "ai_booking_sms_opt_in"
                if sms_consent_opted_in
                else "default_sms_campaign"
            ),
            consent_timestamp=datetime.now().astimezone().isoformat(),
        )
    event = _booking_event(
        config=config,
        event_id=event_id,
        start_iso=start_iso,
        end_iso=end_iso,
        caller_name=caller_name,
        callback_number=callback_number,
        caller_email=caller_email,
    )
    contacts = load_contacts(config.reminders.contacts_path)
    store = ReminderStore(config.reminders.store_path)
    keys = schedule_event_confirmations(
        config=config,
        store=store,
        event=event,
        resolver=ContactResolver(contacts),
    )
    sent = await ReminderDispatcher(config, store).dispatch_due(
        now_iso=datetime.now(timezone.utc).isoformat(),
        limit=max(len(keys), 1),
        idempotency_keys=set(keys),
    )
    logger.info(
        "booking confirmations dispatched: %d sends for event %s",
        sent,
        event_id,
        extra={"component": "reminders.confirmation"},
    )
    return sent


def _booking_match_keys(
    event_id: str, caller_email: str | None, callback_number: str | None
) -> tuple[str, ...]:
    keys = [event_id.strip().lower()]
    if caller_email:
        keys.append(caller_email.strip().lower())
    if callback_number:
        keys.append(callback_number.strip().lower())
    return tuple(dict.fromkeys(k for k in keys if k))


def _booking_event(
    *,
    config: BusinessConfig,
    event_id: str,
    start_iso: str,
    end_iso: str,
    caller_name: str | None,
    callback_number: str | None,
    caller_email: str | None,
) -> AppointmentEvent:
    display_name = (caller_name or "").strip() or "Caller"
    callback = (callback_number or "").strip()
    raw_email = (caller_email or "").strip().lower()
    email = normalize_email(raw_email)
    attendee_emails = normalize_emails((raw_email,))
    notes = "\n".join(
        (
            "[via AI receptionist / UNVERIFIED]",
            f"Patient: {display_name}",
            f"Phone: {callback or '(none)'}",
            f"Email: {email or '(none)'}",
        )
    )
    return AppointmentEvent(
        source="google",
        calendar_id=config.calendar.calendar_id,
        event_id=event_id,
        event_uid=event_id,
        summary=f"Appointment: {display_name}",
        notes=notes,
        start=datetime.fromisoformat(start_iso),
        end=datetime.fromisoformat(end_iso),
        timezone=config.business.timezone,
        attendee_emails=attendee_emails,
        contact_match_keys=_booking_match_keys(event_id, raw_email, callback),
    )


async def send_appointment_email(
    *,
    config: BusinessConfig,
    event: AppointmentEvent,
    attendee_email: str,
    registry_recipient: ReminderRecipient | None = None,
) -> dict[str, str]:
    """Send one manual email using the reminder template fields.

    This is the desktop one-off action: it does not schedule a reminder job.
    It reuses the configured email sender and the reminder subject/body
    template fields so operators get the same copy they would expect from the
    automated reminder path.
    """
    email = normalize_email(registry_recipient.email if registry_recipient is not None else attendee_email)
    if email is None:
        raise ValueError("appointment email requires a valid attendee email")
    if config.email is None:
        raise RuntimeError("email configuration is required to send appointment email")
    if config.email.from_ is None:
        raise RuntimeError("email.from is required to send appointment email")

    recipient = registry_recipient or _manual_email_recipient(config, email)
    subject, body_text, body_html = build_reminder_email(config, event, recipient, 0)
    sender = build_email_sender(config)
    await sender.send(
        from_=config.email.from_,
        to=[recipient.email or email],
        subject=subject,
        body_text=body_text,
        body_html=body_html,
    )
    logger.info(
        "manual appointment email sent",
        extra={"component": "desktop.email", "recipient": recipient.email or email, "event_id": event.event_id},
    )
    return {
        "recipient_email": recipient.email or email,
        "recipient_name": recipient.display_name,
        "subject": subject,
    }


def _appointment_contact_match_keys(event: AppointmentEvent) -> tuple[str, ...]:
    event_keys = (
        event.event_id,
        event.event_uid,
        f"{event.calendar_id}:{event.event_id}",
        f"{event.calendar_id}:{event.event_uid}",
        event.contact_email or "",
    )
    return tuple(
        dict.fromkeys((*event_keys, *event.contact_match_keys, *event.attendee_emails))
    )


async def send_appointment_sms(
    *,
    config: BusinessConfig,
    event: AppointmentEvent,
    registry_recipient: ReminderRecipient | None = None,
) -> dict[str, str]:
    """Send one manual appointment reminder SMS after consent validation."""
    contacts = load_contacts(config.reminders.contacts_path) if registry_recipient is None else []
    recipient = registry_recipient or ContactResolver(contacts).match_event(
        _appointment_contact_match_keys(event)
    )
    extracted = extract_phone(event.notes) if registry_recipient is None else None
    if extracted is None:
        class _NoPhoneExtraction:
            ambiguous = False
            label_present = False
            phone = None

        extracted = _NoPhoneExtraction()
    if extracted.ambiguous:
        raise ValueError(
            "appointment SMS phone number is ambiguous; label the intended number"
        )
    if extracted.label_present and not extracted.phone:
        raise ValueError(
            "appointment SMS phone number is malformed or missing after its label"
        )
    if (
        recipient is not None
        and str(recipient.phone_source or "").startswith("calendar_description:")
        and not extracted.phone
    ):
        raise ValueError(
            "appointment SMS phone is stale because the event description no longer contains a valid number; sync the calendar"
        )
    recipient_phone = normalize_us_phone(recipient.phone) if recipient else None
    # A valid number in the current description is authoritative. This also
    # repairs a stale event-linked contact after staff edits the description.
    if extracted.phone and extracted.phone != recipient_phone:
        recipient = upsert_calendar_event_contact(
            config.reminders.contacts_path,
            calendar_id=event.calendar_id,
            event_id=event.event_id,
            event_uid=event.event_uid,
            display_name=event.summary,
            email=event.contact_email or (event.attendee_emails[0] if event.attendee_emails else None),
            phone=extracted.phone,
            phone_source=extracted.source,
        )
        recipient_phone = normalize_us_phone(recipient.phone)
    elif recipient is None:
        raise ValueError(
            "appointment SMS requires a matching contact or an unambiguous phone number in the event description"
        )
    if recipient is None:
        raise ValueError("appointment SMS requires a matching contact with a phone number")
    if recipient.suppressed:
        raise ValueError("appointment SMS recipient is suppressed")
    if "sms" not in recipient.preferred_channels:
        raise ValueError("appointment SMS recipient does not allow SMS")
    recipient_phone = normalize_us_phone(recipient.phone)
    if recipient_phone is None:
        raise ValueError("appointment SMS recipient has no valid US phone number")
    if recipient.sms_consent_status != "opted_in":
        raise ValueError("appointment SMS requires an opted-in recipient")

    body = build_reminder_sms(config, event, offset_days=1, recipient=recipient)
    provider = config.sms.provider
    if isinstance(provider, TwilioSMSProviderConfig):
        await TwilioSMSSender(provider).send(to=recipient_phone, body=body)
    elif isinstance(provider, FakeSMSProviderConfig):
        await FakeLog(provider.log_path).write(
            {
                "channel": "sms",
                "to": recipient_phone,
                "body": body,
                "manual": True,
                "event_id": event.event_id,
            }
        )
    else:
        raise RuntimeError(f"unsupported sms provider: {provider.type}")
    return {
        "recipient_name": recipient.display_name,
        "recipient_phone": recipient_phone,
    }


def _manual_email_recipient(config: BusinessConfig, attendee_email: str):
    contacts = load_contacts(config.reminders.contacts_path)
    recipient = ContactResolver(contacts).match_event([attendee_email])
    if recipient is not None:
        return recipient
    display_name = _email_to_display_name(attendee_email)
    return ReminderRecipient(
        recipient_id=f"manual-{_slug(attendee_email)}",
        display_name=display_name,
        email=attendee_email,
        preferred_channels=("email",),
        match_keys=(attendee_email.strip().lower(),),
    )


def _email_to_display_name(attendee_email: str) -> str:
    local = attendee_email.split("@", 1)[0].strip()
    if not local:
        return attendee_email
    local = local.split("+", 1)[0]
    normalized = re.sub(r"[^A-Za-z0-9]+", " ", local)
    normalized = re.sub(r"([a-z])([A-Z])", r"\1 \2", normalized)
    normalized = re.sub(r"([A-Za-z])([0-9])", r"\1 \2", normalized)
    normalized = re.sub(r"([0-9])([A-Za-z])", r"\1 \2", normalized)
    parts = [part for part in normalized.split() if part]
    if len(parts) == 1 and parts[0].isalpha() and parts[0].islower() and len(parts[0]) >= 6:
        token = parts[0]
        split_at = _best_plain_name_split(token)
        if split_at:
            parts = [token[:split_at], token[split_at:]]
    display_name = " ".join(part.capitalize() for part in parts if part).strip()
    return display_name or attendee_email


def _best_plain_name_split(token: str) -> int | None:
    if len(token) < 6:
        return None
    vowels = set("aeiou")
    midpoint = len(token) / 2.0
    best_index: int | None = None
    best_score = float("-inf")
    for i in range(3, len(token) - 2):
        score = -abs(i - midpoint)
        if token[i - 1] in vowels:
            score += 1.0
        if token[i] not in vowels:
            score += 1.0
        if i in (4, 5, 6, 7):
            score += 0.25
        if score >= best_score:
            best_score = score
            best_index = i
    return best_index


def _slug(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-") or "email"
