# receptionist/booking/booking.py
from __future__ import annotations

import logging
import asyncio
from datetime import datetime, timezone

from receptionist.booking.client import GoogleCalendarClient
from receptionist.booking.models import BookingResult, SlotProposal
from receptionist.patient_registry import (
    DEFAULT_APPOINTMENT_SOURCE,
    PatientIdentityError,
    PatientRegistry,
    normalize_dob,
    normalize_email,
    normalize_phone,
)

logger = logging.getLogger("receptionist")


def _clean_field(value: str | None) -> str:
    return " ".join((value or "").replace("\r", " ").replace("\n", " ").replace("\x00", " ").split())


class SlotNoLongerAvailableError(Exception):
    """Raised when the proposed slot was free at check_availability time but is now busy.

    The caller (tool handler) should catch this, run availability again, and
    offer the caller new alternatives.
    """


async def book_appointment(
    *,
    slot: SlotProposal,
    caller_name: str,
    callback_number: str,
    call_id: str,
    time_zone: str,
    client: GoogleCalendarClient,
    notes: str | None,
    caller_email: str | None = None,
    caller_dob: str | None = None,
    create_if_missing: bool = False,
    patient_id: str | None = None,
    idempotency_key: str | None = None,
    appointment_type: str = "appointment",
    provider: str = "google",
    source: str = DEFAULT_APPOINTMENT_SOURCE,
    invite_caller: bool | None = None,
) -> BookingResult:
    """Book the given slot on the calendar.

    Performs a last-second free/busy check for the exact slot to detect races
    between check_availability and this call. On race, raises
    SlotNoLongerAvailableError; the tool handler turns that into an LLM-facing
    message offering alternatives.

    When caller_email is given, the caller is added as an OPTIONAL attendee
    and Google sends them the standard calendar invitation. Optional attendees
    do not affect the organizer's free/busy if they decline.
    """
    start = datetime.fromisoformat(slot.start_iso)
    end = datetime.fromisoformat(slot.end_iso)
    normalized_callback = normalize_phone(callback_number)
    if normalized_callback is None:
        raise ValueError("booking requires a valid 10-digit US callback phone number")
    callback_number = normalized_callback
    caller_name = _clean_field(caller_name)
    if not caller_name:
        raise ValueError("booking requires the caller's full name")
    try:
        normalized_dob = normalize_dob(caller_dob)
    except PatientIdentityError as exc:
        raise ValueError("booking requires DOB in YYYY-MM-DD format") from exc
    caller_email = normalize_email(_clean_field(caller_email))

    # The local registry is the identity and booking ledger. It is deliberately
    # resolved before any provider insert, and the appointment row allocates
    # its opaque ID before Google is contacted.
    registry = PatientRegistry.from_env()

    patient_resolution = await asyncio.to_thread(
        registry.resolve_patient,
        name=caller_name,
        dob=normalized_dob,
        phone=callback_number,
        email=caller_email,
        patient_id=patient_id,
        create_if_missing=create_if_missing,
    )
    patient = patient_resolution.patient
    if patient is None:
        raise PatientIdentityError(
            "no_match",
            "No existing patient matched; explicit new-patient creation is required.",
        )

    calendar_id = getattr(client, "calendar_id", "primary")
    if not isinstance(calendar_id, str) or not calendar_id:
        calendar_id = "primary"
    booking_key = idempotency_key or "|".join(
        (source, call_id, patient.patient_id, slot.start_iso, slot.end_iso)
    )
    appointment = await asyncio.to_thread(
        registry.reserve_appointment,
        patient_id=patient.patient_id,
        start=slot.start_iso,
        end=slot.end_iso,
        appointment_type=appointment_type,
        provider=provider,
        calendar_id=calendar_id,
        source=source,
        idempotency_key=booking_key,
    )
    if appointment.google_event_id and appointment.status in {"pending", "confirmed"}:
        return BookingResult(
            event_id=appointment.google_event_id,
            start_iso=appointment.start,
            end_iso=appointment.end,
            html_link="",
            patient_id=appointment.patient_id,
            appointment_id=appointment.appointment_id,
        )

    # Race detection: re-query free/busy for JUST this slot
    busy_now = await client.free_busy(start, end)
    if busy_now:
        logger.info(
            "Slot taken between check_availability and book_appointment: %s",
            slot.start_iso,
            extra={"call_id": call_id, "component": "booking.booking"},
        )
        await asyncio.to_thread(
            registry.update_appointment_status, appointment.appointment_id, "failed"
        )
        raise SlotNoLongerAvailableError(slot.start_iso)

    # Build the event description. UNVERIFIED tag is permanent and intentional —
    # staff viewing the event need to see that the AI took this booking without
    # identity verification.
    booked_at = datetime.now(timezone.utc).isoformat()
    callback_number = _clean_field(callback_number)
    description_lines = [
        "[via AI receptionist / UNVERIFIED]",
        f"Patient: {caller_name}",
        f"Phone: {callback_number}",
        f"Email: {caller_email or '(none)'}",
        f"Booked: {booked_at}",
        f"Call ID: {call_id}",
    ]
    description = "\n".join(description_lines)

    summary = f"Appointment: {caller_name}"

    try:
        result = await client.create_event(
            start=start,
            end=end,
            summary=summary,
            description=description,
            time_zone=time_zone,
            # Email is identity evidence, not consent to send a calendar
            # invitation. Invitation delivery must be an explicit workflow.
            attendee_email=caller_email if (invite_caller is True or (invite_caller is None and caller_email)) else None,
            patient_id=patient.patient_id,
            appointment_id=appointment.appointment_id,
            source=source,
        )
    except Exception:
        await asyncio.to_thread(
            registry.update_appointment_status, appointment.appointment_id, "failed"
        )
        raise

    google_event_id = str(result.get("id") or "").strip()
    if not google_event_id:
        raise ValueError("Google did not return an event ID")
    await asyncio.to_thread(
        registry.update_appointment_google_event,
        appointment.appointment_id,
        google_event_id=google_event_id,
        status="confirmed",
    )

    logger.info(
        "Appointment booked: event_id=%s at %s",
        result["id"], slot.start_iso,
        extra={"call_id": call_id, "component": "booking.booking"},
    )

    return BookingResult(
        event_id=google_event_id,
        start_iso=slot.start_iso,
        end_iso=slot.end_iso,
        html_link=result.get("htmlLink", ""),
        patient_id=patient.patient_id,
        appointment_id=appointment.appointment_id,
    )
