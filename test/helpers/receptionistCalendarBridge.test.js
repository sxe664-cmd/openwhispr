const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PROVIDER,
  ReceptionistCalendarBridge,
  occurrenceId,
  canonicalEventFromAppointment,
  projectCalendarIngress,
  projectCalendarRow,
  projectAppointment,
} = require("../../src/helpers/receptionistCalendarBridge");

const SENSITIVE_SIDECAR_TEXT =
  'C:\\Users\\santi\\token.json /Users/santi/.env.local {"refresh_token":"oauth-refresh-token"} Bearer private-access-token session=private-cookie --calendar-id secret-calendar';

function assertSafePublicValue(value) {
  const text = JSON.stringify(value);
  for (const forbidden of [
    "token.json",
    ".env.local",
    "oauth-refresh-token",
    "private-access-token",
    "private-cookie",
    "secret-calendar",
  ]) {
    assert.doesNotMatch(text, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
}

function appointment(overrides = {}) {
  return {
    calendar_id: "primary",
    event_id: "event-1",
    event_uid: "uid-1",
    start_iso: "2026-08-20T15:15:00+00:00",
    end_iso: "2026-08-20T15:45:00+00:00",
    timezone: "America/New_York",
    title: "Follow-up",
    attendees: ["patient@example.com"],
    recurring: true,
    all_day: false,
    status: "confirmed",
    conference_url: "https://meet.google.com/abc-defg-hij",
    html_link: "https://calendar.google.com/calendar/event?eid=abc",
    ...overrides,
  };
}

test("calendar occurrence ids are stable and namespaced", () => {
  assert.equal(
    occurrenceId(appointment()),
    `${PROVIDER}:primary:event-1:2026-08-20T15_3A15_3A00_2B00_3A00`
  );
  assert.notEqual(
    occurrenceId(appointment({ start_iso: "2026-08-21T15:15:00+00:00" })),
    occurrenceId(appointment())
  );
});

test("projects only safe calendar fields into the local database shape", () => {
  assert.deepEqual(projectAppointment(appointment()), {
    id: "ai_receptionist:primary:event-1:2026-08-20T15_3A15_3A00_2B00_3A00",
    calendar_id: "primary",
    provider: "ai_receptionist",
    summary: "Follow-up",
    start_time: "2026-08-20T15:15:00+00:00",
    end_time: "2026-08-20T15:45:00+00:00",
    is_all_day: 0,
    status: "confirmed",
    hangout_link: "https://meet.google.com/abc-defg-hij",
    html_link: "https://calendar.google.com/calendar/event?eid=abc",
    conference_data: null,
    organizer_email: null,
    attendees_count: 1,
    attendees: JSON.stringify([
      { email: "patient@example.com", displayName: null, responseStatus: null, self: false },
    ]),
  });
  assert.equal(projectAppointment({ event_id: "missing-start" }), null);
});

test("separates sanitized patient metadata from the public calendar projection", () => {
  const source = appointment({
    notes: "private prose that must not leave the sidecar",
    self_attendee_present: false,
    patient_metadata: {
      name: "Alex Morgan",
      email: "ALEX@example.com",
      phone: "+1 (555) 123-4567",
    },
  });
  const row = projectCalendarRow(source);
  const ingress = projectCalendarIngress(source);
  assert.deepEqual(ingress.patientMetadata, {
    name: "Alex Morgan",
    email: "alex@example.com",
    phone: "+15551234567",
    source: "structured_description",
  });
  assert.equal(ingress.selfAttendeePresent, false);
  assert.equal(Object.hasOwn(row, "patient_metadata"), false);
  assert.equal(Object.hasOwn(row, "self_attendee_present"), false);
  assert.equal(Object.hasOwn(ingress.publicEvent, "patient_metadata"), false);
  assert.equal(Object.hasOwn(ingress.publicEvent, "self_attendee_present"), false);
  assert.doesNotMatch(JSON.stringify(ingress.publicEvent), /private prose|Alex Morgan|\+15551234567/);
  assert.equal(
    Object.hasOwn(canonicalEventFromAppointment(source), "patientMetadata"),
    false
  );
});

test("sync is single-flight and keeps a stale status on a failed feed", async () => {
  let calls = 0;
  const runtime = {
    isAvailable: () => true,
    runModule: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("network unavailable");
    },
  };
  const bridge = new ReceptionistCalendarBridge({
    runtime,
    databaseManager: { upsertCalendarEvents: () => {} },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });

  const [first, second] = await Promise.all([bridge.sync(), bridge.sync()]);
  assert.equal(calls, 1);
  assert.equal(first.state, "stale");
  assert.equal(second.state, "stale");
  assert.equal(bridge.getStatus().state, "stale");
});

test("background sync and renderer feed requests are serialized", async () => {
  let activeFeeds = 0;
  let maxActiveFeeds = 0;
  const runtime = {
    isAvailable: () => true,
    runModule: async (_moduleName, args) => {
      if (args[0] === "calendar-events") {
        activeFeeds += 1;
        maxActiveFeeds = Math.max(maxActiveFeeds, activeFeeds);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeFeeds -= 1;
        return { ok: true, stdout: JSON.stringify({ events: [] }) };
      }
      if (args[0] === "appointments") {
        return { ok: true, stdout: JSON.stringify({ appointments: [] }) };
      }
      return { ok: true, stdout: JSON.stringify({}) };
    },
  };
  const bridge = new ReceptionistCalendarBridge({
    runtime,
    databaseManager: {
      upsertCalendarEvents: () => {},
      upsertEncountersFromCalendarEvents: () => {},
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });

  const range = {
    startIso: "2026-08-20T00:00:00.000Z",
    endIso: "2026-08-21T00:00:00.000Z",
    limit: 10,
  };
  const [synced, listed] = await Promise.all([bridge.sync(range), bridge.listCalendarEvents(range)]);

  assert.equal(synced.success, true);
  assert.equal(listed.success, true);
  assert.equal(maxActiveFeeds, 1);
});

test("calendar and reminder failures retain cached behavior while exposing only fixed sidecar errors", async () => {
  let calls = 0;
  const logs = [];
  const runtime = {
    isAvailable: () => true,
    runModule: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          error: { code: "AI_RECEPTIONIST_COMMAND_FAILED", message: SENSITIVE_SIDECAR_TEXT },
          stdout: SENSITIVE_SIDECAR_TEXT,
          stderr: SENSITIVE_SIDECAR_TEXT,
        };
      }
      return { ok: true, stdout: JSON.stringify({ events: [appointment()] }) };
    },
  };
  const bridge = new ReceptionistCalendarBridge({
    runtime,
    databaseManager: {
      upsertCalendarEvents: () => {},
      upsertEncountersFromCalendarEvents: () => {},
    },
    reminderScheduler: null,
    logger: { warn: (...args) => logs.push(args) },
    broadcast: () => {},
  });

  const failed = await bridge.sync();
  assert.equal(failed.state, "stale");
  assert.deepEqual(failed.error, {
    code: "AI_RECEPTIONIST_COMMAND_FAILED",
    message: "AIReceptionist could not complete that request.",
  });
  assert.equal(bridge.getStatus().lastErrorCode, "AI_RECEPTIONIST_COMMAND_FAILED");
  assertSafePublicValue({
    failed,
    status: bridge.getStatus(),
    connection: await bridge.getConnectionStatus(),
  });
  assertSafePublicValue(logs);
  assert.deepEqual(logs[0], [
    "AIReceptionist calendar feed unavailable",
    {
      operation: "calendar-events",
      code: "AI_RECEPTIONIST_COMMAND_FAILED",
    },
  ]);

  const succeeded = await bridge.sync();
  assert.equal(succeeded.success, true);
  assert.equal(bridge.getStatus().lastReminderErrorCode, null);
});

test("malformed feeds and reminder failures use fixed error codes without clearing calendar data", async () => {
  let calls = 0;
  const runtime = {
    isAvailable: () => true,
    runModule: async (_moduleName, args) => {
      calls += 1;
      if (calls === 1) return { ok: true, stdout: "not-json" };
      if (args[0] === "calendar-events")
        return { ok: true, stdout: JSON.stringify({ events: [appointment()] }) };
      if (args[0] === "appointments")
        return { ok: true, stdout: JSON.stringify({ appointments: [appointment()] }) };
      return {
        ok: false,
        error: { code: "AI_RECEPTIONIST_TIMEOUT", message: SENSITIVE_SIDECAR_TEXT },
      };
    },
  };
  const bridge = new ReceptionistCalendarBridge({
    runtime,
    databaseManager: {
      upsertCalendarEvents: () => {},
      upsertEncountersFromCalendarEvents: () => {},
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });

  const malformed = await bridge.sync();
  assert.equal(malformed.error.code, "AI_RECEPTIONIST_INVALID_RESPONSE");
  assert.equal(bridge.getStatus().state, "stale");
  assertSafePublicValue({ malformed, status: bridge.getStatus() });

  const reminderFailure = await bridge.sync();
  assert.equal(reminderFailure.success, true);
  await bridge.waitForBackgroundWork();
  assert.equal(bridge.getStatus().lastReminderErrorCode, "AI_RECEPTIONIST_TIMEOUT");
  assert.equal(bridge.getStatus().lastReminderError, "AIReceptionist took too long to respond.");
  assertSafePublicValue(bridge.getStatus());
});

test("successful feed updates the local projection without exposing raw notes", async () => {
  let saved;
  let encounterSaved;
  const runtime = {
    isAvailable: () => true,
    runModule: async (_moduleName, args) => ({
      ok: true,
      stdout: JSON.stringify(
        args[0] === "appointments"
          ? { appointments: [appointment({ notes: "private note" })] }
          : { events: [appointment({ notes: "private note" })] }
      ),
    }),
  };
  const bridge = new ReceptionistCalendarBridge({
    runtime,
    databaseManager: {
      upsertCalendarEvents: (events) => {
        saved = events;
      },
      upsertEncountersFromCalendarEvents: (events) => {
        encounterSaved = events;
      },
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });

  const result = await bridge.sync();
  assert.equal(result.success, true);
  assert.equal(bridge.getStatus().state, "ready");
  assert.equal(saved.length, 1);
  assert.deepEqual(encounterSaved, saved);
  assert.equal(saved[0].provider, "ai_receptionist");
  assert.doesNotMatch(JSON.stringify(saved), /private note/);
});

test("bridge keeps structured patient metadata inside private ingress envelopes", async () => {
  const ingressCalls = [];
  const encounterCalls = [];
  const reconciliationCalls = [];
  const broadcasts = [];
  const source = appointment({
    notes: "RAW-DESCRIPTION-SENTINEL",
    self_attendee_present: true,
    patient_metadata: {
      name: "Alex Morgan",
      email: "alex.private@example.com",
      phone: "+1 555 123 4567",
    },
  });
  const bridge = new ReceptionistCalendarBridge({
    runtime: {
      isAvailable: () => true,
      runModule: async () => ({
        ok: true,
        stdout: JSON.stringify({
          events: [source],
          window: {
            start_iso: "2026-08-20T00:00:00.000Z",
            end_iso: "2026-08-21T00:00:00.000Z",
            calendar_ids: ["primary"],
            complete: true,
          },
        }),
      }),
    },
    databaseManager: {
      upsertCalendarIngress: (envelopes) => ingressCalls.push(envelopes),
      upsertCalendarEvents: () => assert.fail("public calendar upsert must not receive ingress"),
      upsertEncountersFromCalendarEvents: (events) => encounterCalls.push(events),
      reconcileStaleCalendarWindow: (...args) => reconciliationCalls.push(args),
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: (...args) => broadcasts.push(args),
  });

  const result = await bridge.sync();
  const forbidden = /patient_metadata|metadata_json|self_attendee_present|Alex Morgan|alex\.private@example\.com|\+15551234567|RAW-DESCRIPTION-SENTINEL/;

  assert.equal(ingressCalls.length, 1);
  assert.deepEqual(ingressCalls[0][0].patientMetadata, {
    name: "Alex Morgan",
    email: "alex.private@example.com",
    phone: "+15551234567",
    source: "structured_description",
  });
  assert.equal(ingressCalls[0][0].selfAttendeePresent, true);
  assert.equal(Object.hasOwn(ingressCalls[0][0].publicEvent, "patient_metadata"), false);
  assert.equal(Object.hasOwn(ingressCalls[0][0].publicEvent, "self_attendee_present"), false);
  assert.doesNotMatch(JSON.stringify(result), forbidden);
  assert.doesNotMatch(JSON.stringify(encounterCalls), forbidden);
  assert.doesNotMatch(JSON.stringify(reconciliationCalls), forbidden);
  assert.doesNotMatch(JSON.stringify(broadcasts), forbidden);
  assert.deepEqual(broadcasts[0], ["gcal-events-synced", {
    provider: "ai_receptionist",
    success: true,
    eventCount: 1,
    errorCode: null,
  }]);
});

test("bridge preserves filtered external attendees and keeps self-only feeds empty", async (t) => {
  await t.test("external attendee emails are normalized as non-self public attendees", async () => {
    const ingressCalls = [];
    const encounterCalls = [];
    const broadcasts = [];
    const source = appointment({
      attendee_emails: ["external@example.com"],
      attendees: [],
      self_attendee_present: true,
      notes: "RAW-DESCRIPTION-ATTENDEE-SENTINEL",
      patient_metadata: {
        name: "Alex Morgan",
        email: "alex.private@example.com",
        phone: "+1 555 222 3333",
      },
    });
    const bridge = new ReceptionistCalendarBridge({
      runtime: {
        isAvailable: () => true,
        runModule: async (_moduleName, args) => ({
          ok: true,
          stdout:
            args[0] === "calendar-events"
              ? JSON.stringify({ events: [source] })
              : JSON.stringify({ appointments: [] }),
        }),
      },
      databaseManager: {
        upsertCalendarIngress: (envelopes) => ingressCalls.push(envelopes),
        upsertEncountersFromCalendarEvents: (events) => encounterCalls.push(events),
      },
      reminderScheduler: null,
      logger: { warn: () => {} },
      broadcast: (...args) => broadcasts.push(args),
    });

    const result = await bridge.sync();
    const publicEvent = result.events[0];
    const forbidden =
      /patient_metadata|metadata_json|Alex Morgan|alex\.private@example\.com|\+15552223333|RAW-DESCRIPTION-ATTENDEE-SENTINEL/;

    assert.deepEqual(JSON.parse(publicEvent.attendees), [
      {
        email: "external@example.com",
        displayName: null,
        responseStatus: null,
        self: false,
      },
    ]);
    assert.deepEqual(JSON.parse(ingressCalls[0][0].publicEvent.attendees), [
      {
        email: "external@example.com",
        displayName: null,
        responseStatus: null,
        self: false,
      },
    ]);
    assert.deepEqual(JSON.parse(encounterCalls[0][0].attendees), JSON.parse(publicEvent.attendees));
    assert.equal(ingressCalls[0][0].patientMetadata.email, "alex.private@example.com");
    assert.equal(ingressCalls[0][0].selfAttendeePresent, true);
    assert.doesNotMatch(JSON.stringify(result.events), forbidden);
    assert.doesNotMatch(JSON.stringify(encounterCalls), forbidden);
    assert.doesNotMatch(JSON.stringify(broadcasts), forbidden);
    assert.deepEqual(broadcasts[0], ["gcal-events-synced", {
      provider: "ai_receptionist",
      success: true,
      eventCount: 1,
      errorCode: null,
    }]);
  });

  await t.test("self-only feeds remain empty after upstream filtering", async () => {
    const ingressCalls = [];
    const encounterCalls = [];
    const broadcasts = [];
    const source = appointment({
      attendee_emails: [],
      attendees: [],
      self_attendee_present: true,
      notes: "RAW-DESCRIPTION-SELF-ONLY-SENTINEL",
      patient_metadata: {
        name: "Clinician",
        email: "clinician@example.com",
        phone: "+1 555 444 5555",
      },
    });
    const bridge = new ReceptionistCalendarBridge({
      runtime: {
        isAvailable: () => true,
        runModule: async (_moduleName, args) => ({
          ok: true,
          stdout:
            args[0] === "calendar-events"
              ? JSON.stringify({ events: [source] })
              : JSON.stringify({ appointments: [] }),
        }),
      },
      databaseManager: {
        upsertCalendarIngress: (envelopes) => ingressCalls.push(envelopes),
        upsertEncountersFromCalendarEvents: (events) => encounterCalls.push(events),
      },
      reminderScheduler: null,
      logger: { warn: () => {} },
      broadcast: (...args) => broadcasts.push(args),
    });

    const result = await bridge.sync();

    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].attendees, null);
    assert.equal(ingressCalls.length, 1);
    assert.equal(ingressCalls[0][0].selfAttendeePresent, true);
    assert.equal(ingressCalls[0][0].publicEvent.attendees, null);
    assert.deepEqual(encounterCalls[0][0].attendees, null);
    const forbidden =
      /patient_metadata|metadata_json|Clinician|clinician@example\.com|\+15554445555|RAW-DESCRIPTION-SELF-ONLY-SENTINEL/;
    assert.doesNotMatch(JSON.stringify(result.events), forbidden);
    assert.doesNotMatch(JSON.stringify(ingressCalls[0][0].publicEvent), forbidden);
    assert.doesNotMatch(JSON.stringify(encounterCalls), forbidden);
    assert.doesNotMatch(JSON.stringify(broadcasts), forbidden);
  });
});

test("bridge normalizes invalid self-attendee provenance only in private ingress", async (t) => {
  const invalidValues = [
    ["absent", undefined],
    ["string", "true"],
    ["number", 1],
    ["object", { present: true }],
  ];

  for (const [label, value] of invalidValues) {
    await t.test(label, async () => {
      const ingressCalls = [];
      const encounterCalls = [];
      const broadcasts = [];
      const source = appointment({
        notes: "RAW-PROVENANCE-SENTINEL",
        patient_metadata: {
          name: "Private Patient",
          email: "private.patient@example.com",
          phone: "+1 555 888 9999",
        },
      });
      if (value !== undefined) source.self_attendee_present = value;

      const bridge = new ReceptionistCalendarBridge({
        runtime: {
          isAvailable: () => true,
          runModule: async (_moduleName, args) => ({
            ok: true,
            stdout:
              args[0] === "calendar-events"
                ? JSON.stringify({ events: [source] })
                : JSON.stringify({ appointments: [] }),
          }),
        },
        databaseManager: {
          upsertCalendarIngress: (envelopes) => ingressCalls.push(envelopes),
          upsertEncountersFromCalendarEvents: (events) => encounterCalls.push(events),
        },
        reminderScheduler: null,
        logger: { warn: () => {} },
        broadcast: (...args) => broadcasts.push(args),
      });

      const result = await bridge.sync();
      const publicValues = [
        result,
        ingressCalls[0][0].publicEvent,
        encounterCalls,
        broadcasts,
      ];
      const forbidden =
        /patient_metadata|metadata_json|self_attendee_present|Private Patient|private\.patient@example\.com|\+15558889999|RAW-PROVENANCE-SENTINEL/;

      assert.equal(ingressCalls.length, 1);
      assert.equal(ingressCalls[0][0].selfAttendeePresent, null);
      assert.deepEqual(ingressCalls[0][0].patientMetadata, {
        name: "Private Patient",
        email: "private.patient@example.com",
        phone: "+15558889999",
        source: "structured_description",
      });
      for (const publicValue of publicValues) {
        assert.doesNotMatch(JSON.stringify(publicValue), forbidden);
      }
    });
  }
});

test("calendar page URLs stay separate from direct conference URLs", () => {
  const direct = projectAppointment(appointment());
  const fallback = projectAppointment(appointment({ conference_url: null }));
  assert.equal(direct.hangout_link, "https://meet.google.com/abc-defg-hij");
  assert.equal(direct.html_link, "https://calendar.google.com/calendar/event?eid=abc");
  assert.equal(fallback.hangout_link, null);
  assert.equal(fallback.html_link, "https://calendar.google.com/calendar/event?eid=abc");
});

test("calendar tombstones remove only the cancelled occurrence family", async () => {
  const removed = [];
  const cancelled = [];
  const runtime = {
    isAvailable: () => true,
    runModule: async () => ({
      ok: true,
      stdout: JSON.stringify({
        events: [],
        tombstones: [{ calendar_id: "primary", event_id: "event-1" }],
      }),
    }),
  };
  const bridge = new ReceptionistCalendarBridge({
    runtime,
    databaseManager: {
      upsertCalendarEvents: () => {},
      removeCalendarEventsByPrefix: (...args) => removed.push(args),
      markEncountersCancelledByCalendarEventPrefix: (...args) => cancelled.push(args),
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });

  await bridge.sync();
  assert.deepEqual(removed, [["ai_receptionist", "primary", "ai_receptionist:primary:event-1:"]]);
  assert.deepEqual(cancelled, removed);
});

test("complete feed windows reconcile stale local encounters and rows together", async () => {
  const reconciled = [];
  const runtime = {
    isAvailable: () => true,
    runModule: async (_moduleName, args) => {
      if (args[0] === "run-due") return { ok: true, stdout: "Dispatched reminders: 0\n" };
      if (args[0] === "appointments")
        return { ok: true, stdout: JSON.stringify({ appointments: [appointment()] }) };
      return {
        ok: true,
        stdout: JSON.stringify({
          events: [appointment()],
          tombstones: [],
          window: {
            start_iso: "2026-08-13T00:00:00+00:00",
            end_iso: "2026-08-27T00:00:00+00:00",
            calendar_ids: ["primary"],
            complete: true,
          },
        }),
      };
    },
  };
  const bridge = new ReceptionistCalendarBridge({
    runtime,
    databaseManager: {
      upsertCalendarEvents: () => {},
      reconcileStaleCalendarWindow: (...args) => reconciled.push(args),
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });

  await bridge.sync();
  assert.deepEqual(reconciled, [
    [
      "ai_receptionist",
      "primary",
      ["ai_receptionist:primary:event-1:2026-08-20T15_3A15_3A00_2B00_3A00"],
      "2026-08-13T00:00:00+00:00",
      "2026-08-27T00:00:00+00:00",
    ],
  ]);
});

test("incomplete feeds and failed sidecars never reconcile stale encounters", async () => {
  let reconciled = 0;
  const databaseManager = {
    upsertCalendarEvents: () => {},
    reconcileStaleCalendarWindow: () => {
      reconciled += 1;
    },
  };
  const incomplete = new ReceptionistCalendarBridge({
    runtime: {
      isAvailable: () => true,
      runModule: async () => ({
        ok: true,
        stdout: JSON.stringify({ events: [appointment()], window: { complete: false } }),
      }),
    },
    databaseManager,
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });
  await incomplete.sync();
  const failed = new ReceptionistCalendarBridge({
    runtime: {
      isAvailable: () => true,
      runModule: async () => {
        throw new Error("offline");
      },
    },
    databaseManager,
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });
  await failed.sync();
  assert.equal(reconciled, 0);
});

test("database projection failures settle as stale, expose a safe code, and clear syncPromise", async () => {
  const broadcasts = [];
  const bridge = new ReceptionistCalendarBridge({
    runtime: {
      isAvailable: () => true,
      runModule: async () => ({
        ok: true,
        stdout: JSON.stringify({ events: [appointment()] }),
      }),
    },
    databaseManager: {
      getEncounters: () => [{ id: 1 }],
      upsertCalendarIngress: () => {
        throw new Error("SQLITE_CONSTRAINT: invalid patient_resolution");
      },
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: (...args) => broadcasts.push(args),
  });

  const result = await bridge.sync();

  assert.equal(result.success, false);
  assert.equal(result.state, "stale");
  assert.deepEqual(result.error, {
    code: "CALENDAR_PROJECTION_FAILED",
    message: "Calendar encounters could not be updated. Cached encounters remain available.",
  });
  assert.equal(bridge.getStatus().state, "stale");
  assert.equal(bridge.getStatus().lastErrorCode, "CALENDAR_PROJECTION_FAILED");
  assert.equal(bridge.syncPromise, null);
  assert.deepEqual(broadcasts.at(-1), ["gcal-events-synced", {
    provider: "ai_receptionist",
    success: false,
    eventCount: 0,
    errorCode: "CALENDAR_PROJECTION_FAILED",
  }]);
  assert.doesNotMatch(JSON.stringify(result), /SQLITE|invalid patient_resolution/);
});

test("projection failure is error without cached encounters", async () => {
  const bridge = new ReceptionistCalendarBridge({
    runtime: {
      isAvailable: () => true,
      runModule: async () => ({
        ok: true,
        stdout: JSON.stringify({ events: [appointment()] }),
      }),
    },
    databaseManager: {
      getEncounters: () => [],
      upsertCalendarIngress: () => {
        throw new Error("database unavailable");
      },
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });

  const result = await bridge.sync();
  assert.equal(result.success, false);
  assert.equal(result.state, "error");
  assert.equal(bridge.getStatus().state, "error");
  assert.equal(bridge.syncPromise, null);
});

test("migration health failure prevents startup sync and remains recoverable", () => {
  let feedCalls = 0;
  const bridge = new ReceptionistCalendarBridge({
    runtime: {
      isAvailable: () => true,
      runModule: async () => {
        feedCalls += 1;
        return { ok: true, stdout: JSON.stringify({ events: [] }) };
      },
    },
    databaseManager: {
      getCalendarProjectionHealth: () => ({
        ready: false,
        errorCode: "CALENDAR_PROJECTION_MIGRATION_FAILED",
      }),
      getEncounters: () => [],
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });

  bridge.start();

  assert.equal(feedCalls, 0);
  assert.equal(bridge.getStatus().state, "error");
  assert.equal(bridge.getStatus().lastErrorCode, "CALENDAR_PROJECTION_MIGRATION_FAILED");
  assert.equal(bridge.syncPromise, null);
});

test("startup checks projection health before an unavailable runtime", () => {
  let runtimeAvailabilityChecks = 0;
  let feedCalls = 0;
  const broadcasts = [];
  const bridge = new ReceptionistCalendarBridge({
    runtime: {
      isAvailable: () => {
        runtimeAvailabilityChecks += 1;
        return false;
      },
      runModule: async () => {
        feedCalls += 1;
        throw new Error("feed must not start");
      },
    },
    databaseManager: {
      getCalendarProjectionHealth: () => ({
        ready: false,
        errorCode: "CALENDAR_PROJECTION_MIGRATION_FAILED",
      }),
      getEncounters: () => [],
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: (...args) => broadcasts.push(args),
  });

  bridge.start();

  assert.equal(runtimeAvailabilityChecks, 0);
  assert.equal(feedCalls, 0);
  assert.equal(bridge.getStatus().state, "error");
  assert.equal(bridge.getStatus().lastErrorCode, "CALENDAR_PROJECTION_MIGRATION_FAILED");
  assert.deepEqual(broadcasts.at(-1), ["gcal-events-synced", {
    provider: "ai_receptionist",
    success: false,
    eventCount: 0,
    errorCode: "CALENDAR_PROJECTION_MIGRATION_FAILED",
  }]);
});

test("manual sync checks projection health before an unavailable runtime", async () => {
  let runtimeAvailabilityChecks = 0;
  let feedCalls = 0;
  const broadcasts = [];
  const bridge = new ReceptionistCalendarBridge({
    runtime: {
      isAvailable: () => {
        runtimeAvailabilityChecks += 1;
        return false;
      },
      runModule: async () => {
        feedCalls += 1;
        throw new Error("feed must not start");
      },
    },
    databaseManager: {
      getCalendarProjectionHealth: () => ({
        ready: false,
        errorCode: "CALENDAR_PROJECTION_FAILED",
      }),
      getEncounters: () => [],
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: (...args) => broadcasts.push(args),
  });

  const result = await bridge.sync();

  assert.equal(runtimeAvailabilityChecks, 0);
  assert.equal(feedCalls, 0);
  assert.equal(result.success, false);
  assert.equal(result.state, "error");
  assert.equal(result.error.code, "CALENDAR_PROJECTION_FAILED");
  assert.equal(bridge.getStatus().lastErrorCode, "CALENDAR_PROJECTION_FAILED");
  assert.equal(bridge.syncPromise, null);
  assert.deepEqual(broadcasts.at(-1), ["gcal-events-synced", {
    provider: "ai_receptionist",
    success: false,
    eventCount: 0,
    errorCode: "CALENDAR_PROJECTION_FAILED",
  }]);
});

test("startup and successful sync use the database-owned idempotent repair", async () => {
  let repairs = 0;
  const bridge = new ReceptionistCalendarBridge({
    runtime: {
      isAvailable: () => true,
      runModule: async () => ({
        ok: true,
        stdout: JSON.stringify({ events: [appointment()] }),
      }),
    },
    databaseManager: {
      repairManagedCalendarEncounterProjections: () => {
        repairs += 1;
        return { success: true, created: repairs === 1 ? 4 : 0 };
      },
      upsertCalendarEvents: () => {},
      upsertEncountersFromCalendarEvents: () => {},
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });

  bridge.start();
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.sync();
  bridge.stop();

  assert.ok(repairs >= 2);
});

test("calendar page reads the bounded local cache and starts refresh in the background", async () => {
  const sourceEvent = appointment();
  const cachedRow = {
    provider: "ai_receptionist",
    calendar_id: sourceEvent.calendar_id,
    event_id: sourceEvent.event_id,
    event_uid: sourceEvent.event_uid,
    occurrence_id: occurrenceId(sourceEvent),
    start_time: sourceEvent.start_iso,
    end_time: sourceEvent.end_iso,
    timezone: sourceEvent.timezone,
    summary: sourceEvent.title,
    status: sourceEvent.status,
    is_all_day: 0,
    recurrence: JSON.stringify({ recurring: true }),
    attendees: JSON.stringify([{ email: "patient@example.com" }]),
    hangout_link: sourceEvent.conference_url,
    html_link: sourceEvent.html_link,
  };
  const runtime = {
    isAvailable: () => false,
  };
  const bridge = new ReceptionistCalendarBridge({
    runtime,
    databaseManager: {
      getCalendarEventsInRange: () => [cachedRow],
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });

  const result = await bridge.listCalendarEvents({
    startIso: "2026-08-20T00:00:00-04:00",
    endIso: "2026-08-21T00:00:00-04:00",
    limit: 20,
  });
  assert.equal(result.cached, true);
  assert.equal(result.refreshing, false);
  assert.deepEqual(result.events[0], canonicalEventFromAppointment(appointment()));
});

test("appointment actions resolve the cached canonical event and never accept a renderer recipient", async () => {
  const calls = [];
  const event = canonicalEventFromAppointment(appointment());
  const runtime = {
    isAvailable: () => true,
    runModule: async (_moduleName, args) => {
      calls.push(args);
      return { ok: true, stdout: JSON.stringify({ sent: true, password: "never-returned" }) };
    },
  };
  const bridge = new ReceptionistCalendarBridge({
    runtime,
    databaseManager: {
      getCalendarEventById: () => ({
        id: event.occurrenceId,
        event_id: event.eventId,
        provider: event.provider,
        calendar_id: event.calendarId,
        event_uid: event.eventUid,
        occurrence_id: event.occurrenceId,
        start_time: event.startTime,
        end_time: event.endTime,
        timezone: event.timezone,
        summary: event.summary,
        status: event.status,
        attendees: JSON.stringify(event.attendees),
        hangout_link: event.conferenceUrl,
        html_link: event.calendarUrl,
      }),
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });

  const result = await bridge.sendAppointmentEmail(event.occurrenceId);
  assert.equal(result.success, true);
  assert.equal(result.password, "[redacted]");
  assert.deepEqual(calls[0], [
    "send-email",
    "--event-id",
    "event-1",
    "--event-uid",
    "uid-1",
    "--calendar-id",
    "primary",
    "--summary",
    "Follow-up",
    "--start-iso",
    event.startTime,
    "--end-iso",
    event.endTime,
    "--timezone",
    "America/New_York",
    "--attendee-email",
    "patient@example.com",
  ]);
});

test("appointment reminder status reads persisted channel state in one sidecar call", async () => {
  const event = canonicalEventFromAppointment(appointment());
  const calls = [];
  const runtime = {
    isAvailable: () => true,
    runModule: async (_moduleName, args) => {
      calls.push(args);
      return {
        ok: true,
        stdout: JSON.stringify({
          statuses: {
            [event.occurrenceId]: { email: true, sms: false },
          },
        }),
      };
    },
  };
  const bridge = new ReceptionistCalendarBridge({
    runtime,
    databaseManager: {
      getCalendarEventById: () => ({
        id: event.occurrenceId,
        event_id: event.eventId,
        provider: event.provider,
        calendar_id: event.calendarId,
        event_uid: event.eventUid,
        occurrence_id: event.occurrenceId,
        start_time: event.startTime,
        end_time: event.endTime,
        timezone: event.timezone,
        summary: event.summary,
        status: event.status,
        attendees: JSON.stringify(event.attendees),
        hangout_link: event.conferenceUrl,
        html_link: event.calendarUrl,
      }),
    },
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });

  const result = await bridge.getAppointmentReminderStatuses([event.occurrenceId]);
  assert.equal(result.success, true);
  assert.deepEqual(result.statuses[event.occurrenceId], { email: true, sms: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "reminder-status");
  assert.deepEqual(JSON.parse(calls[0][2]), [
    {
      key: event.occurrenceId,
      calendar_id: event.calendarId,
      event_id: event.eventId,
      event_uid: event.eventUid,
      start_iso: event.startTime,
    },
  ]);
});

test("config save reloads through the sidecar and returns redacted validated state", async () => {
  const calls = [];
  const runtime = {
    isAvailable: () => true,
    runModule: async (_moduleName, args) => {
      calls.push(args);
      if (args[0] === "receptionist-update")
        return { ok: true, stdout: JSON.stringify({ restart_required: true }) };
      return {
        ok: true,
        stdout: JSON.stringify({
          config: {
            receptionist: { greeting: "Hello", password: "secret" },
            business_name: "Practice",
          },
        }),
      };
    },
  };
  const bridge = new ReceptionistCalendarBridge({
    runtime,
    databaseManager: {},
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });
  const result = await bridge.saveReceptionistConfig({ greeting: "Hello" });
  assert.equal(result.success, true);
  assert.equal(result.requiresRestart, true);
  assert.equal(result.config.password, "[redacted]");
  assert.equal(calls[0][0], "receptionist-update");
  assert.equal(calls[1][0], "get");
});

test("configuration reads share one snapshot and stay cached across tab switches", async () => {
  const calls = [];
  const runtime = {
    isAvailable: () => true,
    runModule: async (_moduleName, args) => {
      calls.push(args);
      if (args[0] === "post-workspace") return { ok: true, stdout: JSON.stringify({ enabled: true }) };
      return {
        ok: true,
        stdout: JSON.stringify({
          config: {
            business_name: "Practice",
            calendar: { enabled: true, oauth_token_set: true },
            receptionist: { greeting: "Hello" },
            message_templates: {},
            reminders: { post_appointment: {} },
          },
        }),
      };
    },
  };
  const bridge = new ReceptionistCalendarBridge({
    runtime,
    databaseManager: {},
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });

  await Promise.all([
    bridge.getReceptionistConfig(),
    bridge.getMessageConfig(),
    bridge.getCalendarStatus(),
  ]);
  assert.equal(calls.filter((args) => args[0] === "get").length, 1);

  await bridge.getReceptionistConfig();
  await bridge.getPostAppointmentWorkspace();
  assert.equal(calls.filter((args) => args[0] === "get").length, 1);
  assert.equal(calls.filter((args) => args[0] === "post-workspace").length, 1);
});

test("post-appointment saves preserve the top-level editor timing and follow-ups", () => {
  const bridge = new ReceptionistCalendarBridge({
    runtime: { isAvailable: () => true },
    databaseManager: {},
    reminderScheduler: null,
    logger: { warn: () => {} },
    broadcast: () => {},
  });
  const args = bridge._configSaveArgs("postAppointment", {
    enabled: true,
    offset_days_after: 3,
    follow_ups: [
      { preset: "thank_you_review", enabled: true, offset_days_after: 3, channels: ["email"] },
    ],
    templates: { post_followups: { thank_you_review: { email_text: "Thanks" } } },
    communications: {
      default_transfer_number: "+15550100",
      email_from: "Practice",
      sms_from_number: "+15550101",
    },
  });
  assert.deepEqual(args.slice(0, 7), [
    "update",
    "--default-transfer-number",
    "+15550100",
    "--email-from",
    "Practice",
    "--sms-from-number",
    "+15550101",
  ]);
  assert.ok(args.includes("--post-appointment-enabled"));
  assert.ok(args.includes("true"));
  assert.ok(args.includes("--post-appointment-offset-days"));
  assert.ok(args.includes("3"));
  assert.ok(args.includes("--post-followups-json"));
  assert.ok(args.includes("--post-followup-templates-json"));
});
