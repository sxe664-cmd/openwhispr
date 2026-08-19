from datetime import datetime
from types import SimpleNamespace

from receptionist.reminders.models import AppointmentEvent, ReminderRecipient
from receptionist.reminders.scheduler import _delivery_status, registry_recipient_for_event
from receptionist.patient_registry import PatientRegistry


class _Registry:
    def get_patient(self, patient_id: str):
        assert patient_id == "patient-alex"
        return SimpleNamespace(
            patient_id="patient-alex",
            name="Alex Morgan",
            email="alex@example.com",
            phone="+15551234567",
            sms_consent_status="opted_in",
        )


def test_linked_followup_reminders_use_registry_contacts() -> None:
    event = AppointmentEvent(
        source="google",
        calendar_id="primary",
        event_id="event-followup",
        event_uid="event-followup@example.com",
        summary="Alex Morgan",
        start=datetime(2026, 8, 20, 15, 0),
        end=datetime(2026, 8, 20, 15, 30),
        timezone="America/New_York",
        notes="DOB: 1990-04-12",
        patient_id="patient-alex",
        appointment_id="appointment-followup",
    )

    recipient = registry_recipient_for_event(_Registry(), event)

    assert recipient is not None
    assert recipient.recipient_id == "patient-alex"
    assert recipient.display_name == "Alex Morgan"
    assert recipient.email == "alex@example.com"
    assert recipient.phone == "+15551234567"
    assert recipient.preferred_channels == ("email", "sms")
    assert recipient.sms_consent_status == "opted_in"
    assert recipient.consent_source == "patient_registry"


def test_registry_contact_channels_fail_independently_and_opt_out_wins() -> None:
    config = SimpleNamespace()
    recipient = ReminderRecipient(
        recipient_id="patient-alex",
        display_name="Alex Morgan",
        phone="+12125551234",
        sms_consent_status="opted_in",
    )

    assert _delivery_status(config, recipient, "email") == ("skipped", "missing_email")
    assert _delivery_status(config, recipient, "sms") == ("scheduled", None)

    opted_out = ReminderRecipient(
        **{**recipient.__dict__, "sms_consent_status": "opted_out"}
    )
    assert _delivery_status(config, opted_out, "sms") == ("suppressed", "sms_not_opted_in")

    email_only = ReminderRecipient(
        recipient_id="patient-alex",
        display_name="Alex Morgan",
        email="alex@example.com",
        sms_consent_status="opted_in",
    )
    assert _delivery_status(config, email_only, "email") == ("scheduled", None)
    assert _delivery_status(config, email_only, "sms") == ("skipped", "missing_phone")


def test_registry_appointment_reschedule_keeps_the_same_appointment(tmp_path) -> None:
    registry = PatientRegistry(tmp_path / "registry.sqlite3")
    patient = registry.create_patient(
        name="Alex Morgan",
        dob="1990-04-12",
        email="alex@example.com",
        phone="+12125551234",
    )
    appointment = registry.reserve_appointment(
        patient_id=patient.patient_id,
        start="2026-08-20T15:00:00Z",
        end="2026-08-20T15:30:00Z",
        calendar_id="primary",
        idempotency_key="calendar:google:primary:event-alex",
        appointment_id="appointment-alex",
    )

    moved = registry.update_appointment_schedule(
        appointment.appointment_id,
        start="2026-08-27T15:00:00Z",
        end="2026-08-27T15:30:00Z",
    )

    assert moved.appointment_id == appointment.appointment_id
    assert moved.patient_id == patient.patient_id
    assert moved.start == "2026-08-27T15:00:00Z"
    assert moved.end == "2026-08-27T15:30:00Z"
