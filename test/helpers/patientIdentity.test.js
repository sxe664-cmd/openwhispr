const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatEncounterAutoTitle,
  normalizeAttendees,
  normalizePatientEmail,
  normalizePatientPhone,
  parsePatientMetadata,
  resolvePatientIdentity,
} = require("../../src/helpers/patientIdentity");

const block = `[OpenWhispr Patient]\nname: Alex Morgan\nemail: Alex.Morgan@example.com\nphone: +1 (555) 123-4567\n[/OpenWhispr Patient]`;

function localDateFor(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date(value))
    .filter(({ type }) => ["year", "month", "day"].includes(type))
    .reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

test("normalizes only valid email identities and never uses names", () => {
  assert.equal(normalizePatientEmail("  Alex.Morgan@Example.COM "), "alex.morgan@example.com");
  assert.equal(normalizePatientEmail("Alex Morgan"), null);
  assert.equal(normalizePatientEmail("alex@example"), null);
  assert.equal(normalizePatientEmail(""), null);
});

test("normalizes US phone numbers to E.164 without double-prefixing", () => {
  assert.equal(normalizePatientPhone("561-405-5898"), "+15614055898");
  assert.equal(normalizePatientPhone("1 (561) 405-5898"), "+15614055898");
  assert.equal(normalizePatientPhone("+1 561 405 5898"), "+15614055898");
  assert.equal(normalizePatientPhone("56140558989"), null);
  assert.equal(normalizePatientPhone("+44 20 7946 0958"), null);
});

test("parses one exact bounded patient block into sanitized data", () => {
  assert.deepEqual(parsePatientMetadata(block), {
    metadata: {
      name: "Alex Morgan",
      email: "alex.morgan@example.com",
      phone: "+15551234567",
      source: "structured_description",
    },
    reason: null,
  });
  assert.deepEqual(parsePatientMetadata(`Reminder\n${block}\nBring records.`).metadata, {
    name: "Alex Morgan",
    email: "alex.morgan@example.com",
    phone: "+15551234567",
    source: "structured_description",
  });
});

test("parses compact manual calendar details without requiring the name in the description", () => {
  assert.deepEqual(parsePatientMetadata(`DOB: 1990-04-12\nPhone: +1 (555) 123-4567\nEmail: alex@example.com`), {
    metadata: {
      name: null,
      dob: "1990-04-12",
      email: "alex@example.com",
      phone: "+15551234567",
      source: "structured_description",
    },
    reason: null,
  });
  assert.deepEqual(parsePatientMetadata("DOB: 04/12/1990"), {
    metadata: {
      name: null,
      dob: "1990-04-12",
      email: null,
      phone: null,
      source: "structured_description",
    },
    reason: null,
  });
});

test("parses US DOBs entered with dot separators", () => {
  assert.deepEqual(parsePatientMetadata("DOB: 07.24.1969\nEmail: jairo@example.com"), {
    metadata: {
      name: null,
      dob: "1969-07-24",
      email: "jairo@example.com",
      phone: null,
      source: "structured_description",
    },
    reason: null,
  });
});

test("normalizes structured US phone metadata for reminder recipients", () => {
  assert.deepEqual(parsePatientMetadata("DOB: 07/24/1969\nPhone: 561-405-5898\nEmail: jairo@example.com"), {
    metadata: {
      name: null,
      dob: "1969-07-24",
      email: "jairo@example.com",
      phone: "+15614055898",
      source: "structured_description",
    },
    reason: null,
  });
});

test("rejects missing closing markers, duplicate fields, unknown fields, invalid values, and multiple blocks", () => {
  const secondBlock = `${block}\n${block}`;
  for (const value of [
    "[OpenWhispr Patient]\nemail: alex@example.com",
    "[OpenWhispr Patient]\nemail: alex@example.com\nemail: other@example.com\n[/OpenWhispr Patient]",
    "[OpenWhispr Patient]\nunknown: Alex\nemail: alex@example.com\n[/OpenWhispr Patient]",
    "[OpenWhispr Patient]\nemail: not-an-email\n[/OpenWhispr Patient]",
    "[OpenWhispr Patient]\nname: Alex\n[/OpenWhispr Patient]",
    "DOB: 707.24.1969\nEmail: jairo@example.com",
    `[OpenWhispr Patient]\nname: ${"A".repeat(121)}\nemail: alex@example.com\n[/OpenWhispr Patient]`,
    secondBlock,
    `${"x".repeat(4097)}`,
  ]) {
    assert.deepEqual(parsePatientMetadata(value), { metadata: null, reason: "invalid_metadata" });
  }
});

test("accepts sanitized object input while discarding untrusted extra fields", () => {
  assert.deepEqual(parsePatientMetadata({
    name: " Alex Morgan ",
    email: "ALEX@example.com",
    phone: "555.123.4567",
    description: "raw PHI must not survive",
  }), {
    metadata: {
      name: "Alex Morgan",
      email: "alex@example.com",
      phone: "+15551234567",
      source: "structured_description",
    },
    reason: null,
  });
  assert.equal(parsePatientMetadata({ email: "alex@example.com", phone: "12" }).reason, "invalid_metadata");
});

test("filters self attendees and deterministically de-duplicates normalized emails", () => {
  assert.deepEqual(normalizeAttendees([
    { email: "me@example.com", self: true },
    { email: "ALEX@example.com", displayName: "Alex Morgan" },
    { email: "alex@example.com", displayName: "Duplicate" },
    { displayName: "No email" },
  ]), [{ email: "alex@example.com", displayName: "Alex Morgan" }]);
});

test("requires one external attendee and matching metadata when both are present", () => {
  const matching = resolvePatientIdentity({
    attendees: [{ email: "ALEX@example.com", displayName: "Alex" }, { email: "me@example.com", self: true }],
    patientMetadata: { email: "alex@example.com", name: "Alex Morgan" },
  });
  assert.deepEqual(matching, {
    status: "resolved_attendee",
    normalizedEmail: "alex@example.com",
    displayName: "Alex",
    phone: null,
    identitySource: "attendee_email",
  });

  assert.equal(resolvePatientIdentity({
    attendees: [{ email: "alex@example.com" }],
    patientMetadata: { email: "other@example.com" },
  }).status, "unassigned_conflict");
});

test("does not infer a patient from groups, missing/invalid attendee email, or a name", () => {
  assert.equal(resolvePatientIdentity({
    attendees: [{ email: "one@example.com" }, { email: "two@example.com" }],
    }).status, "unassigned_multiple_attendees");
  assert.equal(resolvePatientIdentity({ attendees: [{ displayName: "Alex Morgan" }] }).status, "unassigned_missing_email");
  assert.equal(resolvePatientIdentity({ attendees: "not-valid-json" }).status, "unassigned_missing_email");
  assert.equal(resolvePatientIdentity({
    attendees: [{ email: "alex@example.com" }, { email: "not-an-email" }],
  }).status, "unassigned_multiple_attendees");
  assert.equal(resolvePatientIdentity({ attendees: [], patientMetadata: { name: "Alex Morgan" } }).status, "unassigned_invalid_metadata");
});

test("uses structured metadata only with explicit no-self provenance", () => {
  const metadata = { email: "alex@example.com", name: "Alex Morgan" };
  const resolved = resolvePatientIdentity({
    attendees: [],
    patientMetadata: metadata,
    selfAttendeePresent: false,
  });
  assert.equal(resolved.status, "resolved_structured");
  assert.equal(resolved.normalizedEmail, "alex@example.com");

  for (const selfAttendeePresent of [true, null, undefined, "false", 0]) {
    assert.equal(resolvePatientIdentity({
      attendees: [],
      patientMetadata: metadata,
      selfAttendeePresent,
    }).status, "unassigned_missing_email");
  }

  assert.equal(resolvePatientIdentity({
    attendees: [],
    patientMetadata: { name: "Alex Morgan" },
    selfAttendeePresent: false,
  }).status, "unassigned_invalid_metadata");
});

test("managed registry resolution uses exact normalized name and DOB", () => {
  const patients = [
    {
      patient_id: "patient-alex",
      name: "Alex Morgan",
      normalized_name: "alex morgan",
      dob: "1990-04-12",
      normalized_dob: "1990-04-12",
      email: "alex@example.com",
      phone: "+15551234567",
    },
  ];
  const resolved = resolvePatientIdentity({
    registryPatients: patients,
    patientMetadata: {
      name: "  alex   morgan ",
      dob: "1990-04-12",
      email: "different@example.com",
    },
  });
  assert.equal(resolved.status, "resolved_registry");
  assert.equal(resolved.patientId, "patient-alex");
  assert.equal(resolved.identitySource, "registry_exact_name_dob");
  assert.equal(resolved.normalizedEmail, "alex@example.com");

  assert.equal(resolvePatientIdentity({
    registryPatients: patients,
    patientMetadata: { name: "Alex Morgan", dob: "1990-04-13" },
  }).status, "unassigned_no_exact_match");
  assert.equal(resolvePatientIdentity({
    registryPatients: patients,
    patientMetadata: { name: "Alex Morgan" },
  }).status, "unassigned_missing_demographics");
});

test("one external attendee remains authoritative regardless of self provenance", () => {
  for (const selfAttendeePresent of [true, null]) {
    const resolved = resolvePatientIdentity({
      attendees: [{ email: "external@example.com", displayName: "External" }],
      patientMetadata: { email: "external@example.com", name: "External Patient" },
      selfAttendeePresent,
    });
    assert.equal(resolved.status, "resolved_attendee");
    assert.equal(resolved.normalizedEmail, "external@example.com");
  }
});

test("formats date-first titles in the event timezone across the New York/UTC boundary", () => {
  const instant = "2026-08-15T03:30:00Z";
  assert.equal(
    formatEncounterAutoTitle({ startTime: instant, timezone: "America/New_York", focus: "Medication — follow-up" }),
    "2026-08-14 — Medication - follow-up"
  );
  assert.equal(
    formatEncounterAutoTitle({ startTime: instant, timezone: "UTC", focus: "Medication – follow-up" }),
    "2026-08-15 — Medication - follow-up"
  );
});

test("falls back to the host-local timezone for missing or invalid event timezones", () => {
  const instant = "2026-08-15T03:30:00Z";
  const expected = `${localDateFor(instant)} — Encounter`;
  assert.equal(formatEncounterAutoTitle({ startTime: instant }), expected);
  assert.equal(formatEncounterAutoTitle({ startTime: instant, timezone: "Not/A-Timezone" }), expected);
});
