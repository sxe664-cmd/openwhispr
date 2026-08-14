from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from receptionist.reminders.identity import normalize_contact_keys, normalize_emails
from receptionist.reminders.models import AppointmentEvent


def import_ics(
    path: str | Path,
    *,
    calendar_id: str = "apple-ics",
    timezone_name: str,
) -> list[AppointmentEvent]:
    """Import a bounded Apple Calendar first-slice `.ics` file.

    This intentionally handles fixture-friendly VEVENT data without becoming a
    full CalDAV/CardDAV implementation.
    """
    text = Path(path).read_text(encoding="utf-8")
    events: list[AppointmentEvent] = []
    for block in text.split("BEGIN:VEVENT")[1:]:
        body = block.split("END:VEVENT", 1)[0]
        fields = _parse_fields(body)
        uid = fields.get("UID") or fields.get("SUMMARY") or f"event-{len(events)+1}"
        start = _parse_ics_dt(fields.get("DTSTART"), timezone_name)
        end = _parse_ics_dt(fields.get("DTEND"), timezone_name)
        if start is None or end is None:
            continue
        raw_attendees = tuple(
            value.removeprefix("mailto:")
            for key, value in fields.items()
            if key.startswith("ATTENDEE")
        )
        attendees = normalize_emails(raw_attendees)
        events.append(
            AppointmentEvent(
                source="apple_ics",
                calendar_id=calendar_id,
                event_id=uid,
                event_uid=uid,
                summary=fields.get("SUMMARY") or "Appointment",
                start=start,
                end=end,
                timezone=timezone_name,
                attendee_emails=attendees,
                contact_match_keys=normalize_contact_keys(raw_attendees),
                cancelled=fields.get("STATUS") == "CANCELLED",
                recurring="RRULE" in fields,
            )
        )
    return events


def _parse_fields(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    current_key: str | None = None
    for raw in body.replace("\r\n", "\n").splitlines():
        if raw.startswith((" ", "\t")) and current_key:
            fields[current_key] += raw.strip()
            continue
        if ":" not in raw:
            continue
        key, value = raw.split(":", 1)
        key = key.split(";", 1)[0].upper()
        current_key = key
        if key in fields and key == "ATTENDEE":
            key = f"ATTENDEE{len([k for k in fields if k.startswith('ATTENDEE')]) + 1}"
            current_key = key
        fields[key] = value.strip()
    return fields


def _parse_ics_dt(value: str | None, timezone_name: str) -> datetime | None:
    if not value:
        return None
    tz = ZoneInfo(timezone_name)
    if value.endswith("Z"):
        return datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    if "T" in value:
        return datetime.strptime(value, "%Y%m%dT%H%M%S").replace(tzinfo=tz)
    return datetime.strptime(value, "%Y%m%d").replace(tzinfo=tz)
