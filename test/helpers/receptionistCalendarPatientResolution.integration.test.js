const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

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
const { ReceptionistCalendarBridge } = require("../../src/helpers/receptionistCalendarBridge.js");

function createDb() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-patient-resolution-"));
  return new DatabaseManager();
}

function sidecarEvent(eventId, overrides = {}) {
  return {
    calendar_id: "primary",
    event_id: eventId,
    event_uid: `uid-${eventId}`,
    start_iso: "2026-08-20T15:15:00+00:00",
    end_iso: "2026-08-20T15:45:00+00:00",
    timezone: "America/New_York",
    title: "Patient encounter",
    notes: "RAW-DESCRIPTION-SENTINEL",
    status: "confirmed",
    ...overrides,
  };
}

function metadata(email, name) {
  return {
    name,
    email,
    phone: "+1 (555) 123-4567",
    source: "structured_description",
  };
}

function publicForbiddenValue(value) {
  const serialized = JSON.stringify(value);
  for (const sentinel of [
    "patient_metadata",
    "metadata_json",
    "self_attendee_present",
    "RAW-DESCRIPTION-SENTINEL",
    "Clinician Private",
    "clinician.private@example.com",
    "+15551234567",
  ]) {
    assert.equal(
      serialized.includes(sentinel),
      false,
      `public value leaked forbidden sentinel ${sentinel}`
    );
  }
}

function assertNoPatientFolder(db, email, folderLabel) {
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM patient_profiles WHERE normalized_email = ?")
      .get(email.toLowerCase()).count,
    0
  );
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS count FROM folders WHERE name = ?").get(folderLabel).count,
    0
  );
}

test("fresh calendar-events bridge resolves only trusted external/no-self identities", (t) => {
  const db = createDb();
  t.after(() => db.db.close());

  const ingressCalls = [];
  const broadcasts = [];
  const events = [
    sidecarEvent("self-only", {
      attendees: [],
      self_attendee_present: true,
      patient_metadata: metadata("clinician.private@example.com", "Clinician Private"),
    }),
    sidecarEvent("attendees-absent", {
      self_attendee_present: null,
      patient_metadata: metadata("absent@example.com", "Absent Provenance"),
    }),
    sidecarEvent("attendees-non-list", {
      attendees: { email: "not-an-attendee-list@example.com" },
      self_attendee_present: null,
      patient_metadata: metadata("non-list@example.com", "Non List Provenance"),
    }),
    sidecarEvent("attendees-non-object-member", {
      attendees: [null],
      self_attendee_present: null,
      patient_metadata: metadata("non-object@example.com", "Non Object Provenance"),
    }),
    sidecarEvent("attendee-self-non-boolean", {
      attendees: [],
      self_attendee_present: null,
      patient_metadata: metadata("non-boolean@example.com", "Non Boolean Provenance"),
    }),
    sidecarEvent("self-plus-external", {
      attendees: ["External.Patient@Example.COM"],
      self_attendee_present: true,
      patient_metadata: metadata("external.patient@example.com", "External Patient"),
    }),
    sidecarEvent("valid-no-self", {
      attendees: [],
      self_attendee_present: false,
      patient_metadata: metadata("Approved.Patient@Example.COM", "Approved Patient"),
    }),
  ];

  const bridge = new ReceptionistCalendarBridge({
    runtime: {
      isAvailable: () => true,
      runModule: async (_moduleName, args) => {
        assert.equal(args[0], "calendar-events");
        return { ok: true, stdout: JSON.stringify({ events }) };
      },
    },
    databaseManager: {
      upsertCalendarIngress: (envelopes) => {
        ingressCalls.push(envelopes);
        db.upsertCalendarIngress(envelopes);
      },
      upsertEncountersFromCalendarEvents: (publicEvents) =>
        db.upsertEncountersFromCalendarEvents(publicEvents),
      reconcileStaleCalendarWindow: (...args) => db.reconcileStaleCalendarWindow(...args),
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: (...args) => broadcasts.push(args),
  });

  return bridge.sync({
    startIso: "2026-08-20T00:00:00.000Z",
    endIso: "2026-08-21T00:00:00.000Z",
    limit: events.length,
  }).then((result) => {
    assert.equal(result.success, true);
    assert.equal(result.events.length, events.length);
    assert.equal(ingressCalls.length, 1);
    assert.equal(ingressCalls[0].length, events.length);

    const byEventId = new Map(
      ingressCalls[0].map((envelope) => [envelope.publicEvent.event_id, envelope])
    );
    const expectedSignals = new Map([
      ["self-only", true],
      ["attendees-absent", null],
      ["attendees-non-list", null],
      ["attendees-non-object-member", null],
      ["attendee-self-non-boolean", null],
      ["self-plus-external", true],
      ["valid-no-self", false],
    ]);

    for (const [eventId, expectedSignal] of expectedSignals) {
      const envelope = byEventId.get(eventId);
      assert.ok(envelope, `missing ingress envelope for ${eventId}`);
      assert.equal(envelope.selfAttendeePresent, expectedSignal);
      assert.ok(envelope.patientMetadata);
      assert.equal(Object.hasOwn(envelope.publicEvent, "patient_metadata"), false);
      assert.equal(Object.hasOwn(envelope.publicEvent, "self_attendee_present"), false);
      publicForbiddenValue(envelope.publicEvent);
    }

    const publicValues = [
      result,
      ...result.events,
      ...broadcasts,
      ...result.events.map((event) => db.getCalendarEventById(event.id)),
      ...db.getCalendarEventsInRange("2026-08-20T00:00:00Z", "2026-08-21T00:00:00Z"),
    ];
    for (const value of publicValues) publicForbiddenValue(value);

    for (const event of result.events) {
      const encounter = db.startEncounterForCalendarEvent(event.id);
      assert.equal(encounter.success, true);
      publicForbiddenValue(encounter);
    }

    const encounterFor = (eventId) =>
      db.getEncounterByCalendarEventId(
        result.events.find((event) => event.event_id === eventId).id
      );
    assert.equal(encounterFor("self-only").patient_resolution, "unassigned_missing_email");
    assert.equal(encounterFor("attendees-absent").patient_resolution, "unassigned_missing_email");
    assert.equal(encounterFor("attendees-non-list").patient_resolution, "unassigned_missing_email");
    assert.equal(
      encounterFor("attendees-non-object-member").patient_resolution,
      "unassigned_missing_email"
    );
    assert.equal(
      encounterFor("attendee-self-non-boolean").patient_resolution,
      "unassigned_missing_email"
    );

    const externalEncounter = encounterFor("self-plus-external");
    assert.equal(externalEncounter.patient_resolution, "created");
    const approvedEncounter = encounterFor("valid-no-self");
    assert.equal(approvedEncounter.patient_resolution, "created");

    assertNoPatientFolder(db, "clinician.private@example.com", "Clinician Private");
    assertNoPatientFolder(db, "absent@example.com", "Absent Provenance");
    assertNoPatientFolder(db, "non-list@example.com", "Non List Provenance");
    assertNoPatientFolder(db, "non-object@example.com", "Non Object Provenance");
    assertNoPatientFolder(db, "non-boolean@example.com", "Non Boolean Provenance");

    const profiles = db.db
      .prepare(
        "SELECT normalized_email, f.space_id FROM patient_profiles p JOIN folders f ON f.id = p.folder_id ORDER BY p.id"
      )
      .all();
    assert.deepEqual(
      profiles.map((profile) => profile.normalized_email),
      ["external.patient@example.com", "approved.patient@example.com"]
    );
    assert.ok(profiles.every((profile) => profile.space_id === db.getPrivateSpaceId()));
  });
});
