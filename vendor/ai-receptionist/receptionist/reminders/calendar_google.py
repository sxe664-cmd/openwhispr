from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from receptionist.booking.client import GoogleCalendarClient
from receptionist.reminders.identity import (
    RECOVERED_CONTACT_SOURCE,
    extract_structured_email,
    normalize_contact_keys,
    normalize_emails,
)
from receptionist.reminders.models import (
    AppointmentEvent,
    CalendarEventTombstone,
    CalendarSyncBatch,
)

logger = logging.getLogger("receptionist")
_MAX_RESULTS_PER_PAGE = 2500


def _safe_conference_url(value: object) -> str | None:
    """Allow only direct, structured HTTPS meeting URLs from Google event data."""
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = value.strip()
    try:
        parsed = urlparse(candidate)
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

    host = parsed.hostname.lower()
    path = parsed.path or "/"
    is_zoom = (host == "zoom.us" or host.endswith(".zoom.us")) and path.startswith("/j/")
    is_google_meet = host == "meet.google.com"
    is_teams = (
        (host == "teams.microsoft.com" and path.startswith("/l/meetup-join"))
        or (host == "teams.live.com" and path.startswith("/meet/"))
    )
    is_webex = host.endswith(".webex.com")
    is_chime = host == "chime.aws"
    return candidate if is_zoom or is_google_meet or is_teams or is_webex or is_chime else None


def _conference_url_from_google(item: dict) -> str | None:
    """Read only Google structured conferencing fields, never free-form event text."""
    direct = _safe_conference_url(item.get("hangoutLink"))
    if direct:
        return direct
    conference_data = item.get("conferenceData")
    if not isinstance(conference_data, dict):
        return None
    entry_points = conference_data.get("entryPoints")
    if not isinstance(entry_points, list):
        return None
    for entry_point in entry_points:
        if not isinstance(entry_point, dict) or entry_point.get("entryPointType") != "video":
            continue
        direct = _safe_conference_url(entry_point.get("uri"))
        if direct:
            return direct
    return None


async def list_google_event_batch(
    client: GoogleCalendarClient,
    *,
    calendar_id: str,
    time_min: datetime,
    time_max: datetime,
    timezone_name: str,
) -> CalendarSyncBatch:
    """List Google Calendar changes and normalize active events plus deletions."""
    service = client._service  # existing client owns the Google service wrapper

    def _execute(page_token: str | None):
        query = {
            "calendarId": calendar_id,
            "timeMin": time_min.isoformat(),
            "timeMax": time_max.isoformat(),
            "singleEvents": True,
            "orderBy": "startTime",
            "maxResults": _MAX_RESULTS_PER_PAGE,
            "showHiddenInvitations": True,
            "showDeleted": True,
        }
        if page_token:
            query["pageToken"] = page_token
        return service.events().list(**query).execute()

    page_count = 0
    raw_items: list[dict] = []
    page_token: str | None = None
    while True:
        response = await asyncio.to_thread(_execute, page_token)
        page_count += 1
        raw_items.extend(response.get("items", []))
        page_token = response.get("nextPageToken")
        if not page_token:
            break

    batch = normalize_google_batch(
        raw_items,
        calendar_id=calendar_id,
        timezone_name=timezone_name,
    )
    sample = [
        {"id": item.get("id", ""), "start": _start_value(item)}
        for item in raw_items[:5]
    ]
    logger.info(
        "reminders.google_sync calendar_id=%s time_min=%s time_max=%s pages=%d raw_items=%d normalized_events=%d tombstones=%d sample=%s",
        calendar_id,
        time_min.isoformat(),
        time_max.isoformat(),
        page_count,
        len(raw_items),
        len(batch.events),
        len(batch.tombstones),
        sample,
    )
    return batch


async def list_google_events(
    client: GoogleCalendarClient,
    *,
    calendar_id: str,
    time_min: datetime,
    time_max: datetime,
    timezone_name: str,
) -> list[AppointmentEvent]:
    """Compatibility wrapper returning only active event instances."""
    batch = await list_google_event_batch(
        client,
        calendar_id=calendar_id,
        time_min=time_min,
        time_max=time_max,
        timezone_name=timezone_name,
    )
    return list(batch.events)


def normalize_google_items(
    items: list[dict],
    *,
    calendar_id: str,
    timezone_name: str,
) -> list[AppointmentEvent]:
    """Compatibility wrapper returning only active normalized events."""
    return list(
        normalize_google_batch(
            items,
            calendar_id=calendar_id,
            timezone_name=timezone_name,
        ).events
    )


def normalize_google_batch(
    items: list[dict],
    *,
    calendar_id: str,
    timezone_name: str,
) -> CalendarSyncBatch:
    events: list[AppointmentEvent] = []
    tombstones: list[CalendarEventTombstone] = []
    for item in items:
        if item.get("status") == "cancelled":
            event_id = str(item.get("id") or "").strip()
            if event_id:
                tombstones.append(
                    CalendarEventTombstone(
                        source="google",
                        calendar_id=calendar_id,
                        event_id=event_id,
                    )
                )
            else:
                logger.warning("reminders.google_sync dropped cancellation without id")
            continue
        try:
            events.append(
                event_from_google(
                    item,
                    calendar_id=calendar_id,
                    timezone_name=timezone_name,
                )
            )
        except Exception as exc:
            logger.warning(
                "reminders.google_sync dropped event id=%s start=%s reason=%s",
                item.get("id", ""),
                _start_value(item),
                exc,
            )
    return CalendarSyncBatch(events=tuple(events), tombstones=tuple(tombstones))


def event_from_google(
    item: dict,
    *,
    calendar_id: str,
    timezone_name: str,
) -> AppointmentEvent:
    tz = ZoneInfo(timezone_name)
    start_raw = item.get("start", {}).get("dateTime") or item.get("start", {}).get("date")
    end_raw = item.get("end", {}).get("dateTime") or item.get("end", {}).get("date")
    if start_raw is None or end_raw is None:
        raise ValueError("Google event missing start/end")
    start = _parse_google_dt(start_raw, tz)
    end = _parse_google_dt(end_raw, tz)
    has_self_attendee = _self_attendee_presence(item)
    attendee_records = item.get("attendees")
    if not isinstance(attendee_records, list):
        attendee_records = ()
    raw_attendees = tuple(
        attendee.get("email")
        for attendee in attendee_records
        if isinstance(attendee, dict) and attendee.get("self") is not True
    )
    attendees = normalize_emails(raw_attendees)
    recovered_email = extract_structured_email(item.get("description") or "")
    return AppointmentEvent(
        source="google",
        calendar_id=calendar_id,
        event_id=item.get("id", ""),
        event_uid=item.get("iCalUID") or item.get("id", ""),
        summary=item.get("summary") or "Appointment",
        notes=(item.get("description") or "").strip(),
        start=start,
        end=end,
        timezone=item.get("start", {}).get("timeZone") or timezone_name,
        attendee_emails=attendees,
        contact_match_keys=normalize_contact_keys(raw_attendees),
        has_self_attendee=has_self_attendee,
        contact_email=recovered_email,
        contact_email_source=RECOVERED_CONTACT_SOURCE if recovered_email else None,
        cancelled=item.get("status") == "cancelled",
        recurring=bool(item.get("recurringEventId") or item.get("recurrence")),
        etag=item.get("etag"),
        html_link=item.get("htmlLink"),
        conference_url=_conference_url_from_google(item),
        recurring_event_id=item.get("recurringEventId"),
        original_start_time=(
            item.get("originalStartTime", {}).get("dateTime")
            or item.get("originalStartTime", {}).get("date")
        ) if item.get("originalStartTime") else None,
        all_day="dateTime" not in item.get("start", {}),
        status=item.get("status") or "confirmed",
    )


def _self_attendee_presence(item: dict) -> bool | None:
    """Return private Google self-attendee provenance without inferring it."""
    attendees = item.get("attendees")
    if not isinstance(attendees, list):
        return None

    has_self_attendee = False
    for attendee in attendees:
        if not isinstance(attendee, dict):
            return None
        if "self" not in attendee:
            continue
        is_self = attendee["self"]
        if type(is_self) is not bool:
            return None
        if is_self is True:
            has_self_attendee = True
    return has_self_attendee


def _start_value(item: dict) -> str:
    start = item.get("start", {})
    return str(start.get("dateTime") or start.get("date") or "")


def _parse_google_dt(value: str, tz: ZoneInfo) -> datetime:
    if "T" not in value:
        return datetime.fromisoformat(value).replace(tzinfo=tz)
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
