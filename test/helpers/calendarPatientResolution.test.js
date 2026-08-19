const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-patient-resolution-"));
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

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return message.includes("NODE_MODULE_VERSION") || message.includes("Could not locate the bindings file");
}

function createManagedDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-patient-resolution-"));
  const priorRegistryPath = process.env.HIRA_PATIENT_REGISTRY_PATH;
  process.env.HIRA_PATIENT_REGISTRY_PATH = path.join(userDataDir, "patient-registry.sqlite3");
  try {
    const db = new DatabaseManager();
    t.after(() => {
      try {
        db.db?.close();
      } finally {
        if (priorRegistryPath === undefined) delete process.env.HIRA_PATIENT_REGISTRY_PATH;
        else process.env.HIRA_PATIENT_REGISTRY_PATH = priorRegistryPath;
      }
    });
    return db;
  } catch (error) {
    if (priorRegistryPath === undefined) delete process.env.HIRA_PATIENT_REGISTRY_PATH;
    else process.env.HIRA_PATIENT_REGISTRY_PATH = priorRegistryPath;
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

function event(id, overrides = {}) {
  return {
    id: `ai_receptionist:primary:${id}:2026-08-20T15:00:00.000Z`,
    calendar_id: "primary",
    provider: "ai_receptionist",
    summary: "Follow-up",
    start_time: "2026-08-20T15:00:00Z",
    end_time: "2026-08-20T15:30:00Z",
    is_all_day: false,
    status: "confirmed",
    event_id: id,
    event_uid: id,
    occurrence_id: id,
    ...overrides,
  };
}

function metadata(overrides = {}) {
  return {
    name: "Alex Morgan",
    dob: "1990-04-12",
    email: "alex@example.com",
    phone: "+15551234567",
    source: "structured_description",
    ...overrides,
  };
}

test("managed calendar ingestion creates one patient, appointment, link, folder, and dated note", (t) => {
  const db = createManagedDb(t);
  if (!db) return;
  const appointment = event("manual-alex");

  db.upsertCalendarIngress([{ publicEvent: appointment, patientMetadata: metadata() }]);
  assert.equal(
    db.db.prepare("SELECT status FROM calendar_patient_links WHERE calendar_event_id = ?").get(appointment.id).status,
    "created"
  );
  db.upsertCalendarIngress([{ publicEvent: appointment, patientMetadata: metadata() }]);

  const patient = db.db.prepare("SELECT * FROM hira_registry.patients").get();
  assert.equal(patient.name, "Alex Morgan");
  assert.equal(patient.normalized_name, "alex morgan");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM hira_registry.patients").get().count, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM hira_registry.appointments").get().count, 1);
  assert.deepEqual(
    db.db.prepare("SELECT patient_id, status FROM calendar_patient_links WHERE calendar_event_id = ?").get(appointment.id),
    { patient_id: patient.patient_id, status: "linked" }
  );

  db.upsertEncountersFromCalendarEvents([appointment]);
  const encounter = db.db.prepare("SELECT patient_id, patient_resolution FROM encounters WHERE calendar_event_id = ?").get(appointment.id);
  assert.equal(encounter.patient_id, patient.patient_id);
  assert.equal(encounter.patient_resolution, "matched");

  const started = db.startEncounterForCalendarEvent(appointment.id);
  assert.equal(started.success, true);
  assert.equal(started.note.title, "2026-08-20 — Follow-up");
  const workspace = db.db.prepare("SELECT f.name FROM patient_workspaces w JOIN folders f ON f.id = w.folder_id WHERE w.patient_id = ?").get(patient.patient_id);
  assert.deepEqual(workspace, { name: "Alex Morgan" });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM notes WHERE calendar_event_id = ?").get(appointment.id).count, 1);

  const renamed = event("manual-alex", { id: appointment.id, summary: "Annual review" });
  db.upsertCalendarIngress([{ publicEvent: renamed, patientMetadata: null }]);
  const linked = db.getCalendarEventById(appointment.id);
  assert.equal(linked.patient_name, "Alex Morgan");
  assert.equal(linked.patient_link_status, "linked");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM hira_registry.appointments").get().count, 1);
});

test("legacy provider-less occurrence keys still resolve the durable calendar event", (t) => {
  const db = createManagedDb(t);
  if (!db) return;
  const legacy = event("legacy-occurrence", {
    occurrence_id: "primary:legacy-occurrence:2026-08-20T15:00:00Z",
  });
  db.upsertCalendarIngress([{ publicEvent: legacy, patientMetadata: null }]);

  const resolved = db.getCalendarEventById(legacy.occurrence_id);
  assert.equal(resolved?.id, legacy.id);
  assert.equal(resolved?.event_id, legacy.event_id);
});

test("calendar projection repair backfills missing events while bounded reads stay side-effect free", (t) => {
  const db = createManagedDb(t);
  if (!db) return;
  const events = [event("backfill-one"), event("backfill-two", { summary: "Second appointment" })];
  db.upsertCalendarIngress(events.map((publicEvent) => ({ publicEvent, patientMetadata: null })));

  const beforeRead = db.db.prepare("SELECT COUNT(*) AS count FROM encounters").get().count;
  const firstRead = db.getEncountersInRange("2026-08-20T00:00:00Z", "2026-08-21T00:00:00Z", 100);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM encounters").get().count, beforeRead);
  assert.deepEqual(firstRead, []);

  const repair = db.repairCalendarEncounterProjections();
  assert.equal(repair.success, true);
  assert.equal(repair.created, 2);
  const repairedRead = db.getEncountersInRange("2026-08-20T00:00:00Z", "2026-08-21T00:00:00Z", 100);
  assert.deepEqual(repairedRead.map((encounter) => encounter.calendar_event_id).sort(), events.map(({ id }) => id).sort());
  assert.ok(repairedRead.every((encounter) => encounter.lifecycle_state === "scheduled"));

  const repeatedRepair = db.repairCalendarEncounterProjections();
  assert.equal(repeatedRepair.created, 0);
  const secondRead = db.getEncountersInRange("2026-08-20T00:00:00Z", "2026-08-21T00:00:00Z", 100);
  assert.equal(secondRead.length, 2);
});

test("projection repair excludes non-managed and non-confirmed calendar events", (t) => {
  const db = createManagedDb(t);
  if (!db) return;
  const managed = event("repair-managed");
  const apple = event("repair-apple", { provider: "apple" });
  const cancelled = event("repair-cancelled", { status: "cancelled" });
  db.upsertCalendarEvents([managed, apple, cancelled]);

  const repair = db.repairCalendarEncounterProjections();
  assert.equal(repair.created, 1);
  assert.deepEqual(
    db.db.prepare("SELECT calendar_event_id FROM encounters").all(),
    [{ calendar_event_id: managed.id }]
  );
});

test("projection repair does not create notes, folders, patients, or reminders", (t) => {
  const db = createManagedDb(t);
  if (!db) return;
  const appointment = event("repair-no-side-effects");
  db.upsertCalendarIngress([{ publicEvent: appointment, patientMetadata: metadata() }]);

  db.repairCalendarEncounterProjections();

  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM notes").get().count, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM patient_workspaces").get().count, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM hira_registry.appointments").get().count, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM encounters").get().count, 1);
});

test("rescheduling and renaming preserve the encounter, folder, patient link, and appointment", (t) => {
  const db = createManagedDb(t);
  if (!db) return;
  const original = event("reschedule-alex");
  const initial = db.upsertCalendarIngress([{ publicEvent: original, patientMetadata: metadata() }]);
  db.upsertEncountersFromCalendarEvents(initial.events);
  const started = db.startEncounterForCalendarEvent(original.id);
  const originalNoteId = started.note.id;
  const originalFolderId = db.db.prepare("SELECT folder_id FROM notes WHERE id = ?").get(originalNoteId).folder_id;

  const moved = event("reschedule-alex", {
    id: "ai_receptionist:primary:reschedule-alex:2026-08-27T16:00:00.000Z",
    start_time: "2026-08-27T16:00:00Z",
    end_time: "2026-08-27T16:30:00Z",
    summary: "Annual review",
  });
  const movedIngress = db.upsertCalendarIngress([{ publicEvent: moved, patientMetadata: null }]);
  assert.equal(movedIngress.events[0].id, original.id);
  db.upsertEncountersFromCalendarEvents(movedIngress.events);

  const encounter = db.db.prepare("SELECT * FROM encounters WHERE calendar_event_id = ?").get(original.id);
  assert.equal(encounter.note_id, originalNoteId);
  assert.equal(encounter.start_time, "2026-08-27T16:00:00Z");
  assert.equal(encounter.title, "Annual review");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM encounters").get().count, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM hira_registry.appointments").get().count, 1);
  assert.equal(db.db.prepare("SELECT folder_id FROM notes WHERE id = ?").get(originalNoteId).folder_id, originalFolderId);
  assert.equal(db.getNote(originalNoteId).title, "2026-08-27 — Annual review");

  db.updateNote(originalNoteId, { title: "My custom note" });
  const renamedAgain = event("reschedule-alex", {
    id: "ai_receptionist:primary:reschedule-alex:2026-08-28T16:00:00.000Z",
    start_time: "2026-08-28T16:00:00Z",
    end_time: "2026-08-28T16:30:00Z",
    summary: "Third visit",
  });
  const renamedIngress = db.upsertCalendarIngress([{ publicEvent: renamedAgain, patientMetadata: null }]);
  db.upsertEncountersFromCalendarEvents(renamedIngress.events);
  assert.equal(db.getNote(originalNoteId).title, "My custom note");
});

test("cancelling an event stops its registry appointment and scheduled encounter", (t) => {
  const db = createManagedDb(t);
  if (!db) return;
  const appointment = event("cancel-alex");
  const initial = db.upsertCalendarIngress([{ publicEvent: appointment, patientMetadata: metadata() }]);
  db.upsertEncountersFromCalendarEvents(initial.events);
  const cancelled = event("cancel-alex", {
    id: appointment.id,
    status: "cancelled",
  });
  const cancellation = db.upsertCalendarIngress([{ publicEvent: cancelled, patientMetadata: null }]);
  db.upsertEncountersFromCalendarEvents(cancellation.events);

  assert.equal(db.db.prepare("SELECT status FROM hira_registry.appointments").get().status, "cancelled");
  assert.equal(
    db.db.prepare("SELECT lifecycle_state, source_status FROM encounters WHERE calendar_event_id = ?").get(appointment.id).lifecycle_state,
    "cancelled"
  );
  assert.equal(db.db.prepare("SELECT source_status FROM encounters WHERE calendar_event_id = ?").get(appointment.id).source_status, "cancelled");
});

test("managed encounters block missing patient details without creating notes or unlinked folders", (t) => {
  const db = createManagedDb(t);
  if (!db) return;
  const appointment = event("missing-details");

  db.upsertCalendarIngress([{ publicEvent: appointment, patientMetadata: { name: "Alex Morgan", source: "structured_description" } }]);
  db.upsertEncountersFromCalendarEvents([appointment]);
  const result = db.startEncounterForCalendarEvent(appointment.id);

  assert.equal(result.success, false);
  assert.equal(result.code, "PATIENT_DETAILS_REQUIRED");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM notes WHERE calendar_event_id = ?").get(appointment.id).count, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM folders WHERE name = 'Unlinked Encounters'").get().count, 0);
});

test("saving a registry patient repairs an already projected encounter", (t) => {
  const db = createManagedDb(t);
  if (!db) return;
  const appointment = event("late-registry-alex");
  db.upsertCalendarIngress([{
    publicEvent: appointment,
    patientMetadata: metadata({ email: null, phone: null }),
  }]);
  db.upsertEncountersFromCalendarEvents([appointment]);
  assert.equal(db.startEncounterForCalendarEvent(appointment.id).code, "PATIENT_DETAILS_REQUIRED");

  const patient = db.savePatientRegistryPatient({
    name: "Alex Morgan",
    dob: "1990-04-12",
    email: "alex@example.com",
    phone: "+12125551234",
  });
  const link = db.db
    .prepare("SELECT patient_id, status FROM calendar_patient_links WHERE calendar_event_id = ?")
    .get(appointment.id);
  const encounter = db.db
    .prepare("SELECT patient_id, patient_resolution FROM encounters WHERE calendar_event_id = ?")
    .get(appointment.id);
  assert.deepEqual(link, { patient_id: patient.patient_id, status: "linked" });
  assert.deepEqual(encounter, { patient_id: patient.patient_id, patient_resolution: "matched" });

  const started = db.startEncounterForCalendarEvent(appointment.id);
  assert.equal(started.success, true);
  assert.equal(started.note.title, "2026-08-20 — Follow-up");
  assert.deepEqual(
    db.db.prepare("SELECT name FROM folders WHERE id = (SELECT folder_id FROM notes WHERE id = ?)").get(started.note.id),
    { name: "Alex Morgan" }
  );
});

test("managed follow-ups reuse an exact patient match with only name and DOB", (t) => {
  const db = createManagedDb(t);
  if (!db) return;
  const first = event("new-alex");
  db.upsertCalendarIngress([{ publicEvent: first, patientMetadata: metadata() }]);
  const patient = db.db.prepare("SELECT * FROM hira_registry.patients").get();

  const followUp = event("follow-up-alex", { summary: "Follow-up" });
  db.upsertCalendarIngress([{
    publicEvent: followUp,
    patientMetadata: metadata({ email: undefined, phone: undefined }),
  }]);

  const link = db.db
    .prepare("SELECT patient_id, status FROM calendar_patient_links WHERE calendar_event_id = ?")
    .get(followUp.id);
  assert.deepEqual(link, { patient_id: patient.patient_id, status: "linked" });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM hira_registry.patients").get().count, 1);
  const publicEvent = db.getCalendarEventById(followUp.id);
  assert.equal(publicEvent.patient_name, "Alex Morgan");
  assert.equal(publicEvent.patient_email, "alex@example.com");
  assert.equal(publicEvent.patient_phone, "+15551234567");
});

test("managed manual events use the calendar title as the patient name", (t) => {
  const db = createManagedDb(t);
  if (!db) return;
  const appointment = event("title-alex", { summary: "Alex Morgan" });
  db.upsertCalendarIngress([{
    publicEvent: appointment,
    patientMetadata: {
      name: null,
      dob: "1990-04-12",
      email: "alex@example.com",
      phone: "+15551234567",
      source: "structured_description",
    },
  }]);

  const patient = db.db.prepare("SELECT name, dob, email, phone FROM hira_registry.patients").get();
  assert.deepEqual(patient, {
    name: "Alex Morgan",
    dob: "1990-04-12",
    email: "alex@example.com",
    phone: "+15551234567",
  });
});

test("managed new patients require both phone and email before creation", (t) => {
  const db = createManagedDb(t);
  if (!db) return;
  const appointment = event("new-without-contact");

  db.upsertCalendarIngress([{
    publicEvent: appointment,
    patientMetadata: metadata({ email: null, phone: null }),
  }]);

  const link = db.db
    .prepare("SELECT patient_id, status, source_name, source_dob FROM calendar_patient_links WHERE calendar_event_id = ?")
    .get(appointment.id);
  assert.deepEqual(link, {
    patient_id: null,
    status: "patient_details_required",
    source_name: "Alex Morgan",
    source_dob: "1990-04-12",
  });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM hira_registry.patients").get().count, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM hira_registry.appointments").get().count, 0);

  db.upsertEncountersFromCalendarEvents([appointment]);
  const result = db.startEncounterForCalendarEvent(appointment.id);
  assert.equal(result.success, false);
  assert.equal(result.code, "PATIENT_DETAILS_REQUIRED");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM notes WHERE calendar_event_id = ?").get(appointment.id).count, 0);
});

test("duplicate normalized name and DOB identities produce a conflict instead of guessing", (t) => {
  const db = createManagedDb(t);
  if (!db) return;
  const now = new Date().toISOString();
  const insert = db.db.prepare(`
    INSERT INTO hira_registry.patients (
      patient_id, name, dob, normalized_name, normalized_dob,
      normalized_phone, normalized_email, sms_consent_status,
      created_at, updated_at, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'opted_in', ?, ?, 1)
  `);
  insert.run("duplicate-a", "Alex Morgan", "1990-04-12", "alex morgan", "1990-04-12", null, "a@example.com", now, now);
  insert.run("duplicate-b", "Alex Morgan", "1990-04-12", "alex morgan", "1990-04-12", null, "b@example.com", now, now);

  const appointment = event("duplicate-identity");
  db.upsertCalendarIngress([{ publicEvent: appointment, patientMetadata: metadata({ email: null, phone: null }) }]);
  const link = db.db.prepare("SELECT patient_id, status FROM calendar_patient_links WHERE calendar_event_id = ?").get(appointment.id);
  assert.deepEqual(link, { patient_id: null, status: "identity_conflict" });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM hira_registry.appointments").get().count, 0);
  db.upsertEncountersFromCalendarEvents([appointment]);
  const result = db.startEncounterForCalendarEvent(appointment.id);
  assert.equal(result.success, false);
  assert.equal(result.code, "PATIENT_DETAILS_REQUIRED");
});

test("recurring occurrences use separate idempotent registry appointments", (t) => {
  const db = createManagedDb(t);
  if (!db) return;
  const first = event("recurring-event", {
    id: "ai_receptionist:primary:recurring-event:2026-08-20T15:00:00.000Z",
    occurrence_id: "occurrence-one",
    recurring_event_id: "recurring-event",
    original_start_time: "2026-08-20T15:00:00Z",
    recurrence: JSON.stringify({ recurring: true }),
  });
  const second = event("recurring-event", {
    id: "ai_receptionist:primary:recurring-event:2026-08-27T15:00:00.000Z",
    occurrence_id: "occurrence-two",
    recurring_event_id: "recurring-event",
    original_start_time: "2026-08-27T15:00:00Z",
    recurrence: JSON.stringify({ recurring: true }),
    start_time: "2026-08-27T15:00:00Z",
    end_time: "2026-08-27T15:30:00Z",
  });

  db.upsertCalendarIngress([
    { publicEvent: first, patientMetadata: metadata() },
    { publicEvent: second, patientMetadata: metadata() },
  ]);

  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM hira_registry.appointments").get().count, 2);
  assert.equal(
    db.db.prepare("SELECT COUNT(DISTINCT appointment_id) AS count FROM calendar_patient_links").get().count,
    2
  );
});

test("merging duplicate registry patients preserves history in the survivor workspace", (t) => {
  const db = createManagedDb(t);
  if (!db) return;
  const now = new Date().toISOString();
  const insertPatient = db.db.prepare(`
    INSERT INTO hira_registry.patients (
      patient_id, name, dob, phone, email, normalized_name, normalized_dob,
      normalized_phone, normalized_email, sms_consent_status, created_at, updated_at, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'opted_in', ?, ?, 1)
  `);
  insertPatient.run("survivor", "Alex Morgan", "1990-04-12", "+12125551234", "alex@old.example", "alex morgan", "1990-04-12", "+12125551234", "alex@old.example", now, now);
  insertPatient.run("duplicate", " Alex  Morgan ", "1990-04-12", "+13125551234", "alex@new.example", "alex morgan", "1990-04-12", "+13125551234", "alex@new.example", now, now);

  const privateSpaceId = db.getPrivateSpaceId();
  const createFolder = (name) => db.db
    .prepare("INSERT INTO folders (name, sort_order, space_id, client_folder_id) VALUES (?, ?, ?, ?)")
    .run(name, 1, privateSpaceId, `${name}-client`).lastInsertRowid;
  const survivorFolderId = createFolder("Alex Morgan");
  const duplicateFolderId = createFolder("Alex Morgan (duplicate)");
  db.db.prepare("INSERT INTO patient_workspaces (patient_id, folder_id) VALUES (?, ?)").run("survivor", survivorFolderId);
  db.db.prepare("INSERT INTO patient_workspaces (patient_id, folder_id) VALUES (?, ?)").run("duplicate", duplicateFolderId);
  const note = db.saveNote("2026-08-10 — Follow-up", "prior encounter", "meeting", null, null, duplicateFolderId).note;
  db.db.prepare("INSERT INTO encounters (calendar_event_id, title, start_time, end_time, note_id, patient_id, patient_resolution) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("duplicate-event", "Follow-up", "2026-08-10T15:00:00Z", "2026-08-10T15:30:00Z", note.id, "duplicate", "matched");
  const newerNote = db.saveNote("2026-08-12 — Check-in", "newer encounter", "meeting", null, null, duplicateFolderId).note;
  db.db.prepare("INSERT INTO encounters (calendar_event_id, title, start_time, end_time, note_id, patient_id, patient_resolution) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("duplicate-event-newer", "Check-in", "2026-08-12T15:00:00Z", "2026-08-12T15:30:00Z", newerNote.id, "duplicate", "matched");

  assert.throws(
    () => db.mergePatientRegistryPatients({ survivorPatientId: "survivor", duplicatePatientId: "duplicate" }),
    (error) => error.code === "PATIENT_MERGE_CONTACT_CONFLICT" && error.field === "phone"
  );
  const merged = db.mergePatientRegistryPatients({
    survivorPatientId: "survivor",
    duplicatePatientId: "duplicate",
    phone: "+13125551234",
    email: "alex@new.example",
  });

  assert.equal(merged.patient_id, "survivor");
  assert.deepEqual(
    db.db.prepare("SELECT active, merged_into_patient_id FROM hira_registry.patients WHERE patient_id = 'duplicate'").get(),
    { active: 0, merged_into_patient_id: "survivor" }
  );
  assert.equal(db.db.prepare("SELECT patient_id FROM encounters WHERE calendar_event_id = 'duplicate-event'").get().patient_id, "survivor");
  assert.equal(db.db.prepare("SELECT folder_id FROM notes WHERE id = ?").get(note.id).folder_id, survivorFolderId);
  assert.equal(db.db.prepare("SELECT deleted_at FROM folders WHERE id = ?").get(duplicateFolderId).deleted_at != null, true);
  assert.equal(db.getPatientEncounterHistory("survivor")[0].note_id, newerNote.id);
  const folderNotes = db.getNotes(null, 50, survivorFolderId);
  assert.deepEqual(folderNotes.map((item) => item.encounter_start_time), [
    "2026-08-12T15:00:00Z",
    "2026-08-10T15:00:00Z",
  ]);
  assert.equal(db.getPatientMergeCandidates("survivor").length, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM hira_registry.patient_merge_history").get().count, 1);
});
