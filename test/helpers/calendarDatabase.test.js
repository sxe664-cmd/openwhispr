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
  `);
  legacy.close();

  const db = new DatabaseManager();
  assert.equal(
    db.db.prepare("SELECT patient_resolution FROM encounters WHERE id = 1").get().patient_resolution,
    "unassigned_legacy"
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
  assert.equal(reloaded.db.prepare("SELECT COUNT(*) AS count FROM encounters").get().count, 0);
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

test("final encounter transcript is persisted before the encounter is completed", (t) => {
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
  const result = db.completeEncounterRecording(started.note.id, finalTranscript);
  assert.equal(result.success, true);
  assert.equal(db.getNote(started.note.id).transcript, finalTranscript);
  assert.equal(db.getEncounterById(started.encounter.id).lifecycle_state, "completed");
  assert.equal(db.getEncounterOutput(started.encounter.id).summary_status, "stale");
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
  db.completeEncounterRecording(started.note.id, "Medication tolerance improved.");
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
