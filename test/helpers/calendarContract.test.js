const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

const {
  canonicalEventFromAppointment,
  canonicalEventFromRow,
  canonicalCalendarIdentityKey,
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

test("calendar reminder actions use the durable local row id", () => {
  const row = {
    id: "ai_receptionist:primary:event-1:2026-08-20T17_3A00_00.000Z",
    provider: "ai_receptionist",
    calendar_id: "primary",
    event_id: "event-1",
    event_uid: "uid-1",
    // Legacy/provider-ingested rows may not include the provider prefix.
    occurrence_id: "primary:event-1:2026-08-20T17:00:00-04:00",
    start_time: "2026-08-20T21:00:00.000Z",
    end_time: "2026-08-20T21:30:00.000Z",
    summary: "Jairo Espinoza",
    status: "confirmed",
    patient_id: "patient-jairo",
    patient_email: "jairo@example.com",
    patient_phone: "+15614055898",
    patient_link_status: "linked",
  };
  const event = canonicalEventFromRow(row);
  assert.equal(event.occurrenceId, row.id);
  assert.equal(event.eventId, row.event_id);
});

test("calendar contacts expose US phone numbers in E.164 and reject malformed values", () => {
  const valid = canonicalEventFromAppointment({
    calendar_id: "primary",
    event_id: "event-phone",
    start_iso: "2026-08-20T15:15:00Z",
    end_iso: "2026-08-20T15:45:00Z",
    patient_id: "patient-phone",
    patient_link_status: "linked",
    patient_email: "patient@example.com",
    patient_phone: "561-405-5898",
  });
  assert.equal(valid.patientPhone, "+15614055898");
  assert.equal(valid.capabilities.canSendSms, true);

  const invalid = canonicalEventFromAppointment({
    calendar_id: "primary",
    event_id: "event-invalid-phone",
    start_iso: "2026-08-20T15:15:00Z",
    end_iso: "2026-08-20T15:45:00Z",
    patient_id: "patient-phone",
    patient_link_status: "linked",
    patient_phone: "56140558989",
  });
  assert.equal(invalid.patientPhone, null);
  assert.equal(invalid.capabilities.canSendSms, false);
});

test("calendar identity stays stable when a non-recurring event is rescheduled", () => {
  const original = canonicalCalendarIdentityKey({
    provider: "google",
    calendarId: "primary",
    eventId: "event-1",
  });
  const moved = canonicalCalendarIdentityKey({
    provider: "google",
    calendarId: "primary",
    eventId: "event-1",
  });
  assert.equal(original, "google:primary:event-1");
  assert.equal(moved, original);
});

test("recurring occurrences use the recurring event and original start as identity", () => {
  const first = canonicalEventFromAppointment({
    provider: "google",
    calendar_id: "primary",
    event_id: "series-instance-1",
    recurring_event_id: "series-1",
    original_start_time: "2026-08-20T15:00:00Z",
    start_iso: "2026-08-20T15:00:00Z",
    end_iso: "2026-08-20T15:30:00Z",
  });
  const second = canonicalEventFromAppointment({
    provider: "google",
    calendar_id: "primary",
    event_id: "series-instance-2",
    recurring_event_id: "series-1",
    original_start_time: "2026-08-27T15:00:00Z",
    start_iso: "2026-08-27T15:00:00Z",
    end_iso: "2026-08-27T15:30:00Z",
  });
  assert.notEqual(first.calendarIdentityKey, second.calendarIdentityKey);
  assert.equal(first.recurringEventId, "series-1");
  assert.equal(second.originalStartTime, "2026-08-27T15:00:00Z");
});

test("patient detail failures disable reminder capabilities without exposing metadata", () => {
  const event = canonicalEventFromAppointment({
    calendar_id: "primary",
    event_id: "event-identity-required",
    start_iso: "2026-08-20T15:15:00Z",
    end_iso: "2026-08-20T15:45:00Z",
    patient_link_status: "patient_details_required",
    patient_metadata: { name: "Private Patient", dob: "1990-04-12" },
    capabilities: { canSendEmail: true, canSendSms: true },
  });
  assert.equal(event.patientLinkStatus, "patient_details_required");
  assert.equal(event.capabilities.canSendEmail, false);
  assert.equal(event.capabilities.canSendSms, false);
  assert.equal(Object.hasOwn(event, "patient_metadata"), false);
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
