const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_METADATA_LENGTH = 4096;
const MAX_LABEL_LENGTH = 120;
const PATIENT_BLOCK_RE = /(?:^|\r?\n)\[OpenWhispr Patient\]\r?\n([\s\S]*?)\r?\n\[\/OpenWhispr Patient\](?=\r?\n|$)/g;
const PATIENT_FIELDS = new Set(["name", "email", "phone"]);

function normalizePatientEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

function normalizePatientPhone(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

function cleanLabel(value) {
  const cleaned = String(value || "").trim().replace(/\s+/g, " ");
  return cleaned ? cleaned.slice(0, MAX_LABEL_LENGTH) : null;
}

function normalizePatientName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name) return null;
  return name.length <= MAX_LABEL_LENGTH ? name : null;
}

function sanitizePatientFields(fields) {
  const email = normalizePatientEmail(fields.email);
  if (!email) return { metadata: null, reason: "invalid_metadata" };

  const rawName = fields.name == null ? "" : String(fields.name).trim();
  const name = normalizePatientName(rawName);
  if (rawName && !name) return { metadata: null, reason: "invalid_metadata" };

  const rawPhone = fields.phone == null ? "" : String(fields.phone).trim();
  const phone = rawPhone ? normalizePatientPhone(rawPhone) : null;
  if (rawPhone && !phone) return { metadata: null, reason: "invalid_metadata" };

  return {
    metadata: {
      name,
      email,
      phone,
      source: "structured_description",
    },
    reason: null,
  };
}

function parsePatientMetadata(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return sanitizePatientFields(value);
  }

  const raw = String(value || "");
  if (!raw.trim()) return { metadata: null, reason: null };
  if (raw.length > MAX_METADATA_LENGTH) {
    return { metadata: null, reason: "invalid_metadata" };
  }

  PATIENT_BLOCK_RE.lastIndex = 0;
  const matches = [...raw.matchAll(PATIENT_BLOCK_RE)];
  PATIENT_BLOCK_RE.lastIndex = 0;
  if (matches.length !== 1) {
    return { metadata: null, reason: "invalid_metadata" };
  }

  const fields = new Map();
  for (const line of matches[0][1].split(/\r?\n/)) {
    const field = /^([A-Za-z]+):[ \t]*(.*)$/.exec(line);
    if (!field) return { metadata: null, reason: "invalid_metadata" };

    const key = field[1].toLowerCase();
    const fieldValue = field[2].trim();
    if (!PATIENT_FIELDS.has(key) || !fieldValue || fields.has(key)) {
      return { metadata: null, reason: "invalid_metadata" };
    }
    fields.set(key, fieldValue);
  }

  return sanitizePatientFields({
    name: fields.get("name"),
    email: fields.get("email"),
    phone: fields.get("phone"),
  });
}

function parseAttendeeInput(value) {
  if (typeof value !== "string") return Array.isArray(value) ? value : [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function inspectAttendees(value) {
  const rawAttendees = parseAttendeeInput(value);
  const unique = new Map();
  let externalEntries = 0;
  let invalidExternalEntries = 0;

  for (const attendee of rawAttendees) {
    if (typeof attendee === "string") {
      if (!attendee.trim()) continue;
      externalEntries += 1;
      const email = normalizePatientEmail(attendee);
      if (!email) {
        invalidExternalEntries += 1;
        continue;
      }
      if (!unique.has(email)) unique.set(email, { email, displayName: null });
      continue;
    }

    if (!attendee || typeof attendee !== "object" || attendee.self === true) continue;
    externalEntries += 1;
    const email = normalizePatientEmail(attendee.email);
    if (!email) {
      invalidExternalEntries += 1;
      continue;
    }
    if (!unique.has(email)) {
      unique.set(email, {
        email,
        displayName: cleanLabel(attendee.displayName),
      });
    }
  }

  return {
    attendees: [...unique.values()],
    externalEntries,
    invalidExternalEntries,
  };
}

function normalizeAttendees(value) {
  return inspectAttendees(value).attendees;
}

function unresolvedPatient(status) {
  return {
    status,
    normalizedEmail: null,
    displayName: null,
    phone: null,
    identitySource: null,
  };
}

function normalizeSelfAttendeePresent(value) {
  return typeof value === "boolean" ? value : null;
}

function resolvePatientIdentity({ attendees, patientMetadata, selfAttendeePresent } = {}) {
  const parsedMetadata = parsePatientMetadata(patientMetadata);
  const attendeeState = inspectAttendees(attendees);

  if (attendeeState.externalEntries > 1) {
    return unresolvedPatient("unassigned_multiple_attendees");
  }
  if (attendeeState.invalidExternalEntries > 0) {
    return unresolvedPatient(
      parsedMetadata.reason === "invalid_metadata"
        ? "unassigned_invalid_metadata"
        : "unassigned_missing_email"
    );
  }

  const [attendee] = attendeeState.attendees;
  if (attendee) {
    if (parsedMetadata.reason === "invalid_metadata") {
      return unresolvedPatient("unassigned_invalid_metadata");
    }
    if (parsedMetadata.metadata && parsedMetadata.metadata.email !== attendee.email) {
      return unresolvedPatient("unassigned_conflict");
    }
    return {
      status: "resolved_attendee",
      normalizedEmail: attendee.email,
      displayName: attendee.displayName || parsedMetadata.metadata?.name || null,
      phone: parsedMetadata.metadata?.phone || null,
      identitySource: "attendee_email",
    };
  }

  if (parsedMetadata.metadata && normalizeSelfAttendeePresent(selfAttendeePresent) === false) {
    return {
      status: "resolved_structured",
      normalizedEmail: parsedMetadata.metadata.email,
      displayName: parsedMetadata.metadata.name,
      phone: parsedMetadata.metadata.phone,
      identitySource: "structured_description",
    };
  }

  return unresolvedPatient(
    parsedMetadata.reason === "invalid_metadata"
      ? "unassigned_invalid_metadata"
      : "unassigned_missing_email"
  );
}

function formatDateInTimezone(date, timezone) {
  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      ...options,
      ...(typeof timezone === "string" && timezone.trim() ? { timeZone: timezone } : {}),
    });
  } catch {
    // An invalid calendar timezone must use the host-local timezone. Omitting
    // timeZone is intentional; using UTC would shift late-night encounters.
    formatter = new Intl.DateTimeFormat("en-US", options);
  }

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter(({ type }) => type === "year" || type === "month" || type === "day")
      .map(({ type, value }) => [type, value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatEncounterAutoTitle({ startTime, timezone, focus } = {}) {
  const parsed = new Date(startTime || Date.now());
  const date = Number.isNaN(parsed.getTime())
    ? formatDateInTimezone(new Date(), timezone)
    : formatDateInTimezone(parsed, timezone);
  const brief = cleanLabel(focus)?.replace(/[\u2014\u2013]/g, "-") || "Encounter";
  return `${date} \u2014 ${brief}`;
}

module.exports = {
  formatEncounterAutoTitle,
  normalizeAttendees,
  normalizePatientEmail,
  normalizePatientPhone,
  normalizeSelfAttendeePresent,
  parsePatientMetadata,
  resolvePatientIdentity,
};
