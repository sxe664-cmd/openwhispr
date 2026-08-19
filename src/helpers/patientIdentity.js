const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Calendar descriptions are often entered on a phone. Accept the two common
// US month/day/year separators while keeping the component widths bounded so
// malformed values cannot silently become an identity match.
const US_DATE_RE = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/;
const MAX_METADATA_LENGTH = 4096;
const MAX_LABEL_LENGTH = 120;
const PATIENT_BLOCK_RE = /(?:^|\r?\n)\[OpenWhispr Patient\]\r?\n([\s\S]*?)\r?\n\[\/OpenWhispr Patient\](?=\r?\n|$)/g;
const PATIENT_FIELDS = new Set([
  "name",
  "email",
  "phone",
  "dob",
  "date_of_birth",
  "patient_id",
  "appointment_id",
]);

function normalizeOpaqueId(value) {
  const id = String(value || "").trim();
  return id && id.length <= 256 ? id : null;
}

function normalizePatientEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

function normalizePatientPhone(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  // OpenWhispr currently supports US numbers only. Store every valid number
  // in one E.164 form so calendar metadata, the registry, and reminder
  // providers use the same recipient identity. Do not prepend blindly: an
  // already-prefixed 11-digit number must not become +11..., and malformed
  // values must remain invalid instead of being guessed into a patient match.
  const nationalNumber = digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.length === 10
      ? digits
      : null;
  return nationalNumber ? `+1${nationalNumber}` : null;
}

function normalizePatientDob(value) {
  const dob = String(value || "").trim();
  if (ISO_DATE_RE.test(dob)) {
    const date = new Date(`${dob}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dob ? null : dob;
  }
  const match = US_DATE_RE.exec(dob);
  if (!match) return null;
  const [, month, day, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeAppointmentId(value) {
  return normalizeOpaqueId(value);
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

function normalizePatientNameKey(value) {
  const name = normalizePatientName(value);
  if (!name) return null;
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase() || null;
}

function sanitizePatientFields(fields) {
  const email = fields.email == null ? null : normalizePatientEmail(fields.email);
  const phone = fields.phone == null ? null : normalizePatientPhone(fields.phone);
  const dob = normalizePatientDob(fields.dob ?? fields.date_of_birth);
  const patientId = normalizeOpaqueId(fields.patient_id ?? fields.patientId);
  const appointmentId = normalizeAppointmentId(fields.appointment_id ?? fields.appointmentId);

  if (fields.email != null && String(fields.email).trim() && !email) return { metadata: null, reason: "invalid_metadata" };
  if (fields.phone != null && String(fields.phone).trim() && !phone) return { metadata: null, reason: "invalid_metadata" };
  if ((fields.dob != null || fields.date_of_birth != null) && !dob) return { metadata: null, reason: "invalid_metadata" };
  if ((fields.patient_id != null || fields.patientId != null) && !patientId) return { metadata: null, reason: "invalid_metadata" };
  if ((fields.appointment_id != null || fields.appointmentId != null) && !appointmentId) return { metadata: null, reason: "invalid_metadata" };
  // A managed event may carry only opaque identifiers. Legacy blocks without
  // an identifier still require an email, preserving their old validation.
  if (!email && !patientId && !appointmentId && !dob) return { metadata: null, reason: "invalid_metadata" };

  const rawName = fields.name == null ? "" : String(fields.name).trim();
  const name = normalizePatientName(rawName);
  if (rawName && !name) return { metadata: null, reason: "invalid_metadata" };
  const metadata = {
      name,
      email,
      phone,
      source: "structured_description",
  };
  if (dob) metadata.dob = dob;
  if (patientId) metadata.patient_id = patientId;
  if (appointmentId) metadata.appointment_id = appointmentId;
  return {
    metadata,
    reason: null,
  };
}

function parsePatientMetadata(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return sanitizePatientFields(value);
  const raw = String(value || "");
  if (!raw.trim()) return { metadata: null, reason: null };
  if (raw.length > MAX_METADATA_LENGTH) return { metadata: null, reason: "invalid_metadata" };
  PATIENT_BLOCK_RE.lastIndex = 0;
  const matches = [...raw.matchAll(PATIENT_BLOCK_RE)];
  PATIENT_BLOCK_RE.lastIndex = 0;
  const hasPatientMarkers = raw.includes("[OpenWhispr Patient]") || raw.includes("[/OpenWhispr Patient]");
  if (hasPatientMarkers && matches.length !== 1) return { metadata: null, reason: "invalid_metadata" };

  const fields = new Map();
  const fieldLines = matches.length === 1
    ? matches[0][1].split(/\r?\n/)
    : raw.trim().split(/\r?\n/).filter((line) => line.trim());
  for (const line of fieldLines) {
    const field = /^([A-Za-z_]+):[ \t]*(.*)$/.exec(line);
    if (!field) return { metadata: null, reason: "invalid_metadata" };
    const key = field[1].toLowerCase();
    const fieldValue = field[2].trim();
    if (!PATIENT_FIELDS.has(key) || !fieldValue || fields.has(key)) return { metadata: null, reason: "invalid_metadata" };
    fields.set(key, fieldValue);
  }
  if (matches.length !== 1 && !fields.has("dob") && !fields.has("date_of_birth") && !fields.has("patient_id") && !fields.has("appointment_id")) {
    return { metadata: null, reason: "invalid_metadata" };
  }
  return sanitizePatientFields({
    name: fields.get("name"),
    email: fields.get("email"),
    phone: fields.get("phone"),
    dob: fields.get("dob") || fields.get("date_of_birth"),
    patient_id: fields.get("patient_id"),
    appointment_id: fields.get("appointment_id"),
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
    if (!unique.has(email)) unique.set(email, { email, displayName: cleanLabel(attendee.displayName) });
  }
  return { attendees: [...unique.values()], externalEntries, invalidExternalEntries };
}

function normalizeAttendees(value) {
  return inspectAttendees(value).attendees;
}

function unresolvedPatient(status, appointmentId = null) {
  return {
    status,
    patientId: null,
    appointmentId,
    normalizedDob: null,
    normalizedEmail: null,
    displayName: null,
    phone: null,
    identitySource: null,
  };
}

function normalizeSelfAttendeePresent(value) {
  return typeof value === "boolean" ? value : null;
}

function resolveFromRegistry({ metadata, registryPatients = [] } = {}) {
  const patients = Array.isArray(registryPatients) ? registryPatients : [];
  const appointmentId = metadata?.appointment_id || null;
  const patientId = metadata?.patient_id || null;
  if (patientId) {
    const matches = patients.filter((patient) => String(patient.patient_id) === patientId);
    if (matches.length !== 1) return unresolvedPatient(matches.length > 1 ? "unassigned_conflict" : "unassigned_unknown_patient_id", appointmentId);
    const patient = matches[0];
    return {
      status: "resolved_patient_id",
      patientId,
      appointmentId,
      normalizedDob: normalizePatientDob(patient.dob ?? patient.date_of_birth),
      normalizedEmail: normalizePatientEmail(patient.normalized_email ?? patient.email),
      displayName: cleanLabel(patient.display_name ?? patient.name),
      phone: normalizePatientPhone(patient.normalized_phone ?? patient.phone),
      identitySource: "patient_id",
    };
  }

  const nameKey = normalizePatientNameKey(metadata?.name);
  const dob = normalizePatientDob(metadata?.dob);
  if (!nameKey || !dob) return unresolvedPatient("unassigned_missing_demographics", appointmentId);
  const matches = patients.filter((patient) =>
    normalizePatientNameKey(patient.normalized_name ?? patient.name) === nameKey
    && normalizePatientDob(patient.normalized_dob ?? patient.dob ?? patient.date_of_birth) === dob
  );
  if (matches.length !== 1) return unresolvedPatient(matches.length > 1 ? "unassigned_conflict" : "unassigned_no_exact_match", appointmentId);
  const patient = matches[0];
  return {
    status: "resolved_registry",
    patientId: normalizeOpaqueId(patient.patient_id),
    appointmentId,
    normalizedDob: dob,
    normalizedEmail: normalizePatientEmail(patient.normalized_email ?? patient.email),
    displayName: cleanLabel(patient.display_name ?? patient.name),
    phone: normalizePatientPhone(patient.normalized_phone ?? patient.phone),
    identitySource: "registry_exact_name_dob",
  };
}

function resolvePatientIdentity({
  attendees,
  patientMetadata,
  selfAttendeePresent,
  registryPatients = null,
  appointmentPatient = null,
  legacyEmailFallback = registryPatients == null,
} = {}) {
  const parsedMetadata = parsePatientMetadata(patientMetadata);
  const attendeeState = inspectAttendees(attendees);
  if (registryPatients != null) {
    const metadata = parsedMetadata.metadata || {
      appointment_id: null,
      source: "structured_description",
    };
    if (appointmentPatient?.patient_id && !metadata.patient_id) metadata.patient_id = appointmentPatient.patient_id;
    return resolveFromRegistry({ metadata, registryPatients });
  }

  if (attendeeState.externalEntries > 1) return unresolvedPatient("unassigned_multiple_attendees", parsedMetadata.metadata?.appointment_id);
  if (attendeeState.invalidExternalEntries > 0) {
    return unresolvedPatient(parsedMetadata.reason === "invalid_metadata" ? "unassigned_invalid_metadata" : "unassigned_missing_email", parsedMetadata.metadata?.appointment_id);
  }
  const [attendee] = attendeeState.attendees;
  if (attendee) {
    if (parsedMetadata.reason === "invalid_metadata") return unresolvedPatient("unassigned_invalid_metadata");
    if (parsedMetadata.metadata?.email && parsedMetadata.metadata.email !== attendee.email) return unresolvedPatient("unassigned_conflict", parsedMetadata.metadata.appointment_id);
    const resolved = {
      status: "resolved_attendee",
      normalizedEmail: attendee.email,
      displayName: attendee.displayName || parsedMetadata.metadata?.name || null,
      phone: parsedMetadata.metadata?.phone || null,
      identitySource: "attendee_email",
    };
    if (parsedMetadata.metadata?.patient_id) resolved.patientId = parsedMetadata.metadata.patient_id;
    if (parsedMetadata.metadata?.appointment_id) resolved.appointmentId = parsedMetadata.metadata.appointment_id;
    if (parsedMetadata.metadata?.dob) resolved.normalizedDob = parsedMetadata.metadata.dob;
    return resolved;
  }
  if (legacyEmailFallback && parsedMetadata.metadata && normalizeSelfAttendeePresent(selfAttendeePresent) === false) {
    return {
      status: "resolved_structured",
      patientId: parsedMetadata.metadata.patient_id || null,
      appointmentId: parsedMetadata.metadata.appointment_id || null,
      normalizedDob: parsedMetadata.metadata.dob || null,
      normalizedEmail: parsedMetadata.metadata.email,
      displayName: parsedMetadata.metadata.name,
      phone: parsedMetadata.metadata.phone,
      identitySource: "structured_description",
    };
  }
  return unresolvedPatient(parsedMetadata.reason === "invalid_metadata" ? "unassigned_invalid_metadata" : "unassigned_missing_email", parsedMetadata.metadata?.appointment_id);
}

function formatDateInTimezone(date, timezone) {
  const options = { year: "numeric", month: "2-digit", day: "2-digit" };
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", { ...options, ...(typeof timezone === "string" && timezone.trim() ? { timeZone: timezone } : {}) });
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", options);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).filter(({ type }) => type === "year" || type === "month" || type === "day").map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatEncounterAutoTitle({ startTime, timezone, focus } = {}) {
  const parsed = new Date(startTime || Date.now());
  const date = Number.isNaN(parsed.getTime()) ? formatDateInTimezone(new Date(), timezone) : formatDateInTimezone(parsed, timezone);
  const brief = cleanLabel(focus)?.replace(/[\u2014\u2013]/g, "-") || "Encounter";
  return `${date} \u2014 ${brief}`;
}

module.exports = {
  formatEncounterAutoTitle,
  normalizeAttendees,
  normalizeAppointmentId,
  normalizeOpaqueId,
  normalizePatientDob,
  normalizePatientEmail,
  normalizePatientPhone,
  normalizePatientName,
  normalizePatientNameKey,
  normalizeSelfAttendeePresent,
  parsePatientMetadata,
  resolvePatientIdentity,
};
