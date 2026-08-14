const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const IPC_SOURCE = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");

function loadProjection(name, context = {}) {
  const match = IPC_SOURCE.match(
    new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`)
  );
  assert.ok(match, `expected ${name} in ipcHandlers.js`);
  return vm.runInNewContext(`(${match[0]})`, { Object, ...context });
}

const publicFieldMatch = IPC_SOURCE.match(
  /const CALENDAR_EVENT_PUBLIC_FIELDS = Object\.freeze\(\[([\s\S]*?)\]\);/
);
assert.ok(publicFieldMatch, "expected named public calendar fields in ipcHandlers.js");
const CALENDAR_EVENT_PUBLIC_FIELDS = vm.runInNewContext(`[${publicFieldMatch[1]}]`, { Object });
const projectPublicCalendarEvent = loadProjection("projectPublicCalendarEvent", {
  CALENDAR_EVENT_PUBLIC_FIELDS,
});
const projectPublicCalendarEvents = loadProjection("projectPublicCalendarEvents", {
  projectPublicCalendarEvent,
});

const legacyPatientName = "LEGACY_PATIENT_NAME_SENTINEL";
const legacyPatientEmail = "legacy-patient@example.invalid";
const legacyPatientPhone = "+1-555-0100";
const rawDescription = `[OpenWhispr Patient]\nname: ${legacyPatientName}\nemail: ${legacyPatientEmail}\nphone: ${legacyPatientPhone}\n[/OpenWhispr Patient]`;

function legacyCalendarRow(overrides = {}) {
  return {
    id: "event-1",
    calendar_id: "calendar-1",
    provider: "google",
    summary: "Follow-up",
    start_time: "2026-08-14T14:00:00Z",
    end_time: "2026-08-14T14:30:00Z",
    is_all_day: false,
    status: "confirmed",
    attendees: JSON.stringify([{ email: "attendee@example.invalid" }]),
    patient_metadata: JSON.stringify({
      name: legacyPatientName,
      email: legacyPatientEmail,
      phone: legacyPatientPhone,
    }),
    metadata_json: JSON.stringify({ name: legacyPatientName, email: legacyPatientEmail }),
    description: rawDescription,
    raw_description: rawDescription,
    ...overrides,
  };
}

test("IPC uses D1 public calendar getters and projects both calendar handlers", () => {
  assert.match(
    IPC_SOURCE,
    /events: projectPublicCalendarEvents\(this\.databaseManager\.getUpcomingEvents\(windowMinutes\)\)/
  );
  assert.match(
    IPC_SOURCE,
    /projectPublicCalendarEvent\(this\.databaseManager\.getCalendarEventById\(eventId\)\)/
  );
  assert.doesNotMatch(
    IPC_SOURCE,
    /gcal-get-(?:upcoming-events|event)[\s\S]{0,500}SELECT \*/
  );
});

test("public projection removes legacy patient metadata and raw descriptions", () => {
  const row = legacyCalendarRow({ attendees_count: 1, timezone: "America/New_York" });
  const projected = projectPublicCalendarEvent(row);

  assert.equal(projected.id, row.id);
  assert.equal(projected.summary, row.summary);
  assert.equal(projected.attendees, row.attendees);
  assert.equal(projected.timezone, row.timezone);
  assert.equal(Object.hasOwn(projected, "patient_metadata"), false);
  assert.equal(Object.hasOwn(projected, "metadata_json"), false);
  assert.equal(Object.hasOwn(projected, "description"), false);
  assert.equal(Object.hasOwn(projected, "raw_description"), false);

  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes(legacyPatientName), false);
  assert.equal(serialized.includes(legacyPatientEmail), false);
  assert.equal(serialized.includes(legacyPatientPhone), false);
  assert.equal(serialized.includes(rawDescription), false);
});

test("upcoming projection preserves named public attendee data only", () => {
  const projected = projectPublicCalendarEvents([
    legacyCalendarRow({ id: "event-1" }),
    legacyCalendarRow({ id: "event-2", patient_metadata: legacyPatientName }),
  ]);

  assert.equal(projected.length, 2);
  assert.equal(projected[0].attendees, JSON.stringify([{ email: "attendee@example.invalid" }]));
  assert.deepEqual(
    projected.map((event) => Object.keys(event).sort()),
    [
      ["attendees", "calendar_id", "end_time", "id", "is_all_day", "provider", "start_time", "status", "summary"],
      ["attendees", "calendar_id", "end_time", "id", "is_all_day", "provider", "start_time", "status", "summary"],
    ]
  );
});
