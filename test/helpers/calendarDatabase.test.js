const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-calendar-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");
const DATABASE_SOURCE = fs.readFileSync(
  path.join(__dirname, "../../src/helpers/database.js"),
  "utf8"
);

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-calendar-db-"));
  try {
    return new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      if (process.env.REQUIRE_DB_TESTS === "1") {
        throw new Error(
          "REQUIRE_DB_TESTS=1 requires an Electron-compatible better-sqlite3 binding"
        );
      }
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

function appleEvent(id, overrides = {}) {
  return {
    id,
    calendar_id: "apple-calendar",
    provider: "apple",
    summary: id,
    start_time: "2026-07-20T10:00:00Z",
    end_time: "2026-07-20T11:00:00Z",
    is_all_day: false,
    status: "confirmed",
    ...overrides,
  };
}

test("Apple snapshots retain events referenced by meeting notes", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertCalendarEvents([appleEvent("linked-event"), appleEvent("unlinked-event")]);
  const note = db.saveNote("Linked meeting", "", "meeting").note;
  db.updateNote(note.id, { calendar_event_id: "linked-event" });

  db.replaceAppleCalendarEvents([]);

  assert.equal(db.getCalendarEventById("linked-event")?.summary, "linked-event");
  assert.equal(db.getCalendarEventById("unlinked-event"), null);
  db.db.close();
});

function restEvent(provider, calendarId, id) {
  return {
    id,
    calendar_id: calendarId,
    provider,
    summary: id,
    start_time: "2026-07-22T10:00:00Z",
    end_time: "2026-07-22T11:00:00Z",
    is_all_day: false,
    status: "confirmed",
  };
}

test("calendar ingress has a sole private metadata path and public reads use an allowlist", () => {
  assert.match(DATABASE_SOURCE, /const CALENDAR_EVENT_PUBLIC_COLUMNS = \[/);
  assert.match(DATABASE_SOURCE, /upsertCalendarEvents\(publicEvents\)/);
  assert.match(DATABASE_SOURCE, /upsertCalendarIngress\(envelopes\)/);
  assert.match(DATABASE_SOURCE, /CREATE TABLE IF NOT EXISTS calendar_patient_metadata/);
  assert.match(DATABASE_SOURCE, /SELECT \$\{CALENDAR_EVENT_PUBLIC_COLUMNS\} FROM calendar_events/);
  const publicUpsertStart = DATABASE_SOURCE.indexOf("upsertCalendarEvents(publicEvents)");
  const publicUpsertEnd = DATABASE_SOURCE.indexOf("\n  // The bridge", publicUpsertStart);
  assert.ok(publicUpsertStart >= 0 && publicUpsertEnd > publicUpsertStart);
  assert.doesNotMatch(
    DATABASE_SOURCE.slice(publicUpsertStart, publicUpsertEnd),
    /patient_metadata|metadata_json|self_attendee_present/
  );
});

test("patient resolution migration installs a closed persisted enum", () => {
  assert.match(
    DATABASE_SOURCE,
    /CHECK \(patient_resolution IN \(\$\{PATIENT_RESOLUTION_SQL\}\)\)/
  );
  assert.match(DATABASE_SOURCE, /validate_encounters_patient_resolution_insert/);
  assert.match(DATABASE_SOURCE, /validate_encounters_patient_resolution_update/);
  assert.match(DATABASE_SOURCE, /SET patient_resolution = 'unassigned_legacy'/);
});

test("patient resolution enum rejects invalid fresh-schema inserts and updates", (t) => {
  const db = createDb(t);
  if (!db) return;

  assert.throws(
    () => db.db.prepare("INSERT INTO encounters (patient_resolution) VALUES ('not-a-resolution')").run(),
    /invalid patient_resolution|CHECK constraint failed/i
  );
  const row = db.db
    .prepare("INSERT INTO encounters (patient_resolution) VALUES ('unassigned_legacy')")
    .run();
  assert.throws(
    () =>
      db.db
        .prepare("UPDATE encounters SET patient_resolution = 'not-a-resolution' WHERE id = ?")
        .run(row.lastInsertRowid),
    /invalid patient_resolution|CHECK constraint failed/i
  );
  db.db.close();
});

test("upgrade migration maps legacy resolutions and triggers reject invalid writes", (t) => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-calendar-db-"));
  let legacy;
  try {
    const SqliteDatabase = require("better-sqlite3");
    legacy = new SqliteDatabase(path.join(userDataDir, "transcriptions.db"));
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      if (process.env.REQUIRE_DB_TESTS === "1") {
        throw new Error(
          "REQUIRE_DB_TESTS=1 requires an Electron-compatible better-sqlite3 binding"
        );
      }
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return;
    }
    throw error;
  }
  legacy.exec(`
    CREATE TABLE encounters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      calendar_event_id TEXT UNIQUE,
      provider TEXT,
      calendar_id TEXT,
      title TEXT NOT NULL DEFAULT 'Encounter',
      start_time TEXT,
      end_time TEXT,
      source_status TEXT NOT NULL DEFAULT 'confirmed',
      lifecycle_state TEXT NOT NULL DEFAULT 'scheduled',
      note_id INTEGER UNIQUE,
      meeting_context TEXT,
      attendees_count INTEGER NOT NULL DEFAULT 0,
      attendees TEXT,
      patient_resolution TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      cancelled_at DATETIME
    );
    INSERT INTO encounters (patient_resolution) VALUES ('obsolete_resolution');
    CREATE TRIGGER validate_encounters_patient_resolution_insert
    BEFORE INSERT ON encounters
    FOR EACH ROW
    WHEN NEW.patient_resolution IS NULL
      OR NEW.patient_resolution NOT IN (
        'created', 'matched', 'unassigned_missing_email',
        'unassigned_multiple_attendees', 'unassigned_conflict',
        'unassigned_invalid_metadata', 'unassigned_folder_unavailable',
        'unassigned_legacy'
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid patient_resolution');
    END;
    CREATE TRIGGER validate_encounters_patient_resolution_update
    BEFORE UPDATE OF patient_resolution ON encounters
    FOR EACH ROW
    WHEN NEW.patient_resolution IS NULL
      OR NEW.patient_resolution NOT IN (
        'created', 'matched', 'unassigned_missing_email',
        'unassigned_multiple_attendees', 'unassigned_conflict',
        'unassigned_invalid_metadata', 'unassigned_folder_unavailable',
        'unassigned_legacy'
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid patient_resolution');
    END;
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const db = new DatabaseManager();
  assert.equal(db.db.pragma("user_version", { simple: true }), 3);
  assert.equal(
    db.db.prepare("SELECT patient_resolution FROM encounters WHERE id = 1").get().patient_resolution,
    "unassigned_legacy"
  );
  const triggers = db.db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'validate_encounters_patient_resolution_%' ORDER BY name"
    )
    .all()
    .map(({ sql }) => sql)
    .join("\\n");
  assert.match(triggers, /unassigned_missing_demographics/);
  assert.doesNotThrow(() =>
    db.db
      .prepare("INSERT INTO encounters (patient_resolution) VALUES ('unassigned_missing_demographics')")
      .run()
  );
  assert.throws(
    () => db.db.prepare("INSERT INTO encounters (patient_resolution) VALUES ('not-a-resolution')").run(),
    /invalid patient_resolution/i
  );
  assert.throws(
    () => db.db.prepare("UPDATE encounters SET patient_resolution = 'not-a-resolution' WHERE id = 1").run(),
    /invalid patient_resolution/i
  );
  db.db.close();
});

test("v2 rebuild preserves legacy encounter outputs, indexes, and custom triggers", (t) => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-calendar-db-"));
  let legacy;
  try {
    const SqliteDatabase = require("better-sqlite3");
    legacy = new SqliteDatabase(path.join(userDataDir, "transcriptions.db"));
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      if (process.env.REQUIRE_DB_TESTS === "1") throw error;
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return;
    }
    throw error;
  }
  legacy.exec([
    "CREATE TABLE encounters (",
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
    "  calendar_event_id TEXT UNIQUE,",
    "  provider TEXT, calendar_id TEXT, title TEXT NOT NULL DEFAULT 'Encounter',",
    "  start_time TEXT, end_time TEXT, source_status TEXT NOT NULL DEFAULT 'confirmed',",
    "  lifecycle_state TEXT NOT NULL DEFAULT 'scheduled' CHECK (lifecycle_state IN ('scheduled', 'in_progress', 'completed', 'cancelled')),",
    "  note_id INTEGER UNIQUE, meeting_context TEXT, attendees_count INTEGER NOT NULL DEFAULT 0, attendees TEXT,",
    "  patient_resolution TEXT NOT NULL DEFAULT 'unassigned_missing_email' CHECK (patient_resolution IN ('created', 'matched', 'unassigned_missing_email', 'unassigned_legacy')),",
    "  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, started_at DATETIME, completed_at DATETIME, cancelled_at DATETIME",
    ");",
    "CREATE INDEX idx_legacy_encounters_title ON encounters(title);",
    "CREATE TRIGGER legacy_encounter_audit AFTER UPDATE OF title ON encounters BEGIN SELECT 1; END;",
    "CREATE TABLE encounter_outputs (encounter_id INTEGER PRIMARY KEY REFERENCES encounters(id) ON DELETE CASCADE, transcript_hash TEXT NOT NULL);",
    "INSERT INTO encounters (calendar_event_id, title, patient_resolution) VALUES ('legacy-event', 'Legacy', 'created');",
    "INSERT INTO encounter_outputs (encounter_id, transcript_hash) VALUES (1, 'legacy-hash');",
    "PRAGMA user_version = 1;"
  ].join("\n"));
  legacy.close();

  const db = new DatabaseManager();
  assert.equal(db.db.pragma("user_version", { simple: true }), 3);
  assert.deepEqual(
    db.db.prepare("SELECT title, patient_resolution FROM encounters WHERE id = 1").get(),
    { title: "Legacy", patient_resolution: "created" }
  );
  assert.deepEqual(
    db.db.prepare("SELECT transcript_hash FROM encounter_outputs WHERE encounter_id = 1").get(),
    { transcript_hash: "legacy-hash" }
  );
  assert.ok(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_legacy_encounters_title'").get());
  assert.ok(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'legacy_encounter_audit'").get());
  assert.deepEqual(db.db.pragma("foreign_key_check"), []);
  db.db.close();
});

test("failed v2 migration rolls back and leaves the schema version unchanged", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.db.pragma("user_version = 1");
  const originalCreateTriggers = db._createPatientResolutionTriggers;
  db._createPatientResolutionTriggers = () => {
    throw new Error("forced migration failure");
  };
  assert.throws(() => db._migrateCalendarSchemaToV2(), /forced migration failure/);
  assert.equal(db.db.pragma("user_version", { simple: true }), 1);
  assert.ok(
    db.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'validate_encounters_patient_resolution_insert'")
      .get()
  );
  db._createPatientResolutionTriggers = originalCreateTriggers;
  db.db.close();
});

test("future calendar schema versions fail closed without downgrade", () => {
  assert.match(DATABASE_SOURCE, /currentVersion > CALENDAR_SCHEMA_VERSION/);
  assert.match(DATABASE_SOURCE, /CALENDAR_SCHEMA_VERSION_UNSUPPORTED/);
  assert.match(DATABASE_SOURCE, /schemaVersion: currentVersion/);
});

test("v1 startup migration failure leaves rows, stale triggers, and version unchanged", (t) => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-calendar-db-"));
  let legacy;
  try {
    const SqliteDatabase = require("better-sqlite3");
    legacy = new SqliteDatabase(path.join(userDataDir, "transcriptions.db"));
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      if (process.env.REQUIRE_DB_TESTS === "1") throw error;
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return;
    }
    throw error;
  }
  legacy.exec([
    "CREATE TABLE encounters (id INTEGER PRIMARY KEY AUTOINCREMENT, calendar_event_id TEXT UNIQUE, provider TEXT, calendar_id TEXT, title TEXT NOT NULL DEFAULT 'Encounter', start_time TEXT, end_time TEXT, source_status TEXT NOT NULL DEFAULT 'confirmed', lifecycle_state TEXT NOT NULL DEFAULT 'scheduled', note_id INTEGER UNIQUE, meeting_context TEXT, attendees_count INTEGER NOT NULL DEFAULT 0, attendees TEXT, patient_resolution TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, started_at DATETIME, completed_at DATETIME, cancelled_at DATETIME);",
    "INSERT INTO encounters (calendar_event_id, patient_resolution) VALUES ('pre-migration-event', 'obsolete_resolution');",
    "CREATE TRIGGER validate_encounters_patient_resolution_insert BEFORE INSERT ON encounters FOR EACH ROW WHEN NEW.patient_resolution IS NULL OR NEW.patient_resolution NOT IN ('created', 'matched', 'unassigned_missing_email', 'unassigned_legacy') BEGIN SELECT RAISE(ABORT, 'invalid patient_resolution'); END;",
    "CREATE TRIGGER validate_encounters_patient_resolution_update BEFORE UPDATE OF patient_resolution ON encounters FOR EACH ROW WHEN NEW.patient_resolution IS NULL OR NEW.patient_resolution NOT IN ('created', 'matched', 'unassigned_missing_email', 'unassigned_legacy') BEGIN SELECT RAISE(ABORT, 'invalid patient_resolution'); END;",
    "PRAGMA user_version = 1;",
  ].join("\n"));
  const preMigrationTriggerSql = legacy
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'validate_encounters_patient_resolution_%' ORDER BY name"
    )
    .all()
    .map(({ sql }) => sql)
    .join("\n");
  legacy.close();

  const originalCreateTriggers = DatabaseManager.prototype._createPatientResolutionTriggers;
  DatabaseManager.prototype._createPatientResolutionTriggers = () => {
    throw new Error("forced startup migration failure");
  };
  let db;
  try {
    db = new DatabaseManager();
    assert.deepEqual(
      db.db.prepare("SELECT patient_resolution FROM encounters WHERE id = 1").get(),
      { patient_resolution: "obsolete_resolution" }
    );
    assert.equal(db.db.pragma("user_version", { simple: true }), 1);
    const postMigrationTriggerSql = db.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'validate_encounters_patient_resolution_insert'")
      .get().sql;
    const allPostMigrationTriggerSql = db.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'validate_encounters_patient_resolution_%' ORDER BY name"
      )
      .all()
      .map(({ sql }) => sql)
      .join("\n");
    assert.equal(allPostMigrationTriggerSql, preMigrationTriggerSql);
    assert.doesNotMatch(postMigrationTriggerSql, /unassigned_missing_demographics/);
    assert.deepEqual(db.getCalendarProjectionHealth(), {
      ready: false,
      schemaVersion: 1,
      errorCode: "CALENDAR_PROJECTION_MIGRATION_FAILED",
    });
  } finally {
    DatabaseManager.prototype._createPatientResolutionTriggers = originalCreateTriggers;
    db?.db.close();
  }
});

test("foreign-key validation failure rolls back the legacy rebuild before version 2", (t) => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-calendar-db-"));
  let legacy;
  try {
    const SqliteDatabase = require("better-sqlite3");
    legacy = new SqliteDatabase(path.join(userDataDir, "transcriptions.db"));
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      if (process.env.REQUIRE_DB_TESTS === "1") throw error;
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return;
    }
    throw error;
  }
  legacy.exec([
    "PRAGMA foreign_keys = OFF;",
    "CREATE TABLE encounters (id INTEGER PRIMARY KEY AUTOINCREMENT, calendar_event_id TEXT UNIQUE, provider TEXT, calendar_id TEXT, title TEXT NOT NULL DEFAULT 'Encounter', start_time TEXT, end_time TEXT, source_status TEXT NOT NULL DEFAULT 'confirmed', lifecycle_state TEXT NOT NULL DEFAULT 'scheduled', note_id INTEGER UNIQUE, meeting_context TEXT, attendees_count INTEGER NOT NULL DEFAULT 0, attendees TEXT, patient_resolution TEXT NOT NULL DEFAULT 'unassigned_missing_email' CHECK (patient_resolution IN ('created', 'matched', 'unassigned_missing_email', 'unassigned_legacy')), created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, started_at DATETIME, completed_at DATETIME DEFAULT NULL, cancelled_at DATETIME DEFAULT NULL);",
    "CREATE TABLE encounter_outputs (encounter_id INTEGER PRIMARY KEY REFERENCES encounters(id) ON DELETE CASCADE, transcript_hash TEXT NOT NULL);",
    "INSERT INTO encounters (calendar_event_id, patient_resolution) VALUES ('valid-event', 'created');",
    "INSERT INTO encounter_outputs (encounter_id, transcript_hash) VALUES (999, 'orphan-output');",
    "CREATE TRIGGER legacy_encounter_audit AFTER UPDATE OF title ON encounters BEGIN SELECT 1; END;",
    "PRAGMA user_version = 1;",
  ].join("\n"));
  legacy.close();

  const db = new DatabaseManager();
  assert.equal(db.db.pragma("user_version", { simple: true }), 1);
  assert.deepEqual(
    db.db.prepare("SELECT calendar_event_id, patient_resolution FROM encounters WHERE id = 1").get(),
    { calendar_event_id: "valid-event", patient_resolution: "created" }
  );
  assert.deepEqual(
    db.db.prepare("SELECT transcript_hash FROM encounter_outputs WHERE encounter_id = 999").get(),
    { transcript_hash: "orphan-output" }
  );
  assert.ok(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'legacy_encounter_audit'").get());
  assert.match(db.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'encounters'").get().sql, /unassigned_missing_email/);
  assert.equal(db.db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(db.getCalendarProjectionHealth().errorCode, "CALENDAR_PROJECTION_MIGRATION_FAILED");
  db.db.close();
});

test("calendar ingress stores tri-state provenance privately, redacts public reads, and deletes absent metadata", (t) => {
  const db = createDb(t);
  if (!db) return;

  const event = restEvent("ai_receptionist", "primary", "private-ingress-event");
  const metadata = {
    name: "Sentinel Patient",
    email: "sentinel.patient@example.com",
    phone: "+15551234567",
    source: "structured_description",
  };
  db.upsertCalendarIngress([{
    publicEvent: event,
    patientMetadata: metadata,
    selfAttendeePresent: false,
  }]);

  const stored = db.db
    .prepare("SELECT metadata_json, source, self_attendee_present FROM calendar_patient_metadata WHERE calendar_event_id = ?")
    .get(event.id);
  assert.deepEqual(JSON.parse(stored.metadata_json), metadata);
  assert.equal(stored.source, "structured_description");
  assert.equal(stored.self_attendee_present, 0);
  assert.equal(db.db.prepare("SELECT patient_metadata FROM calendar_events WHERE id = ?").get(event.id).patient_metadata, null);

  const publicById = db.getCalendarEventById(event.id);
  const publicInRange = db.getCalendarEventsInRange("2026-07-22T00:00:00Z", "2026-07-23T00:00:00Z");
  for (const publicEvent of [publicById, publicInRange[0]]) {
    assert.equal(Object.hasOwn(publicEvent, "patient_metadata"), false);
    assert.equal(Object.hasOwn(publicEvent, "metadata_json"), false);
    assert.equal(Object.hasOwn(publicEvent, "self_attendee_present"), false);
    assert.equal(JSON.stringify(publicEvent).includes("Sentinel Patient"), false);
    assert.equal(JSON.stringify(publicEvent).includes("sentinel.patient@example.com"), false);
    assert.equal(JSON.stringify(publicEvent).includes("15551234567"), false);
  }
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM patient_profiles").get().count, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM folders WHERE name = ?").get("Sentinel Patient").count, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM encounters WHERE calendar_event_id = ?").get(event.id).count, 0);

  db.upsertCalendarIngress([{ publicEvent: event, patientMetadata: null, selfAttendeePresent: true }]);
  assert.equal(
    db.db.prepare("SELECT metadata_json FROM calendar_patient_metadata WHERE calendar_event_id = ?").get(event.id),
    undefined
  );
  db.db.close();
});

test("private ingress resolves only explicit no-self metadata and preserves retry idempotency", (t) => {
  const db = createDb(t);
  if (!db) return;

  const metadata = (email, name) => ({
    email,
    name,
    phone: null,
    source: "structured_description",
  });
  const metadataOnly = (id) => {
    const event = restEvent("ai_receptionist", "primary", id);
    event.attendees = JSON.stringify([]);
    event.attendees_count = 0;
    return event;
  };

  const selfOnly = metadataOnly("patient-self-only-metadata");
  const unknown = metadataOnly("patient-unknown-metadata");
  const malformed = metadataOnly("patient-malformed-self-provenance");
  const noSelf = metadataOnly("patient-no-self-metadata");
  db.upsertCalendarIngress([
    {
      publicEvent: selfOnly,
      patientMetadata: metadata("clinician@example.com", "Clinician"),
      selfAttendeePresent: true,
    },
    {
      publicEvent: unknown,
      patientMetadata: metadata("unknown@example.com", "Unknown"),
      selfAttendeePresent: null,
    },
    {
      publicEvent: malformed,
      patientMetadata: metadata("malformed@example.com", "Malformed"),
      selfAttendeePresent: "false",
    },
    {
      publicEvent: noSelf,
      patientMetadata: metadata("approved@example.com", "Approved Patient"),
      selfAttendeePresent: false,
    },
  ]);
  db.upsertEncountersFromCalendarEvents([selfOnly, unknown, malformed, noSelf]);

  const selfOnlyResult = db.startEncounterForCalendarEvent(selfOnly.id);
  const unknownResult = db.startEncounterForCalendarEvent(unknown.id);
  const malformedResult = db.startEncounterForCalendarEvent(malformed.id);
  const noSelfResult = db.startEncounterForCalendarEvent(noSelf.id);
  const retry = db.startEncounterForCalendarEvent(noSelf.id);
  assert.equal(selfOnlyResult.patientResolution, "unassigned_missing_email");
  assert.equal(unknownResult.patientResolution, "unassigned_missing_email");
  assert.equal(malformedResult.patientResolution, "unassigned_missing_email");
  assert.equal(selfOnlyResult.patientProfileId, null);
  assert.equal(unknownResult.patientProfileId, null);
  assert.equal(malformedResult.patientProfileId, null);
  assert.equal(noSelfResult.patientResolution, "created");
  assert.equal(retry.patientResolution, "matched");
  assert.equal(noSelfResult.note.id, retry.note.id);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS count FROM patient_profiles").get().count,
    1
  );
  assert.equal(
    db.db.prepare("SELECT self_attendee_present FROM calendar_patient_metadata WHERE calendar_event_id = ?")
      .get(selfOnly.id).self_attendee_present,
    1
  );
  assert.equal(
    db.db.prepare("SELECT self_attendee_present FROM calendar_patient_metadata WHERE calendar_event_id = ?")
      .get(unknown.id).self_attendee_present,
    null
  );
  assert.equal(
    db.db.prepare("SELECT self_attendee_present FROM calendar_patient_metadata WHERE calendar_event_id = ?")
      .get(malformed.id).self_attendee_present,
    null
  );
  assert.equal(
    db.db.prepare("SELECT self_attendee_present FROM calendar_patient_metadata WHERE calendar_event_id = ?")
      .get(noSelf.id).self_attendee_present,
    0
  );
  db.db.close();
});

test("one external attendee resolves regardless of private self provenance", (t) => {
  const db = createDb(t);
  if (!db) return;

  const eventWithExternalAttendee = (id, email) => {
    const event = restEvent("ai_receptionist", "primary", id);
    event.attendees = JSON.stringify([{ email, displayName: email }]);
    event.attendees_count = 1;
    return event;
  };
  const selfPresent = eventWithExternalAttendee("patient-external-self-present", "external-true@example.com");
  const unknown = eventWithExternalAttendee("patient-external-unknown", "external-null@example.com");
  db.upsertCalendarIngress([
    {
      publicEvent: selfPresent,
      patientMetadata: { email: "external-true@example.com", name: "External True", source: "structured_description" },
      selfAttendeePresent: true,
    },
    {
      publicEvent: unknown,
      patientMetadata: { email: "external-null@example.com", name: "External Null", source: "structured_description" },
      selfAttendeePresent: null,
    },
  ]);
  db.upsertEncountersFromCalendarEvents([selfPresent, unknown]);

  const trueResult = db.startEncounterForCalendarEvent(selfPresent.id);
  const nullResult = db.startEncounterForCalendarEvent(unknown.id);
  assert.equal(trueResult.patientResolution, "created");
  assert.equal(nullResult.patientResolution, "created");
  assert.deepEqual(
    db.db.prepare("SELECT normalized_email FROM patient_profiles ORDER BY normalized_email").all(),
    [{ normalized_email: "external-null@example.com" }, { normalized_email: "external-true@example.com" }]
  );
  db.db.close();
});

test("private metadata schema upgrades without backfilling self-attendee provenance", (t) => {
  const db = createDb(t);
  if (!db) return;

  const event = restEvent("ai_receptionist", "primary", "legacy-self-provenance");
  event.attendees = JSON.stringify([]);
  event.attendees_count = 0;
  db.upsertCalendarEvents([event]);
  db.db.exec("DROP TABLE calendar_patient_metadata");
  db.db.exec(`
    CREATE TABLE calendar_patient_metadata (
      calendar_event_id TEXT PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
      metadata_json TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source = 'structured_description'),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.db.prepare(`
    INSERT INTO calendar_patient_metadata (calendar_event_id, metadata_json, source)
    VALUES (?, ?, 'structured_description')
  `).run(event.id, JSON.stringify({
    email: "legacy@example.com",
    name: "Legacy Patient",
    phone: null,
    source: "structured_description",
  }));
  db.db.close();

  const upgraded = new DatabaseManager();
  const stored = upgraded.db.prepare(`
    SELECT self_attendee_present
    FROM calendar_patient_metadata
    WHERE calendar_event_id = ?
  `).get(event.id);
  assert.equal(stored.self_attendee_present, null);
  upgraded.upsertEncountersFromCalendarEvents([event]);
  const result = upgraded.startEncounterForCalendarEvent(event.id);
  assert.equal(result.patientResolution, "unassigned_missing_email");
  assert.equal(result.patientProfileId, null);
  assert.equal(upgraded.db.prepare("SELECT COUNT(*) AS count FROM patient_profiles").get().count, 0);
  upgraded.db.close();
});

test("upgrade relocation moves valid legacy metadata without historical assignment", (t) => {
  const db = createDb(t);
  if (!db) return;

  const event = restEvent("ai_receptionist", "primary", "legacy-private-ingress-event");
  db.upsertCalendarEvents([event]);
  db.db
    .prepare("UPDATE calendar_events SET patient_metadata = ? WHERE id = ?")
    .run(JSON.stringify({ name: "Legacy Patient", email: "legacy.patient@example.com" }), event.id);
  db.db.close();

  const reloaded = new DatabaseManager();
  const moved = reloaded.db
    .prepare("SELECT metadata_json, self_attendee_present FROM calendar_patient_metadata WHERE calendar_event_id = ?")
    .get(event.id);
  assert.deepEqual(JSON.parse(moved.metadata_json), {
    name: "Legacy Patient",
    email: "legacy.patient@example.com",
    phone: null,
    source: "structured_description",
  });
  assert.equal(moved.self_attendee_present, null);
  assert.equal(
    reloaded.db.prepare("SELECT patient_metadata FROM calendar_events WHERE id = ?").get(event.id).patient_metadata,
    null
  );
  assert.equal(reloaded.db.prepare("SELECT COUNT(*) AS count FROM patient_profiles").get().count, 0);
  assert.equal(reloaded.db.prepare("SELECT COUNT(*) AS count FROM encounters").get().count, 1);
  reloaded.db.close();
});

test("full-sync prune drops stale events but keeps fresh, note-linked, and other-scope rows", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertCalendarEvents([
    restEvent("microsoft", "ms-cal", "fresh"),
    restEvent("microsoft", "ms-cal", "stale"),
    restEvent("microsoft", "ms-cal", "stale-linked"),
    restEvent("microsoft", "other-cal", "other-calendar"),
    restEvent("google", "ms-cal", "other-provider"),
  ]);
  const note = db.saveNote("Linked meeting", "", "meeting").note;
  db.updateNote(note.id, { calendar_event_id: "stale-linked" });

  db.removeStaleCalendarEvents("microsoft", "ms-cal", ["fresh"]);

  assert.equal(db.getCalendarEventById("fresh")?.summary, "fresh");
  assert.equal(db.getCalendarEventById("stale"), null);
  assert.equal(db.getCalendarEventById("stale-linked")?.summary, "stale-linked");
  assert.equal(db.getCalendarEventById("other-calendar")?.summary, "other-calendar");
  assert.equal(db.getCalendarEventById("other-provider")?.summary, "other-provider");
  db.db.close();
});

test("full-sync prune with an empty fresh set clears the calendar's unlinked events", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertCalendarEvents([restEvent("microsoft", "ms-cal", "stale")]);

  db.removeStaleCalendarEvents("microsoft", "ms-cal", []);

  assert.equal(db.getCalendarEventById("stale"), null);
  db.db.close();
});

test("tentative Apple events remain visible in upcoming meetings", (t) => {
  const db = createDb(t);
  if (!db) return;

  const now = Date.now();
  db.upsertCalendarEvents([
    appleEvent("tentative-event", {
      start_time: new Date(now + 5 * 60_000).toISOString(),
      end_time: new Date(now + 35 * 60_000).toISOString(),
      status: "tentative",
    }),
  ]);

  const events = db.getUpcomingEvents(15);
  assert.equal(
    events.some((event) => event.id === "tentative-event"),
    true
  );
  db.db.close();
});

test("note generation candidates require a real encounter link", (t) => {
  const db = createDb(t);
  if (!db) return;

  const note = db.saveNote("Regular meeting note", "", "meeting").note;
  const withoutEncounter = db.createNoteGenerationCandidate({
    noteId: note.id,
    generatedContent: "# Candidate",
  });
  assert.equal(withoutEncounter.success, false);
  assert.equal(withoutEncounter.code, "ENCOUNTER_REQUIRED");

  db.db
    .prepare(
      `INSERT INTO encounters
        (calendar_event_id, provider, calendar_id, title, note_id, patient_resolution)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      "ai_receptionist:primary:encounter-candidate-test",
      "ai_receptionist",
      "primary",
      "Encounter candidate test",
      note.id,
      "unassigned_legacy"
    );

  const linked = db.createNoteGenerationCandidate({
    noteId: note.id,
    generatedContent: "# Candidate",
  });
  assert.equal(linked.success, true);
  assert.equal(linked.candidate.note_id, note.id);
  db.db.close();
});

test("transcript sessions keep interim checkpoints ineligible and finalize after completion", (t) => {
  const db = createDb(t);
  if (!db) return;

  const note = db.saveNote("Finalization contract", "manual emphasis", "meeting").note;
  const encounterId = Number(
    db.db.prepare(
      `INSERT INTO encounters
        (calendar_event_id, provider, calendar_id, title, note_id, lifecycle_state, patient_resolution)
       VALUES (?, 'ai_receptionist', 'primary', 'Finalization contract', ?, 'in_progress', 'unassigned_legacy')`
    ).run("ai_receptionist:primary:finalization-contract", note.id).lastInsertRowid
  );

  assert.equal(db.beginTranscriptSession(note.id, "session-a").success, true);
  assert.equal(db.markEncounterComplete(encounterId).errorCode, "ENCOUNTER_TRANSCRIPT_NOT_SAVED");
  assert.equal(db.db.prepare("SELECT lifecycle_state FROM encounters WHERE id = ?").get(encounterId).lifecycle_state, "in_progress");
  const checkpoint = db.checkpointTranscriptSession(note.id, "session-a", "partial transcript");
  assert.equal(checkpoint.success, true);
  assert.equal(checkpoint.note.transcript_persistence_status, "checkpointed");
  assert.equal(db.getEncountersNeedingOutputGeneration().length, 0);
  assert.equal(db.beginEncounterOutputGeneration(encounterId), null);
  assert.equal(db.getNoteGenerationSource(note.id).isFinalized, false);

  assert.equal(db.markEncounterComplete(encounterId).success, true);
  const finalized = db.finalizeTranscriptSession(note.id, "session-a", "final transcript");
  assert.equal(finalized.success, true);
  assert.equal(finalized.note.transcript_persistence_status, "finalized");
  assert.equal(finalized.note.finalized_transcript_revision, finalized.note.transcript_revision);
  assert.equal(db.getEncountersNeedingOutputGeneration().some((item) => item.id === encounterId), true);
  assert.ok(db.beginEncounterOutputGeneration(encounterId)?.token);
  db.db.close();
});

test("an empty recording session can checkpoint and finalize without creating generation work", (t) => {
  const db = createDb(t);
  if (!db) return;

  const note = db.saveNote("Empty recording", "", "meeting").note;
  const encounterId = Number(
    db.db.prepare(
      `INSERT INTO encounters
        (calendar_event_id, provider, calendar_id, title, note_id, lifecycle_state, patient_resolution)
       VALUES (?, 'ai_receptionist', 'primary', 'Empty recording', ?, 'in_progress', 'unassigned_legacy')`
    ).run("ai_receptionist:primary:empty-recording", note.id).lastInsertRowid
  );

  assert.equal(db.beginTranscriptSession(note.id, "empty-session").success, true);
  const checkpoint = db.checkpointTranscriptSession(note.id, "empty-session", "");
  assert.equal(checkpoint.success, true);
  assert.equal(checkpoint.note.transcript_persistence_status, "checkpointed");
  assert.equal(db.markEncounterComplete(encounterId).success, true);

  const finalized = db.finalizeTranscriptSession(note.id, "empty-session", "");
  assert.equal(finalized.success, true);
  assert.equal(finalized.note.transcript_persistence_status, "finalized");
  assert.equal(finalized.note.transcript_session_id, null);
  assert.equal(finalized.note.finalized_transcript_revision, finalized.note.transcript_revision);
  assert.equal(db.getEncountersNeedingOutputGeneration().some((item) => item.id === encounterId), false);
  assert.equal(db.beginEncounterOutputGeneration(encounterId), null);
  db.db.close();
});

test("transcript session claims reject stale writers and generation sources expose revisions", (t) => {
  const db = createDb(t);
  if (!db) return;

  const note = db.saveNote("Session claim", "first", "meeting").note;
  assert.equal(db.beginTranscriptSession(note.id, "old-session").success, true);
  assert.equal(db.beginTranscriptSession(note.id, "new-session").success, true);
  assert.equal(
    db.finalizeTranscriptSession(note.id, "old-session", "stale transcript").errorCode,
    "ENCOUNTER_RECORDING_STALE_SESSION"
  );
  const finalized = db.finalizeTranscriptSession(note.id, "new-session", "current transcript");
  assert.equal(finalized.success, true);

  const beforeEdit = db.getNoteGenerationSource(note.id);
  db.updateNote(note.id, { content: "second" });
  const afterEdit = db.getNoteGenerationSource(note.id);
  assert.ok(afterEdit.sourceRevision > beforeEdit.sourceRevision);
  assert.equal(afterEdit.isFinalized, true);
  assert.equal(afterEdit.finalizedTranscriptRevision, afterEdit.transcriptRevision);
  db.db.close();
});

test("encounter projection preserves local ownership and start retries reuse one note", (t) => {
  const db = createDb(t);
  if (!db) return;

  const event = restEvent("ai_receptionist", "primary", "ai_receptionist:primary:event-1:one");
  event.summary = "Initial title";
  event.attendees = '[{"email":"patient@example.com"}]';
  event.attendees_count = 1;
  db.upsertCalendarEvents([event]);
  db.upsertEncountersFromCalendarEvents([event]);

  const first = db.startEncounterForCalendarEvent(event.id, { meetingContext: "in_person" });
  const retry = db.startEncounterForCalendarEvent(event.id, { meetingContext: "telehealth" });
  assert.equal(first.success, true);
  assert.equal(retry.success, true);
  assert.equal(first.note.id, retry.note.id);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS count FROM notes WHERE calendar_event_id = ?").get(event.id)
      .count,
    1
  );

  const refreshed = { ...event, summary: "Renamed by calendar" };
  db.upsertEncountersFromCalendarEvents([refreshed]);
  const encounter = db.getEncounterByCalendarEventId(event.id);
  assert.equal(encounter.title, "Renamed by calendar");
  assert.equal(encounter.note_id, first.note.id);
  assert.equal(encounter.lifecycle_state, "in_progress");
  assert.equal(encounter.meeting_context, "telehealth");
  db.db.close();
});

test("encounter tombstones cancel unstarted rows but preserve started records", (t) => {
  const db = createDb(t);
  if (!db) return;

  const scheduled = restEvent(
    "ai_receptionist",
    "primary",
    "ai_receptionist:primary:scheduled:one"
  );
  const started = restEvent("ai_receptionist", "primary", "ai_receptionist:primary:started:one");
  db.upsertCalendarEvents([scheduled, started]);
  db.upsertEncountersFromCalendarEvents([scheduled, started]);
  db.startEncounterForCalendarEvent(started.id);

  db.markEncountersCancelledByCalendarEventPrefix(
    "ai_receptionist",
    "primary",
    "ai_receptionist:primary:scheduled:"
  );
  db.markEncountersCancelledByCalendarEventPrefix(
    "ai_receptionist",
    "primary",
    "ai_receptionist:primary:started:"
  );

  assert.equal(db.getEncounterByCalendarEventId(scheduled.id).lifecycle_state, "cancelled");
  assert.equal(db.getEncounterByCalendarEventId(started.id).lifecycle_state, "in_progress");
  assert.equal(db.getEncounterByCalendarEventId(started.id).note_id != null, true);
  db.db.close();
});

test("complete-window reconciliation cancels only stale unstarted encounters", (t) => {
  const db = createDb(t);
  if (!db) return;

  const fresh = restEvent("ai_receptionist", "primary", "fresh");
  const stale = restEvent("ai_receptionist", "primary", "stale");
  const inProgress = restEvent("ai_receptionist", "primary", "in-progress");
  const completed = restEvent("ai_receptionist", "primary", "completed");
  const linked = restEvent("ai_receptionist", "primary", "linked");
  db.upsertCalendarEvents([fresh, stale, inProgress, completed, linked]);
  db.upsertEncountersFromCalendarEvents([fresh, stale, inProgress, completed, linked]);
  db.startEncounterForCalendarEvent(inProgress.id);
  db.startEncounterForCalendarEvent(completed.id);
  db.db
    .prepare(
      "UPDATE encounters SET lifecycle_state = 'completed', completed_at = CURRENT_TIMESTAMP WHERE calendar_event_id = ?"
    )
    .run(completed.id);
  const note = db.saveNote("Linked note", "", "meeting").note;
  db.updateNote(note.id, { calendar_event_id: linked.id });
  db.db
    .prepare(
      "UPDATE encounters SET note_id = ?, lifecycle_state = 'scheduled' WHERE calendar_event_id = ?"
    )
    .run(note.id, linked.id);

  db.reconcileStaleCalendarWindow(
    "ai_receptionist",
    "primary",
    [fresh.id],
    "2026-07-22T00:00:00Z",
    "2026-07-23T00:00:00Z"
  );

  assert.equal(db.getEncounterByCalendarEventId(fresh.id).lifecycle_state, "scheduled");
  assert.equal(db.getEncounterByCalendarEventId(stale.id).lifecycle_state, "cancelled");
  assert.equal(db.getCalendarEventById(stale.id), null);
  assert.equal(db.getEncounterByCalendarEventId(inProgress.id).lifecycle_state, "in_progress");
  assert.equal(db.getEncounterByCalendarEventId(completed.id).lifecycle_state, "completed");
  assert.equal(db.getEncounterByCalendarEventId(linked.id).note_id, note.id);
  assert.equal(db.getCalendarEventById(linked.id)?.id, linked.id);
  db.db.close();
});

test("encounter outputs are local, retry-safe, and stale when the canonical transcript changes", (t) => {
  const db = createDb(t);
  if (!db) return;

  const event = restEvent("ai_receptionist", "primary", "encounter-output");
  db.upsertCalendarEvents([event]);
  db.upsertEncountersFromCalendarEvents([event]);
  const started = db.startEncounterForCalendarEvent(event.id);
  const encounterId = started.encounter.id;

  const initial = db.getOrCreateEncounterOutput(encounterId);
  assert.equal(initial.summary_status, "pending");
  assert.equal(initial.soap_status, "pending");

  const ready = db.updateEncounterOutput(encounterId, {
    summary: "Clinical summary",
    soap: "SOAP note",
    summary_status: "ready",
    soap_status: "ready",
    summary_provider: "local",
    summary_model: "qwen-local",
  });
  assert.equal(ready.status, "ready");

  db.updateNote(started.note.id, { transcript: '[{"id":"segment-1","text":"Hello"}]' });
  const stale = db.getEncounterOutput(encounterId);
  assert.equal(stale.summary_status, "stale");
  assert.equal(stale.soap_status, "stale");
  assert.notEqual(stale.transcript_hash, initial.transcript_hash);

  const retry = db.retryEncounterOutput(encounterId, "summary");
  assert.equal(retry.summary_status, "pending");
  assert.equal(retry.soap_status, "stale");
  db.db.close();
});

test("final encounter transcript is persisted without completing the encounter", (t) => {
  const db = createDb(t);
  if (!db) return;

  const event = restEvent("ai_receptionist", "primary", "encounter-finalize");
  db.upsertCalendarEvents([event]);
  db.upsertEncountersFromCalendarEvents([event]);
  const started = db.startEncounterForCalendarEvent(event.id);
  db.updateEncounterOutput(started.encounter.id, {
    summary: "Old summary",
    summary_status: "ready",
  });

  const finalTranscript = '[{"id":"segment-1","text":"Final transcript"}]';
  const result = db.saveEncounterRecording(started.note.id, finalTranscript);
  assert.equal(result.success, true);
  assert.equal(db.getNote(started.note.id).transcript, finalTranscript);
  assert.equal(db.getEncounterById(started.encounter.id).lifecycle_state, "in_progress");
  assert.equal(db.getEncounterOutput(started.encounter.id).summary_status, "stale");
  db.db.close();
});

test("encounter completion is independent from clinical output generation and locks source edits", (t) => {
  const db = createDb(t);
  if (!db) return;

  const event = restEvent("ai_receptionist", "primary", "encounter-lock");
  db.upsertCalendarEvents([event]);
  db.upsertEncountersFromCalendarEvents([event]);
  const started = db.startEncounterForCalendarEvent(event.id);
  db.saveEncounterRecording(started.note.id, '[{"text":"Ready to complete"}]');

  const completed = db.markEncounterComplete(started.encounter.id);
  assert.equal(completed.success, true);
  assert.equal(completed.encounter.lifecycle_state, "completed");

  const retry = db.retryEncounterOutput(started.encounter.id, "all");
  assert.equal(retry.summary_status, "pending");
  assert.equal(retry.soap_status, "pending");
  assert.equal(retry.focus_status, "pending");

  const edit = db.updateNote(started.note.id, { content: "Should not save" });
  assert.equal(edit.success, false);
  assert.equal(edit.errorCode, "ENCOUNTER_COMPLETED");
  assert.equal(db.getNote(started.note.id).content, "");
  db.db.close();
});

test("direct encounter resolution and output reconciliation do not depend on scheduled-list size", (t) => {
  const db = createDb(t);
  if (!db) return;

  const completedEvent = restEvent("ai_receptionist", "primary", "direct-completed");
  db.upsertCalendarEvents([completedEvent]);
  db.upsertEncountersFromCalendarEvents([completedEvent]);
  const started = db.startEncounterForCalendarEvent(completedEvent.id);
  const completed = db.saveEncounterRecording(
    started.note.id,
    '[{"text":"The patient reports improvement."}]'
  );
  assert.equal(completed.success, true);

  const scheduledEvents = Array.from({ length: 225 }, (_, index) =>
    restEvent("ai_receptionist", "primary", `scheduled-overflow-${index}`)
  );
  db.upsertCalendarEvents(scheduledEvents);
  db.upsertEncountersFromCalendarEvents(scheduledEvents);
  // Saving is no longer completion: explicitly close the historical fixture
  // so the in-progress-first listing legitimately excludes it.
  assert.equal(db.markEncounterComplete(started.encounter.id).success, true);

  const listed = db.getEncounters(200);
  assert.equal(listed.some((encounter) => encounter.id === started.encounter.id), false);

  const direct = db.getEncounterByNoteId(started.note.id);
  assert.equal(direct.id, started.encounter.id);

  const pending = db.getEncountersNeedingOutputGeneration(50);
  assert.equal(pending.some((encounter) => encounter.id === started.encounter.id), true);
  assert.equal(pending.some((encounter) => encounter.note_id == null), false);
  db.db.close();
});

test("bounded encounter and calendar queries use an exclusive end boundary", (t) => {
  const db = createDb(t);
  if (!db) return;

  const atStart = restEvent("ai_receptionist", "primary", "at-start");
  atStart.start_time = "2026-07-22T00:00:00Z";
  const atEnd = restEvent("ai_receptionist", "primary", "at-end");
  atEnd.start_time = "2026-07-23T00:00:00Z";
  db.upsertCalendarEvents([atStart, atEnd]);
  db.upsertEncountersFromCalendarEvents([atStart, atEnd]);

  const events = db.getCalendarEventsInRange(
    "2026-07-22T00:00:00Z",
    "2026-07-23T00:00:00Z",
    10,
    "ai_receptionist"
  );
  const encounters = db.getEncountersInRange(
    "2026-07-22T00:00:00Z",
    "2026-07-23T00:00:00Z",
    10
  );
  assert.deepEqual(events.map((event) => event.id), ["at-start"]);
  assert.deepEqual(encounters.map((encounter) => encounter.calendar_event_id), ["at-start"]);
  db.db.close();
});

function startEncounterOutputFixture(db, id) {
  const event = restEvent("ai_receptionist", "primary", id);
  db.upsertCalendarEvents([event]);
  db.upsertEncountersFromCalendarEvents([event]);
  const started = db.startEncounterForCalendarEvent(event.id);
  return { encounterId: started.encounter.id, noteId: started.note.id };
}

test("guarded output completion rejects a generation raced by a transcript edit", (t) => {
  const db = createDb(t);
  if (!db) return;

  const { encounterId, noteId } = startEncounterOutputFixture(db, "output-update-race");
  db.updateNote(noteId, { transcript: '[{"id":"one","text":"Before edit"}]' });
  const begun = db.beginEncounterOutputGeneration(encounterId);

  db.updateNote(noteId, { transcript: '[{"id":"one","text":"After edit"}]' });
  const finished = db.finishEncounterOutputGeneration(encounterId, begun.token, {
    summary: "Old generated summary",
    summary_status: "ready",
    soap: "Old generated SOAP",
    soap_status: "ready",
  });

  assert.equal(finished.applied, false);
  assert.equal(finished.output.summary, null);
  assert.equal(finished.output.summary_status, "pending");
  assert.equal(finished.output.transcript_revision, begun.token.transcriptRevision + 1);
  db.db.close();
});

test("output generation claims prevent duplicate work and reclaim stale claims safely", (t) => {
  const db = createDb(t);
  if (!db) return;

  const { encounterId, noteId } = startEncounterOutputFixture(db, "output-claim");
  db.updateNote(noteId, { transcript: '[{"text":"Current transcript"}]' });

  const first = db.beginEncounterOutputGeneration(encounterId);
  assert.equal(typeof first.token.generationId, "string");
  assert.equal("generation_id" in first.output, false);

  const duplicate = db.beginEncounterOutputGeneration(encounterId);
  assert.equal(duplicate.busy, true);
  assert.equal(duplicate.token, null);

  db.db
    .prepare("UPDATE encounter_outputs SET generation_started_at = '2000-01-01 00:00:00' WHERE encounter_id = ?")
    .run(encounterId);
  const heartbeatProtected = db.beginEncounterOutputGeneration(encounterId);
  assert.equal(heartbeatProtected.busy, true);

  db.db
    .prepare("UPDATE encounter_outputs SET generation_heartbeat_at = '2000-01-01 00:00:00' WHERE encounter_id = ?")
    .run(encounterId);
  const reclaimed = db.beginEncounterOutputGeneration(encounterId);
  assert.equal(reclaimed.busy, false);
  assert.notEqual(reclaimed.token.generationId, first.token.generationId);

  const oldFinish = db.finishEncounterOutputGeneration(encounterId, first.token, {
    summary: "Old summary",
    summary_status: "ready",
    soap: "Old SOAP",
    soap_status: "ready",
    focus: "Old focus",
    focus_status: "ready",
  });
  assert.equal(oldFinish.applied, false);

  const currentFinish = db.finishEncounterOutputGeneration(encounterId, reclaimed.token, {
    summary: "Current summary",
    summary_status: "ready",
    soap: "Current SOAP",
    soap_status: "ready",
    focus: "Current focus",
    focus_status: "ready",
  });
  assert.equal(currentFinish.applied, true);
  assert.equal(currentFinish.output.summary, "Current summary");
  db.db.close();
});

test("progress updates require the current transcript claim and refresh the heartbeat", (t) => {
  const db = createDb(t);
  if (!db) return;

  const { encounterId, noteId } = startEncounterOutputFixture(db, "output-progress-guard");
  db.updateNote(noteId, { transcript: '[{"text":"Current transcript"}]' });
  const begun = db.beginEncounterOutputGeneration(encounterId);

  const progress = db.updateEncounterOutputGenerationProgress(encounterId, begun.token, {
    phase: "mapping",
    current: 2,
    total: 5,
  });
  assert.equal(progress.applied, true);
  assert.equal(progress.output.generation_phase, "mapping");
  assert.equal(progress.output.generation_progress_current, 2);
  assert.equal(progress.output.generation_progress_total, 5);
  assert.ok(progress.output.generation_heartbeat_at);

  db.updateNote(noteId, { transcript: '[{"text":"New transcript"}]' });
  const stale = db.updateEncounterOutputGenerationProgress(encounterId, begun.token, {
    phase: "mapping",
    current: 3,
    total: 5,
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.output.generation_phase, null);
  assert.equal(stale.output.generation_progress_current, 0);
  db.db.close();
});

test("guarded output completion rejects a diarization-style transcript rewrite", (t) => {
  const db = createDb(t);
  if (!db) return;

  const { encounterId, noteId } = startEncounterOutputFixture(db, "output-diarization-race");
  db.updateNote(noteId, { transcript: '[{"text":"Hello doctor"}]' });
  const begun = db.beginEncounterOutputGeneration(encounterId, ["summary"]);

  db.updateNote(noteId, {
    transcript: '[{"speaker":"SPEAKER_00","text":"Hello doctor"}]',
  });
  const finished = db.finishEncounterOutputGeneration(encounterId, begun.token, {
    summary: "Summary without speaker labels",
    summary_status: "ready",
  });

  assert.equal(finished.applied, false);
  assert.equal(finished.output.summary_status, "pending");
  assert.equal(
    finished.output.transcript_hash,
    db.getEncounterTranscriptToken(encounterId).transcriptHash
  );
  db.db.close();
});

test("transcript revision prevents ABA generation completion", (t) => {
  const db = createDb(t);
  if (!db) return;

  const { encounterId, noteId } = startEncounterOutputFixture(db, "output-aba-race");
  const transcriptA = '[{"text":"Transcript A"}]';
  db.updateNote(noteId, { transcript: transcriptA });
  const begun = db.beginEncounterOutputGeneration(encounterId);

  db.updateNote(noteId, { transcript: '[{"text":"Transcript B"}]' });
  db.updateNote(noteId, { transcript: transcriptA });
  const currentToken = db.getEncounterTranscriptToken(encounterId);
  const finished = db.finishEncounterOutputGeneration(encounterId, begun.token, {
    summary: "Result for the first A",
    summary_status: "ready",
  });

  assert.equal(currentToken.transcriptHash, begun.token.transcriptHash);
  assert.ok(currentToken.transcriptRevision > begun.token.transcriptRevision);
  assert.equal(finished.applied, false);
  assert.equal(finished.output.summary, null);
  db.db.close();
});

test("guarded output completion publishes matching-token results", (t) => {
  const db = createDb(t);
  if (!db) return;

  const { encounterId, noteId } = startEncounterOutputFixture(db, "output-matching-token");
  db.updateNote(noteId, { transcript: '[{"text":"Current encounter transcript"}]' });
  const begun = db.beginEncounterOutputGeneration(encounterId);
  const finished = db.finishEncounterOutputGeneration(encounterId, begun.token, {
    summary: "Current summary",
    summary_status: "ready",
    summary_provider: "local",
    soap: "Current SOAP",
    soap_status: "ready",
    soap_model: "qwen-local",
  });

  assert.equal(finished.applied, true);
  assert.equal(finished.output.status, "ready");
  assert.equal(finished.output.summary, "Current summary");
  assert.equal(finished.output.transcript_revision, begun.token.transcriptRevision);
  db.db.close();
});

test("transcript changes preserve existing output state semantics", (t) => {
  const db = createDb(t);
  if (!db) return;

  const { encounterId, noteId } = startEncounterOutputFixture(db, "output-existing-states");
  db.updateEncounterOutput(encounterId, {
    summary: "Existing summary",
    summary_status: "ready",
    soap_status: "processing",
  });

  db.updateNote(noteId, { transcript: '[{"text":"Revised transcript"}]' });
  const invalidated = db.getEncounterOutput(encounterId);
  assert.equal(invalidated.summary_status, "stale");
  assert.equal(invalidated.soap_status, "pending");

  const retried = db.retryEncounterOutput(encounterId, "summary");
  assert.equal(retried.summary_status, "pending");
  assert.equal(retried.soap_status, "pending");
  db.db.close();
});

test("patient folders resolve by exact email, stay private, and keep retry idempotency", (t) => {
  const db = createDb(t);
  if (!db) return;

  const alex = restEvent("ai_receptionist", "primary", "patient-alex-one");
  alex.summary = "Follow-up";
  alex.attendees_count = 1;
  alex.attendees = JSON.stringify([{ email: "Alex@example.com", displayName: "Alex Morgan" }]);
  db.upsertCalendarIngress([
    {
      publicEvent: alex,
      patientMetadata: {
        email: "alex@example.com",
        name: "Alex Morgan",
        phone: null,
        source: "structured_description",
      },
    },
  ]);
  db.upsertEncountersFromCalendarEvents([alex]);
  const first = db.startEncounterForCalendarEvent(alex.id);
  const retry = db.startEncounterForCalendarEvent(alex.id);
  assert.equal(first.patientResolution, "created");
  assert.equal(Object.hasOwn(first, "patientProfile"), false);
  assert.equal(typeof first.patientProfileId, "number");
  assert.equal(retry.patientResolution, "matched");
  assert.equal(first.note.id, retry.note.id);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM patient_profiles").get().count, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM notes WHERE calendar_event_id = ?").get(alex.id).count, 1);
  const profile = db.db.prepare(
    "SELECT p.normalized_email, f.space_id FROM patient_profiles p JOIN folders f ON f.id = p.folder_id"
  ).get();
  assert.equal(profile.normalized_email, "alex@example.com");
  assert.equal(profile.space_id, db.getPrivateSpaceId());

  const renamed = restEvent("ai_receptionist", "primary", "patient-alex-two");
  renamed.attendees_count = 1;
  renamed.attendees = JSON.stringify([{ email: "alex@example.com", displayName: "Alexandra Morgan" }]);
  db.upsertCalendarEvents([renamed]);
  db.upsertEncountersFromCalendarEvents([renamed]);
  const second = db.startEncounterForCalendarEvent(renamed.id);
  assert.equal(second.patientResolution, "matched");
  assert.equal(second.patientProfileId, first.patientProfileId);

  const sameNameNewEmail = restEvent("ai_receptionist", "primary", "patient-alex-three");
  sameNameNewEmail.attendees_count = 1;
  sameNameNewEmail.attendees = JSON.stringify([{ email: "another-alex@example.com", displayName: "Alex Morgan" }]);
  db.upsertCalendarEvents([sameNameNewEmail]);
  db.upsertEncountersFromCalendarEvents([sameNameNewEmail]);
  const third = db.startEncounterForCalendarEvent(sameNameNewEmail.id);
  assert.equal(third.patientResolution, "created");
  assert.notEqual(third.patientProfileId, first.patientProfileId);
  const patientFolders = db.db
    .prepare(
      `SELECT f.name
       FROM patient_profiles p JOIN folders f ON f.id = p.folder_id
       ORDER BY p.id ASC`
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(patientFolders, ["Alex Morgan", "Alex Morgan (2)"]);
  db.db.close();
});

test("Google self filtering never creates a clinician patient folder", (t) => {
  const db = createDb(t);
  if (!db) return;

  const clinician = { email: "clinician@example.com", self: true };
  const externalPatient = {
    email: "external.patient@example.com",
    displayName: "External Patient",
    self: false,
  };

  // These represent the provider-shaped attendees before R5-1 removes self attendees.
  const selfOnlyBeforeFilter = restEvent(
    "google",
    "primary",
    "google-self-only-before-filter"
  );
  const selfOnlyGoogleAttendees = [clinician];
  assert.equal(selfOnlyGoogleAttendees.length, 1);
  selfOnlyBeforeFilter.attendees = JSON.stringify(
    selfOnlyGoogleAttendees.filter((attendee) => attendee.self !== true)
  );
  selfOnlyBeforeFilter.attendees_count = 0;
  assert.deepEqual(JSON.parse(selfOnlyBeforeFilter.attendees), []);
  db.upsertCalendarEvents([selfOnlyBeforeFilter]);
  db.upsertEncountersFromCalendarEvents([selfOnlyBeforeFilter]);

  const selfOnlyResult = db.startEncounterForCalendarEvent(selfOnlyBeforeFilter.id);
  assert.equal(selfOnlyResult.patientResolution, "unassigned_missing_email");
  assert.equal(selfOnlyResult.patientProfileId, null);
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM patient_profiles WHERE normalized_email = ?")
      .get(clinician.email).count,
    0
  );
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM folders WHERE name = ?")
      .get("clinician@example.com").count,
    0
  );

  const mixedBeforeFilter = restEvent(
    "google",
    "primary",
    "google-self-plus-external-before-filter"
  );
  const mixedGoogleAttendees = [clinician, externalPatient];
  assert.equal(mixedGoogleAttendees.length, 2);
  mixedBeforeFilter.attendees = JSON.stringify(
    mixedGoogleAttendees.filter((attendee) => attendee.self !== true)
  );
  mixedBeforeFilter.attendees_count = 1;
  assert.deepEqual(JSON.parse(mixedBeforeFilter.attendees), [externalPatient]);
  db.upsertCalendarEvents([mixedBeforeFilter]);
  db.upsertEncountersFromCalendarEvents([mixedBeforeFilter]);

  const mixedResult = db.startEncounterForCalendarEvent(mixedBeforeFilter.id);
  assert.equal(mixedResult.patientResolution, "created");
  assert.equal(typeof mixedResult.patientProfileId, "number");

  const profiles = db.db
    .prepare(
      `SELECT p.normalized_email, f.space_id
       FROM patient_profiles p JOIN folders f ON f.id = p.folder_id`
    )
    .all();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].normalized_email, externalPatient.email);
  assert.equal(profiles[0].space_id, db.getPrivateSpaceId());
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM patient_profiles WHERE normalized_email = ?")
      .get(clinician.email).count,
    0
  );

  db.db.close();
});

test("ambiguous and conflicting patient identities remain in Meetings without profiles", (t) => {
  const db = createDb(t);
  if (!db) return;

  const group = restEvent("ai_receptionist", "primary", "patient-group");
  group.attendees_count = 2;
  group.attendees = JSON.stringify([{ email: "one@example.com" }, { email: "two@example.com" }]);
  const conflict = restEvent("ai_receptionist", "primary", "patient-conflict");
  conflict.attendees_count = 1;
  conflict.attendees = JSON.stringify([{ email: "one@example.com" }]);
  db.upsertCalendarIngress([
    { publicEvent: group, patientMetadata: null },
    {
      publicEvent: conflict,
      patientMetadata: {
        email: "other@example.com",
        name: null,
        phone: null,
        source: "structured_description",
      },
    },
  ]);
  db.upsertEncountersFromCalendarEvents([group, conflict]);

  const groupResult = db.startEncounterForCalendarEvent(group.id);
  const conflictResult = db.startEncounterForCalendarEvent(conflict.id);
  assert.equal(groupResult.patientResolution, "unassigned_multiple_attendees");
  assert.equal(conflictResult.patientResolution, "unassigned_conflict");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM patient_profiles").get().count, 0);
  const meetings = db.getMeetingsFolder(db.getPrivateSpaceId());
  assert.equal(groupResult.note.folder_id, meetings.id);
  assert.equal(conflictResult.note.folder_id, meetings.id);
  db.db.close();
});

test("missing identity and an unavailable patient folder remain review-required without duplicate profiles", (t) => {
  const db = createDb(t);
  if (!db) return;

  const missing = restEvent("ai_receptionist", "primary", "patient-missing");
  missing.attendees_count = 0;
  db.upsertCalendarIngress([{ publicEvent: missing, patientMetadata: null }]);
  db.upsertEncountersFromCalendarEvents([missing]);
  const missingResult = db.startEncounterForCalendarEvent(missing.id);
  assert.equal(missingResult.patientResolution, "unassigned_missing_email");
  assert.equal(missingResult.patientProfileId, null);

  const available = restEvent("ai_receptionist", "primary", "patient-unavailable-source");
  available.attendees = JSON.stringify([{ email: "review@example.com", displayName: "Review Patient" }]);
  available.attendees_count = 1;
  db.upsertCalendarEvents([available]);
  db.upsertEncountersFromCalendarEvents([available]);
  const created = db.startEncounterForCalendarEvent(available.id);
  const profileId = created.patientProfileId;
  const profile = db.db.prepare("SELECT folder_id FROM patient_profiles WHERE id = ?").get(profileId);
  db.db.prepare("UPDATE folders SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(profile.folder_id);

  const followUp = restEvent("ai_receptionist", "primary", "patient-unavailable-follow-up");
  followUp.attendees = JSON.stringify([{ email: "review@example.com", displayName: "Review Patient" }]);
  followUp.attendees_count = 1;
  db.upsertCalendarEvents([followUp]);
  db.upsertEncountersFromCalendarEvents([followUp]);
  const unavailable = db.startEncounterForCalendarEvent(followUp.id);
  const meetings = db.getMeetingsFolder(db.getPrivateSpaceId());
  assert.equal(unavailable.patientResolution, "unassigned_folder_unavailable");
  assert.equal(unavailable.encounter.patient_profile_id, profileId);
  assert.equal(unavailable.patientProfileId, profileId);
  assert.equal(unavailable.note.folder_id, meetings.id);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM patient_profiles").get().count, 1);
  db.db.close();
});

test("timezone-aware focus title promotion preserves manual and stale-output guards", (t) => {
  const db = createDb(t);
  if (!db) return;
  const event = restEvent("ai_receptionist", "primary", "patient-focus");
  event.start_time = "2026-08-15T03:30:00Z";
  event.end_time = "2026-08-15T04:00:00Z";
  event.timezone = "America/New_York";
  event.summary = "Calendar follow-up";
  event.attendees_count = 1;
  event.attendees = JSON.stringify([{ email: "patient@example.com" }]);
  db.upsertCalendarEvents([event]);
  db.upsertEncountersFromCalendarEvents([event]);
  const started = db.startEncounterForCalendarEvent(event.id);
  assert.equal(started.note.title, "2026-08-14 — Calendar follow-up");
  db.saveEncounterRecording(started.note.id, "Medication tolerance improved.");
  const begun = db.beginEncounterOutputGeneration(started.encounter.id, "focus");
  const refined = db.finishEncounterOutputGeneration(started.encounter.id, begun.token, {
    focus: "Medication tolerance follow-up",
    focus_status: "ready",
  });
  assert.equal(refined.note.title, "2026-08-14 — Medication tolerance follow-up");
  db.updateNote(started.note.id, { title: "Manual record title" });
  const next = db.beginEncounterOutputGeneration(started.encounter.id, "focus");
  const protectedResult = db.finishEncounterOutputGeneration(started.encounter.id, next.token, {
    focus: "Should not overwrite",
    focus_status: "ready",
  });
  assert.equal(protectedResult.note, null);
  assert.equal(db.getNote(started.note.id).title, "Manual record title");

  const stale = db.beginEncounterOutputGeneration(started.encounter.id, "focus");
  db.updateNote(started.note.id, { transcript: "Manual transcript correction" });
  const staleResult = db.finishEncounterOutputGeneration(started.encounter.id, stale.token, {
    focus: "Must not apply",
    focus_status: "ready",
  });
  assert.equal(staleResult.applied, false);
  assert.equal(db.getNote(started.note.id).title, "Manual record title");
  db.db.close();
});
