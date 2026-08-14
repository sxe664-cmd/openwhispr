import sqlite3
from datetime import datetime
from types import SimpleNamespace

from receptionist.desktop_config import _calendar_feed_event, _stored_appointment_event
from receptionist.reminders.calendar_google import event_from_google
from receptionist.reminders.identity import (
    RECOVERED_CONTACT_SOURCE,
    extract_patient_metadata,
)
from receptionist.reminders.models import AppointmentEvent
from receptionist.reminders.scheduler import _contact_match_keys
from receptionist.reminders.store import ReminderStore


def test_extract_patient_metadata_returns_only_the_sanitized_contract() -> None:
    description = """Internal scheduling text that must not leave the sidecar.
[OpenWhispr Patient]
Name: Alex Morgan
Email: ALEX.MORGAN@example.com
Phone: +1 (212) 555-0199
[/OpenWhispr Patient]
More private notes that must not leave the sidecar.
"""

    assert extract_patient_metadata(description) == {
        "name": "Alex Morgan",
        "email": "alex.morgan@example.com",
        "phone": "+12125550199",
        "source": RECOVERED_CONTACT_SOURCE,
    }


def test_extract_patient_metadata_rejects_malformed_and_ambiguous_blocks() -> None:
    invalid_descriptions = (
        "[OpenWhispr Patient]\nEmail: alex@example.com",
        "[OpenWhispr Patient]\nEmail: alex@example.com\n[/OpenWhispr Patient]\n"
        "[OpenWhispr Patient]\nEmail: sam@example.com\n[/OpenWhispr Patient]",
        "[OpenWhispr Patient]\nEmail: alex@example.com\nUnknown: value\n[/OpenWhispr Patient]",
        "[OpenWhispr Patient]\nEmail: alex@example.com\nEmail: sam@example.com\n[/OpenWhispr Patient]",
        "[OpenWhispr Patient]\nEmail: not-an-email\n[/OpenWhispr Patient]",
        "[OpenWhispr Patient]\nEmail: alex@example.com\n[/OpenWhispr Patient]\n"
        "[OpenWhispr Patient]",
    )

    for description in invalid_descriptions:
        assert extract_patient_metadata(description) is None


def test_extract_patient_metadata_rejects_overlong_blocks_and_values() -> None:
    overlong_block = "[OpenWhispr Patient]\nEmail: alex@example.com\nName: " + ("A" * 500) + "\n[/OpenWhispr Patient]"
    overlong_phone = "[OpenWhispr Patient]\nEmail: alex@example.com\nPhone: " + ("1" * 33) + "\n[/OpenWhispr Patient]"

    assert extract_patient_metadata(overlong_block) is None
    assert extract_patient_metadata(overlong_phone) is None


def test_calendar_feed_safely_excludes_private_provenance() -> None:
    raw_note_sentinel = "RAW-DESCRIPTION-MUST-NOT-LEAVE-SIDECAR"
    event = SimpleNamespace(
        calendar_id="calendar-1",
        event_id="event-1",
        event_uid="uid-1",
        start=datetime(2026, 8, 14, 9, 0),
        end=datetime(2026, 8, 14, 9, 30),
        timezone="America/New_York",
        summary="Consultation",
        attendee_emails=("existing-attendee@example.com",),
        has_self_attendee=True,
        recurring=False,
        all_day=False,
        status="confirmed",
        conference_url=None,
        html_link=None,
        notes=(
            f"{raw_note_sentinel}\n"
            "[OpenWhispr Patient]\n"
            "Name: Alex Morgan\n"
            "Email: alex@example.com\n"
            "[/OpenWhispr Patient]"
        ),
    )

    safe_projected = _calendar_feed_event(event)
    private_projected = _calendar_feed_event(event, include_private_provenance=True)

    assert "patient_metadata" not in safe_projected
    assert "self_attendee_present" not in safe_projected
    assert private_projected["patient_metadata"] == {
        "name": "Alex Morgan",
        "email": "alex@example.com",
        "phone": None,
        "source": RECOVERED_CONTACT_SOURCE,
    }
    assert private_projected["self_attendee_present"] is True
    assert raw_note_sentinel not in repr(safe_projected)
    assert raw_note_sentinel not in repr(private_projected)
    assert "notes" not in safe_projected
    assert "notes" not in private_projected


def _google_event(*attendees: object, description: str = "") -> dict:
    return {
        "id": "google-event-1",
        "iCalUID": "google-event-1@example.com",
        "summary": "Consultation",
        "start": {
            "dateTime": "2026-08-14T09:00:00-04:00",
            "timeZone": "America/New_York",
        },
        "end": {
            "dateTime": "2026-08-14T09:30:00-04:00",
            "timeZone": "America/New_York",
        },
        "attendees": list(attendees),
        "description": description,
    }


def test_google_self_only_attendees_emit_no_attendee_email() -> None:
    event = event_from_google(
        _google_event({"email": "clinician@example.com", "self": True}),
        calendar_id="calendar-1",
        timezone_name="America/New_York",
    )

    assert event.attendee_emails == ()
    assert event.contact_match_keys == ()
    assert event.has_self_attendee is True


def test_google_self_attendee_is_excluded_but_external_attendee_is_retained() -> None:
    event = event_from_google(
        _google_event(
            {"email": "clinician@example.com", "self": True},
            {"email": "PATIENT@Example.COM", "self": False},
        ),
        calendar_id="calendar-1",
        timezone_name="America/New_York",
    )

    assert event.attendee_emails == ("patient@example.com",)
    assert event.contact_match_keys == ("patient@example.com",)
    assert event.has_self_attendee is True


def test_google_external_attendees_preserve_existing_reminder_fields() -> None:
    description = "Email: patient@example.com\nReminder details remain available internally."
    event = event_from_google(
        _google_event(
            {"email": "PATIENT@Example.COM", "responseStatus": "accepted"},
            description=description,
        ),
        calendar_id="calendar-1",
        timezone_name="America/New_York",
    )

    assert event.attendee_emails == ("patient@example.com",)
    assert event.contact_match_keys == ("patient@example.com",)
    assert event.notes == description
    assert event.contact_email == "patient@example.com"
    assert event.contact_email_source == RECOVERED_CONTACT_SOURCE
    assert event.has_self_attendee is False


def test_google_missing_or_non_list_attendees_have_unknown_provenance() -> None:
    missing = _google_event()
    missing.pop("attendees")
    non_list = _google_event()
    non_list["attendees"] = "not-a-list"

    for item in (missing, non_list):
        event = event_from_google(
            item,
            calendar_id="calendar-1",
            timezone_name="America/New_York",
        )
        assert event.has_self_attendee is None
        assert event.attendee_emails == ()
        assert event.contact_match_keys == ()


def test_google_empty_list_and_omitted_self_are_valid_no_self() -> None:
    empty = event_from_google(
        _google_event(),
        calendar_id="calendar-1",
        timezone_name="America/New_York",
    )
    omitted_self = event_from_google(
        _google_event({"email": "PATIENT@example.com"}),
        calendar_id="calendar-1",
        timezone_name="America/New_York",
    )

    assert empty.has_self_attendee is False
    assert omitted_self.has_self_attendee is False
    assert omitted_self.attendee_emails == ("patient@example.com",)
    assert omitted_self.contact_match_keys == ("patient@example.com",)


def test_google_malformed_attendee_provenance_keeps_existing_external_filtering() -> None:
    non_object = event_from_google(
        _google_event("not-an-attendee", {"email": "PATIENT@example.com", "self": False}),
        calendar_id="calendar-1",
        timezone_name="America/New_York",
    )
    malformed_self = event_from_google(
        _google_event({"email": "PATIENT@example.com", "self": "false"}),
        calendar_id="calendar-1",
        timezone_name="America/New_York",
    )

    assert non_object.has_self_attendee is None
    assert non_object.attendee_emails == ("patient@example.com",)
    assert non_object.contact_match_keys == ("patient@example.com",)
    assert malformed_self.has_self_attendee is None
    assert malformed_self.attendee_emails == ("patient@example.com",)
    assert malformed_self.contact_match_keys == ("patient@example.com",)


def _stored_event(*, event_id: str, has_self_attendee: bool | None) -> AppointmentEvent:
    return AppointmentEvent(
        source="google",
        calendar_id="calendar-1",
        event_id=event_id,
        event_uid=f"{event_id}@example.com",
        summary="Consultation",
        notes="Internal reminder note",
        start=datetime(2026, 8, 14, 9, 0),
        end=datetime(2026, 8, 14, 9, 30),
        timezone="America/New_York",
        attendee_emails=("patient@example.com",),
        contact_match_keys=("patient@example.com",),
        has_self_attendee=has_self_attendee,
    )


def test_reminder_store_round_trips_self_attendee_provenance(tmp_path) -> None:
    store = ReminderStore(tmp_path / "reminders.sqlite")
    for index, presence in enumerate((True, False, None)):
        store.upsert_event(_stored_event(event_id=f"event-{index}", has_self_attendee=presence))

    records = {record["event_id"]: record for record in store.list_events(limit=10)}
    for index, presence in enumerate((True, False, None)):
        record = records[f"event-{index}"]
        assert record["self_attendee_present"] is presence
        restored = _stored_appointment_event(record)
        assert restored.attendee_emails == ("patient@example.com",)
        assert restored.contact_match_keys == ("patient@example.com",)
        assert restored.has_self_attendee is presence
        active = store.get_active_google_event(calendar_id="calendar-1", event_id=f"event-{index}")
        assert active is not None
        assert active.has_self_attendee is presence


def test_reminder_store_cache_replay_restores_non_attendee_contact_key(tmp_path) -> None:
    store = ReminderStore(tmp_path / "contact-key-cache.sqlite")
    event = AppointmentEvent(
        source="google",
        calendar_id="calendar-1",
        event_id="event-contact-key",
        event_uid="event-contact-key@example.com",
        summary="Contact-key consultation",
        notes="Internal reminder note",
        start=datetime(2026, 8, 14, 9, 0),
        end=datetime(2026, 8, 14, 9, 30),
        timezone="America/New_York",
        attendee_emails=(),
        contact_match_keys=("  CRM-Patient-42  ",),
        has_self_attendee=None,
    )

    store.upsert_event(event)

    record = store.list_events(limit=10)[0]
    assert record["attendee_emails"] == []
    assert record["contact_match_keys"] == ("crm-patient-42",)
    assert record["self_attendee_present"] is None

    restored = _stored_appointment_event(record)
    assert restored.attendee_emails == ()
    assert restored.contact_match_keys == ("crm-patient-42",)
    assert restored.has_self_attendee is None
    assert "crm-patient-42" in _contact_match_keys(restored)


def test_reminder_store_upgrade_leaves_legacy_self_attendee_provenance_null(tmp_path) -> None:
    path = tmp_path / "legacy-reminders.sqlite"
    store = ReminderStore(path)
    store.upsert_event(_stored_event(event_id="legacy-event", has_self_attendee=True))

    with sqlite3.connect(path) as conn:
        conn.execute("ALTER TABLE events RENAME TO events_current")
        conn.execute(
            """
            CREATE TABLE events (
                source TEXT NOT NULL, calendar_id TEXT NOT NULL, event_id TEXT NOT NULL,
                event_uid TEXT NOT NULL, summary TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
                start_iso TEXT NOT NULL, end_iso TEXT NOT NULL, timezone TEXT NOT NULL,
                attendee_emails TEXT NOT NULL, contact_match_keys TEXT NOT NULL DEFAULT '',
                contact_email TEXT, contact_email_source TEXT, contact_email_recovered_at TEXT,
                cancelled INTEGER NOT NULL DEFAULT 0, recurring INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (source, calendar_id, event_id, start_iso)
            )
            """
        )
        conn.execute(
            """
            INSERT INTO events(
                source, calendar_id, event_id, event_uid, summary, notes, start_iso, end_iso,
                timezone, attendee_emails, contact_match_keys, contact_email,
                contact_email_source, contact_email_recovered_at, cancelled, recurring, updated_at
            )
            SELECT source, calendar_id, event_id, event_uid, summary, notes, start_iso, end_iso,
                   timezone, attendee_emails, contact_match_keys, contact_email,
                   contact_email_source, contact_email_recovered_at, cancelled, recurring, updated_at
            FROM events_current
            """
        )
        conn.execute("DROP TABLE events_current")

    upgraded = ReminderStore(path)
    record = upgraded.list_events(limit=10)[0]
    assert record["self_attendee_present"] is None
    assert _stored_appointment_event(record).has_self_attendee is None
    with upgraded.connect() as conn:
        column = next(row for row in conn.execute("PRAGMA table_info(events)") if row["name"] == "self_attendee_present")
    assert column["dflt_value"] is None
