import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import receptionist.desktop_config as desktop_config
from receptionist.reminders.models import AppointmentEvent
from receptionist.reminders.store import (
    MANUAL_CLAIM_TIMEOUT_SECONDS,
    ReminderStore,
)


def _event() -> AppointmentEvent:
    return AppointmentEvent(
        source="google",
        calendar_id="primary",
        event_id="event-manual-reminder",
        event_uid="event-manual-reminder@example.com",
        summary="Alex Morgan",
        start=datetime(2026, 8, 20, 15, 0, tzinfo=timezone.utc),
        end=datetime(2026, 8, 20, 15, 30, tzinfo=timezone.utc),
        timezone="America/New_York",
        attendee_emails=("alex@example.com",),
    )


def _status_request(event: AppointmentEvent) -> list[dict[str, str]]:
    return [
        {
            "key": "google:primary:event-manual-reminder:2026-08-20T15:00:00+00:00",
            "calendar_id": event.calendar_id,
            "event_id": event.event_id,
            "event_uid": event.event_uid,
            "start_iso": event.start.isoformat(),
        }
    ]


def _provider_failure() -> None:
    raise RuntimeError("provider unavailable")


def test_manual_send_persists_status_and_is_idempotent(tmp_path) -> None:
    store_path = tmp_path / "reminders.sqlite3"
    store = ReminderStore(store_path)
    event = _event()
    provider_calls = []

    result, already_sent = desktop_config._run_manual_send(
        store=store,
        event=event,
        channel="email",
        provider="fake",
        send=lambda: provider_calls.append("email") or {"message_id": "fake-1"},
    )

    assert result == {"message_id": "fake-1"}
    assert already_sent is False

    reloaded = ReminderStore(store_path)
    statuses = reloaded.get_reminder_statuses(_status_request(event))
    assert statuses[next(iter(statuses))] == {"email": True, "sms": False}

    duplicate_result, duplicate_already_sent = desktop_config._run_manual_send(
        store=reloaded,
        event=event,
        channel="email",
        provider="fake",
        send=lambda: provider_calls.append("duplicate"),
    )

    assert duplicate_result is None
    assert duplicate_already_sent is True
    assert provider_calls == ["email"]


def test_manual_channels_are_tracked_independently(tmp_path) -> None:
    store = ReminderStore(tmp_path / "reminders.sqlite3")
    event = _event()

    desktop_config._run_manual_send(
        store=store,
        event=event,
        channel="email",
        provider="fake",
        send=lambda: {"channel": "email"},
    )
    desktop_config._run_manual_send(
        store=store,
        event=event,
        channel="sms",
        provider="fake",
        send=lambda: {"channel": "sms"},
    )

    statuses = ReminderStore(store.path).get_reminder_statuses(_status_request(event))
    assert statuses[next(iter(statuses))] == {"email": True, "sms": True}


def test_calendar_sync_does_not_overwrite_an_in_progress_manual_send(tmp_path) -> None:
    store = ReminderStore(tmp_path / "reminders.sqlite3")
    event = _event()
    store.upsert_job(
        event=event,
        recipient=None,
        channel="sms",
        offset_days=0,
        due_at=event.start.isoformat(),
        status="scheduled",
        reason="scheduled",
    )

    claim = store.claim_manual_slot(event=event, channel="sms")
    assert claim is not None
    assert claim["job"] is not None

    store.upsert_job(
        event=event,
        recipient=None,
        channel="sms",
        offset_days=0,
        due_at=event.start.isoformat(),
        status="scheduled",
        reason="scheduled",
    )

    with store.connect() as conn:
        row = conn.execute(
            "SELECT status, reason, claimed_at FROM reminder_jobs WHERE id=?",
            (claim["job"].id,),
        ).fetchone()
    assert dict(row) == {
        "status": "claimed",
        "reason": "manual_send_pending",
        "claimed_at": claim["claim_token"],
    }

    assert store.complete_manual_slot(
        job_id=claim["job"].id,
        claim_token=claim["claim_token"],
        provider="fake",
        detail="sync race test",
    )


def test_failed_manual_send_releases_claim_for_retry(tmp_path) -> None:
    store = ReminderStore(tmp_path / "reminders.sqlite3")
    event = _event()

    with pytest.raises(RuntimeError, match="provider unavailable"):
        desktop_config._run_manual_send(
            store=store,
            event=event,
            channel="sms",
            provider="fake",
            send=_provider_failure,
        )

    statuses = store.get_reminder_statuses(_status_request(event))
    assert statuses[next(iter(statuses))] == {"email": False, "sms": False}
    assert [job.status for job in store.list_jobs(phase="manual")] == ["failed"]

    result, already_sent = desktop_config._run_manual_send(
        store=store,
        event=event,
        channel="sms",
        provider="fake",
        send=lambda: {"channel": "sms"},
    )

    assert result == {"channel": "sms"}
    assert already_sent is False
    assert store.get_reminder_statuses(_status_request(event))[next(iter(statuses))]["sms"] is True


def test_stale_manual_claim_is_recovered(tmp_path) -> None:
    store = ReminderStore(tmp_path / "reminders.sqlite3")
    event = _event()
    first_claim = store.claim_manual_slot(event=event, channel="sms")
    assert first_claim is not None
    assert first_claim["job"] is not None

    stale_time = datetime.now(timezone.utc) - timedelta(seconds=MANUAL_CLAIM_TIMEOUT_SECONDS + 1)
    with store.connect() as conn:
        conn.execute(
            "UPDATE reminder_jobs SET claimed_at=? WHERE id=?",
            (f"manual:{stale_time.isoformat()}", first_claim["job"].id),
        )

    recovered_claim = store.claim_manual_slot(event=event, channel="sms")
    assert recovered_claim is not None
    assert recovered_claim.get("busy") is not True
    assert recovered_claim.get("already_sent") is not True

    assert store.complete_manual_slot(
        job_id=recovered_claim["job"].id,
        claim_token=recovered_claim["claim_token"],
        provider="fake",
        detail="recovered test send",
    )
    with store.connect() as conn:
        attempts = conn.execute(
            "SELECT status, detail FROM reminder_attempts ORDER BY id"
        ).fetchall()
    assert [row["status"] for row in attempts] == ["failed", "sent"]


def test_reminder_status_command_reads_persisted_store(tmp_path, monkeypatch, capsys) -> None:
    store_path = tmp_path / "reminders.sqlite3"
    store = ReminderStore(store_path)
    event = _event()
    claim = store.claim_manual_slot(event=event, channel="email")
    assert claim is not None
    assert store.complete_manual_slot(
        job_id=claim["job"].id,
        claim_token=claim["claim_token"],
        provider="fake",
        detail="status command test",
    )

    config = SimpleNamespace(reminders=SimpleNamespace(store_path=str(store_path)))
    monkeypatch.setattr(desktop_config, "_load_app_config", lambda: config)
    desktop_config.reminder_statuses(
        SimpleNamespace(events_json=json.dumps(_status_request(event)))
    )

    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["statuses"][next(iter(payload["statuses"]))] == {
        "email": True,
        "sms": False,
    }
