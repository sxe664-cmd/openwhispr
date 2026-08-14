"""Bounded appointment lookup, cancellation, and rescheduling.

This module is intentionally deterministic. The voice model may collect and
confirm values, but it never chooses a calendar event ID or performs a raw
Google mutation itself.
"""
from __future__ import annotations

import html
import json
import logging
import re
import secrets
import unicodedata
from dataclasses import dataclass, replace
from datetime import datetime, time, timedelta, timezone
from dateutil import parser as dateparser
from googleapiclient.errors import HttpError
from zoneinfo import ZoneInfo

from receptionist.booking.availability import find_slots
from receptionist.booking.client import GoogleCalendarClient
from receptionist.config import BusinessConfig
from receptionist.reminders.calendar_google import event_from_google
from receptionist.reminders.contacts import ContactResolver, load_contacts
from receptionist.reminders.delivery import FakeLog, build_email_sender
from receptionist.reminders.identity import normalize_email
from receptionist.reminders.models import AppointmentEvent
from receptionist.reminders.phone import extract_phone, normalize_us_phone
from receptionist.reminders.scheduler import sync_events
from receptionist.reminders.store import ReminderStore

logger = logging.getLogger("receptionist")

_PATIENT_LINE_RE = re.compile(r"(?im)^\s*patient\s*:\s*(?P<value>.+?)\s*$")
_SUMMARY_PREFIX_RE = re.compile(r"(?i)^\s*appointment\s*(?::|-|with)?\s*")


class AppointmentChangeError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.user_message = message


@dataclass(frozen=True)
class AppointmentCandidate:
    token: str
    event: AppointmentEvent
    patient_name: str
    phone: str | None
    email: str | None
    expires_at: datetime
    call_id: str | None = None


@dataclass(frozen=True)
class RescheduleOffer:
    token: str
    appointment_token: str
    start_iso: str
    end_iso: str
    expires_at: datetime


class AppointmentChangeService:
    """Shared appointment-change service for voice and desktop callers."""

    def __init__(
        self,
        *,
        config: BusinessConfig,
        client: GoogleCalendarClient,
        store: ReminderStore | None = None,
        now: datetime | None = None,
    ) -> None:
        self.config = config
        self.client = client
        self.store = store or ReminderStore(config.reminders.store_path)
        self._now_override = now
        self._candidates: dict[str, AppointmentCandidate] = {}
        self._offers: dict[str, RescheduleOffer] = {}

    @property
    def enabled(self) -> bool:
        return bool(getattr(self.config, "appointment_changes", None) and self.config.appointment_changes.enabled)

    def _now(self) -> datetime:
        if self._now_override is not None:
            return self._now_override
        return datetime.now(ZoneInfo(self.config.business.timezone))

    def _ttl(self) -> timedelta:
        return timedelta(seconds=self.config.appointment_changes.token_ttl_seconds)

    def _ensure_enabled(self) -> None:
        if not self.enabled:
            raise AppointmentChangeError(
                "appointment_changes_disabled",
                "Appointment changes are not enabled. Please transfer this caller to the Front Desk.",
            )

    async def lookup(
        self,
        *,
        patient_name: str,
        callback_number: str,
        appointment_start: datetime,
        caller_email: str | None = None,
        call_id: str | None = None,
    ) -> AppointmentCandidate:
        self._ensure_enabled()
        name_key = _name_key(patient_name)
        phone = normalize_us_phone(callback_number)
        email = normalize_email(caller_email) if caller_email else None
        if not name_key:
            raise AppointmentChangeError("missing_name", "I need the patient's full name to find the appointment.")
        if not phone and not email:
            raise AppointmentChangeError(
                "missing_identity",
                "I need a valid callback number or email address to verify the appointment.",
            )
        target = _in_business_timezone(appointment_start, self.config.business.timezone)
        if target <= self._now().astimezone(target.tzinfo):
            raise AppointmentChangeError(
                "appointment_not_future",
                "That appointment is no longer a future appointment that can be changed automatically.",
            )

        window_minutes = self.config.appointment_changes.lookup_window_minutes
        window = timedelta(minutes=window_minutes)
        local_events = self._local_events(target - window, target + window)
        candidates = self._matching_events(local_events, name_key, phone, email, target)

        # The local store is an optimization, not an authority. If it did not
        # produce exactly one match, ask Google for a bounded fresh view.
        if len(candidates) != 1:
            raw_items = await self.client.list_events(
                time_min=(target - window).astimezone(timezone.utc),
                time_max=(target + window).astimezone(timezone.utc),
                single_events=True,
                show_deleted=False,
            )
            fresh_events: list[AppointmentEvent] = []
            for item in raw_items:
                if item.get("status") == "cancelled":
                    continue
                try:
                    fresh_events.append(
                        event_from_google(
                            item,
                            calendar_id=self.client.calendar_id,
                            timezone_name=self.config.business.timezone,
                        )
                    )
                except Exception:
                    logger.warning(
                        "appointment lookup skipped malformed Google event",
                        extra={"component": "appointment_changes.lookup"},
                    )
            candidates = self._matching_events(fresh_events, name_key, phone, email, target)

        if len(candidates) == 0:
            raise AppointmentChangeError(
                "appointment_not_found",
                "I could not verify one appointment from those details. I will transfer you to the Front Desk.",
            )
        if len(candidates) > 1:
            raise AppointmentChangeError(
                "appointment_ambiguous",
                "I found more than one matching appointment. I will transfer you to the Front Desk so nobody changes the wrong appointment.",
            )

        candidate_event = candidates[0]
        current = await self._fresh_event(candidate_event)
        if current.cancelled or current.all_day or current.start <= self._now().astimezone(current.start.tzinfo):
            raise AppointmentChangeError(
                "appointment_unsupported",
                "That appointment cannot be changed automatically. I will transfer you to the Front Desk.",
            )
        # Re-run identity matching against the fresh provider copy so a stale
        # local record cannot authorize a different event.
        if not self._matching_events([current], name_key, phone, email, target):
            raise AppointmentChangeError(
                "appointment_changed",
                "The appointment changed while I was verifying it. I will transfer you to the Front Desk.",
            )
        self.store.upsert_event(current)

        token = secrets.token_urlsafe(24)
        candidate = AppointmentCandidate(
            token=token,
            event=current,
            patient_name=_patient_name(current),
            phone=_event_phone(current, self.config),
            email=_event_email(current),
            expires_at=self._now().astimezone(timezone.utc) + self._ttl(),
            call_id=call_id,
        )
        self._candidates[token] = candidate
        logger.info(
            "appointment lookup matched one event",
            extra={
                "component": "appointment_changes.lookup",
                "call_id": call_id,
                "event_id": current.event_id,
                "calendar_id": current.calendar_id,
            },
        )
        return candidate

    async def check_reschedule_availability(
        self,
        *,
        appointment_token: str,
        preferred_start: datetime,
        call_id: str | None = None,
    ) -> list[RescheduleOffer]:
        self._ensure_enabled()
        candidate = self._candidate(appointment_token, call_id=call_id)
        current = await self._fresh_event(candidate.event)
        self._validate_current_event(current)
        self._require_same_token_revision(candidate.event, current)
        preferred = _in_business_timezone(preferred_start, self.config.business.timezone)
        now = self._now().astimezone(preferred.tzinfo)
        calendar = self.config.calendar
        assert calendar is not None
        earliest = now + timedelta(hours=calendar.earliest_booking_hours_ahead)
        latest = now + timedelta(days=calendar.booking_window_days)
        if preferred < earliest or preferred > latest:
            raise AppointmentChangeError(
                "outside_booking_window",
                "That requested time is outside the calendar booking window.",
            )
        busy = await self.client.free_busy(earliest, latest)
        busy = _without_interval(busy, current.start, current.end)
        slots = find_slots(
            business_hours=self.config.hours,
            business_timezone=self.config.business.timezone,
            calendar_config=calendar,
            preferred_dt=preferred,
            existing_busy=busy,
            earliest=earliest,
            latest=latest,
            now=now,
        )
        offers: list[RescheduleOffer] = []
        duration = _elapsed_duration(current.start, current.end)
        for slot in slots:
            slot_start = datetime.fromisoformat(slot.start_iso)
            slot_end = slot_start + duration
            if not _fits_business_hours(
                self.config.hours,
                slot_start,
                slot_end,
                self.config.business.timezone,
            ):
                continue
            if any(
                _overlaps(slot_start, slot_end, busy_start, busy_end)
                for busy_start, busy_end in busy
            ):
                continue
            token = secrets.token_urlsafe(20)
            offer = RescheduleOffer(
                token=token,
                appointment_token=appointment_token,
                start_iso=slot_start.isoformat(),
                end_iso=slot_end.isoformat(),
                expires_at=self._now().astimezone(timezone.utc) + self._ttl(),
            )
            self._offers[token] = offer
            offers.append(offer)
        return offers

    async def reschedule(
        self,
        *,
        appointment_token: str,
        slot_token: str,
        details_confirmed: bool,
        actor: str = "voice",
        call_id: str | None = None,
    ) -> dict:
        self._ensure_enabled()
        if not details_confirmed:
            raise AppointmentChangeError(
                "confirmation_required",
                "I need explicit confirmation of the original and new appointment times before changing it.",
            )
        offer = self._offer(slot_token, appointment_token)
        candidate = self._candidate(appointment_token, call_id=call_id)
        current = await self._fresh_event(candidate.event)
        self._validate_current_event(current)
        replay = self._replay_if_completed(
            action="reschedule",
            identity_event=candidate.event,
            requested_start=datetime.fromisoformat(offer.start_iso),
            requested_end=datetime.fromisoformat(offer.end_iso),
            actor=actor,
            call_id=call_id,
            current=current,
        )
        if replay is not None:
            return replay
        self._require_same_token_revision(candidate.event, current)
        start = datetime.fromisoformat(offer.start_iso)
        end = datetime.fromisoformat(offer.end_iso)
        await self._check_exact_slot(start, end, current)
        return await self._mutate(
            action="reschedule",
            current=current,
            requested_start=start,
            requested_end=end,
            actor=actor,
            call_id=call_id,
            identity_event=candidate.event,
        )

    async def cancel(
        self,
        *,
        appointment_token: str,
        details_confirmed: bool,
        actor: str = "voice",
        call_id: str | None = None,
    ) -> dict:
        self._ensure_enabled()
        if not details_confirmed:
            raise AppointmentChangeError(
                "confirmation_required",
                "I need explicit confirmation of the exact appointment before cancelling it.",
            )
        candidate = self._candidate(appointment_token, call_id=call_id)
        try:
            current = await self._fresh_event(candidate.event)
        except AppointmentChangeError as exc:
            if exc.code == "appointment_cancelled":
                replay = self._completed_operation(
                    action="cancel",
                    identity_event=candidate.event,
                    requested_start=None,
                    actor=actor,
                    call_id=call_id,
                )
                if replay is not None:
                    return replay
            raise
        self._validate_current_event(current)
        replay = self._replay_if_completed(
            action="cancel",
            identity_event=candidate.event,
            requested_start=None,
            requested_end=None,
            actor=actor,
            call_id=call_id,
            current=current,
        )
        if replay is not None:
            return replay
        self._require_same_token_revision(candidate.event, current)
        return await self._mutate(
            action="cancel",
            current=current,
            requested_start=None,
            requested_end=None,
            actor=actor,
            call_id=call_id,
            identity_event=candidate.event,
        )

    async def desktop_reschedule(
        self,
        *,
        calendar_id: str,
        event_id: str,
        new_start: datetime,
        actor: str = "desktop",
        confirmed: bool = False,
    ) -> dict:
        self._ensure_enabled()
        if not confirmed:
            raise AppointmentChangeError(
                "confirmation_required",
                "The desktop confirmation step is required before changing this appointment.",
            )
        canonical = self.store.get_active_google_event(
            calendar_id=calendar_id,
            event_id=event_id,
        )
        if canonical is None:
            raise AppointmentChangeError(
                "canonical_event_missing",
                "This appointment is not in the synchronized desktop calendar. Please refresh and try again.",
            )
        current = await self._fresh_event_by_id(calendar_id, event_id)
        self._validate_current_event(current)
        self._require_same_stored_revision(canonical, current)
        start = _in_business_timezone(new_start, self.config.business.timezone)
        end = start + _elapsed_duration(current.start, current.end)
        replay = self._completed_target_operation(
            action="reschedule",
            calendar_id=calendar_id,
            event_id=event_id,
            requested_start=start,
            actor=actor,
        )
        if replay is not None and _same_datetime(current.start, start) and _same_datetime(current.end, end):
            return replay
        await self._check_exact_slot(start, end, current)
        return await self._mutate(
            action="reschedule",
            current=current,
            requested_start=start,
            requested_end=end,
            actor=actor,
            identity_event=canonical,
        )

    async def desktop_cancel(
        self,
        *,
        calendar_id: str,
        event_id: str,
        actor: str = "desktop",
        confirmed: bool = False,
    ) -> dict:
        self._ensure_enabled()
        if not confirmed:
            raise AppointmentChangeError(
                "confirmation_required",
                "The desktop confirmation step is required before cancelling this appointment.",
            )
        canonical = self.store.get_active_google_event(
            calendar_id=calendar_id,
            event_id=event_id,
        )
        if canonical is None:
            replay = self._completed_target_operation(
                action="cancel",
                calendar_id=calendar_id,
                event_id=event_id,
                requested_start=None,
                actor=actor,
            )
            if replay is not None:
                try:
                    raw = await self.client.get_event(event_id=event_id, show_deleted=True)
                except Exception:
                    raw = {}
                if raw.get("status") == "cancelled":
                    return replay
            raise AppointmentChangeError(
                "canonical_event_missing",
                "This appointment is not in the synchronized desktop calendar. Please refresh and try again.",
            )
        current = await self._fresh_event_by_id(calendar_id, event_id)
        self._validate_current_event(current)
        self._require_same_stored_revision(canonical, current)
        return await self._mutate(
            action="cancel",
            current=current,
            requested_start=None,
            requested_end=None,
            actor=actor,
            identity_event=canonical,
        )

    async def dispatch_pending_notifications(self) -> int:
        sent = 0
        notification_retry_limit = getattr(
            self.config.appointment_changes,
            "notification_retry_limit",
            5,
        )
        for row in self.store.list_pending_appointment_notifications():
            try:
                if self.config.reminders.email_provider == "fake":
                    await FakeLog(self.config.reminders.fake_email_log_path).write(
                        {
                            "channel": "email",
                            "to": row["recipient"],
                            "subject": row["subject"],
                            "body_text": row["body_text"],
                            "operation_id": row["operation_id"],
                            "appointment_change": True,
                        }
                    )
                else:
                    if self.config.email is None or self.config.email.from_ is None:
                        raise RuntimeError("email configuration is required for appointment-change notifications")
                    sender = build_email_sender(self.config)
                    await sender.send(
                        from_=self.config.email.from_,
                        to=[row["recipient"]],
                        subject=row["subject"],
                        body_text=row["body_text"],
                        body_html=row["body_html"],
                    )
                self.store.mark_appointment_notification(
                    row["id"],
                    status="sent",
                    retry_limit=notification_retry_limit,
                )
                sent += 1
            except Exception as exc:
                logger.exception(
                    "appointment change notification failed",
                    extra={"component": "appointment_changes.notification", "operation_id": row["operation_id"]},
                )
                self.store.mark_appointment_notification(
                    row["id"],
                    status="failed",
                    error=str(exc),
                    retry_limit=notification_retry_limit,
                )
        return sent

    async def reconcile_pending_operations(self, *, limit: int = 50) -> int:
        """Repair durable operations after a crash without repeating Google writes.

        ``pending`` means the process may have stopped before or during the
        provider request. ``provider_applied`` and ``recovery_pending`` mean
        Google may already have changed the event. Every branch re-fetches the
        event and only performs local reconciliation; this method never calls
        patch or delete.
        """
        operations = self.store.list_appointment_operations(
            statuses=("pending", "provider_applied", "recovery_pending"),
            limit=limit,
        )
        retry_limit = getattr(
            self.config.appointment_changes,
            "operation_retry_limit",
            3,
        )
        operations = [
            operation
            for operation in operations
            if int(operation.get("attempts") or 0) < retry_limit
        ]
        repaired = 0
        for operation in operations:
            try:
                raw = await self.client.get_event(
                    event_id=operation["event_id"],
                    show_deleted=True,
                )
            except Exception as exc:
                if operation["status"] == "pending":
                    self.store.update_appointment_operation(
                        operation["operation_id"],
                        status="recovery_pending",
                        error_code="provider_result_unknown",
                        error_detail=str(exc),
                        attempts=int(operation.get("attempts") or 0) + 1,
                    )
                continue

            if not self._raw_matches_operation(raw, operation):
                if operation["status"] == "pending":
                    try:
                        current = event_from_google(
                            raw,
                            calendar_id=operation["calendar_id"],
                            timezone_name=self.config.business.timezone,
                        )
                        same_original = (
                            operation.get("previous_start_iso")
                            and _same_datetime(
                                current.start,
                                datetime.fromisoformat(operation["previous_start_iso"]),
                            )
                        )
                    except Exception:
                        same_original = False
                    unchanged = same_original and (
                        not operation.get("etag") or raw.get("etag") == operation.get("etag")
                    )
                    self.store.update_appointment_operation(
                        operation["operation_id"],
                        status="failed" if unchanged else "conflict",
                        error_code="provider_not_applied" if unchanged else "event_conflict",
                        error_detail=(
                            "provider mutation was not applied"
                            if unchanged
                            else "event changed while recovering an appointment operation"
                        ),
                        attempts=int(operation.get("attempts") or 0) + 1,
                    )
                continue

            try:
                provider_event = event_from_google(
                    raw,
                    calendar_id=operation["calendar_id"],
                    timezone_name=self.config.business.timezone,
                )
                previous = replace(
                    provider_event,
                    start=datetime.fromisoformat(operation["previous_start_iso"]),
                    end=datetime.fromisoformat(operation["previous_end_iso"]),
                    cancelled=False,
                    status="confirmed",
                )
                action = operation["action"]
                if action == "cancel":
                    updated = replace(
                        previous,
                        cancelled=True,
                        status="cancelled",
                        etag=provider_event.etag,
                        html_link=provider_event.html_link,
                    )
                    new_start_iso = None
                    new_end_iso = None
                else:
                    updated = provider_event
                    new_start_iso = updated.start.isoformat()
                    new_end_iso = updated.end.isoformat()
                result = {
                    "ok": True,
                    "operation_id": operation["operation_id"],
                    "action": action,
                    "event_id": operation["event_id"],
                    "calendar_id": operation["calendar_id"],
                    "previous_start_iso": previous.start.isoformat(),
                    "new_start_iso": new_start_iso,
                    "new_end_iso": new_end_iso,
                    "html_link": updated.html_link,
                }
                self._reconcile_local_change(
                    action=action,
                    previous=previous,
                    updated=updated,
                )
                self.store.update_appointment_operation(
                    operation["operation_id"],
                    status="local_reconciled",
                    result_json=json.dumps(result, sort_keys=True),
                    attempts=int(operation.get("attempts") or 0) + 1,
                )
                self._queue_notifications(result, previous, updated)
                await self.dispatch_pending_notifications()
                self.store.update_appointment_operation(
                    operation["operation_id"],
                    status="completed",
                )
                repaired += 1
            except Exception as exc:
                logger.exception(
                    "appointment operation recovery failed",
                    extra={
                        "component": "appointment_changes.recovery",
                        "operation_id": operation["operation_id"],
                    },
                )
                self.store.update_appointment_operation(
                    operation["operation_id"],
                    status="recovery_pending",
                    error_code="local_reconciliation_failed",
                    error_detail=str(exc),
                    attempts=int(operation.get("attempts") or 0) + 1,
                )
        return repaired

    @staticmethod
    def _raw_matches_operation(raw: dict, operation: dict) -> bool:
        action = operation.get("action")
        if action == "cancel":
            return raw.get("status") == "cancelled"
        requested_start = operation.get("requested_start_iso")
        requested_end = operation.get("requested_end_iso")
        actual_start = raw.get("start", {}).get("dateTime")
        actual_end = raw.get("end", {}).get("dateTime")
        if not requested_start or not requested_end or not actual_start or not actual_end:
            return False
        try:
            return _same_datetime(
                datetime.fromisoformat(actual_start.replace("Z", "+00:00")),
                datetime.fromisoformat(requested_start),
            ) and _same_datetime(
                datetime.fromisoformat(actual_end.replace("Z", "+00:00")),
                datetime.fromisoformat(requested_end),
            )
        except ValueError:
            return False

    async def _mutate(
        self,
        *,
        action: str,
        current: AppointmentEvent,
        requested_start: datetime | None,
        requested_end: datetime | None,
        actor: str,
        call_id: str | None = None,
        identity_event: AppointmentEvent | None = None,
    ) -> dict:
        identity = identity_event or current
        idempotency_key = self._operation_key(
            action=action,
            identity_event=identity,
            requested_start=requested_start,
            actor=actor,
            call_id=call_id,
        )
        operation_id = secrets.token_urlsafe(18)
        operation = self.store.begin_appointment_operation(
            operation_id=operation_id,
            idempotency_key=idempotency_key,
            action=action,
            source=current.source,
            calendar_id=current.calendar_id,
            event_id=current.event_id,
            recurring_event_id=current.recurring_event_id,
            original_start_iso=current.original_start_time,
            previous_start_iso=current.start.isoformat(),
            previous_end_iso=current.end.isoformat(),
            requested_start_iso=requested_start.isoformat() if requested_start else None,
            requested_end_iso=requested_end.isoformat() if requested_end else None,
            etag=current.etag,
            actor=actor,
            call_id=call_id,
        )
        if operation.get("status") in {"completed", "local_reconciled", "notification_pending"} and operation.get("result_json"):
            if operation.get("status") == "notification_pending":
                await self.dispatch_pending_notifications()
            return json.loads(operation["result_json"])
        operation_id = operation["operation_id"]

        raw_result: dict | None = None
        if operation.get("status") in {"provider_applied", "recovery_pending"}:
            raw_result = await self._resolve_after_provider_error(
                current, action, requested_start, requested_end,
            )
            if raw_result is None:
                self.store.update_appointment_operation(
                    operation_id,
                    status="recovery_pending",
                    error_code="provider_result_unknown",
                    error_detail="provider mutation was recorded but could not be verified",
                )
                raise AppointmentChangeError(
                    "operation_recovery_pending",
                    "A previous calendar request may still be resolving. I will transfer you to the Front Desk.",
                )
        try:
            if raw_result is None and not current.etag:
                raise AppointmentChangeError(
                    "missing_event_version",
                    "I could not verify the current version of that appointment. I will transfer you to the Front Desk.",
                )
            if raw_result is None and action == "reschedule":
                assert requested_start is not None and requested_end is not None
                raw_result = await self.client.update_event_time(
                    event_id=current.event_id,
                    start=requested_start,
                    end=requested_end,
                    time_zone=current.timezone,
                    etag=current.etag,
                    send_updates="all",
                )
            elif raw_result is None:
                await self.client.delete_event(
                    event_id=current.event_id,
                    etag=current.etag,
                    send_updates="all",
                )
                raw_result = {"id": current.event_id, "status": "cancelled", "etag": current.etag}
        except AppointmentChangeError:
            self.store.update_appointment_operation(
                operation_id,
                status="failed",
                error_code="missing_event_version",
                error_detail="event has no ETag",
            )
            raise
        except Exception as exc:
            if _http_status(exc) == 412:
                self.store.update_appointment_operation(
                    operation_id,
                    status="conflict",
                    error_code="event_conflict",
                    error_detail="Google Calendar event changed concurrently",
                )
                raise AppointmentChangeError(
                    "event_conflict",
                    "That appointment changed while I was working on it. I will transfer you to the Front Desk.",
                ) from exc
            resolved = await self._resolve_after_provider_error(current, action, requested_start, requested_end)
            if resolved is None:
                self.store.update_appointment_operation(
                    operation_id,
                    status="recovery_pending",
                    error_code="provider_result_unknown",
                    error_detail=str(exc),
                )
                raise AppointmentChangeError(
                    "calendar_error",
                    "I could not safely confirm the calendar change. I will transfer you to the Front Desk while it is reconciled.",
                ) from exc
            raw_result = resolved

        # Treat the provider response as provisional. Re-fetch the exact
        # event so a partial response, proxy retry, or delete timeout cannot
        # be mistaken for a durable calendar state.
        try:
            verified_result = await self.client.get_event(
                event_id=current.event_id,
                show_deleted=True,
            )
        except Exception as exc:
            self.store.update_appointment_operation(
                operation_id,
                status="recovery_pending",
                error_code="provider_result_unknown",
                error_detail=str(exc),
            )
            raise AppointmentChangeError(
                "operation_recovery_pending",
                "The calendar change may have succeeded, but I could not verify it yet. I will transfer you to the Front Desk.",
            ) from exc
        if not self._raw_matches_operation(verified_result, operation):
            self.store.update_appointment_operation(
                operation_id,
                status="recovery_pending",
                error_code="provider_result_mismatch",
                error_detail="Google returned a state different from the requested change",
            )
            raise AppointmentChangeError(
                "operation_recovery_pending",
                "The calendar returned an unexpected result. I will transfer you to the Front Desk while it is reconciled.",
            )
        raw_result = verified_result

        self.store.update_appointment_operation(operation_id, status="provider_applied")
        updated = self._updated_event(current, raw_result, action, requested_start, requested_end)
        local_previous = current
        if operation.get("status") in {"provider_applied", "recovery_pending"}:
            try:
                local_previous = replace(
                    current,
                    start=datetime.fromisoformat(operation["previous_start_iso"]),
                    end=datetime.fromisoformat(operation["previous_end_iso"]),
                    cancelled=False,
                    status="confirmed",
                )
            except (KeyError, TypeError, ValueError):
                local_previous = current
        result = {
            "ok": True,
            "operation_id": operation_id,
            "action": action,
            "event_id": current.event_id,
            "calendar_id": current.calendar_id,
            "previous_start_iso": local_previous.start.isoformat(),
            "new_start_iso": updated.start.isoformat() if action == "reschedule" else None,
            "new_end_iso": updated.end.isoformat() if action == "reschedule" else None,
            "html_link": updated.html_link or current.html_link,
        }
        try:
            self._reconcile_local_change(
                action=action,
                previous=local_previous,
                updated=updated,
            )
            self.store.update_appointment_operation(
                operation_id,
                status="local_reconciled",
                result_json=json.dumps(result, sort_keys=True),
            )
        except Exception as exc:
            self.store.update_appointment_operation(
                operation_id,
                status="provider_applied",
                error_code="local_reconciliation_failed",
                error_detail=str(exc),
            )
            raise AppointmentChangeError(
                "local_reconciliation_failed",
                "The calendar change succeeded, but local reminders need staff follow-up. I will transfer you to the Front Desk.",
            ) from exc

        try:
            self._queue_notifications(result, local_previous, updated)
            await self.dispatch_pending_notifications()
            self.store.update_appointment_operation(operation_id, status="completed")
        except Exception as exc:
            logger.exception(
                "appointment change notification queue failed",
                extra={"component": "appointment_changes.notification_queue", "operation_id": operation_id},
            )
            self.store.update_appointment_operation(
                operation_id,
                status="notification_pending",
                error_code="notification_queue_failed",
                error_detail=str(exc),
            )
        return result

    def _reconcile_local_change(
        self,
        *,
        action: str,
        previous: AppointmentEvent,
        updated: AppointmentEvent,
    ) -> None:
        if action == "cancel":
            self.store.upsert_event(updated)
            self.store.cancel_event_occurrence(
                source=previous.source,
                calendar_id=previous.calendar_id,
                event_id=previous.event_id,
                start_iso=previous.start.isoformat(),
            )
            return
        self.store.cancel_event_occurrence(
            source=previous.source,
            calendar_id=previous.calendar_id,
            event_id=previous.event_id,
            start_iso=previous.start.isoformat(),
            reason="event_rescheduled",
        )
        self.store.upsert_event(updated)
        if self.config.reminders.enabled:
            contacts = load_contacts(self.config.reminders.contacts_path)
            sync_events(config=self.config, store=self.store, events=[updated], contacts=contacts)

    def _queue_notifications(
        self,
        result: dict,
        previous: AppointmentEvent,
        updated: AppointmentEvent,
    ) -> None:
        action = result["action"]
        subject = f"Appointment {action}: {_patient_name(previous) or previous.summary}"
        previous_when = _format_when(previous, self.config.business.timezone)
        new_when = _format_when(updated, self.config.business.timezone) if action == "reschedule" else "(cancelled)"
        body_text = (
            f"Appointment {action}\n\n"
            f"Patient: {_patient_name(previous) or previous.summary}\n"
            f"Previous appointment: {previous_when}\n"
            f"New appointment: {new_when}\n"
            f"Event ID: {previous.event_id}\n"
            f"Calendar ID: {previous.calendar_id}\n"
            f"Event link: {updated.html_link or previous.html_link or '(not available)'}\n"
            f"Operation ID: {result['operation_id']}\n"
            f"Google attendee update: {'sent' if previous.attendee_emails else 'not applicable (no attendee email)'}\n"
        )
        body_html = "".join(f"<p>{html.escape(line)}</p>" for line in body_text.split("\n") if line)
        for recipient in self.config.appointment_changes.admin_email_to:
            self.store.queue_appointment_notification(
                operation_id=result["operation_id"],
                recipient=recipient,
                subject=subject,
                body_text=body_text,
                body_html=body_html,
            )

    async def _resolve_after_provider_error(
        self,
        current: AppointmentEvent,
        action: str,
        requested_start: datetime | None,
        requested_end: datetime | None,
    ) -> dict | None:
        try:
            raw = await self.client.get_event(event_id=current.event_id, show_deleted=True)
        except Exception:
            return None
        if action == "cancel":
            return raw if raw.get("status") == "cancelled" else None
        actual_start = raw.get("start", {}).get("dateTime")
        actual_end = raw.get("end", {}).get("dateTime")
        if requested_start and requested_end and actual_start and actual_end:
            if _same_instant(actual_start, requested_start) and _same_instant(actual_end, requested_end):
                return raw
        return None

    async def _fresh_event(self, event: AppointmentEvent) -> AppointmentEvent:
        return await self._fresh_event_by_id(event.calendar_id, event.event_id)

    async def _fresh_event_by_id(self, calendar_id: str, event_id: str) -> AppointmentEvent:
        if calendar_id != self.client.calendar_id:
            raise AppointmentChangeError("calendar_mismatch", "This appointment belongs to another calendar.")
        raw = await self.client.get_event(event_id=event_id, show_deleted=True)
        if str(raw.get("id") or "") != event_id:
            raise AppointmentChangeError(
                "event_identity_mismatch",
                "The calendar returned a different appointment than requested. I will transfer you to the Front Desk.",
            )
        if raw.get("status") == "cancelled":
            raise AppointmentChangeError("appointment_cancelled", "That appointment is already cancelled.")
        return event_from_google(
            raw,
            calendar_id=calendar_id,
            timezone_name=self.config.business.timezone,
        )

    def _validate_current_event(self, event: AppointmentEvent) -> None:
        if event.cancelled or event.status == "cancelled":
            raise AppointmentChangeError("appointment_cancelled", "That appointment is already cancelled.")
        if event.end <= event.start:
            raise AppointmentChangeError(
                "invalid_event_time",
                "That appointment has invalid calendar times and must be handled by the Front Desk.",
            )
        if event.all_day:
            raise AppointmentChangeError("all_day_event", "All-day appointments must be changed by the Front Desk.")
        if event.recurring and not event.recurring_event_id:
            raise AppointmentChangeError(
                "unsupported_recurring_series",
                "Whole recurring appointment series changes must be handled by the Front Desk.",
            )
        if event.start <= self._now().astimezone(event.start.tzinfo):
            raise AppointmentChangeError("appointment_not_future", "Only future appointments can be changed automatically.")

    async def _check_exact_slot(
        self,
        start: datetime,
        end: datetime,
        current: AppointmentEvent,
    ) -> None:
        now = self._now().astimezone(start.tzinfo)
        if start <= now:
            raise AppointmentChangeError("slot_in_past", "That new appointment time is in the past.")
        busy = await self.client.free_busy(start, end)
        if _without_interval(busy, current.start, current.end):
            raise AppointmentChangeError("slot_unavailable", "That time is no longer available.")

    def _candidate(self, token: str, *, call_id: str | None = None) -> AppointmentCandidate:
        candidate = self._candidates.get(token)
        if candidate is None or candidate.expires_at <= self._now().astimezone(timezone.utc):
            self._candidates.pop(token, None)
            raise AppointmentChangeError("appointment_token_expired", "That appointment lookup has expired. Please start again.")
        if candidate.call_id and call_id and candidate.call_id != call_id:
            raise AppointmentChangeError(
                "appointment_token_call_mismatch",
                "That appointment lookup belongs to another call. I will transfer you to the Front Desk.",
            )
        return candidate

    @staticmethod
    def _operation_key(
        *,
        action: str,
        identity_event: AppointmentEvent,
        requested_start: datetime | None,
        actor: str,
        call_id: str | None,
    ) -> str:
        requested_key = requested_start.isoformat() if requested_start else "cancelled"
        return "|".join(
            (
                action,
                identity_event.calendar_id,
                identity_event.event_id,
                identity_event.start.isoformat(),
                requested_key,
            )
        )

    def _completed_operation(
        self,
        *,
        action: str,
        identity_event: AppointmentEvent,
        requested_start: datetime | None,
        actor: str,
        call_id: str | None,
    ) -> dict | None:
        operation = self.store.get_appointment_operation_by_key(
            self._operation_key(
                action=action,
                identity_event=identity_event,
                requested_start=requested_start,
                actor=actor,
                call_id=call_id,
            )
        )
        if operation is None or operation.get("status") not in {"completed", "local_reconciled", "notification_pending"}:
            return None
        result_json = operation.get("result_json")
        if not result_json:
            return None
        try:
            return json.loads(result_json)
        except (TypeError, ValueError):
            return None

    def _completed_target_operation(
        self,
        *,
        action: str,
        calendar_id: str,
        event_id: str,
        requested_start: datetime | None,
        actor: str,
    ) -> dict | None:
        operation = self.store.find_completed_appointment_operation(
            action=action,
            calendar_id=calendar_id,
            event_id=event_id,
            requested_start_iso=requested_start.isoformat() if requested_start else None,
            actor=actor,
        )
        if operation is None or not operation.get("result_json"):
            return None
        try:
            return json.loads(operation["result_json"])
        except (TypeError, ValueError):
            return None

    def _replay_if_completed(
        self,
        *,
        action: str,
        identity_event: AppointmentEvent,
        requested_start: datetime | None,
        requested_end: datetime | None,
        actor: str,
        call_id: str | None,
        current: AppointmentEvent,
    ) -> dict | None:
        result = self._completed_operation(
            action=action,
            identity_event=identity_event,
            requested_start=requested_start,
            actor=actor,
            call_id=call_id,
        )
        if result is None:
            return None
        if action == "cancel":
            return result if _same_event_revision(identity_event, current) else None
        if requested_start is None or requested_end is None:
            return None
        if (
            _same_datetime(current.start, requested_start)
            and _same_datetime(current.end, requested_end)
        ):
            return result
        # A completed operation exists, but the event no longer has its
        # requested state. Treat that as a fresh concurrency conflict rather
        # than replaying an obsolete success.
        return None

    def _require_same_token_revision(
        self,
        expected: AppointmentEvent,
        current: AppointmentEvent,
    ) -> None:
        if not _same_event_revision(expected, current):
            raise AppointmentChangeError(
                "event_conflict",
                "That appointment changed while I was verifying it. I will transfer you to the Front Desk.",
            )

    def _require_same_stored_revision(
        self,
        stored: AppointmentEvent,
        current: AppointmentEvent,
    ) -> None:
        if (
            stored.event_id != current.event_id
            or stored.calendar_id != current.calendar_id
            or not _same_datetime(stored.start, current.start)
            or not _same_datetime(stored.end, current.end)
        ):
            raise AppointmentChangeError(
                "event_conflict",
                "The calendar changed since this desktop view was loaded. Refresh the appointment and try again.",
            )

    def _offer(self, token: str, appointment_token: str) -> RescheduleOffer:
        offer = self._offers.get(token)
        if offer is None or offer.expires_at <= self._now().astimezone(timezone.utc):
            self._offers.pop(token, None)
            raise AppointmentChangeError("slot_token_expired", "That offered time has expired. Please check availability again.")
        if offer.appointment_token != appointment_token:
            raise AppointmentChangeError("slot_token_mismatch", "That time was not offered for this appointment.")
        return offer

    def _local_events(self, time_min: datetime, time_max: datetime) -> list[AppointmentEvent]:
        rows = self.store.list_events(
            limit=500,
            start_iso=time_min.astimezone(timezone.utc).isoformat(),
            end_iso=time_max.astimezone(timezone.utc).isoformat(),
        )
        return [_event_from_store_row(row) for row in rows if row.get("source") == "google"]

    def _matching_events(
        self,
        events: list[AppointmentEvent],
        name_key: str,
        phone: str | None,
        email: str | None,
        target: datetime,
    ) -> list[AppointmentEvent]:
        matches: list[AppointmentEvent] = []
        for event in events:
            if event.cancelled or event.all_day:
                continue
            local_start = _in_business_timezone(event.start, self.config.business.timezone)
            if local_start.replace(second=0, microsecond=0) != target.replace(second=0, microsecond=0):
                continue
            if _name_key(_patient_name(event)) != name_key:
                continue
            event_phone = _event_phone(event, self.config)
            event_email = _event_email(event)
            if (phone and phone == event_phone) or (email and email in _event_emails(event)):
                matches.append(event)
        return matches

    def _updated_event(
        self,
        current: AppointmentEvent,
        raw: dict,
        action: str,
        requested_start: datetime | None,
        requested_end: datetime | None,
    ) -> AppointmentEvent:
        if action == "cancel":
            return AppointmentEvent(**{**current.__dict__, "cancelled": True, "status": "cancelled"})
        try:
            parsed = event_from_google(
                raw,
                calendar_id=current.calendar_id,
                timezone_name=self.config.business.timezone,
            )
            preserved = {
                "event_uid": parsed.event_uid if raw.get("iCalUID") else current.event_uid,
                "summary": parsed.summary if "summary" in raw else current.summary,
                "notes": parsed.notes if "description" in raw else current.notes,
                "attendee_emails": parsed.attendee_emails if "attendees" in raw else current.attendee_emails,
                "contact_match_keys": parsed.contact_match_keys if "attendees" in raw else current.contact_match_keys,
                "contact_email": parsed.contact_email if "description" in raw else current.contact_email,
                "contact_email_source": (
                    parsed.contact_email_source
                    if "description" in raw
                    else current.contact_email_source
                ),
                "contact_email_recovered_at": current.contact_email_recovered_at,
                "timezone": raw.get("start", {}).get("timeZone") or current.timezone,
                "html_link": parsed.html_link or current.html_link,
                "etag": parsed.etag or current.etag,
            }
            if current.recurring and not parsed.recurring:
                preserved.update(
                    recurring=True,
                    recurring_event_id=current.recurring_event_id,
                    original_start_time=current.original_start_time,
                )
            return replace(parsed, **preserved)
        except Exception:
            assert requested_start is not None and requested_end is not None
            return AppointmentEvent(
                **{
                    **current.__dict__,
                    "start": requested_start,
                    "end": requested_end,
                }
            )


def _event_from_store_row(row: dict) -> AppointmentEvent:
    return AppointmentEvent(
        source=row["source"],
        calendar_id=row["calendar_id"],
        event_id=row["event_id"],
        event_uid=row["event_uid"],
        summary=row["summary"],
        notes=row.get("notes") or "",
        start=datetime.fromisoformat(row["start_iso"]),
        end=datetime.fromisoformat(row["end_iso"]),
        timezone=row["timezone"],
        attendee_emails=tuple(row.get("attendee_emails") or ()),
        contact_email=row.get("contact_email"),
        recurring=bool(row.get("recurring")),
        cancelled=bool(row.get("cancelled")),
    )


def _patient_name(event: AppointmentEvent) -> str:
    match = _PATIENT_LINE_RE.search(event.notes or "")
    if match:
        return " ".join(match.group("value").split())
    return _SUMMARY_PREFIX_RE.sub("", event.summary or "Appointment").strip()


def _event_phone(event: AppointmentEvent, config: BusinessConfig) -> str | None:
    extracted = extract_phone(event.notes)
    if extracted.phone and not extracted.ambiguous:
        return extracted.phone
    # A malformed labeled value or an ambiguous description invalidates the
    # event's phone. Never revive an old local number in that case.
    if extracted.ambiguous or extracted.label_present:
        return None
    contacts = load_contacts(config.reminders.contacts_path)
    keys = [
        event.event_id,
        event.event_uid,
        f"{event.calendar_id}:{event.event_id}",
        f"{event.calendar_id}:{event.event_uid}",
        event.contact_email or "",
        *event.attendee_emails,
    ]
    recipient = ContactResolver(contacts).match_event(keys)
    if (
        recipient is not None
        and str(recipient.phone_source or "").startswith("calendar_description:")
        and not extracted.phone
    ):
        return None
    return normalize_us_phone(recipient.phone) if recipient else None


def _event_email(event: AppointmentEvent) -> str | None:
    return normalize_email(event.contact_email) or (
        event.attendee_emails[0] if event.attendee_emails else None
    )


def _event_emails(event: AppointmentEvent) -> tuple[str, ...]:
    values = [normalize_email(event.contact_email)]
    values.extend(normalize_email(value) for value in event.attendee_emails)
    return tuple(dict.fromkeys(value for value in values if value))


def _name_key(value: str | None) -> str:
    normalized = unicodedata.normalize("NFKD", str(value or ""))
    normalized = "".join(char for char in normalized if not unicodedata.combining(char))
    normalized = re.sub(r"[^a-zA-Z0-9]+", " ", normalized).lower().strip()
    return " ".join(sorted(normalized.split()))


def _in_business_timezone(value: datetime, timezone_name: str) -> datetime:
    tz = ZoneInfo(timezone_name)
    if value.tzinfo is None:
        return value.replace(tzinfo=tz)
    return value.astimezone(tz)


def _same_instant(value: str, expected: datetime) -> bool:
    try:
        actual = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if actual.tzinfo is None:
            actual = actual.replace(tzinfo=expected.tzinfo)
        return actual.astimezone(timezone.utc) == expected.astimezone(timezone.utc)
    except ValueError:
        return False


def _same_datetime(left: datetime, right: datetime) -> bool:
    return left.astimezone(timezone.utc) == right.astimezone(timezone.utc)


def _elapsed_duration(start: datetime, end: datetime) -> timedelta:
    return end.astimezone(timezone.utc) - start.astimezone(timezone.utc)


def _fits_business_hours(hours, start: datetime, end: datetime, timezone_name: str) -> bool:
    local_start = _in_business_timezone(start, timezone_name)
    local_end = _in_business_timezone(end, timezone_name)
    if local_start.date() != local_end.date():
        return False
    day_hours = getattr(hours, local_start.strftime("%A").lower(), None)
    if day_hours is None:
        return False
    open_hour, open_minute = (int(value) for value in day_hours.open.split(":"))
    close_hour, close_minute = (int(value) for value in day_hours.close.split(":"))
    return (
        time(open_hour, open_minute)
        <= local_start.time().replace(second=0, microsecond=0)
        and local_end.time().replace(second=0, microsecond=0)
        <= time(close_hour, close_minute)
    )


def _same_event_revision(expected: AppointmentEvent, current: AppointmentEvent) -> bool:
    if (
        expected.calendar_id != current.calendar_id
        or expected.event_id != current.event_id
        or not _same_datetime(expected.start, current.start)
        or not _same_datetime(expected.end, current.end)
    ):
        return False
    if expected.etag and current.etag and expected.etag != current.etag:
        return False
    if expected.recurring_event_id and expected.recurring_event_id != current.recurring_event_id:
        return False
    return True


def _without_interval(
    busy: list[tuple[datetime, datetime]],
    excluded_start: datetime,
    excluded_end: datetime,
) -> list[tuple[datetime, datetime]]:
    result: list[tuple[datetime, datetime]] = []
    for start, end in busy:
        if not (
            start.astimezone(timezone.utc) == excluded_start.astimezone(timezone.utc)
            and end.astimezone(timezone.utc) == excluded_end.astimezone(timezone.utc)
        ):
            result.append((start, end))
    return result


def _overlaps(start: datetime, end: datetime, other_start: datetime, other_end: datetime) -> bool:
    return start < other_end and end > other_start


def _format_when(event: AppointmentEvent, timezone_name: str) -> str:
    local = _in_business_timezone(event.start, timezone_name)
    return local.strftime("%A, %B %d at %I:%M %p").replace(" 0", " ")


def _http_status(exc: Exception) -> int | None:
    if isinstance(exc, HttpError):
        return getattr(exc.resp, "status", None)
    return getattr(getattr(exc, "response", None), "status_code", None)


def parse_change_datetime(value_date: str, value_time: str, *, timezone_name: str) -> datetime:
    """Parse caller/desktop date and time into the business timezone."""
    tz = ZoneInfo(timezone_name)
    now = datetime.now(tz)
    date_value = value_date.strip().lower()
    if date_value in {"today", "tonight"}:
        date_value = now.strftime("%B %d %Y")
    elif date_value == "tomorrow":
        date_value = (now + timedelta(days=1)).strftime("%B %d %Y")
    else:
        weekdays = {
            "monday": 0, "tuesday": 1, "wednesday": 2,
            "thursday": 3, "friday": 4, "saturday": 5, "sunday": 6,
        }
        for prefix in ("next ", "this "):
            weekday = date_value[len(prefix):] if date_value.startswith(prefix) else ""
            if weekday in weekdays:
                days_ahead = (weekdays[weekday] - now.weekday()) % 7
                if prefix == "next ":
                    days_ahead = days_ahead + 7 if days_ahead < 7 else days_ahead
                date_value = (now + timedelta(days=days_ahead)).strftime("%B %d %Y")
                break
    parsed = dateparser.parse(
        f"{date_value} {value_time}",
        default=now.replace(second=0, microsecond=0),
    )
    if parsed is None:
        raise ValueError("date and time could not be parsed")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=tz)
    return parsed.astimezone(tz)
