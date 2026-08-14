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
  occurrenceId: string;
  summary: string;
  startTime: string;
  endTime: string;
  timezone: string;
  allDay: boolean;
  status: string;
  recurrence: CalendarRecurrence | null;
  attendees: CalendarAttendee[];
  conferenceUrl: string | null;
  calendarUrl: string | null;
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
  occurrence_id?: string | null;
  timezone?: string | null;
  recurrence?: string | null;
  capabilities?: string | null;
}

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
