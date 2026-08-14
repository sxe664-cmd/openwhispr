const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

const {
  canonicalEventFromAppointment,
  canonicalOccurrenceId,
  localDayRange,
  localMonthRange,
  localWeekRange,
  normalizeRange,
  redactSecrets,
} = require("../../src/helpers/calendarContract");

test("calendar ranges are normalized to a bounded half-open UTC window", () => {
  const range = normalizeRange({
    startIso: "2026-08-01T00:00:00-04:00",
    endIso: "2026-08-02T00:00:00-04:00",
    limit: 9999,
  });
  assert.deepEqual(range, {
    startIso: "2026-08-01T04:00:00.000Z",
    endIso: "2026-08-02T04:00:00.000Z",
    limit: 500,
  });
  assert.throws(
    () => normalizeRange({ startIso: range.endIso, endIso: range.startIso }),
    /after startIso/
  );
});

test("canonical occurrence identity includes provider, event, and occurrence start", () => {
  const id = canonicalOccurrenceId({
    provider: "ai_receptionist",
    calendarId: "primary",
    eventId: "event/1",
    startTime: "2026-08-20T15:15:00.000Z",
  });
  assert.equal(id, "ai_receptionist:primary:event_2F1:2026-08-20T15_3A15_3A00.000Z");
  assert.notEqual(id, canonicalOccurrenceId({
    provider: "ai_receptionist",
    calendarId: "primary",
    eventId: "event/1",
    startTime: "2026-08-21T15:15:00.000Z",
  }));
});

test("canonical events retain safe capability and recurrence metadata", () => {
  const event = canonicalEventFromAppointment({
    calendar_id: "primary",
    event_id: "event-1",
    event_uid: "uid-1",
    start_iso: "2026-08-20T15:15:00Z",
    end_iso: "2026-08-20T15:45:00Z",
    timezone: "America/New_York",
    attendees: ["patient@example.com"],
    recurring: true,
    capabilities: { canSendEmail: true, canSendSms: false },
  });
  assert.equal(event.eventUid, "uid-1");
  assert.equal(event.recurrence.recurring, true);
  assert.equal(event.capabilities.canSendEmail, true);
  assert.equal(event.capabilities.canSendSms, false);
  assert.equal(event.capabilities.canCancel, true);
});

test("local week and month windows stay bounded across calendar boundaries", () => {
  const date = new Date("2026-12-31T12:00:00Z");
  const week = localWeekRange(date);
  const month = localMonthRange(date, true);
  assert.ok(Date.parse(week.endIso) - Date.parse(week.startIso) <= 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000);
  assert.ok(Date.parse(month.endIso) - Date.parse(month.startIso) <= 42 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000);
  assert.equal(localDayRange(date).startIso.slice(0, 10), "2026-12-31");
});

test("local-day boundaries account for DST transitions", () => {
  const script = `const {localDayRange}=require('./src/helpers/calendarContract'); console.log(JSON.stringify(localDayRange(new Date('2026-03-08T12:00:00'))));`;
  const output = execFileSync(process.execPath, ["-e", script], {
    cwd: require("node:path").resolve(__dirname, "../.."),
    env: { ...process.env, TZ: "America/New_York" },
    encoding: "utf8",
  });
  const range = JSON.parse(output);
  assert.equal(Date.parse(range.endIso) - Date.parse(range.startIso), 23 * 60 * 60 * 1000);
});

test("secret-shaped config fields are redacted from public payloads", () => {
  assert.deepEqual(redactSecrets({ email: "owner@example.com", password: "do-not-return", nested: { refresh_token: "token" } }), {
    email: "owner@example.com",
    password: "[redacted]",
    nested: { refresh_token: "[redacted]" },
  });
});
