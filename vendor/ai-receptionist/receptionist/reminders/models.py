from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

ReminderChannel = Literal["email", "sms"]
ReminderPhase = Literal["confirmation", "pre", "post"]
ReminderStatus = Literal["scheduled", "claimed", "sent", "failed", "skipped", "cancelled", "suppressed"]


@dataclass(frozen=True)
class AppointmentEvent:
    source: str
    calendar_id: str
    event_id: str
    event_uid: str
    summary: str
    start: datetime
    end: datetime
    timezone: str
    notes: str = ""
    attendee_emails: tuple[str, ...] = ()
    contact_match_keys: tuple[str, ...] = ()
    contact_email: str | None = None
    contact_email_source: str | None = None
    contact_email_recovered_at: str | None = None
    cancelled: bool = False
    recurring: bool = False
    etag: str | None = None
    html_link: str | None = None
    conference_url: str | None = None
    recurring_event_id: str | None = None
    original_start_time: str | None = None
    all_day: bool = False
    status: str = "confirmed"
    # Managed appointments carry these opaque IDs in Google private
    # extendedProperties. They are never inferred from title/description.
    patient_id: str | None = None
    appointment_id: str | None = None

    @property
    def event_key(self) -> str:
        return self.event_uid or self.event_id


@dataclass(frozen=True)
class CalendarEventTombstone:
    source: str
    calendar_id: str
    event_id: str


@dataclass(frozen=True)
class CalendarSyncBatch:
    events: tuple[AppointmentEvent, ...] = ()
    tombstones: tuple[CalendarEventTombstone, ...] = ()


@dataclass(frozen=True)
class ReminderRecipient:
    recipient_id: str
    display_name: str
    email: str | None = None
    phone: str | None = None
    preferred_channels: tuple[ReminderChannel, ...] = ("email", "sms")
    sms_consent_status: Literal["unknown", "opted_in", "opted_out"] = "unknown"
    consent_source: str | None = None
    consent_timestamp: str | None = None
    phone_source: str | None = None
    suppressed: bool = False
    match_keys: tuple[str, ...] = ()


@dataclass(frozen=True)
class ReminderJob:
    id: int | None
    idempotency_key: str
    source: str
    calendar_id: str
    event_id: str
    event_uid: str
    event_start: str
    event_end: str
    event_timezone: str
    recipient_id: str | None
    channel: ReminderChannel
    offset_days: int
    due_at: str
    status: ReminderStatus
    reason: str | None = None
    claimed_at: str | None = None
    event_summary: str = "Appointment"
    phase: ReminderPhase = "pre"
    post_followup_id: str | None = None
