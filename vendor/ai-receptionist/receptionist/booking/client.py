# receptionist/booking/client.py
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

import httplib2
from googleapiclient.discovery import build
from google_auth_httplib2 import AuthorizedHttp

logger = logging.getLogger("receptionist")
_GOOGLE_API_TIMEOUT_SECONDS = 15.0


class GoogleCalendarClient:
    """Thin async wrapper over google-api-python-client's Calendar v3 service.

    All Google API calls are synchronous in google-api-python-client, so we
    wrap them in asyncio.to_thread to keep the event loop unblocked during
    calls.
    """

    def __init__(self, credentials, calendar_id: str) -> None:
        self.credentials = credentials
        self.calendar_id = calendar_id
        # cache_discovery=False is the documented pattern; avoids noisy
        # warnings about oauth2client absence in production.
        # Use an explicit transport timeout. The default httplib2 transport can
        # otherwise leave a desktop feed process waiting indefinitely when a
        # network path or Google endpoint stops responding.
        http = AuthorizedHttp(
            credentials,
            http=httplib2.Http(timeout=_GOOGLE_API_TIMEOUT_SECONDS),
        )
        self._service = build("calendar", "v3", http=http, cache_discovery=False)

    async def free_busy(
        self, time_min: datetime, time_max: datetime
    ) -> list[tuple[datetime, datetime]]:
        """Query free/busy. Returns list of (start, end) tuples of busy intervals.

        time_min / time_max must be timezone-aware datetime objects.
        Returned datetimes preserve the timezone from Google's RFC 3339 response
        (typically UTC when the response uses the 'Z' suffix).
        """
        body = {
            "timeMin": time_min.isoformat(),
            "timeMax": time_max.isoformat(),
            "items": [{"id": self.calendar_id}],
        }
        response = await asyncio.wait_for(
            asyncio.to_thread(lambda: self._service.freebusy().query(body=body).execute()),
            timeout=_GOOGLE_API_TIMEOUT_SECONDS,
        )
        busy_raw = response.get("calendars", {}).get(self.calendar_id, {}).get("busy", [])
        return [
            (_parse_rfc3339(b["start"]), _parse_rfc3339(b["end"]))
            for b in busy_raw
        ]

    async def create_event(
        self,
        *,
        start: datetime,
        end: datetime,
        summary: str,
        description: str,
        time_zone: str,
        location: str | None = None,
        attendee_email: str | None = None,
        patient_id: str | None = None,
        appointment_id: str | None = None,
        source: str = "ai_receptionist",
        private_extended_properties: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Create a calendar event. Returns {id, htmlLink, ...}.

        `time_zone` is an IANA zone string (e.g. "America/New_York"). The start/end
        datetimes are rendered as wall-clock times in that zone in the request body
        so Google honors the configured timezone semantics.

        When `attendee_email` is given, the caller is added as an OPTIONAL attendee
        and Google sends them the standard calendar invitation (with .ics, accept/
        decline, "Add to my calendar"). Optional attendees do not affect the
        organizer's busy view if they decline. When None, no email is sent
        (sendUpdates="none").
        """
        body = {
            "summary": summary,
            "description": description,
            "start": {
                "dateTime": start.isoformat(),
                "timeZone": time_zone,
            },
            "end": {
                "dateTime": end.isoformat(),
                "timeZone": time_zone,
            },
        }
        if location:
            body["location"] = location

        private = dict(private_extended_properties or {})
        if patient_id is not None:
            private["patient_id"] = str(patient_id)
        if appointment_id is not None:
            private["appointment_id"] = str(appointment_id)
        if patient_id is not None or appointment_id is not None:
            private.setdefault("source", source)
        if private:
            body["extendedProperties"] = {"private": private}

        # If a caller email is provided, add them as an optional attendee.
        # optional=True keeps the event off-impact in the organizer's free/busy:
        # a caller decline won't make our event look "tentative" or flag conflicts.
        if attendee_email:
            body["attendees"] = [
                {"email": attendee_email, "optional": True, "responseStatus": "needsAction"},
            ]
            send_updates = "all"
        else:
            send_updates = "none"

        result = await asyncio.wait_for(
            asyncio.to_thread(
                lambda: self._service.events().insert(
                    calendarId=self.calendar_id,
                    body=body,
                    sendUpdates=send_updates,
                ).execute()
            ),
            timeout=_GOOGLE_API_TIMEOUT_SECONDS,
        )
        logger.info(
            "GoogleCalendarClient: created event %s (%s)",
            result.get("id"), result.get("htmlLink"),
        )
        return result

    async def rename_event(
        self,
        *,
        event_id: str,
        summary: str,
        send_updates: str = "all",
        etag: str | None = None,
    ) -> dict[str, Any]:
        """Rename an existing event and return the updated payload."""
        def _patch() -> dict[str, Any]:
            request = self._service.events().patch(
                calendarId=self.calendar_id,
                eventId=event_id,
                body={"summary": summary},
                sendUpdates=send_updates,
            )
            return self._execute_conditional(request, etag)

        result = await asyncio.wait_for(
            asyncio.to_thread(_patch),
            timeout=_GOOGLE_API_TIMEOUT_SECONDS,
        )
        logger.info(
            "GoogleCalendarClient: renamed event %s to %s",
            result.get("id") or event_id,
            summary,
        )
        return result

    async def get_event(self, *, event_id: str, show_deleted: bool = True) -> dict[str, Any]:
        """Fetch one event, including its current ETag for safe mutations."""
        return await asyncio.wait_for(
            asyncio.to_thread(
                lambda: self._service.events().get(
                    calendarId=self.calendar_id,
                    eventId=event_id,
                    showDeleted=show_deleted,
                ).execute()
            ),
            timeout=_GOOGLE_API_TIMEOUT_SECONDS,
        )

    async def list_events(
        self,
        *,
        time_min: datetime,
        time_max: datetime,
        single_events: bool = True,
        show_deleted: bool = False,
        query: str | None = None,
    ) -> list[dict[str, Any]]:
        """List a bounded set of event payloads for deterministic lookup."""
        def _list() -> list[dict[str, Any]]:
            items: list[dict[str, Any]] = []
            page_token: str | None = None
            while True:
                kwargs: dict[str, Any] = {
                    "calendarId": self.calendar_id,
                    "timeMin": time_min.isoformat(),
                    "timeMax": time_max.isoformat(),
                    "singleEvents": single_events,
                    "showDeleted": show_deleted,
                    "orderBy": "startTime" if single_events else "updated",
                    "maxResults": 2500,
                }
                if query:
                    kwargs["q"] = query
                if page_token:
                    kwargs["pageToken"] = page_token
                response = self._service.events().list(**kwargs).execute()
                items.extend(response.get("items", []))
                page_token = response.get("nextPageToken")
                if not page_token:
                    return items

        return await asyncio.wait_for(asyncio.to_thread(_list), timeout=_GOOGLE_API_TIMEOUT_SECONDS)

    @staticmethod
    def _execute_conditional(request, etag: str | None):
        if etag:
            headers = getattr(request, "headers", None)
            if headers is None:
                headers = {}
                request.headers = headers
            headers["If-Match"] = etag
        return request.execute()

    async def update_event_time(
        self,
        *,
        event_id: str,
        start: datetime,
        end: datetime,
        time_zone: str,
        etag: str | None = None,
        send_updates: str = "all",
    ) -> dict[str, Any]:
        """Conditionally update only an event's start and end."""
        body = {
            "start": {"dateTime": start.isoformat(), "timeZone": time_zone},
            "end": {"dateTime": end.isoformat(), "timeZone": time_zone},
        }

        def _patch() -> dict[str, Any]:
            request = self._service.events().patch(
                calendarId=self.calendar_id,
                eventId=event_id,
                body=body,
                sendUpdates=send_updates,
            )
            return self._execute_conditional(request, etag)

        return await asyncio.wait_for(asyncio.to_thread(_patch), timeout=_GOOGLE_API_TIMEOUT_SECONDS)

    async def delete_event(
        self,
        *,
        event_id: str,
        send_updates: str = "all",
        etag: str | None = None,
    ) -> None:
        """Delete an existing event."""
        def _delete() -> None:
            request = self._service.events().delete(
                calendarId=self.calendar_id,
                eventId=event_id,
                sendUpdates=send_updates,
            )
            self._execute_conditional(request, etag)

        await asyncio.wait_for(asyncio.to_thread(_delete), timeout=_GOOGLE_API_TIMEOUT_SECONDS)
        logger.info("GoogleCalendarClient: deleted event %s", event_id)


def _parse_rfc3339(s: str) -> datetime:
    """Parse Google's RFC 3339 timestamp. Handles both 'Z' suffix and '+HH:MM' offsets."""
    # Python's fromisoformat handles '+HH:MM' natively. The 'Z' suffix needs substitution.
    return datetime.fromisoformat(s.replace("Z", "+00:00"))
