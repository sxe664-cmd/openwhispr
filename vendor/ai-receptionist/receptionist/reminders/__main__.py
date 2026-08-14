from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

from receptionist.booking.auth import build_credentials
from receptionist.booking.appointments import AppointmentChangeService
from receptionist.booking.client import GoogleCalendarClient
from receptionist.config import load_app_config
from receptionist.reminders.calendar_apple import import_ics
from receptionist.reminders.calendar_google import (
    list_google_event_batch,
    normalize_google_batch,
)
from receptionist.reminders.contacts import load_contacts
from receptionist.reminders.delivery import ReminderDispatcher
from receptionist.reminders.models import CalendarSyncBatch
from receptionist.reminders.scheduler import parse_now, sync_events
from receptionist.reminders.store import ReminderStore


load_dotenv(".env.local")
load_dotenv(".env")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m receptionist.reminders")
    sub = parser.add_subparsers(dest="command", required=True)

    for name in ("init-db", "sync", "run-due", "list"):
        p = sub.add_parser(name)

    contacts = sub.add_parser("contacts")
    contacts_sub = contacts.add_subparsers(dest="contacts_command", required=True)
    contacts_import = contacts_sub.add_parser("import")

    sync_p = sub.choices["sync"]
    sync_p.add_argument("--fixture", help="Google JSON fixture with items[] for local tests")
    sync_p.add_argument("--ics", help="Apple .ics file to import")
    sync_p.add_argument("--now", help="Injected current time")

    run_due = sub.choices["run-due"]
    run_due.add_argument("--now", help="Injected current time")
    run_due.add_argument("--limit", type=int, default=100)

    list_p = sub.choices["list"]
    list_p.add_argument("--status")

    args = parser.parse_args(argv)
    from receptionist.runtime import ensure_app_runtime
    ensure_app_runtime()
    config = load_app_config()
    store = ReminderStore(config.reminders.store_path)

    if args.command == "init-db":
        store.init_db()
        print(f"Initialized reminder store: {store.path}")
        return 0
    if args.command == "contacts":
        loaded = load_contacts(config.reminders.contacts_path)
        count = store.import_recipients(loaded)
        print(f"Imported contacts: {count}")
        return 0
    if args.command == "sync":
        count = asyncio.run(_sync(config, store, fixture=args.fixture, ics=args.ics, now=args.now))
        print(f"Synced events: {count}")
        return 0
    if args.command == "run-due":
        now = parse_now(args.now, config.business.timezone).astimezone(__import__("datetime").timezone.utc)
        appointment_changes = None
        if config.calendar is not None and config.calendar.enabled:
            creds = build_credentials(config.calendar.auth)
            client = GoogleCalendarClient(creds, config.calendar.calendar_id)
            appointment_changes = AppointmentChangeService(
                config=config,
                client=client,
                store=store,
            )
            # Recover provider-side changes before claiming reminders. This
            # prevents a stale job from being delivered after a successful
            # calendar mutation whose local follow-up was interrupted.
            asyncio.run(appointment_changes.reconcile_pending_operations())
        sent = asyncio.run(ReminderDispatcher(config, store).dispatch_due(now_iso=now.isoformat(), limit=args.limit))
        if appointment_changes is not None:
            sent += asyncio.run(
                appointment_changes.dispatch_pending_notifications()
            )
        print(f"Dispatched reminders: {sent}")
        return 0
    if args.command == "list":
        for job in store.list_jobs(status=args.status):
            print(f"{job.id}\t{job.phase}\t{job.status}\t{job.channel}\t{job.due_at}\t{job.reason or ''}\t{job.idempotency_key}")
        return 0
    return 2


async def _sync(config, store: ReminderStore, *, fixture: str | None, ics: str | None, now: str | None) -> int:
    contacts = load_contacts(config.reminders.contacts_path)
    current = parse_now(now, config.business.timezone)
    if fixture:
        raw = json.loads(Path(fixture).read_text(encoding="utf-8"))
        items = raw.get("items", raw if isinstance(raw, list) else [])
        batch = normalize_google_batch(
            items,
            calendar_id=(config.calendar.calendar_id if config.calendar else "primary"),
            timezone_name=config.business.timezone,
        )
        normalized_count = len(batch.events) + len(batch.tombstones)
        if normalized_count < len(items):
            print(
                f"Warning: Google fixture normalization dropped {len(items) - normalized_count} events "
                f"(raw={len(items)} normalized={normalized_count})"
            )
    elif ics:
        batch = CalendarSyncBatch(
            events=tuple(import_ics(ics, timezone_name=config.business.timezone))
        )
    else:
        batch = await _load_configured_events(config, current=current)
    return sync_events(
        config=config,
        store=store,
        events=batch.events,
        contacts=contacts,
        now=current,
        tombstones=batch.tombstones,
    )


async def _load_configured_events(
    config,
    *,
    current,
    window_start=None,
    window_end=None,
) -> CalendarSyncBatch:
    """Load bounded reminder-source changes from the application config."""
    sources = list(config.reminders.calendar_sources)
    lookback = window_start or current - timedelta(days=config.reminders.lookback_days)
    lookahead = window_end or current + timedelta(days=config.reminders.lookahead_days)
    events = []
    tombstones = []

    if sources:
        for source in sources:
            if source.type == "google":
                if config.calendar is None or not config.calendar.enabled:
                    raise RuntimeError("reminders calendar source google requires calendar.enabled")
                creds = build_credentials(config.calendar.auth)
                client = GoogleCalendarClient(creds, source.calendar_id)
                batch = await list_google_event_batch(
                    client,
                    calendar_id=source.calendar_id,
                    time_min=lookback,
                    time_max=lookahead,
                    timezone_name=config.business.timezone,
                )
                events.extend(batch.events)
                tombstones.extend(batch.tombstones)
            elif source.type == "apple_ics":
                if not source.path:
                    raise RuntimeError("apple_ics reminder calendar source requires path")
                events.extend(
                    import_ics(
                        source.path,
                        calendar_id=source.calendar_id,
                        timezone_name=config.business.timezone,
                    )
                )
            else:
                raise RuntimeError(f"unsupported reminder calendar source: {source.type}")
        return CalendarSyncBatch(events=tuple(events), tombstones=tuple(tombstones))

    if config.calendar is None or not config.calendar.enabled:
        raise RuntimeError("Google sync requires calendar.enabled or use --fixture/--ics")

    creds = build_credentials(config.calendar.auth)
    client = GoogleCalendarClient(creds, config.calendar.calendar_id)
    return await list_google_event_batch(
        client,
        calendar_id=config.calendar.calendar_id,
        time_min=lookback,
        time_max=lookahead,
        timezone_name=config.business.timezone,
    )


if __name__ == "__main__":
    sys.exit(main())
