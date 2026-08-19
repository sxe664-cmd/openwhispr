from __future__ import annotations

import os
import re
import sqlite3
import time
import unicodedata
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from receptionist.reminders.phone import normalize_us_phone


SCHEMA_VERSION = 2
REGISTRY_ENV = "HIRA_PATIENT_REGISTRY_PATH"
DEFAULT_APPOINTMENT_SOURCE = "ai_receptionist"
SMS_CONSENT_STATUSES = {"unknown", "opted_in", "opted_out"}
_LOCK_RETRIES = 6
_LOCK_DELAY_SECONDS = 0.05
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class PatientRegistryError(RuntimeError):
    """Base error for the local patient/appointment registry."""


class PatientRegistryConfigError(PatientRegistryError):
    """The shared registry path is not configured safely."""


class PatientIdentityError(PatientRegistryError):
    """Identity data is missing, ambiguous, conflicting, or invalid."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class IdempotencyConflictError(PatientRegistryError):
    """An idempotency key was reused for different appointment data."""


@dataclass(frozen=True)
class PatientRecord:
    patient_id: str
    name: str
    dob: str
    phone: str | None
    email: str | None
    active: bool
    created_at: str
    updated_at: str
    sms_consent_status: str = "opted_in"


@dataclass(frozen=True)
class PatientResolution:
    patient: PatientRecord | None
    created: bool = False
    reason: str = "matched"


@dataclass(frozen=True)
class AppointmentRecord:
    appointment_id: str
    patient_id: str
    start: str
    end: str
    appointment_type: str
    provider: str
    calendar_id: str
    google_event_id: str | None
    status: str
    source: str
    idempotency_key: str
    created_at: str
    updated_at: str

    @property
    def type(self) -> str:
        return self.appointment_type


def normalize_email(value: object) -> str | None:
    """Normalize an email once, at the registry boundary."""
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if not normalized:
        return None
    if not _EMAIL_RE.fullmatch(normalized):
        raise PatientIdentityError("invalid_email", "email is not valid")
    return normalized


def normalize_phone(value: object) -> str | None:
    """Use the application's existing E.164-ish US phone normalization."""
    if value is None or not str(value).strip():
        return None
    normalized = normalize_us_phone(value)
    if normalized is None:
        raise PatientIdentityError("invalid_phone", "phone is not a valid US number")
    return normalized


def normalize_dob(value: object) -> str:
    """Require and return an ISO calendar date (YYYY-MM-DD)."""
    if isinstance(value, datetime):
        candidate = value.date().isoformat()
    elif isinstance(value, date):
        candidate = value.isoformat()
    else:
        candidate = str(value or "").strip()
    try:
        parsed = date.fromisoformat(candidate)
    except (TypeError, ValueError) as exc:
        raise PatientIdentityError("invalid_dob", "dob must be YYYY-MM-DD") from exc
    if parsed.isoformat() != candidate:
        raise PatientIdentityError("invalid_dob", "dob must be YYYY-MM-DD")
    if parsed > date.today():
        raise PatientIdentityError("invalid_dob", "dob cannot be in the future")
    return candidate


def normalize_name_key(value: object) -> str:
    normalized = unicodedata.normalize("NFKD", str(value or ""))
    normalized = "".join(char for char in normalized if not unicodedata.combining(char))
    normalized = re.sub(r"[^a-zA-Z0-9]+", " ", normalized).lower().strip()
    return " ".join(normalized.split())


def registry_path(path: str | os.PathLike[str] | None = None) -> Path:
    """Resolve the one same-host registry path, never a cloud/database URL."""
    value = path if path is not None else os.environ.get(REGISTRY_ENV)
    if value is None or not str(value).strip():
        raise PatientRegistryConfigError(f"{REGISTRY_ENV} is not configured")
    if str(value).strip() == ":memory:":
        return Path(":memory:")
    resolved = Path(str(value)).expanduser()
    if resolved.name in {"", ".", ".."}:
        raise PatientRegistryConfigError("patient registry path must name a SQLite file")
    return resolved


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class PatientRegistry:
    """Small retrying SQLite repository shared by the receptionist processes."""

    def __init__(self, path: str | os.PathLike[str] | None = None) -> None:
        self.path = registry_path(path)
        self._memory_connection: sqlite3.Connection | None = None

    @classmethod
    def from_env(cls) -> PatientRegistry:
        return cls()

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        if self.path == Path(":memory:"):
            if self._memory_connection is None:
                self._memory_connection = sqlite3.connect(":memory:", check_same_thread=False)
            connection = self._memory_connection
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            yield connection
            return

        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(
            str(self.path),
            timeout=5.0,
            isolation_level=None,
            check_same_thread=False,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
        finally:
            connection.close()

    def _run(self, operation, *, write: bool = False):
        last_error: Exception | None = None
        for attempt in range(_LOCK_RETRIES):
            try:
                with self._connection() as connection:
                    if write:
                        connection.execute("BEGIN IMMEDIATE")
                    result = operation(connection)
                    if write:
                        connection.execute("COMMIT")
                    return result
            except sqlite3.OperationalError as exc:
                last_error = exc
                if "locked" not in str(exc).lower() and "busy" not in str(exc).lower():
                    raise
                if attempt + 1 >= _LOCK_RETRIES:
                    raise PatientRegistryError("patient registry remained locked") from exc
                time.sleep(_LOCK_DELAY_SECONDS * (attempt + 1))
            except Exception:
                # Explicit transactions need rollback before the connection is
                # closed; SQLite will also roll it back, but doing it here
                # keeps the retry path deterministic for injected test errors.
                raise
        raise PatientRegistryError("patient registry operation failed") from last_error

    def init_db(self) -> None:
        def _init(connection: sqlite3.Connection) -> None:
            connection.execute("PRAGMA user_version")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS patients (
                    patient_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    dob TEXT NOT NULL,
                    phone TEXT,
                    email TEXT,
                    normalized_name TEXT NOT NULL,
                    normalized_dob TEXT NOT NULL,
                    normalized_phone TEXT,
                    normalized_email TEXT,
                    sms_consent_status TEXT NOT NULL DEFAULT 'opted_in',
                    merged_into_patient_id TEXT,
                    merged_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
                );
                CREATE INDEX IF NOT EXISTS idx_patients_dob_phone
                    ON patients(normalized_dob, normalized_phone);
                CREATE INDEX IF NOT EXISTS idx_patients_dob_email
                    ON patients(normalized_dob, normalized_email);
                CREATE INDEX IF NOT EXISTS idx_patients_name_dob
                    ON patients(normalized_name, normalized_dob);
                CREATE TABLE IF NOT EXISTS appointments (
                    appointment_id TEXT PRIMARY KEY,
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    start TEXT NOT NULL,
                    end TEXT NOT NULL,
                    type TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    calendar_id TEXT NOT NULL,
                    google_event_id TEXT,
                    calendar_identity_key TEXT,
                    status TEXT NOT NULL,
                    source TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_appointments_google_event
                    ON appointments(calendar_id, google_event_id);
                CREATE INDEX IF NOT EXISTS idx_appointments_identity
                    ON appointments(calendar_identity_key);
                CREATE TABLE IF NOT EXISTS patient_merge_history (
                    merge_id TEXT PRIMARY KEY,
                    source_patient_id TEXT NOT NULL,
                    survivor_patient_id TEXT NOT NULL,
                    field_choices TEXT,
                    created_at TEXT NOT NULL
                );
                """
            )
            columns = {row[1] for row in connection.execute("PRAGMA table_info(patients)").fetchall()}
            if "sms_consent_status" not in columns:
                connection.execute(
                    "ALTER TABLE patients ADD COLUMN sms_consent_status TEXT NOT NULL DEFAULT 'opted_in'"
                )
            if "merged_into_patient_id" not in columns:
                connection.execute("ALTER TABLE patients ADD COLUMN merged_into_patient_id TEXT")
            if "merged_at" not in columns:
                connection.execute("ALTER TABLE patients ADD COLUMN merged_at TEXT")
            appointment_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(appointments)").fetchall()
            }
            if "calendar_identity_key" not in appointment_columns:
                connection.execute("ALTER TABLE appointments ADD COLUMN calendar_identity_key TEXT")
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_appointments_identity ON appointments(calendar_identity_key)"
            )
            connection.execute(
                "UPDATE patients SET sms_consent_status = 'opted_in' WHERE sms_consent_status IS NULL OR sms_consent_status = 'unknown'"
            )
            connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            connection.commit()

        # executescript manages its own DDL transaction; keep initialization
        # outside the repository's BEGIN/COMMIT wrapper.
        self._run(_init)

    def _ensure_initialized(self) -> None:
        self.init_db()

    def create_patient(
        self,
        *,
        name: str,
        dob: object,
        phone: object = None,
        email: object = None,
        patient_id: str | None = None,
        sms_consent_status: str = "opted_in",
    ) -> PatientRecord:
        normalized_name = " ".join(str(name or "").split())
        if not normalized_name:
            raise PatientIdentityError("missing_name", "name is required")
        normalized_dob = normalize_dob(dob)
        normalized_phone = normalize_phone(phone)
        normalized_email = normalize_email(email)
        if sms_consent_status not in SMS_CONSENT_STATUSES:
            raise PatientIdentityError("invalid_sms_consent", "sms consent status is invalid")
        if sms_consent_status == "unknown":
            sms_consent_status = "opted_in"
        now = _utc_now()
        record = PatientRecord(
            patient_id=patient_id or str(uuid.uuid4()),
            name=normalized_name,
            dob=normalized_dob,
            phone=normalized_phone,
            email=normalized_email,
            active=True,
            created_at=now,
            updated_at=now,
            sms_consent_status=sms_consent_status,
        )

        def _insert(connection: sqlite3.Connection) -> PatientRecord:
            connection.execute(
                """
                INSERT INTO patients(
                    patient_id, name, dob, phone, email, normalized_name,
                    normalized_dob, normalized_phone, normalized_email,
                    sms_consent_status, created_at, updated_at, active
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    record.patient_id,
                    record.name,
                    record.dob,
                    record.phone,
                    record.email,
                    normalize_name_key(record.name),
                    record.dob,
                    record.phone,
                    record.email,
                    sms_consent_status,
                    record.created_at,
                    record.updated_at,
                ),
            )
            return record

        self._ensure_initialized()
        return self._run(_insert, write=True)

    def get_patient(self, patient_id: str) -> PatientRecord | None:
        self._ensure_initialized()
        row = self._run(
            lambda connection: connection.execute(
                "SELECT * FROM patients WHERE patient_id = ? AND active = 1",
                (str(patient_id),),
            ).fetchone()
        )
        return _patient_from_row(row) if row else None

    def resolve_patient(
        self,
        *,
        name: str,
        dob: object,
        phone: object = None,
        email: object = None,
        patient_id: str | None = None,
        create_if_missing: bool = False,
    ) -> PatientResolution:
        """Resolve by exact normalized name+DOB, creating when requested."""
        self._ensure_initialized()
        if patient_id:
            patient = self.get_patient(patient_id)
            if patient is None:
                raise PatientIdentityError("unknown_patient_id", "patient_id was not found")
            return PatientResolution(patient=patient, reason="known_patient_id")

        normalized_name = " ".join(str(name or "").split())
        if not normalized_name:
            raise PatientIdentityError("missing_name", "name is required")
        normalized_dob = normalize_dob(dob)
        normalized_phone = normalize_phone(phone)
        normalized_email = normalize_email(email)
        normalized_name_key = normalize_name_key(normalized_name)

        def _find(connection: sqlite3.Connection) -> list[sqlite3.Row]:
            return list(connection.execute(
                "SELECT * FROM patients WHERE active = 1 AND normalized_name = ? AND normalized_dob = ?",
                (normalized_name_key, normalized_dob),
            ).fetchall())

        rows = self._run(_find)
        if len(rows) > 1:
            raise PatientIdentityError("multiple_matches", "identity matched multiple patients")
        patient = _patient_from_row(rows[0]) if rows else None
        if patient:
            if (normalized_phone and not patient.phone) or (normalized_email and not patient.email):
                now = _utc_now()

                def _fill_missing(connection: sqlite3.Connection) -> None:
                    connection.execute(
                        """
                        UPDATE patients
                        SET phone = COALESCE(phone, ?),
                            email = COALESCE(email, ?),
                            normalized_phone = COALESCE(normalized_phone, ?),
                            normalized_email = COALESCE(normalized_email, ?),
                            updated_at = ?
                        WHERE patient_id = ?
                        """,
                        (normalized_phone, normalized_email, normalized_phone, normalized_email, now, patient.patient_id),
                    )

                self._run(_fill_missing, write=True)
                patient = self.get_patient(patient.patient_id)
            return PatientResolution(patient=patient, reason="exact_match")
        if not create_if_missing:
            return PatientResolution(patient=None, reason="no_match")
        return PatientResolution(
            patient=self.create_patient(
                name=normalized_name,
                dob=normalized_dob,
                phone=normalized_phone,
                email=normalized_email,
            ),
            created=True,
            reason="created",
        )

    resolve_or_create_patient = resolve_patient

    def reserve_appointment(
        self,
        *,
        patient_id: str,
        start: str,
        end: str,
        appointment_type: str = "appointment",
        provider: str = "google",
        calendar_id: str,
        source: str = DEFAULT_APPOINTMENT_SOURCE,
        idempotency_key: str,
        appointment_id: str | None = None,
    ) -> AppointmentRecord:
        self._ensure_initialized()
        values = {
            "patient_id": str(patient_id),
            "start": str(start),
            "end": str(end),
            "type": str(appointment_type),
            "provider": str(provider),
            "calendar_id": str(calendar_id),
            "source": str(source),
            "idempotency_key": str(idempotency_key),
        }
        if not values["idempotency_key"]:
            raise PatientRegistryError("idempotency_key is required")

        def _reserve(connection: sqlite3.Connection) -> AppointmentRecord:
            existing = connection.execute(
                "SELECT * FROM appointments WHERE idempotency_key = ?",
                (values["idempotency_key"],),
            ).fetchone()
            if existing:
                existing_record = _appointment_from_row(existing)
                if any(getattr(existing_record, key) != value for key, value in values.items()):
                    raise IdempotencyConflictError("idempotency_key was reused for different appointment data")
                return existing_record
            now = _utc_now()
            record = AppointmentRecord(
                appointment_id=appointment_id or str(uuid.uuid4()),
                patient_id=values["patient_id"],
                start=values["start"],
                end=values["end"],
                appointment_type=values["type"],
                provider=values["provider"],
                calendar_id=values["calendar_id"],
                google_event_id=None,
                status="pending",
                source=values["source"],
                idempotency_key=values["idempotency_key"],
                created_at=now,
                updated_at=now,
            )
            connection.execute(
                """
                INSERT INTO appointments(
                    appointment_id, patient_id, start, end, type, provider,
                    calendar_id, google_event_id, status, source,
                    idempotency_key, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.appointment_id, record.patient_id, record.start,
                    record.end, record.appointment_type, record.provider,
                    record.calendar_id, record.google_event_id, record.status,
                    record.source, record.idempotency_key, record.created_at,
                    record.updated_at,
                ),
            )
            return record

        return self._run(_reserve, write=True)

    def update_appointment_google_event(
        self,
        appointment_id: str,
        *,
        google_event_id: str,
        status: str = "confirmed",
    ) -> AppointmentRecord:
        self._ensure_initialized()
        now = _utc_now()

        def _update(connection: sqlite3.Connection) -> AppointmentRecord:
            connection.execute(
                "UPDATE appointments SET google_event_id = ?, status = ?, updated_at = ? WHERE appointment_id = ?",
                (str(google_event_id), str(status), now, str(appointment_id)),
            )
            row = connection.execute(
                "SELECT * FROM appointments WHERE appointment_id = ?",
                (str(appointment_id),),
            ).fetchone()
            if row is None:
                raise PatientRegistryError("appointment_id was not found")
            return _appointment_from_row(row)

        return self._run(_update, write=True)

    def update_appointment_status(self, appointment_id: str, status: str) -> AppointmentRecord:
        self._ensure_initialized()
        now = _utc_now()

        def _update(connection: sqlite3.Connection) -> AppointmentRecord:
            connection.execute(
                "UPDATE appointments SET status = ?, updated_at = ? WHERE appointment_id = ?",
                (str(status), now, str(appointment_id)),
            )
            row = connection.execute(
                "SELECT * FROM appointments WHERE appointment_id = ?",
                (str(appointment_id),),
            ).fetchone()
            if row is None:
                raise PatientRegistryError("appointment_id was not found")
            return _appointment_from_row(row)

        return self._run(_update, write=True)

    def update_appointment_schedule(
        self,
        appointment_id: str,
        *,
        start: str,
        end: str,
        status: str = "confirmed",
    ) -> AppointmentRecord:
        """Update an existing appointment without changing its identity."""
        self._ensure_initialized()
        now = _utc_now()

        def _update(connection: sqlite3.Connection) -> AppointmentRecord:
            connection.execute(
                """
                UPDATE appointments
                SET start = ?, end = ?, status = ?, updated_at = ?
                WHERE appointment_id = ?
                """,
                (str(start), str(end), str(status), now, str(appointment_id)),
            )
            row = connection.execute(
                "SELECT * FROM appointments WHERE appointment_id = ?",
                (str(appointment_id),),
            ).fetchone()
            if row is None:
                raise PatientRegistryError("appointment_id was not found")
            return _appointment_from_row(row)

        return self._run(_update, write=True)

    def get_appointment(self, appointment_id: str) -> AppointmentRecord | None:
        self._ensure_initialized()
        row = self._run(
            lambda connection: connection.execute(
                "SELECT * FROM appointments WHERE appointment_id = ?",
                (str(appointment_id),),
            ).fetchone()
        )
        return _appointment_from_row(row) if row else None

    def get_appointment_by_google_event_id(
        self,
        *,
        calendar_id: str,
        google_event_id: str,
    ) -> AppointmentRecord | None:
        self._ensure_initialized()
        row = self._run(
            lambda connection: connection.execute(
                "SELECT * FROM appointments WHERE calendar_id = ? AND google_event_id = ? ORDER BY created_at LIMIT 1",
                (str(calendar_id), str(google_event_id)),
            ).fetchone()
        )
        return _appointment_from_row(row) if row else None


def init_registry(path: str | os.PathLike[str] | None = None) -> PatientRegistry:
    registry = PatientRegistry(path)
    registry.init_db()
    return registry


def resolve_patient(**kwargs: Any) -> PatientResolution:
    return PatientRegistry.from_env().resolve_patient(**kwargs)


def create_patient(**kwargs: Any) -> PatientRecord:
    return PatientRegistry.from_env().create_patient(**kwargs)


def reserve_appointment(**kwargs: Any) -> AppointmentRecord:
    return PatientRegistry.from_env().reserve_appointment(**kwargs)


def _patient_from_row(row: sqlite3.Row) -> PatientRecord:
    return PatientRecord(
        patient_id=row["patient_id"],
        name=row["name"],
        dob=row["dob"],
        phone=row["phone"],
        email=row["email"],
        active=bool(row["active"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        sms_consent_status=(
            "opted_out"
            if row["sms_consent_status"] == "opted_out"
            else "opted_in"
        ) if "sms_consent_status" in row.keys() else "opted_in",
    )


def _appointment_from_row(row: sqlite3.Row) -> AppointmentRecord:
    return AppointmentRecord(
        appointment_id=row["appointment_id"],
        patient_id=row["patient_id"],
        start=row["start"],
        end=row["end"],
        appointment_type=row["type"],
        provider=row["provider"],
        calendar_id=row["calendar_id"],
        google_event_id=row["google_event_id"],
        status=row["status"],
        source=row["source"],
        idempotency_key=row["idempotency_key"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
