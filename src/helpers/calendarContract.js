const MAX_CALENDAR_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_CALENDAR_ROWS = 500;

function asIso(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be an ISO timestamp`);
  return date.toISOString();
}

function normalizeRange({ startIso, endIso, limit = MAX_CALENDAR_ROWS }) {
  const start = asIso(startIso, "startIso");
  const end = asIso(endIso, "endIso");
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (endMs <= startMs) throw new RangeError("endIso must be after startIso");
  if (endMs - startMs > MAX_CALENDAR_RANGE_MS) {
    throw new RangeError("calendar range exceeds the supported bound");
  }
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || MAX_CALENDAR_ROWS, MAX_CALENDAR_ROWS));
  return { startIso: start, endIso: end, limit: normalizedLimit };
}

function localRange(date, endDate) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = endDate || new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return normalizeRange({ startIso: start.toISOString(), endIso: end.toISOString() });
}

function localDayRange(date = new Date()) {
  return localRange(date);
}

function localWeekRange(date = new Date(), weekStartsOn = 1) {
  const current = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = current.getDay();
  const offset = (day - weekStartsOn + 7) % 7;
  current.setDate(current.getDate() - offset);
  const end = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 7);
  return normalizeRange({ startIso: current.toISOString(), endIso: end.toISOString() });
}

function localMonthRange(date = new Date(), includeVisiblePadding = false) {
  const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
  if (!includeVisiblePadding) {
    return normalizeRange({
      startIso: monthStart.toISOString(),
      endIso: new Date(date.getFullYear(), date.getMonth() + 1, 1).toISOString(),
    });
  }
  const firstDay = new Date(monthStart);
  firstDay.setDate(firstDay.getDate() - ((firstDay.getDay() + 6) % 7));
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  lastDay.setDate(lastDay.getDate() + (7 - ((lastDay.getDay() + 6) % 7) - 1) + 1);
  return normalizeRange({ startIso: firstDay.toISOString(), endIso: lastDay.toISOString() });
}

function encodePart(value) {
  return encodeURIComponent(String(value || "")).replace(/%/g, "_");
}

function canonicalOccurrenceId({ provider = "ai_receptionist", calendarId, eventId, startTime }) {
  if (!calendarId || !eventId || !startTime) throw new TypeError("calendar occurrence identity is incomplete");
  return [provider, encodePart(calendarId), encodePart(eventId), encodePart(startTime)].join(":");
}

function parseAttendees(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeAttendee(attendee) {
  if (typeof attendee === "string") return { email: attendee.trim(), displayName: null, responseStatus: null, self: false };
  if (!attendee || typeof attendee !== "object" || typeof attendee.email !== "string") return null;
  return {
    email: attendee.email.trim(),
    displayName: typeof attendee.displayName === "string" ? attendee.displayName : null,
    responseStatus: attendee.responseStatus || null,
    self: attendee.self === true,
  };
}

function canonicalEventFromAppointment(appointment) {
  if (!appointment || typeof appointment !== "object") return null;
  const eventId = appointment.event_id || appointment.eventId || appointment.event_uid || appointment.eventUid;
  const startTime = appointment.start_iso || appointment.startTime;
  const endTime = appointment.end_iso || appointment.endTime;
  const calendarId = appointment.calendar_id || appointment.calendarId || "primary";
  if (!eventId || !startTime || !endTime) return null;
  const attendees = parseAttendees(appointment.attendees || appointment.attendee_emails)
    .map(normalizeAttendee)
    .filter((attendee) => attendee?.email);
  const provider = appointment.provider || "ai_receptionist";
  return {
    provider,
    calendarId,
    eventId: String(eventId),
    eventUid: String(appointment.event_uid || appointment.eventUid || eventId),
    occurrenceId: appointment.occurrence_id || appointment.occurrenceId
      || canonicalOccurrenceId({ provider, calendarId, eventId, startTime }),
    summary: appointment.summary || appointment.title || "Appointment",
    startTime,
    endTime,
    timezone: appointment.timezone || "UTC",
    allDay: appointment.all_day === true || appointment.all_day === 1 || appointment.allDay === true,
    status: appointment.status || "confirmed",
    recurrence: typeof appointment.recurrence === "string"
      ? parseJson(appointment.recurrence)
      : appointment.recurrence || (appointment.recurring ? { recurring: true } : null),
    attendees,
    conferenceUrl: appointment.conference_url || appointment.hangout_link || null,
    calendarUrl: appointment.html_link || appointment.calendar_url || null,
    capabilities: {
      canSendEmail: appointment.capabilities?.canSendEmail ?? attendees.length > 0,
      canSendSms: appointment.capabilities?.canSendSms ?? appointment.sms_available === true,
      canRename: appointment.capabilities?.canRename ?? (appointment.appointment_changes_enabled === undefined ? true : appointment.appointment_changes_enabled === true),
      canCancel: appointment.capabilities?.canCancel ?? (appointment.can_cancel === undefined ? true : appointment.can_cancel === true),
      canReschedule: appointment.capabilities?.canReschedule ?? (appointment.can_reschedule === undefined ? true : appointment.can_reschedule === true),
    },
  };
}

function canonicalEventFromRow(row) {
  if (!row) return null;
  const event = canonicalEventFromAppointment({
    provider: row.provider,
    calendar_id: row.calendar_id,
    event_id: row.event_id || row.event_uid || row.id,
    event_uid: row.event_uid,
    occurrence_id: row.occurrence_id || row.id,
    start_iso: row.start_time,
    end_iso: row.end_time,
    timezone: row.timezone,
    all_day: row.is_all_day,
    status: row.status,
    summary: row.summary,
    attendees: row.attendees,
    conference_url: row.hangout_link,
    html_link: row.html_link,
    recurrence: row.recurrence,
    capabilities: row.capabilities ? parseJson(row.capabilities) : undefined,
  });
  return event;
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (/(?:token|password|secret|client_secret|private_key|access_key)/i.test(key)) {
      output[key] = child == null || child === "" ? child : "[redacted]";
    } else {
      output[key] = redactSecrets(child);
    }
  }
  return output;
}

module.exports = {
  MAX_CALENDAR_RANGE_MS,
  MAX_CALENDAR_ROWS,
  canonicalEventFromAppointment,
  canonicalEventFromRow,
  canonicalOccurrenceId,
  localDayRange,
  localMonthRange,
  localWeekRange,
  normalizeRange,
  parseJson,
  redactSecrets,
};
