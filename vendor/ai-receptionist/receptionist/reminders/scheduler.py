from __future__ import annotations

from datetime import datetime, timedelta, timezone
import logging
from typing import Iterable
from zoneinfo import ZoneInfo

from receptionist.config import BusinessConfig
from receptionist.reminders.contacts import (
    ContactResolver,
    invalidate_calendar_event_contact,
    upsert_calendar_event_contact,
)
from receptionist.reminders.phone import extract_phone, normalize_us_phone
from receptionist.reminders.models import (
    AppointmentEvent,
    CalendarEventTombstone,
    ReminderRecipient,
)
from receptionist.reminders.store import ReminderStore


logger = logging.getLogger("receptionist")


def parse_now(now: str | None, tz_name: str) -> datetime:
    if now:
        dt = datetime.fromisoformat(now.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=ZoneInfo(tz_name))
        return dt
    return datetime.now(ZoneInfo(tz_name))


def due_at_for(event: AppointmentEvent, offset_days: int, phase: str = "pre") -> datetime:
    anchor = event.end if phase == "post" else event.start
    due = anchor - timedelta(days=offset_days) if phase == "pre" else anchor + timedelta(days=offset_days)
    if due.tzinfo is None:
        due = due.replace(tzinfo=ZoneInfo(event.timezone))
    return due.astimezone(timezone.utc)


def schedule_event_reminders(
    *,
    config: BusinessConfig,
    store: ReminderStore,
    event: AppointmentEvent,
    resolver: ContactResolver,
    now: datetime | None = None,
    phase: str = "pre",
    post_followup_id: str | None = None,
) -> list[str]:
    """Create/update reminder jobs for one event.

    Events are appointments only; recipients and SMS consent come from the
    structured resolver. Missing data becomes skipped/suppressed jobs rather
    than guessed sends.
    """
    if not config.reminders.enabled:
        return []
    if phase == "post" and not config.reminders.post_appointment.enabled:
        return []
    now = now or datetime.now(ZoneInfo(config.business.timezone))
    if now.tzinfo is None:
        now = now.replace(tzinfo=ZoneInfo(config.business.timezone))

    event = store.upsert_event(event)
    if event.cancelled:
        store.cancel_jobs_for_event(event, "event_cancelled")
        return []

    recipient = resolver.match_event(_contact_match_keys(event))
    if recipient is not None:
        store.import_recipients([recipient])
    keys: list[str] = []
    if phase == "post":
        follow_ups = [
            item for item in (config.reminders.post_appointment.follow_ups or [])
            if item.enabled and (post_followup_id is None or item.preset == post_followup_id)
        ]
        if post_followup_id and not follow_ups:
            return []
        schedule_items = [
            (item.offset_days_after, item.channels, item.preset)
            for item in follow_ups
        ]
    else:
        schedule_items = [
            (offset, config.reminders.channels, "")
            for offset in config.reminders.offset_days
        ]
    for offset, channels, followup_id in schedule_items:
        due = due_at_for(event, offset, phase)
        for channel in channels:
            status, reason = _delivery_status(config, recipient, channel)
            if due < now.astimezone(timezone.utc) and not config.reminders.allow_retroactive_send:
                status = "skipped"
                reason = "missed_due_time"
            keys.append(
                store.upsert_job(
                    event=event,
                    recipient=recipient,
                    channel=channel,
                    offset_days=offset,
                    due_at=due.isoformat(),
                    status=status,
                    reason=reason,
                    phase=phase,
                    post_followup_id=followup_id or None,
                )
            )
    return keys


def schedule_event_confirmations(
    *,
    config: BusinessConfig,
    store: ReminderStore,
    event: AppointmentEvent,
    resolver: ContactResolver,
    now: datetime | None = None,
) -> list[str]:
    """Create/update immediate confirmation jobs for one booked appointment.

    Confirmation jobs use offset_days=0 so they share the existing reminder
    ledger/idempotency/dispatch path without colliding with T-4/T-1 reminders.
    Recipient and SMS consent rules are identical to reminders.
    """
    if not config.reminders.enabled:
        return []
    now = now or datetime.now(ZoneInfo(config.business.timezone))
    if now.tzinfo is None:
        now = now.replace(tzinfo=ZoneInfo(config.business.timezone))

    event = store.upsert_event(event)
    if event.cancelled:
        store.cancel_jobs_for_event(event, "event_cancelled")
        return []

    recipient = resolver.match_event(_contact_match_keys(event))
    if recipient is not None:
        store.import_recipients([recipient])

    keys: list[str] = []
    due = now.astimezone(timezone.utc)
    for channel in config.reminders.channels:
        status, reason = _delivery_status(config, recipient, channel)
        keys.append(
            store.upsert_job(
                event=event,
                recipient=recipient,
                channel=channel,
                offset_days=0,
                due_at=due.isoformat(),
                status=status,
                reason=reason,
                phase="confirmation",
            )
        )
    return keys


def sync_events(
    *,
    config: BusinessConfig,
    store: ReminderStore,
    events: Iterable[AppointmentEvent],
    contacts: list[ReminderRecipient],
    now: datetime | None = None,
    tombstones: Iterable[CalendarEventTombstone] = (),
) -> int:
    for tombstone in tombstones:
        store.cancel_event(
            source=tombstone.source,
            calendar_id=tombstone.calendar_id,
            event_id=tombstone.event_id,
            reason="provider_deleted",
        )

    resolver = ContactResolver(contacts)
    count = 0
    for event in events:
        extracted = extract_phone(event.notes)
        if extracted.ambiguous:
            logger.warning(
                "reminders.phone_parse ambiguous event_id=%s candidates=%s",
                event.event_id,
                ",".join(extracted.candidates),
            )
            invalidated = invalidate_calendar_event_contact(
                config.reminders.contacts_path,
                calendar_id=event.calendar_id,
                event_id=event.event_id,
                event_uid=event.event_uid,
                phone_source="ambiguous",
            )
            if invalidated:
                contacts = [
                    candidate for candidate in contacts
                    if candidate.recipient_id != invalidated.recipient_id
                ] + [invalidated]
                resolver = ContactResolver(contacts)
        elif extracted.phone:
            contact = upsert_calendar_event_contact(
                config.reminders.contacts_path,
                calendar_id=event.calendar_id,
                event_id=event.event_id,
                event_uid=event.event_uid,
                display_name=event.summary,
                email=event.contact_email or (event.attendee_emails[0] if event.attendee_emails else None),
                phone=extracted.phone,
                phone_source=extracted.source,
            )
            contacts = [
                candidate
                for candidate in contacts
                if candidate.recipient_id != contact.recipient_id
            ]
            contacts.append(contact)
            resolver = ContactResolver(contacts)
        else:
            invalidated = invalidate_calendar_event_contact(
                config.reminders.contacts_path,
                calendar_id=event.calendar_id,
                event_id=event.event_id,
                event_uid=event.event_uid,
                phone_source="missing",
            )
            if invalidated:
                contacts = [
                    candidate for candidate in contacts
                    if candidate.recipient_id != invalidated.recipient_id
                ] + [invalidated]
                resolver = ContactResolver(contacts)
        schedule_event_reminders(
            config=config,
            store=store,
            event=event,
            resolver=resolver,
            now=now,
        )
        schedule_event_reminders(
            config=config,
            store=store,
            event=event,
            resolver=resolver,
            now=now,
            phase="post",
        )
        count += 1
    return count


def _contact_match_keys(event: AppointmentEvent) -> tuple[str, ...]:
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

def _delivery_status(
    config: BusinessConfig, recipient: ReminderRecipient | None, channel: str
) -> tuple[str, str | None]:
    if recipient is None:
        return "skipped", "missing_recipient"
    if recipient.suppressed:
        return "suppressed", "recipient_suppressed"
    if channel not in recipient.preferred_channels:
        return "skipped", "channel_not_preferred"
    if channel == "email":
        if not recipient.email:
            return "skipped", "missing_email"
        return "scheduled", None
    if channel == "sms":
        if not normalize_us_phone(recipient.phone):
            return "skipped", "invalid_phone" if recipient.phone else "missing_phone"
        if recipient.sms_consent_status != "opted_in":
            return "suppressed", "sms_not_opted_in"
        return "scheduled", None
    return "skipped", "unsupported_channel"
