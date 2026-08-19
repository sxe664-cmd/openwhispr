export type PatientSmsConsentStatus = "unknown" | "opted_in" | "opted_out";

export interface PatientRegistryRecord {
  patient_id: string;
  name: string;
  dob: string;
  phone: string | null;
  email: string | null;
  sms_consent_status: PatientSmsConsentStatus;
  updated_at: string | null;
  folder_id: number | null;
  folder_name: string | null;
  has_workspace: boolean;
  encounter_count: number;
}

export interface PatientEncounterHistoryItem {
  encounter_id: number;
  note_id: number | null;
  calendar_event_id: string | null;
  encounter_date: string | null;
  encounter_end: string | null;
  appointment_title: string;
  lifecycle_state: "scheduled" | "in_progress" | "completed" | "cancelled";
  note_title: string | null;
  folder_id: number | null;
}

export interface PatientRegistryPayload {
  patient_id?: string;
  name: string;
  dob: string;
  phone?: string;
  email?: string;
  sms_consent_status?: PatientSmsConsentStatus;
}
