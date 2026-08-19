export interface GoogleCalendar {
  id: string;
  summary: string;
  description: string | null;
  background_color: string | null;
  is_selected: number;
  is_primary: number;
  sync_token: string | null;
}

/** Canonical source event. LocalEncounter is a separate lifecycle projection. */
export interface CalendarEvent {
  provider: string;
  calendarId: string;
  eventId: string;
  eventUid: string;
  calendarIdentityKey: string;
  occurrenceId: string;
  summary: string;
  startTime: string;
  endTime: string;
  timezone: string;
  allDay: boolean;
  status: string;
  recurrence: CalendarRecurrence | null;
  recurringEventId: string | null;
  originalStartTime: string | null;
  attendees: CalendarAttendee[];
  conferenceUrl: string | null;
  calendarUrl: string | null;
  patientId: string | null;
  appointmentId: string | null;
  patientName: string | null;
  patientDob: string | null;
  patientEmail: string | null;
  patientPhone: string | null;
  patientSmsConsentStatus: PatientSmsConsentStatus;
  patientLinkStatus: PatientLinkStatus | null;
  patientLinkSource: string | null;
  capabilities: CalendarEventCapabilities;
}

/** Backward-compatible SQLite row shape used by existing calendar callers. */
export interface CalendarEventRow {
  id: string;
  calendar_id: string;
  provider: string;
  summary: string | null;
  start_time: string;
  end_time: string;
  is_all_day: number;
  status: string;
  hangout_link: string | null;
  conference_data: string | null;
  organizer_email: string | null;
  attendees_count: number;
  attendees: string | null;
  event_uid?: string | null;
  event_id?: string | null;
  calendar_identity_key?: string | null;
  occurrence_id?: string | null;
  recurring_event_id?: string | null;
  original_start_time?: string | null;
  timezone?: string | null;
  recurrence?: string | null;
  capabilities?: string | null;
  patient_id?: string | null;
  appointment_id?: string | null;
  patient_name?: string | null;
  patient_dob?: string | null;
  patient_email?: string | null;
  patient_phone?: string | null;
  patient_sms_consent_status?: PatientSmsConsentStatus | null;
  patient_link_status?: PatientLinkStatus | null;
  patient_link_source?: string | null;
}

export type PatientSmsConsentStatus = "unknown" | "opted_in" | "opted_out";
export type PatientLinkStatus =
  | "linked"
  | "created"
  | "patient_details_required"
  | "identity_conflict"
  | "unknown_patient_id";

export interface CalendarEventCapabilities {
  canSendEmail: boolean;
  canSendSms: boolean;
  canRename: boolean;
  canCancel: boolean;
  canReschedule: boolean;
}

export interface CalendarRecurrence {
  recurring: boolean;
  rule?: string | null;
  recurringEventId?: string | null;
}

export interface CalendarAccount {
  email: string;
}

export interface CalendarConnectionStatus {
  connected: boolean;
  email: string | null;
}

export interface MeetingDetectionPreferences {
  processDetection: boolean;
  audioDetection: boolean;
}

export interface CalendarAttendee {
  email: string;
  displayName: string | null;
  responseStatus: "needsAction" | "declined" | "tentative" | "accepted" | null;
  self: boolean;
}

export interface Contact {
  email: string;
  display_name: string | null;
}
