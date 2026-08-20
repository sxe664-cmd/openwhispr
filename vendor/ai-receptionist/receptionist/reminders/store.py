from __future__ import annotations

import sqlite3
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from receptionist.reminders.identity import (
    RECOVERED_CONTACT_SOURCE,
    extract_structured_email,
    normalize_contact_keys,
    normalize_emails,
    split_stored_values,
)
from receptionist.reminders.models import AppointmentEvent, ReminderJob, ReminderRecipient

# Version 8 added structured contact recovery. Version 9 adds phase-aware
# pre/post reminder jobs. Version 10 identifies each post follow-up preset.
# Version 11 preserves private self-attendee provenance without backfilling it.
SCHEMA_VERSION = 11

# A manual provider call is normally short-lived, but a process crash can
# leave its ledger row claimed. Reclaim after a bounded interval so a failed
# desktop process cannot permanently block a reminder channel.
MANUAL_CLAIM_TIMEOUT_SECONDS = 15 * 60


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_event_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def _manual_claim_is_stale(claimed_at: str | None, now: datetime) -> bool:
    if not claimed_at:
        return True
    raw_timestamp = claimed_at.removeprefix("manual:")
    try:
        started_at = _parse_event_datetime(raw_timestamp)
    except (TypeError, ValueError):
        return True
    return (now - started_at).total_seconds() >= MANUAL_CLAIM_TIMEOUT_SECONDS


def _self_attendee_presence(value: object) -> bool | None:
    """Normalize persisted provenance without treating unknown values as false."""
    if type(value) is bool:
        return value
    if type(value) is int and value in (0, 1):
        return bool(value)
    return None


def make_idempotency_key(
    *,
    source: str,
    calendar_id: str,
    event_uid_or_id: str,
    event_start: str,
    offset_days: int,
    channel: str,
    phase: str = "pre",
    post_followup_id: str = "",
) -> str:
    if phase == "post":
        return "|".join([source, calendar_id, event_uid_or_id, event_start, phase, post_followup_id, str(offset_days), channel])
    return "|".join([source, calendar_id, event_uid_or_id, event_start, phase, str(offset_days), channel])


_EVENTS_SCHEMA = """
CREATE TABLE events (
    source TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_uid TEXT NOT NULL,
    summary TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    start_iso TEXT NOT NULL,
    end_iso TEXT NOT NULL,
    timezone TEXT NOT NULL,
    attendee_emails TEXT NOT NULL,
    contact_match_keys TEXT NOT NULL DEFAULT '',
    self_attendee_present INTEGER,
    contact_email TEXT,
    contact_email_source TEXT,
    contact_email_recovered_at TEXT,
    cancelled INTEGER NOT NULL DEFAULT 0,
    recurring INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source, calendar_id, event_id, start_iso)
)
"""

_JOBS_SCHEMA = """
CREATE TABLE reminder_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_uid TEXT NOT NULL,
    event_summary TEXT NOT NULL DEFAULT '',
    event_start TEXT NOT NULL,
    event_end TEXT NOT NULL,
    event_timezone TEXT NOT NULL,
    recipient_id TEXT,
    channel TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'pre',
    post_followup_id TEXT NOT NULL DEFAULT '',
    offset_days INTEGER NOT NULL,
    due_at TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    claimed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""

_ATTEMPTS_SCHEMA = """
CREATE TABLE reminder_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    attempted_at TEXT NOT NULL,
    status TEXT NOT NULL,
    provider TEXT NOT NULL,
    detail TEXT,
    FOREIGN KEY(job_id) REFERENCES reminder_jobs(id)
)
"""

_APPOINTMENT_OPERATIONS_SCHEMA = """
CREATE TABLE IF NOT EXISTS appointment_operations (
    operation_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL,
    source TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    recurring_event_id TEXT,
    original_start_iso TEXT,
    previous_start_iso TEXT NOT NULL,
    previous_end_iso TEXT NOT NULL,
    requested_start_iso TEXT,
    requested_end_iso TEXT,
    etag TEXT,
    actor TEXT NOT NULL,
    call_id TEXT,
    status TEXT NOT NULL,
    result_json TEXT,
    error_code TEXT,
    error_detail TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""

_NOTIFICATION_OUTBOX_SCHEMA = """
CREATE TABLE IF NOT EXISTS appointment_notification_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    body_text TEXT NOT NULL,
    body_html TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(operation_id) REFERENCES appointment_operations(operation_id)
)
"""


class ReminderStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._initialized = False

    def connect(self) -> sqlite3.Connection:
        if self.path.parent:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=10000")
        return conn

    def init_db(self) -> None:
        # A calendar feed can upsert hundreds of occurrences and schedule
        # multiple reminder jobs for each one. Re-running the full schema and
        # normalization pass for every row turns a normal refresh into an
        # unbounded-looking operation on an established database.
        if self._initialized:
            return
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            if not self._table_exists(conn, "events"):
                self._ensure_shared_tables(conn)
                self._create_reminder_tables(conn)
            elif self._has_legacy_scope(conn):
                self._migrate_legacy_scope(conn)
            else:
                self._ensure_shared_tables(conn)
                self._ensure_current_columns(conn)
                self._ensure_operation_tables(conn)
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (SCHEMA_VERSION, utc_now_iso()),
            )
            # Version 6 is the historical reminder/contact normalization
            # marker. Keep it present for databases created by the current
            # code so older operators and migration checks can distinguish
            # the scope migration from the current schema marker.
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (6, utc_now_iso()),
            )
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (7, utc_now_iso()),
            )
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (8, utc_now_iso()),
            )
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (9, utc_now_iso()),
            )
        self._initialized = True

    @staticmethod
    def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
        return conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone() is not None

    @staticmethod
    def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
        return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}

    def _ensure_shared_tables(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS recipients (
                recipient_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                email TEXT,
                phone TEXT,
                preferred_channels TEXT NOT NULL,
                sms_consent_status TEXT NOT NULL,
                consent_source TEXT,
                consent_timestamp TEXT,
                suppressed INTEGER NOT NULL DEFAULT 0,
                match_keys TEXT NOT NULL
            )"""
        )

    def _create_reminder_tables(self, conn: sqlite3.Connection) -> None:
        conn.executescript(
            f"{_EVENTS_SCHEMA}; {_JOBS_SCHEMA}; {_ATTEMPTS_SCHEMA}; "
            f"{_APPOINTMENT_OPERATIONS_SCHEMA}; {_NOTIFICATION_OUTBOX_SCHEMA};"
        )

    def _ensure_operation_tables(self, conn: sqlite3.Connection) -> None:
        conn.executescript(f"{_APPOINTMENT_OPERATIONS_SCHEMA}; {_NOTIFICATION_OUTBOX_SCHEMA};")
        operation_columns = {
            "result_json": "TEXT",
            "error_code": "TEXT",
            "error_detail": "TEXT",
            "attempts": "INTEGER NOT NULL DEFAULT 0",
            "updated_at": "TEXT",
        }
        notification_columns = {
            "attempts": "INTEGER NOT NULL DEFAULT 0",
            "next_attempt_at": "TEXT",
            "last_error": "TEXT",
            "sent_at": "TEXT",
            "updated_at": "TEXT",
        }
        for table, columns in (
            ("appointment_operations", operation_columns),
            ("appointment_notification_outbox", notification_columns),
        ):
            existing = self._columns(conn, table)
            for column, definition in columns.items():
                if column not in existing:
                    conn.execute(
                        f"ALTER TABLE {table} ADD COLUMN {column} {definition}"
                    )

    def _has_legacy_scope(self, conn: sqlite3.Connection) -> bool:
        return "business_slug" in self._columns(conn, "events") or "business_slug" in self._columns(conn, "reminder_jobs")

    def _ensure_current_columns(self, conn: sqlite3.Connection) -> None:
        if "notes" not in self._columns(conn, "events"):
            conn.execute("ALTER TABLE events ADD COLUMN notes TEXT NOT NULL DEFAULT ''")
        if "contact_match_keys" not in self._columns(conn, "events"):
            conn.execute("ALTER TABLE events ADD COLUMN contact_match_keys TEXT NOT NULL DEFAULT ''")
            conn.execute("UPDATE events SET contact_match_keys=attendee_emails")
        if "self_attendee_present" not in self._columns(conn, "events"):
            conn.execute("ALTER TABLE events ADD COLUMN self_attendee_present INTEGER")
        if "contact_email" not in self._columns(conn, "events"):
            conn.execute("ALTER TABLE events ADD COLUMN contact_email TEXT")
        if "contact_email_source" not in self._columns(conn, "events"):
            conn.execute("ALTER TABLE events ADD COLUMN contact_email_source TEXT")
        if "contact_email_recovered_at" not in self._columns(conn, "events"):
            conn.execute("ALTER TABLE events ADD COLUMN contact_email_recovered_at TEXT")
        self._normalize_event_contact_fields(conn)
        self._recover_structured_contacts(conn)
        if "phase" not in self._columns(conn, "reminder_jobs"):
            conn.execute("ALTER TABLE reminder_jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'pre'")
        if "post_followup_id" not in self._columns(conn, "reminder_jobs"):
            conn.execute("ALTER TABLE reminder_jobs ADD COLUMN post_followup_id TEXT NOT NULL DEFAULT ''")
        self._normalize_job_phases(conn)
        if "event_summary" not in self._columns(conn, "reminder_jobs"):
            conn.execute("ALTER TABLE reminder_jobs ADD COLUMN event_summary TEXT NOT NULL DEFAULT ''")

    @staticmethod
    def _normalize_job_phases(conn: sqlite3.Connection) -> None:
        rows = conn.execute(
            "SELECT id, source, calendar_id, event_uid, event_id, event_start, offset_days, channel, phase, post_followup_id FROM reminder_jobs"
        ).fetchall()
        updates = []
        for row in rows:
            stored_phase = row["phase"]
            phase = (
                "confirmation"
                if row["offset_days"] == 0 and stored_phase in (None, "", "pre")
                else stored_phase or ("confirmation" if row["offset_days"] == 0 else "pre")
            )
            post_followup_id = row["post_followup_id"] or ("thank_you_review" if phase == "post" else "")
            key = make_idempotency_key(
                source=row["source"],
                calendar_id=row["calendar_id"],
                event_uid_or_id=row["event_uid"] or row["event_id"],
                event_start=row["event_start"],
                offset_days=row["offset_days"],
                channel=row["channel"],
                phase=phase,
                post_followup_id=post_followup_id,
            )
            updates.append((row["id"], key, phase, post_followup_id))
        if not updates:
            return
        conn.executemany(
            "UPDATE reminder_jobs SET idempotency_key=? WHERE id=?",
            [(f"__phase_migration__{job_id}", job_id) for job_id, _, _, _ in updates],
        )
        conn.executemany(
            "UPDATE reminder_jobs SET idempotency_key=?, phase=?, post_followup_id=? WHERE id=?",
            [(key, phase, followup_id, job_id) for job_id, key, phase, followup_id in updates],
        )
    @staticmethod
    def _normalize_event_contact_fields(conn: sqlite3.Connection) -> None:
        rows = conn.execute(
            "SELECT rowid, attendee_emails, contact_match_keys FROM events"
        ).fetchall()
        for row in rows:
            attendee_values = split_stored_values(row["attendee_emails"])
            attendee_emails = normalize_emails(attendee_values)
            contact_match_keys = normalize_contact_keys(
                (*split_stored_values(row["contact_match_keys"]), *attendee_values)
            )
            normalized = (",".join(attendee_emails), ",".join(contact_match_keys))
            if normalized != (row["attendee_emails"], row["contact_match_keys"]):
                conn.execute(
                    "UPDATE events SET attendee_emails=?, contact_match_keys=? WHERE rowid=?",
                    (*normalized, row["rowid"]),
                )

    @staticmethod
    def _recover_structured_contacts(conn: sqlite3.Connection) -> None:
        rows = conn.execute(
            "SELECT rowid, notes, attendee_emails, contact_email FROM events WHERE source='google'"
        ).fetchall()
        now = utc_now_iso()
        for row in rows:
            if row["contact_email"] or normalize_emails(split_stored_values(row["attendee_emails"])):
                continue
            recovered = extract_structured_email(row["notes"])
            if recovered:
                conn.execute(
                    "UPDATE events SET contact_email=?, contact_email_source=?, contact_email_recovered_at=? WHERE rowid=?",
                    (recovered, RECOVERED_CONTACT_SOURCE, now, row["rowid"]),
                )

    def _migrate_legacy_scope(self, conn: sqlite3.Connection) -> None:
        """Atomically remove legacy scope columns while preserving reminder history."""
        conn.execute("BEGIN IMMEDIATE")
        try:
            self._ensure_shared_tables(conn)
            self._create_migration_tables(conn)
            event_count, job_count, attempt_count = self._copy_legacy_rows(conn)
            self._replace_legacy_tables(conn)
            self._ensure_operation_tables(conn)
            self._verify_migration(conn, event_count, job_count, attempt_count)
            conn.execute(
                "INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (SCHEMA_VERSION, utc_now_iso()),
            )
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (6, utc_now_iso()),
            )
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (7, utc_now_iso()),
            )
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (8, utc_now_iso()),
            )
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (9, utc_now_iso()),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    def _create_migration_tables(self, conn: sqlite3.Connection) -> None:
        conn.execute(_EVENTS_SCHEMA.replace("CREATE TABLE events", "CREATE TABLE events_v3"))
        conn.execute(_JOBS_SCHEMA.replace("CREATE TABLE reminder_jobs", "CREATE TABLE reminder_jobs_v3"))
        conn.execute(
            _ATTEMPTS_SCHEMA.replace("CREATE TABLE reminder_attempts", "CREATE TABLE reminder_attempts_v3")
            .replace("REFERENCES reminder_jobs", "REFERENCES reminder_jobs_v3")
        )

    @staticmethod
    def _value(row: sqlite3.Row, name: str, default: object = "") -> object:
        return row[name] if name in row.keys() else default

    def _copy_legacy_rows(self, conn: sqlite3.Connection) -> tuple[int, int, int]:
        events = conn.execute("SELECT rowid, * FROM events").fetchall()
        event_winners: dict[tuple[str, str, str, str], sqlite3.Row] = {}
        for row in events:
            key = (row["source"], row["calendar_id"], row["event_id"], row["start_iso"])
            current = event_winners.get(key)
            if current is None or (str(row["updated_at"]), row["rowid"]) > (str(current["updated_at"]), current["rowid"]):
                event_winners[key] = row
        for row in event_winners.values():
            conn.execute(
                """
                INSERT INTO events_v3(
                    source, calendar_id, event_id, event_uid, summary, notes, start_iso, end_iso,
                    timezone, attendee_emails, contact_match_keys, self_attendee_present, contact_email, contact_email_source, contact_email_recovered_at, cancelled, recurring, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["source"], row["calendar_id"], row["event_id"], row["event_uid"],
                    row["summary"], self._value(row, "notes"), row["start_iso"], row["end_iso"],
                    row["timezone"],
                    ",".join(normalize_emails(split_stored_values(row["attendee_emails"]))),
                    ",".join(
                        normalize_contact_keys(
                            (
                                *split_stored_values(
                                    self._value(row, "contact_match_keys", "")
                                ),
                                *split_stored_values(row["attendee_emails"]),
                            )
                        )
                    ),
                    self._value(row, "self_attendee_present", None),
                    (extract_structured_email(self._value(row, "notes", "")) if not normalize_emails(split_stored_values(row["attendee_emails"])) else None),
                    (RECOVERED_CONTACT_SOURCE if extract_structured_email(self._value(row, "notes", "")) and not normalize_emails(split_stored_values(row["attendee_emails"])) else None),
                    (utc_now_iso() if extract_structured_email(self._value(row, "notes", "")) and not normalize_emails(split_stored_values(row["attendee_emails"])) else None),
                    row["cancelled"], row["recurring"], row["updated_at"],
                ),
            )

        jobs = conn.execute("SELECT * FROM reminder_jobs").fetchall()
        job_winners: dict[str, sqlite3.Row] = {}
        for row in jobs:
            row_phase = self._value(row, "phase", "confirmation" if row["offset_days"] == 0 else "pre")
            row_followup_id = self._value(row, "post_followup_id", "thank_you_review" if row_phase == "post" else "")
            key = make_idempotency_key(
                source=row["source"],
                calendar_id=row["calendar_id"],
                event_uid_or_id=row["event_uid"] or row["event_id"],
                event_start=row["event_start"],
                offset_days=row["offset_days"],
                channel=row["channel"],
                phase=row_phase,
                post_followup_id=row_followup_id,
            )
            current = job_winners.get(key)
            if current is None:
                job_winners[key] = row
                continue
            rank = (row["status"] == "sent", str(row["updated_at"]), row["id"])
            current_rank = (current["status"] == "sent", str(current["updated_at"]), current["id"])
            if rank > current_rank:
                job_winners[key] = row

        job_id_map: dict[int, int] = {}
        for key, row in job_winners.items():
            conn.execute(
                """
                INSERT INTO reminder_jobs_v3(
                    id, idempotency_key, source, calendar_id, event_id, event_uid, event_summary,
                    event_start, event_end, event_timezone, recipient_id, channel, phase, post_followup_id, offset_days,
                    due_at, status, reason, claimed_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"], key, row["source"], row["calendar_id"], row["event_id"], row["event_uid"],
                    self._value(row, "event_summary"), row["event_start"], row["event_end"],
                    row["event_timezone"], row["recipient_id"], row["channel"],
                    row_phase, row_followup_id,
                    row["offset_days"],
                    row["due_at"], row["status"], row["reason"], row["claimed_at"],
                    row["created_at"], row["updated_at"],
                ),
            )
        for row in jobs:
            row_phase = self._value(row, "phase", "confirmation" if row["offset_days"] == 0 else "pre")
            row_followup_id = self._value(row, "post_followup_id", "thank_you_review" if row_phase == "post" else "")
            key = make_idempotency_key(
                source=row["source"], calendar_id=row["calendar_id"],
                event_uid_or_id=row["event_uid"] or row["event_id"], event_start=row["event_start"],
                offset_days=row["offset_days"], channel=row["channel"],
                phase=row_phase,
                post_followup_id=row_followup_id,
            )
            job_id_map[row["id"]] = job_winners[key]["id"]

        attempts = conn.execute("SELECT * FROM reminder_attempts").fetchall()
        for row in attempts:
            conn.execute(
                "INSERT INTO reminder_attempts_v3(id, job_id, attempted_at, status, provider, detail) VALUES (?, ?, ?, ?, ?, ?)",
                (row["id"], job_id_map[row["job_id"]], row["attempted_at"], row["status"], row["provider"], row["detail"]),
            )
        return len(event_winners), len(job_winners), len(attempts)

    def _replace_legacy_tables(self, conn: sqlite3.Connection) -> None:
        conn.execute("DROP TABLE reminder_attempts")
        conn.execute("DROP TABLE reminder_jobs")
        conn.execute("DROP TABLE events")
        conn.execute("ALTER TABLE events_v3 RENAME TO events")
        conn.execute("ALTER TABLE reminder_jobs_v3 RENAME TO reminder_jobs")
        conn.execute("ALTER TABLE reminder_attempts_v3 RENAME TO reminder_attempts")

    def _verify_migration(self, conn: sqlite3.Connection, events: int, jobs: int, attempts: int) -> None:
        actual = (
            conn.execute("SELECT COUNT(*) FROM events").fetchone()[0],
            conn.execute("SELECT COUNT(*) FROM reminder_jobs").fetchone()[0],
            conn.execute("SELECT COUNT(*) FROM reminder_attempts").fetchone()[0],
        )
        if actual != (events, jobs, attempts):
            raise RuntimeError(f"reminder migration verification failed: expected {(events, jobs, attempts)}, got {actual}")
        if any(conn.execute("PRAGMA foreign_key_check").fetchall()):
            raise RuntimeError("reminder migration foreign key check failed")

    def import_recipients(self, recipients: Iterable[ReminderRecipient]) -> int:
        self.init_db()
        count = 0
        with self.connect() as conn:
            for r in recipients:
                conn.execute(
                    """
                    INSERT INTO recipients(recipient_id, display_name, email, phone, preferred_channels,
                        sms_consent_status, consent_source, consent_timestamp, suppressed, match_keys)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(recipient_id) DO UPDATE SET
                        display_name=excluded.display_name, email=excluded.email, phone=excluded.phone,
                        preferred_channels=excluded.preferred_channels, sms_consent_status=excluded.sms_consent_status,
                        consent_source=excluded.consent_source, consent_timestamp=excluded.consent_timestamp,
                        suppressed=excluded.suppressed, match_keys=excluded.match_keys
                    """,
                    (r.recipient_id, r.display_name, r.email, r.phone, ",".join(r.preferred_channels),
                     r.sms_consent_status, r.consent_source, r.consent_timestamp, int(r.suppressed), ",".join(r.match_keys)),
                )
                count += 1
        return count

    def begin_appointment_operation(
        self,
        *,
        operation_id: str,
        idempotency_key: str,
        action: str,
        source: str,
        calendar_id: str,
        event_id: str,
        recurring_event_id: str | None,
        original_start_iso: str | None,
        previous_start_iso: str,
        previous_end_iso: str,
        requested_start_iso: str | None,
        requested_end_iso: str | None,
        etag: str | None,
        actor: str,
        call_id: str | None,
    ) -> dict:
        """Create an idempotent operation intent or return the existing one."""
        self.init_db()
        now = utc_now_iso()
        with self.connect() as conn:
            existing = conn.execute(
                "SELECT * FROM appointment_operations WHERE idempotency_key=?",
                (idempotency_key,),
            ).fetchone()
            if existing is not None:
                return dict(existing)
            conn.execute(
                """
                INSERT INTO appointment_operations(
                    operation_id, idempotency_key, action, source, calendar_id, event_id,
                    recurring_event_id, original_start_iso, previous_start_iso, previous_end_iso,
                    requested_start_iso, requested_end_iso, etag, actor, call_id, status,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                """,
                (
                    operation_id, idempotency_key, action, source, calendar_id, event_id,
                    recurring_event_id, original_start_iso, previous_start_iso, previous_end_iso,
                    requested_start_iso, requested_end_iso, etag, actor, call_id, now, now,
                ),
            )
            row = conn.execute(
                "SELECT * FROM appointment_operations WHERE operation_id=?",
                (operation_id,),
            ).fetchone()
        return dict(row)

    def get_appointment_operation(self, operation_id: str) -> dict | None:
        self.init_db()
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM appointment_operations WHERE operation_id=?",
                (operation_id,),
            ).fetchone()
        return dict(row) if row is not None else None

    def get_appointment_operation_by_key(self, idempotency_key: str) -> dict | None:
        self.init_db()
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM appointment_operations WHERE idempotency_key=?",
                (idempotency_key,),
            ).fetchone()
        return dict(row) if row is not None else None

    def find_completed_appointment_operation(
        self,
        *,
        action: str,
        calendar_id: str,
        event_id: str,
        requested_start_iso: str | None = None,
        actor: str | None = None,
    ) -> dict | None:
        self.init_db()
        query = (
            "SELECT * FROM appointment_operations "
            "WHERE action=? AND calendar_id=? AND event_id=? "
            "AND status IN ('completed', 'local_reconciled', 'notification_pending')"
        )
        params: list[object] = [action, calendar_id, event_id]
        if requested_start_iso is not None:
            query += " AND requested_start_iso=?"
            params.append(requested_start_iso)
        if actor is not None:
            query += " AND actor=?"
            params.append(actor)
        query += " ORDER BY updated_at DESC, created_at DESC LIMIT 1"
        with self.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return dict(row) if row is not None else None

    def list_appointment_operations(
        self,
        *,
        statuses: Iterable[str] | None = None,
        limit: int = 50,
    ) -> list[dict]:
        self.init_db()
        values = tuple(dict.fromkeys(str(value) for value in (statuses or ()) if str(value)))
        with self.connect() as conn:
            if values:
                placeholders = ",".join("?" for _ in values)
                rows = conn.execute(
                    f"SELECT * FROM appointment_operations WHERE status IN ({placeholders}) "
                    "ORDER BY created_at, operation_id LIMIT ?",
                    (*values, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM appointment_operations ORDER BY created_at, operation_id LIMIT ?",
                    (limit,),
                ).fetchall()
        return [dict(row) for row in rows]

    def has_pending_appointment_change(
        self,
        *,
        source: str,
        calendar_id: str,
        event_id: str,
        event_start: str,
    ) -> bool:
        """Return whether a provider mutation currently blocks delivery."""
        self.init_db()
        with self.connect() as conn:
            return conn.execute(
                """
                SELECT 1 FROM appointment_operations
                WHERE source=? AND calendar_id=? AND event_id=?
                  AND previous_start_iso=?
                  AND status IN ('pending', 'provider_applied', 'recovery_pending')
                LIMIT 1
                """,
                (source, calendar_id, event_id, event_start),
            ).fetchone() is not None

    def update_appointment_operation(self, operation_id: str, **fields) -> dict | None:
        allowed = {
            "status", "result_json", "error_code", "error_detail", "attempts",
            "etag", "requested_start_iso", "requested_end_iso",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return self.get_appointment_operation(operation_id)
        updates["updated_at"] = utc_now_iso()
        assignments = ", ".join(f"{key}=?" for key in updates)
        self.init_db()
        with self.connect() as conn:
            conn.execute(
                f"UPDATE appointment_operations SET {assignments} WHERE operation_id=?",
                (*updates.values(), operation_id),
            )
            row = conn.execute(
                "SELECT * FROM appointment_operations WHERE operation_id=?",
                (operation_id,),
            ).fetchone()
        return dict(row) if row is not None else None

    def queue_appointment_notification(
        self,
        *,
        operation_id: str,
        recipient: str,
        subject: str,
        body_text: str,
        body_html: str,
    ) -> int:
        self.init_db()
        key = f"appointment-change|{operation_id}|{recipient.strip().lower()}"
        now = utc_now_iso()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO appointment_notification_outbox(
                    operation_id, idempotency_key, recipient, subject, body_text, body_html,
                    status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                ON CONFLICT(idempotency_key) DO NOTHING
                """,
                (operation_id, key, recipient, subject, body_text, body_html, now, now),
            )
            row = conn.execute(
                "SELECT id FROM appointment_notification_outbox WHERE idempotency_key=?",
                (key,),
            ).fetchone()
        return int(row["id"])

    def list_pending_appointment_notifications(self, *, limit: int = 25) -> list[dict]:
        self.init_db()
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM appointment_notification_outbox
                WHERE status='pending'
                  AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                ORDER BY id ASC LIMIT ?
                """,
                (utc_now_iso(), limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def mark_appointment_notification(
        self,
        notification_id: int,
        *,
        status: str,
        error: str | None = None,
        retry_limit: int = 5,
    ) -> None:
        now = utc_now_iso()
        with self.connect() as conn:
            row = conn.execute(
                "SELECT attempts FROM appointment_notification_outbox WHERE id=?",
                (notification_id,),
            ).fetchone()
            attempts = int(row["attempts"] if row is not None else 0) + 1
            if status == "failed":
                persisted_status = (
                    "failed"
                    if attempts >= max(1, int(retry_limit))
                    else "pending"
                )
            else:
                persisted_status = status
            conn.execute(
                """
                UPDATE appointment_notification_outbox
                SET status=?, attempts=attempts+1, last_error=?,
                    next_attempt_at=CASE WHEN ?='pending' THEN ? ELSE NULL END,
                    sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END,
                    updated_at=?
                WHERE id=?
                """,
                (persisted_status, error, persisted_status, now, status, now, now, notification_id),
            )

    def cancel_event_occurrence(
        self,
        *,
        source: str,
        calendar_id: str,
        event_id: str,
        start_iso: str,
        reason: str = "appointment_cancelled",
    ) -> tuple[int, int]:
        """Cancel exactly one event occurrence and its unsent jobs."""
        self.init_db()
        now = utc_now_iso()
        target_start = _parse_event_datetime(start_iso)
        with self.connect() as conn:
            event_rows = conn.execute(
                """
                SELECT rowid, start_iso FROM events
                WHERE source=? AND calendar_id=? AND event_id=? AND cancelled=0
                """,
                (source, calendar_id, event_id),
            ).fetchall()
            event_rowids = [
                row["rowid"]
                for row in event_rows
                if _parse_event_datetime(row["start_iso"]) == target_start
            ]
            if event_rowids:
                placeholders = ",".join("?" for _ in event_rowids)
                event_count = conn.execute(
                    f"UPDATE events SET cancelled=1, updated_at=? WHERE rowid IN ({placeholders})",
                    (now, *event_rowids),
                ).rowcount
            else:
                event_count = 0

            job_rows = conn.execute(
                """
                SELECT id, event_start FROM reminder_jobs
                WHERE source=? AND calendar_id=? AND event_id=?
                  AND status IN ('scheduled', 'claimed')
                """,
                (source, calendar_id, event_id),
            ).fetchall()
            job_ids = [
                row["id"]
                for row in job_rows
                if _parse_event_datetime(row["event_start"]) == target_start
            ]
            if job_ids:
                placeholders = ",".join("?" for _ in job_ids)
                jobs_count = conn.execute(
                    f"""
                    UPDATE reminder_jobs SET status='cancelled', reason=?, claimed_at=NULL, updated_at=?
                    WHERE id IN ({placeholders})
                    """,
                    (reason, now, *job_ids),
                ).rowcount
            else:
                jobs_count = 0
            return event_count, jobs_count

    def upsert_event(self, event: AppointmentEvent) -> AppointmentEvent:
        self.init_db()
        attendee_values = tuple(event.attendee_emails)
        attendee_emails = normalize_emails(attendee_values)
        has_self_attendee = _self_attendee_presence(event.has_self_attendee)
        with self.connect() as conn:
            now = utc_now_iso()
            if not event.cancelled and not event.recurring:
                prior_starts = [
                    row["start_iso"]
                    for row in conn.execute(
                        """SELECT start_iso FROM events
                           WHERE source=? AND calendar_id=? AND event_id=?
                             AND start_iso<>? AND cancelled=0 AND recurring=0""",
                        (event.source, event.calendar_id, event.event_id, event.start.isoformat()),
                    ).fetchall()
                ]
                if prior_starts:
                    placeholders = ",".join("?" for _ in prior_starts)
                    conn.execute(
                        f"""UPDATE events SET cancelled=1, updated_at=?
                            WHERE source=? AND calendar_id=? AND event_id=?
                              AND start_iso IN ({placeholders}) AND cancelled=0 AND recurring=0""",
                        (now, event.source, event.calendar_id, event.event_id, *prior_starts),
                    )
                    conn.execute(
                        f"""UPDATE reminder_jobs
                            SET status='cancelled', reason='event_rescheduled', claimed_at=NULL, updated_at=?
                            WHERE source=? AND calendar_id=? AND event_id=?
                              AND event_start IN ({placeholders})
                              AND status IN ('scheduled', 'claimed')""",
                        (now, event.source, event.calendar_id, event.event_id, *prior_starts),
                    )
            existing = conn.execute(
                """SELECT contact_match_keys, contact_email, contact_email_source, contact_email_recovered_at FROM events
                   WHERE source=? AND calendar_id=? AND event_id=? AND start_iso=?""",
                (event.source, event.calendar_id, event.event_id, event.start.isoformat()),
            ).fetchone()
            existing_keys = (
                split_stored_values(existing["contact_match_keys"])
                if existing is not None
                else ()
            )
            incoming_contact_email = event.contact_email or (extract_structured_email(event.notes) if not attendee_emails else None)
            contact_email = incoming_contact_email or (existing["contact_email"] if existing is not None else None)
            contact_email_source = (event.contact_email_source or (RECOVERED_CONTACT_SOURCE if incoming_contact_email else None)) or (existing["contact_email_source"] if existing is not None else None)
            contact_email_recovered_at = event.contact_email_recovered_at or (utc_now_iso() if incoming_contact_email and contact_email_source == RECOVERED_CONTACT_SOURCE and (existing is None or not existing["contact_email"]) else (existing["contact_email_recovered_at"] if existing is not None else None))
            contact_match_keys = normalize_contact_keys(
                (*existing_keys, *event.contact_match_keys, *attendee_values)
            )
            conn.execute(
                """
                INSERT INTO events(source, calendar_id, event_id, event_uid, summary, notes, start_iso, end_iso,
                    timezone, attendee_emails, contact_match_keys, self_attendee_present, contact_email, contact_email_source, contact_email_recovered_at, cancelled, recurring, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source, calendar_id, event_id, start_iso) DO UPDATE SET
                    event_uid=excluded.event_uid, summary=excluded.summary, notes=excluded.notes,
                    end_iso=excluded.end_iso, timezone=excluded.timezone, attendee_emails=excluded.attendee_emails,
                    contact_match_keys=excluded.contact_match_keys, self_attendee_present=excluded.self_attendee_present, contact_email=excluded.contact_email, contact_email_source=excluded.contact_email_source, contact_email_recovered_at=excluded.contact_email_recovered_at, cancelled=excluded.cancelled, recurring=excluded.recurring, updated_at=excluded.updated_at
                """,
                (event.source, event.calendar_id, event.event_id, event.event_uid, event.summary, event.notes,
                  event.start.isoformat(), event.end.isoformat(), event.timezone, ",".join(attendee_emails),
                  ",".join(contact_match_keys), has_self_attendee, contact_email, contact_email_source, contact_email_recovered_at, int(event.cancelled), int(event.recurring), now),
            )
        return replace(
            event,
            attendee_emails=attendee_emails,
            contact_match_keys=contact_match_keys,
            has_self_attendee=has_self_attendee,
            contact_email=contact_email,
            contact_email_source=contact_email_source,
            contact_email_recovered_at=contact_email_recovered_at,
        )

    def upsert_job(self, *, event: AppointmentEvent, recipient: ReminderRecipient | None, channel: str,
                   offset_days: int, due_at: str, status: str, reason: str | None = None,
                   phase: str = "pre", post_followup_id: str | None = None) -> str:
        self.init_db()
        post_followup_id = post_followup_id or ("thank_you_review" if phase == "post" else "")
        key = make_idempotency_key(source=event.source, calendar_id=event.calendar_id,
                                   event_uid_or_id=event.event_key, event_start=event.start.isoformat(),
                                   offset_days=offset_days, channel=channel, phase=phase,
                                   post_followup_id=post_followup_id)
        now = utc_now_iso()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO reminder_jobs(idempotency_key, source, calendar_id, event_id, event_uid, event_summary,
                    event_start, event_end, event_timezone, recipient_id, channel, phase, post_followup_id, offset_days, due_at, status,
                    reason, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(idempotency_key) DO UPDATE SET
                    event_summary=excluded.event_summary, event_end=excluded.event_end,
                    event_timezone=excluded.event_timezone, recipient_id=excluded.recipient_id, due_at=excluded.due_at,
                    status=CASE WHEN reminder_jobs.status IN ('sent', 'claimed')
                                THEN reminder_jobs.status ELSE excluded.status END,
                    reason=CASE WHEN reminder_jobs.status='claimed'
                                THEN reminder_jobs.reason ELSE excluded.reason END,
                    claimed_at=CASE WHEN reminder_jobs.status='claimed'
                                    THEN reminder_jobs.claimed_at ELSE NULL END,
                    updated_at=excluded.updated_at
                """,
                (key, event.source, event.calendar_id, event.event_id, event.event_uid, event.summary,
                 event.start.isoformat(), event.end.isoformat(), event.timezone,
                 recipient.recipient_id if recipient else None, channel, phase, post_followup_id, offset_days, due_at, status, reason, now, now),
            )
        return key

    def claim_manual_slot(self, *, event: AppointmentEvent, channel: str) -> dict | None:
        """Claim the one pre-appointment slot represented by a manual button.

        Manual sends use the existing reminder ledger. A scheduled, missed, or
        previously failed pre-appointment job is preferred so the manual send
        fulfills that exact slot. If scheduling has not created a pre job yet,
        a one-off manual ledger job is created and claimed. The claim is
        taken under a write transaction so the automatic dispatcher cannot
        claim the same job at the same time.
        """
        self.init_db()
        claim_token = f"manual:{utc_now_iso()}"
        claim_now = _parse_event_datetime(claim_token.removeprefix("manual:"))
        event_start = event.start.isoformat()
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")

            stale_claims = conn.execute(
                """
                SELECT id, claimed_at FROM reminder_jobs
                WHERE source=? AND calendar_id=? AND event_id=? AND event_start=?
                  AND channel=? AND phase IN ('pre', 'manual')
                  AND status='claimed' AND reason='manual_send_pending'
                  AND claimed_at IS NOT NULL
                """,
                (event.source, event.calendar_id, event.event_id, event_start, channel),
            ).fetchall()
            for stale in stale_claims:
                if not _manual_claim_is_stale(stale["claimed_at"], claim_now):
                    continue
                conn.execute(
                    """
                    UPDATE reminder_jobs
                    SET status='failed', reason='manual_send_interrupted',
                        claimed_at=NULL, updated_at=?
                    WHERE id=? AND status='claimed' AND claimed_at=?
                    """,
                    (claim_token.removeprefix("manual:"), stale["id"], stale["claimed_at"]),
                )
                conn.execute(
                    """
                    INSERT INTO reminder_attempts(job_id, attempted_at, status, provider, detail)
                    VALUES (?, ?, 'failed', 'manual', 'manual send interrupted before completion')
                    """,
                    (stale["id"], claim_token.removeprefix("manual:")),
                )

            sent = conn.execute(
                """
                SELECT 1 FROM reminder_jobs
                WHERE source=? AND calendar_id=? AND event_id=? AND event_start=?
                  AND channel=? AND phase IN ('pre', 'manual') AND status='sent'
                LIMIT 1
                """,
                (event.source, event.calendar_id, event.event_id, event_start, channel),
            ).fetchone()
            if sent is not None:
                conn.commit()
                return {"already_sent": True}

            claimed = conn.execute(
                """
                SELECT 1 FROM reminder_jobs
                WHERE source=? AND calendar_id=? AND event_id=? AND event_start=?
                  AND channel=? AND phase IN ('pre', 'manual') AND status='claimed'
                  AND claimed_at IS NOT NULL
                LIMIT 1
                """,
                (event.source, event.calendar_id, event.event_id, event_start, channel),
            ).fetchone()
            if claimed is not None:
                conn.commit()
                return {"busy": True}

            row = conn.execute(
                """
                SELECT * FROM reminder_jobs
                WHERE source=? AND calendar_id=? AND event_id=? AND event_start=?
                  AND channel=? AND phase IN ('pre', 'manual')
                  AND status IN ('scheduled', 'skipped', 'failed')
                  AND claimed_at IS NULL
                ORDER BY
                  CASE WHEN status='skipped' THEN 0
                       WHEN status='failed' THEN 1
                       ELSE 2 END,
                  due_at ASC, id ASC
                LIMIT 1
                """,
                (event.source, event.calendar_id, event.event_id, event_start, channel),
            ).fetchone()
            created = False
            previous_status = None
            previous_reason = None
            if row is None:
                created = True
                previous_status = None
                previous_reason = None
                key = make_idempotency_key(
                    source=event.source,
                    calendar_id=event.calendar_id,
                    event_uid_or_id=event.event_key,
                    event_start=event_start,
                    offset_days=0,
                    channel=channel,
                    phase="manual",
                )
                now = utc_now_iso()
                conn.execute(
                    """
                    INSERT INTO reminder_jobs(
                        idempotency_key, source, calendar_id, event_id, event_uid,
                        event_summary, event_start, event_end, event_timezone,
                        recipient_id, channel, phase, post_followup_id, offset_days,
                        due_at, status, reason, claimed_at, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?, 'claimed',
                              'manual_send_pending', ?, ?, ?)
                    """,
                    (
                        key, event.source, event.calendar_id, event.event_id, event.event_uid,
                        event.summary, event_start, event.end.isoformat(), event.timezone,
                        None, channel, "manual", now, claim_token, now, now,
                    ),
                )
                row = conn.execute(
                    "SELECT * FROM reminder_jobs WHERE idempotency_key=?",
                    (key,),
                ).fetchone()
            else:
                previous_status = row["status"]
                previous_reason = row["reason"]
                conn.execute(
                    """
                    UPDATE reminder_jobs
                    SET status='claimed', claimed_at=?, reason='manual_send_pending', updated_at=?
                    WHERE id=? AND claimed_at IS NULL
                    """,
                    (claim_token, utc_now_iso(), row["id"]),
                )
                row = conn.execute(
                    "SELECT * FROM reminder_jobs WHERE id=?",
                    (row["id"],),
                ).fetchone()

            conn.commit()
            return {
                "job": replace(self._row_to_job(row), status="claimed", claimed_at=claim_token),
                "claim_token": claim_token,
                "created": created,
                "previous_status": previous_status,
                "previous_reason": previous_reason,
            }

    def complete_manual_slot(
        self,
        *,
        job_id: int,
        claim_token: str,
        provider: str,
        detail: str | None = None,
    ) -> bool:
        """Mark a claimed manual send as delivered and record its attempt."""
        self.init_db()
        now = utc_now_iso()
        with self.connect() as conn:
            cur = conn.execute(
                """
                UPDATE reminder_jobs
                SET status='sent', reason='manual_send', claimed_at=NULL, updated_at=?
                WHERE id=? AND status='claimed' AND claimed_at=?
                """,
                (now, job_id, claim_token),
            )
            if cur.rowcount != 1:
                return False
            conn.execute(
                """
                INSERT INTO reminder_attempts(job_id, attempted_at, status, provider, detail)
                VALUES (?, ?, 'sent', ?, ?)
                """,
                (job_id, now, provider, detail),
            )
        return True

    def release_manual_slot(
        self,
        *,
        job_id: int,
        claim_token: str,
        previous_status: str | None,
        previous_reason: str | None,
        created: bool,
        provider: str,
        detail: str | None = None,
    ) -> bool:
        """Restore or fail a claimed slot after a failed manual provider call."""
        self.init_db()
        now = utc_now_iso()
        restored_status = previous_status if previous_status and not created else "failed"
        restored_reason = previous_reason if previous_status and not created else "manual_send_failed"
        with self.connect() as conn:
            cur = conn.execute(
                """
                UPDATE reminder_jobs
                SET status=?, reason=?, claimed_at=NULL, updated_at=?
                WHERE id=? AND status='claimed' AND claimed_at=?
                """,
                (restored_status, restored_reason, now, job_id, claim_token),
            )
            if cur.rowcount != 1:
                return False
            conn.execute(
                """
                INSERT INTO reminder_attempts(job_id, attempted_at, status, provider, detail)
                VALUES (?, ?, 'failed', ?, ?)
                """,
                (job_id, now, provider, detail),
            )
        return True

    def get_reminder_statuses(self, events: Iterable[dict]) -> dict[str, dict[str, bool]]:
        """Return persisted pre-reminder sends keyed by the caller's event key."""
        self.init_db()
        statuses: dict[str, dict[str, bool]] = {}
        with self.connect() as conn:
            for event in events:
                key = str(event.get("key") or "").strip()
                calendar_id = str(event.get("calendar_id") or "").strip()
                event_id = str(event.get("event_id") or "").strip()
                event_start = str(event.get("start_iso") or "").strip()
                if not key or not calendar_id or not event_id or not event_start:
                    continue
                rows = conn.execute(
                    """
                    SELECT channel FROM reminder_jobs
                    WHERE source='google' AND calendar_id=? AND event_id=?
                      AND event_start=? AND phase IN ('pre', 'manual') AND status='sent'
                    """,
                    (calendar_id, event_id, event_start),
                ).fetchall()
                sent_channels = {row["channel"] for row in rows}
                statuses[key] = {
                    "email": "email" in sent_channels,
                    "sms": "sms" in sent_channels,
                }
        return statuses

    def cancel_jobs_for_event(self, event: AppointmentEvent, reason: str) -> int:
        self.init_db()
        with self.connect() as conn:
            cur = conn.execute(
                """UPDATE reminder_jobs SET status='cancelled', reason=?, updated_at=?, claimed_at=NULL
                   WHERE source=? AND calendar_id=? AND event_id=? AND status IN ('scheduled', 'claimed')""",
                (reason, utc_now_iso(), event.source, event.calendar_id, event.event_id),
            )
            return cur.rowcount

    def rename_event(self, *, source: str, calendar_id: str, event_id: str, summary: str) -> int:
        self.init_db()
        with self.connect() as conn:
            cur = conn.execute(
                "UPDATE events SET summary=?, updated_at=? WHERE source=? AND calendar_id=? AND event_id=?",
                (summary, utc_now_iso(), source, calendar_id, event_id),
            )
            conn.execute(
                "UPDATE reminder_jobs SET event_summary=?, updated_at=? WHERE source=? AND calendar_id=? AND event_id=?",
                (summary, utc_now_iso(), source, calendar_id, event_id),
            )
            return cur.rowcount

    def cancel_event(self, *, source: str, calendar_id: str, event_id: str,
                     reason: str = "deleted") -> tuple[int, int]:
        self.init_db()
        with self.connect() as conn:
            event_cur = conn.execute(
                "UPDATE events SET cancelled=1, updated_at=? WHERE source=? AND calendar_id=? AND event_id=?",
                (utc_now_iso(), source, calendar_id, event_id),
            )
            jobs_cur = conn.execute(
                """UPDATE reminder_jobs SET status='cancelled', reason=?, claimed_at=NULL, updated_at=?
                   WHERE source=? AND calendar_id=? AND event_id=? AND status IN ('scheduled', 'claimed')""",
                (reason, utc_now_iso(), source, calendar_id, event_id),
            )
            return event_cur.rowcount, jobs_cur.rowcount

    def claim_due(
        self,
        now_iso: str,
        *,
        limit: int = 100,
        idempotency_keys: Iterable[str] | None = None,
    ) -> list[ReminderJob]:
        self.init_db()
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            params: list[object] = [now_iso]
            query = """SELECT * FROM reminder_jobs WHERE status='scheduled' AND claimed_at IS NULL AND due_at <= ?"""
            keys = tuple(dict.fromkeys(str(key) for key in (idempotency_keys or ()) if str(key)))
            if idempotency_keys is not None:
                if not keys:
                    conn.commit()
                    return []
                placeholders = ",".join("?" for _ in keys)
                query += f" AND idempotency_key IN ({placeholders})"
                params.extend(keys)
            query += " ORDER BY due_at ASC, id ASC LIMIT ?"
            params.append(limit)
            rows = conn.execute(query, params).fetchall()
            claimed = utc_now_iso()
            if rows:
                conn.executemany("UPDATE reminder_jobs SET claimed_at=?, updated_at=? WHERE id=?",
                                 [(claimed, claimed, row["id"]) for row in rows])
            conn.commit()
        return [replace(self._row_to_job(row), claimed_at=claimed) for row in rows]

    def get_dispatchable_claim(self, job_id: int, claimed_at: str) -> ReminderJob | None:
        """Return a claim only while its exact scheduled lease is still current."""
        if not claimed_at:
            return None
        self.init_db()
        with self.connect() as conn:
            row = conn.execute(
                """SELECT * FROM reminder_jobs
                   WHERE id=? AND status='scheduled' AND claimed_at=?""",
                (job_id, claimed_at),
            ).fetchone()
        return self._row_to_job(row) if row is not None else None

    def is_job_event_current(self, job: ReminderJob) -> bool:
        """Verify that a claimed job still points at an active exact occurrence."""
        self.init_db()
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT 1 FROM events
                WHERE source=? AND calendar_id=? AND event_id=?
                  AND start_iso=? AND end_iso=? AND cancelled=0
                LIMIT 1
                """,
                (
                    job.source,
                    job.calendar_id,
                    job.event_id,
                    job.event_start,
                    job.event_end,
                ),
            ).fetchone()
        return row is not None

    def release_claim(self, job_id: int, claimed_at: str, *, reason: str | None = None) -> bool:
        """Release a claim without marking the job delivered or failed."""
        if not claimed_at:
            return False
        self.init_db()
        with self.connect() as conn:
            cur = conn.execute(
                """
                UPDATE reminder_jobs
                SET claimed_at=NULL, reason=COALESCE(?, reason), updated_at=?
                WHERE id=? AND status='scheduled' AND claimed_at=?
                """,
                (reason, utc_now_iso(), job_id, claimed_at),
            )
        return cur.rowcount == 1

    def mark_job(self, job_id: int, status: str, *, reason: str | None = None) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE reminder_jobs SET status=?, reason=?, claimed_at=NULL, updated_at=? WHERE id=?",
                         (status, reason, utc_now_iso(), job_id))

    def record_attempt(self, job_id: int, *, status: str, provider: str, detail: str | None = None) -> None:
        with self.connect() as conn:
            conn.execute("INSERT INTO reminder_attempts(job_id, attempted_at, status, provider, detail) VALUES (?, ?, ?, ?, ?)",
                         (job_id, utc_now_iso(), status, provider, detail))

    def list_jobs(
        self,
        *,
        status: str | None = None,
        phase: str | None = None,
        limit: int | None = None,
    ) -> list[ReminderJob]:
        self.init_db()
        with self.connect() as conn:
            clauses: list[str] = []
            params: list[object] = []
            if status:
                clauses.append("status=?")
                params.append(status)
            if phase:
                clauses.append("phase=?")
                params.append(phase)
            where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
            limit_sql = " LIMIT ?" if limit is not None else ""
            if limit is not None:
                params.append(max(0, int(limit)))
            rows = conn.execute(
                f"SELECT * FROM reminder_jobs{where} ORDER BY due_at, id{limit_sql}",
                params,
            ).fetchall()
        return [self._row_to_job(row) for row in rows]

    def list_events(self, *, limit: int = 25, start_iso: str | None = None,
                    end_iso: str | None = None) -> list[dict]:
        self.init_db()
        with self.connect() as conn:
            rows = conn.execute(
                """SELECT source, calendar_id, event_id, event_uid, summary, notes, start_iso, end_iso,
                          timezone, attendee_emails, contact_match_keys, self_attendee_present, contact_email, contact_email_source, contact_email_recovered_at, cancelled, recurring FROM events
                   WHERE cancelled=0 ORDER BY start_iso ASC"""
            ).fetchall()
        start_at = _parse_event_datetime(start_iso) if start_iso else None
        end_at = _parse_event_datetime(end_iso) if end_iso else None
        events = []
        for row in rows:
            event_start = _parse_event_datetime(row["start_iso"])
            if (start_at and event_start < start_at) or (end_at and event_start >= end_at):
                continue
            events.append({
                "source": row["source"], "calendar_id": row["calendar_id"], "event_id": row["event_id"],
                "event_uid": row["event_uid"], "summary": row["summary"], "notes": row["notes"],
                "start_iso": row["start_iso"], "end_iso": row["end_iso"], "timezone": row["timezone"],
                "attendee_emails": list(normalize_emails(split_stored_values(row["attendee_emails"]))),
                "contact_match_keys": normalize_contact_keys(
                    split_stored_values(row["contact_match_keys"])
                ),
                "self_attendee_present": _self_attendee_presence(row["self_attendee_present"]),
                "contact_email": normalize_emails((row["contact_email"],))[0] if row["contact_email"] else None,
                "contact_email_source": row["contact_email_source"],
                "contact_email_recovered_at": row["contact_email_recovered_at"],
                "recurring": bool(row["recurring"]),
            })
            if len(events) >= limit:
                break
        return events

    def get_active_google_event(
        self,
        *,
        calendar_id: str,
        event_id: str,
        event_uid: str | None = None,
    ) -> AppointmentEvent | None:
        """Return one canonical active Google event, or fail closed with ``None``."""
        calendar_id = calendar_id.strip()
        event_id = event_id.strip()
        event_uid = event_uid.strip() if event_uid else None
        if not calendar_id or not event_id:
            return None

        self.init_db()
        query = """SELECT source, calendar_id, event_id, event_uid, summary, notes, start_iso,
                          end_iso, timezone, attendee_emails, contact_match_keys, self_attendee_present, contact_email, contact_email_source, contact_email_recovered_at, cancelled, recurring
                   FROM events
                   WHERE source='google' AND calendar_id=? AND event_id=? AND cancelled=0"""
        params: list[str] = [calendar_id, event_id]
        if event_uid:
            query += " AND event_uid=?"
            params.append(event_uid)
        with self.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        if len(rows) != 1:
            return None

        row = rows[0]
        return AppointmentEvent(
            source=row["source"],
            calendar_id=row["calendar_id"],
            event_id=row["event_id"],
            event_uid=row["event_uid"],
            summary=row["summary"],
            notes=row["notes"],
            start=datetime.fromisoformat(row["start_iso"]),
            end=datetime.fromisoformat(row["end_iso"]),
            timezone=row["timezone"],
            attendee_emails=normalize_emails(split_stored_values(row["attendee_emails"])),
            contact_match_keys=normalize_contact_keys(
                split_stored_values(row["contact_match_keys"])
            ),
            has_self_attendee=_self_attendee_presence(row["self_attendee_present"]),
            contact_email=normalize_emails((row["contact_email"],))[0] if row["contact_email"] else None,
            contact_email_source=row["contact_email_source"],
            contact_email_recovered_at=row["contact_email_recovered_at"],
            cancelled=bool(row["cancelled"]),
            recurring=bool(row["recurring"]),
        )

    def get_recipient(self, recipient_id: str | None) -> ReminderRecipient | None:
        if not recipient_id:
            return None
        self.init_db()
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM recipients WHERE recipient_id=?", (recipient_id,)).fetchone()
        if row is None:
            return None
        return ReminderRecipient(
            recipient_id=row["recipient_id"], display_name=row["display_name"], email=row["email"], phone=row["phone"],
            preferred_channels=tuple(row["preferred_channels"].split(",")) if row["preferred_channels"] else (),
            sms_consent_status=row["sms_consent_status"], consent_source=row["consent_source"],
            consent_timestamp=row["consent_timestamp"], suppressed=bool(row["suppressed"]),
            match_keys=tuple(row["match_keys"].split(",")) if row["match_keys"] else (),
        )

    @staticmethod
    def _row_to_job(row: sqlite3.Row) -> ReminderJob:
        return ReminderJob(
            id=row["id"], idempotency_key=row["idempotency_key"], source=row["source"],
            calendar_id=row["calendar_id"], event_id=row["event_id"], event_uid=row["event_uid"],
            event_start=row["event_start"], event_end=row["event_end"], event_timezone=row["event_timezone"],
            recipient_id=row["recipient_id"], channel=row["channel"], offset_days=row["offset_days"],
            due_at=row["due_at"], status=row["status"], reason=row["reason"], claimed_at=row["claimed_at"],
            event_summary=row["event_summary"] or "Appointment",
            phase=row["phase"] if "phase" in row.keys() else ("confirmation" if row["offset_days"] == 0 else "pre"),
            post_followup_id=(row["post_followup_id"] if "post_followup_id" in row.keys() and row["post_followup_id"] else ("thank_you_review" if row["phase"] == "post" else None)),
        )
