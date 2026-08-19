import type { ModelDefinition } from "../models/ModelRegistry";
import type { TinfoilCatalogModel } from "../models/tinfoilModels";
import type { CalendarEvent } from "./calendar";
import type {
  PatientEncounterHistoryItem,
  PatientRegistryPayload,
  PatientRegistryRecord,
} from "./patientRegistry";

export interface CalendarRangeRequest {
  startIso: string;
  endIso: string;
  limit?: number;
}

export interface CalendarActionResult {
  success: boolean;
  eventId?: string;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

export type LocalTranscriptionProvider = "whisper" | "nvidia";

export type MeetingContext = "in_person" | "telehealth";
export type MeetingDiarizationStatus =
  "idle" | "queued" | "processing" | "completed" | "skipped" | "failed";

export const DEFAULT_MEETING_CONTEXT: MeetingContext = "telehealth";

export function normalizeMeetingContext(value: unknown): MeetingContext {
  return value === "in_person" ? "in_person" : DEFAULT_MEETING_CONTEXT;
}

export type EncounterLifecycleState = "scheduled" | "in_progress" | "completed" | "cancelled";
export type EncounterOutputStatus = "pending" | "processing" | "ready" | "failed" | "stale";
export type EncounterOutputType = "summary" | "soap" | "focus" | "all";
export type ClinicalNoteExportSection =
  "summary" | "soap" | "encounterDetails" | "participants" | "transcript";

export interface ClinicalNoteExportOptions {
  sections: ClinicalNoteExportSection[];
}

export interface ClinicalNoteExportPreview {
  success: boolean;
  encounterId?: number | null;
  title?: string;
  date?: string;
  duration?: number | null;
  sections?: Record<ClinicalNoteExportSection, { available: boolean; status: string }>;
  error?: string;
}
export type PatientResolution =
  | "created"
  | "matched"
  | "unassigned_review"
  | "unassigned_missing_email"
  | "unassigned_missing_demographics"
  | "unassigned_no_exact_match"
  | "unassigned_unknown_patient_id"
  | "unassigned_multiple_attendees"
  | "unassigned_conflict"
  | "unassigned_invalid_metadata"
  | "unassigned_folder_unavailable"
  | "unassigned_legacy";

export interface LocalEncounter {
  id: number;
  calendar_event_id: string | null;
  provider: string | null;
  calendar_id: string | null;
  title: string;
  start_time: string | null;
  end_time: string | null;
  source_status: string;
  lifecycle_state: EncounterLifecycleState;
  note_id: number | null;
  patient_id: string | null;
  appointment_id: string | null;
  dob: string | null;
  normalized_phone: string | null;
  normalized_email: string | null;
  patient_profile_id: number | null;
  patient_resolution: PatientResolution;
  meeting_context: MeetingContext | null;
  attendees_count: number;
  attendees: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  has_conference_url: boolean | number;
  has_calendar_event_url: boolean | number;
}

export interface EncounterOutput {
  encounter_id: number;
  transcript_hash: string;
  transcript_revision: number;
  summary: string | null;
  soap: string | null;
  focus: string | null;
  summary_status: EncounterOutputStatus;
  soap_status: EncounterOutputStatus;
  focus_status: EncounterOutputStatus;
  /** Derived from the two independent clinical output states. */
  status: EncounterOutputStatus;
  summary_provider: string | null;
  summary_model: string | null;
  soap_provider: string | null;
  soap_model: string | null;
  focus_provider: string | null;
  focus_model: string | null;
  summary_error_code: string | null;
  soap_error_code: string | null;
  focus_error_code: string | null;
  created_at: string;
  updated_at: string;
  summary_updated_at: string | null;
  soap_updated_at: string | null;
  focus_updated_at: string | null;
}

export interface EncounterTranscriptToken {
  transcriptRevision: number;
  transcriptHash: string;
  /** Present for a claimed generation; omitted for read-only transcript snapshots. */
  generationId?: string;
}

export interface EncounterOutputGenerationUpdate {
  summary?: string | null;
  soap?: string | null;
  focus?: string | null;
  summary_status?: "ready" | "failed";
  soap_status?: "ready" | "failed";
  focus_status?: "ready" | "failed";
  summary_provider?: string | null;
  summary_model?: string | null;
  soap_provider?: string | null;
  soap_model?: string | null;
  focus_provider?: string | null;
  focus_model?: string | null;
  summary_error_code?: string | null;
  soap_error_code?: string | null;
  focus_error_code?: string | null;
}

export type ChineseScriptPreference = "simplified" | "traditional" | "as-transcribed";

export type InferenceMode = "providers" | "local" | "self-hosted" | "enterprise";

export type SelfHostedType = "openai-compatible" | "lan";

export type TranscriptionStatus = "completed" | "failed" | "pending" | "discarded";

export interface PolicyFailureMetadata {
  error?: string;
  code?: string;
  status?: number;
  minAppVersion?: string;
  details?: unknown;
}

export interface NoteRecordingProviderModel {
  id: string;
  name: string;
  default?: boolean;
}

export interface NoteRecordingProvider {
  id: string;
  name: string;
  models: NoteRecordingProviderModel[];
}

export type NoteRecordingConfigFailure = { success: false } & PolicyFailureMetadata;

export type NoteRecordingConfigResult =
  { success: true; providers: NoteRecordingProvider[] } | NoteRecordingConfigFailure;

export type TranscriptionErrorCode =
  | "TIMEOUT"
  | "NETWORK"
  | "SERVER_ERROR"
  | "OFFLINE"
  | "AUTH_EXPIRED"
  | "AUTH_REQUIRED"
  | "LIMIT_REACHED"
  | "PROVIDER_RATE_LIMITED"
  | "API_KEY_MISSING"
  | "INVALID_KEY"
  | "MODEL_NOT_AVAILABLE"
  | "CUSTOM_ENDPOINT_INVALID"
  | null;

/**
 * Proxied-transcription IPC results. `ipcMain.handle` drops custom error props on
 * rejection, so these handlers resolve with a serialized error instead of throwing.
 */
export type ProxyTranscriptionResult =
  | { text: string; model?: string; error?: undefined }
  | { error: string; code?: string; messageKey?: string; text?: undefined };

export interface TranscriptionItem {
  id: number;
  text: string;
  raw_text: string | null;
  timestamp: string;
  created_at: string;
  has_audio: number;
  audio_duration_ms: number | null;
  provider: string | null;
  model: string | null;
  status: TranscriptionStatus;
  error_message: string | null;
  error_code: TranscriptionErrorCode;
  route_kind?: string | null;
  client_transcription_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
}

export interface NoteItem {
  id: number;
  title: string;
  content: string;
  enhanced_content: string | null;
  enhancement_prompt: string | null;
  enhanced_at_content_hash: string | null;
  enhanced_template_revision_id?: number | null;
  note_type: "personal" | "meeting" | "upload";
  source_file: string | null;
  audio_duration_seconds: number | null;
  folder_id: number | null;
  space_id: number;
  transcript: string | null;
  calendar_event_id: string | null;
  participants: string | null;
  diarization_enabled: number | null;
  expected_speaker_count: number | null;
  meeting_context: MeetingContext | null;
  cloud_id: string | null;
  is_shared: number;
  share_token: string | null;
  // The note's owner (CloudNote.user_id) â€” who created it, not who last
  // edited it. Only populated from the cloud; NULL on local-only rows and on
  // team notes mirrored before ownership shipped (the UI fails closed on
  // those until the owner backfill fills them).
  owner_user_id?: string | null;
  // Last cloud editor; only populated on cloud pull (local edits don't set it).
  updated_by_user_id?: string | null;
  // Server updated_at this device last acked (push response or pull); echoed
  // as base_updated_at on the next PATCH. Null = pre-guard row, pushes LWW.
  cloud_updated_at?: string | null;
  created_at: string;
  updated_at: string;
  client_note_id: string;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
  // Computed by getNoteByClientId while a parent folder DELETE awaits its
  // server result. Held notes stay hidden and must not be pulled/queued alone.
  folder_delete_pending?: number;
  // 1 while a cloud-backed row that left a team space still owes its scope
  // retraction push (D6); cleared when the row settles.
  left_team?: number;
  encounter_start_time?: string | null;
  encounter_title?: string | null;
}

export type NoteTemplateKind = "generic" | "encounter";

export interface NoteTemplateRevision {
  id: number;
  template_id: number;
  version: number;
  created_at: string;
}

export interface NoteTemplate {
  id: number;
  template_key: string;
  name: string;
  description: string;
  kind: NoteTemplateKind;
  is_builtin: boolean;
  is_default: boolean;
  active_revision_id: number | null;
  active_revision: NoteTemplateRevision | null;
  revisions: NoteTemplateRevision[];
  created_at: string;
  updated_at: string;
  /** Returned only when getNoteTemplate(..., { includeRaw: true }) is used. */
  template_text?: string;
}

export interface NoteGenerationCandidate {
  candidate_id: string;
  note_id: number;
  template_id: number;
  template_name?: string | null;
  template_revision_id: number;
  template_revision_version: number | null;
  base_content_hash: string;
  base_enhanced_content_hash: string;
  generated_content: string;
  status: "pending" | "applied" | "discarded";
  has_clinical_source: boolean;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
  discarded_at: string | null;
}

export interface NoteUpdateAckResult {
  success: boolean;
  outcome: "synced" | "pending" | "identity-changed";
  changes: number;
}

export type ShareVisibility = "private" | "link" | "domain" | "invited";

export type NotePermission = "owner" | "editor" | "viewer";

export type NoteAccessPrincipalType = "user" | "email" | "team" | "folder" | "workspace";

export interface NoteAccessPrincipal {
  type: NoteAccessPrincipalType;
  id: string | null;
  email: string | null;
  name: string | null;
  image: string | null;
  member_count: number | null;
}

export interface NoteAccessGrant {
  id: string;
  principal: NoteAccessPrincipal;
  permission: Exclude<NotePermission, "owner">;
  source: "direct" | "team" | "folder" | "workspace";
  inherited: boolean;
  pending: boolean;
  created_at: string;
  updated_at: string;
}

export interface NoteAccessState {
  owner: NoteAccessPrincipal;
  grants: NoteAccessGrant[];
  my_permission: NotePermission;
  can_manage_access: boolean;
  can_manage_inherited_access: boolean;
}

export interface ShareSettings {
  visibility: ShareVisibility;
  token_prefix: string | null;
  domain_allowlist: string[];
  updated_by_user_id: string | null;
  updated_at: string | null;
}

export interface NoteShareInvitation {
  id: string;
  email: string;
  invited_by_user_id: string;
  accepted_at: string | null;
  revoked_at: string | null;
  last_emailed_at: string | null;
  created_at: string;
}

export interface FolderItem {
  id: number;
  name: string;
  is_default: number;
  sort_order: number;
  space_id: number;
  created_at: string;
  updated_at: string;
  client_folder_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
  // 1 while a cloud-backed row that left a team space still owes its scope
  // retraction push (D6); cleared when the row settles.
  left_team?: number;
}

export type FolderPushSnapshot = Pick<
  FolderItem,
  | "client_folder_id"
  | "name"
  | "is_default"
  | "sort_order"
  | "space_id"
  | "created_at"
  | "updated_at"
  | "sync_status"
  | "deleted_at"
  | "left_team"
>;

export interface FolderAckResult {
  success: boolean;
  outcome: "synced" | "pending" | "already-linked" | "identity-changed" | "unresolved";
  changes: number;
}

/** A team assigned to a space, as mirrored from GET /api/me/spaces. */
export interface SpaceTeamRef {
  id: string;
  name: string;
  // Explicit team membership role, if any (workspace admins may have none).
  my_role?: "admin" | "member" | null;
  // Per-assignment cap on what the team conveys (space_teams.access): its
  // team admins are space admins only when this is 'admin'. Absent on
  // mirrors written before the API shipped it; those rows are 'admin'.
  access?: "admin" | "member";
}

export interface SpaceItem {
  id: number;
  client_space_id: string;
  cloud_space_id: string | null;
  // Retained only for unambiguous adoption of pre-spaces team rows.
  cloud_team_id?: string | null;
  workspace_id: string | null;
  kind: "private" | "team";
  name: string;
  emoji: string | null;
  sort_order: number;
  // Server-computed max effective role across assigned teams (ws owner/admin â‡’ admin).
  my_role: "admin" | "member" | null;
  // Server-computed deduped union of assigned team rosters.
  member_count: number | null;
  teams: SpaceTeamRef[];
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DictionaryEntryItem {
  id: number;
  word: string;
  source: "manual" | "learned";
  created_at: string;
  updated_at: string;
  client_dict_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
}

export interface SnippetEntryItem {
  id: number;
  trigger: string;
  replacement: string;
  created_at: string;
  updated_at: string;
  client_snippet_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
}

export interface ActionItem {
  id: number;
  name: string;
  description: string;
  prompt: string;
  icon: string;
  is_builtin: number;
  sort_order: number;
  translation_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface GpuDevice {
  index: number;
  uuid: string;
  name: string;
  vramMb: number;
}

export interface GpuInfo {
  hasNvidiaGpu: boolean;
  gpuName?: string;
  driverVersion?: string;
  vramMb?: number;
  computeCap?: number;
  /** Whether the card meets the shipped CUDA build's minimum compute capability. */
  cudaSupported?: boolean;
}

export interface CudaWhisperStatus {
  downloaded: boolean;
  downloading: boolean;
  path: string | null;
  gpuInfo: GpuInfo;
  /** CUDA fell back to CPU on this machine and stays off until retried. */
  gpuFailed?: boolean;
}

export interface VulkanWhisperStatus {
  downloaded: boolean;
  downloading: boolean;
  vulkan: VulkanGpuResult;
  hasNvidiaGpu: boolean;
  /** Vulkan fell back to CPU on this machine and stays off until retried. */
  gpuFailed?: boolean;
}

export interface WhisperServerStatus {
  available: boolean;
  running: boolean;
  port: number | null;
  hostname: string;
  isRemote: boolean;
  modelPath: string | null;
  modelName: string | null;
  gpuBackend: "cuda" | "vulkan" | null;
  /** True only when the running server is actually using a local GPU backend. */
  gpuAccelerated: boolean;
}

export interface WhisperCheckResult {
  installed: boolean;
  working: boolean;
  error?: string;
}

export interface WhisperModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  size_mb?: number;
  error?: string;
  code?: string;
  isDownloading?: boolean;
  isInstalling?: boolean;
  downloadProgress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface WhisperModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_mb?: number;
  error?: string;
}

export interface WhisperModelsListResult {
  success: boolean;
  models: WhisperModelResult[];
  cache_dir: string;
}

export interface FFmpegAvailabilityResult {
  available: boolean;
  path?: string;
  error?: string;
}

export interface AudioDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  ffmpeg: { available: boolean; path: string | null; error: string | null };
  whisperBinary: { available: boolean; path: string | null; error: string | null };
  whisperServer: { available: boolean; path: string | null };
  modelsDir: string;
  models: string[];
}

export type SystemAudioMode = "native" | "loopback" | "portal" | "unsupported";
export type SystemAudioStrategy =
  "native" | "loopback" | "pipewire-loopback" | "wasapi-loopback" | "unsupported";

export interface SystemAudioAccessResult {
  granted: boolean;
  status: "granted" | "denied" | "not-determined" | "restricted" | "unknown" | "unsupported";
  mode: SystemAudioMode;
  supportsPersistentGrant?: boolean;
  supportsPersistentPortalGrant?: boolean;
  supportsNativeCapture?: boolean;
  supportsOnboardingGrant?: boolean;
  requiresRuntimeSharePrompt?: boolean;
  strategy?: SystemAudioStrategy;
  restoreTokenAvailable?: boolean;
  portalVersion?: number | null;
  error?: string;
}

export interface ScreenRecordingAccessResult {
  granted: boolean;
  status: "granted" | "denied" | "not-determined" | "restricted" | "unknown" | "unsupported";
  supported: boolean;
  /** macOS only: granted mid-session, so capture stays broken until the app relaunches. */
  needsRelaunch?: boolean;
}

export interface ScreenContextImage {
  mediaType: string;
  /** Base64 image bytes, no data-URL prefix. */
  data: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  version?: string;
  releaseDate?: string;
  files?: any[];
  releaseNotes?: string;
  message?: string;
}

export interface UpdateStatusResult {
  updateAvailable: boolean;
  updateDownloaded: boolean;
  isDevelopment: boolean;
}

export interface UpdateInfoResult {
  version?: string;
  releaseDate?: string;
  releaseNotes?: string | null;
  files?: any[];
}

export interface UpdateResult {
  success: boolean;
  message: string;
}

export interface AppVersionResult {
  version: string;
}

export interface WhisperDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
  result?: any;
}

export interface ParakeetCheckResult {
  installed: boolean;
  working: boolean;
  path?: string;
}

export interface ParakeetModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  path?: string;
  size_bytes?: number;
  size_mb?: number;
  error?: string;
  code?: string;
  isDownloading?: boolean;
  isInstalling?: boolean;
  downloadProgress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface ParakeetModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_bytes?: number;
  freed_mb?: number;
  error?: string;
}

export interface ParakeetModelsListResult {
  success: boolean;
  models: ParakeetModelResult[];
  cache_dir: string;
}

export interface ParakeetDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;

  total_bytes?: number;
  error?: string;
  code?: string;
}

export interface ParakeetTranscriptionResult {
  success: boolean;
  text?: string;
  message?: string;
  error?: string;
}

export interface ParakeetDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  sherpaOnnx: { available: boolean; path: string | null };
  modelsDir: string;
  models: string[];
}

export interface PasteToolsResult {
  platform: "darwin" | "win32" | "linux";
  available: boolean;
  method: string | null;
  requiresPermission: boolean;
  isWayland?: boolean;
  xwaylandAvailable?: boolean;
  terminalAware?: boolean;
  hasNativeBinary?: boolean;
  hasUinput?: boolean;
  tools?: string[];
  recommendedInstall?: string;
}

export type GpuBackend = "vulkan" | "cpu" | "metal" | null;

export interface LlamaServerStatus {
  available: boolean;
  running: boolean;
  port: number | null;
  modelPath: string | null;
  modelName: string | null;
  backend: GpuBackend;
  gpuAccelerated: boolean;
}

export interface VulkanGpuResult {
  available: boolean;
  deviceName?: string;
  reason?: string;
  error?: string;
}

export interface LlamaVulkanStatus {
  supported: boolean;
  downloaded: boolean;
  downloading?: boolean;
  error?: string;
}

export interface LlamaVulkanDownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
}

export interface LocalLLMModelStatus extends ModelDefinition {
  providerId?: string;
  providerName?: string;
  isDownloaded: boolean;
  isDownloading: boolean;
  downloadProgress: number;
  downloadedSize: number;
  totalSize: number;
  path: string | null;
}

export type LocalLLMDownloadProgressEvent =
  | {
      type?: "progress";
      modelId: string;
      progress: number;
      downloadedSize: number;
      totalSize: number;
    }
  | {
      type: "complete";
      modelId: string;
      progress: 100;
      downloadedSize?: number;
      totalSize?: number;
    }
  | {
      type: "error";
      modelId: string;
      error: string;
      code?: string;
      details?: unknown;
    };

export interface ConversationPreview {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
  cloud_id?: string | null;
  client_conversation_id?: string;
  sync_status?: "synced" | "pending" | "error";
  deleted_at?: string | null;
  // Computed for sync lookups while the parent folder delete is unresolved.
  folder_delete_pending?: number;
  message_count: number;
  last_message?: string | null;
  last_message_role?: "user" | "assistant" | "system" | null;
}

export interface ReferralItem {
  id: string;
  email: string;
  name: string | null;
  status: "pending" | "completed" | "rewarded";
  created_at: string;
  first_payment_at: string | null;
}

declare global {
  interface Window {
    electronAPI: {
      // Basic window operations
      pasteText: (
        text: string,
        options?: {
          fromStreaming?: boolean;
          restoreClipboard?: boolean;
          allowClipboardFallback?: boolean;
        }
      ) => Promise<void>;
      captureSelectedText?: () => Promise<
        | {
            status: "selected";
            sessionId: string;
            text: string;
            characterCount: number;
          }
        | {
            status: "none" | "unavailable" | "target_changed" | "too_large";
            code?: string;
            characterCount?: number;
            maxCharacters?: number;
          }
      >;
      replaceSelectedText?: (
        sessionId: string,
        text: string,
        options?: { restoreClipboard?: boolean; allowClipboardFallback?: boolean }
      ) => Promise<{
        success: boolean;
        code?:
          | "invalid_replacement"
          | "session_expired"
          | "target_changed"
          | "selection_unavailable"
          | "selection_changed"
          | "paste_failed"
          | "selection_manager_unavailable";
        error?: string;
      }>;
      hideWindow: () => Promise<void>;
      showDictationPanel: () => Promise<void>;
      captureDictationTarget?: () => Promise<{ success: boolean; pid: number | null }>;
      onToggleDictation: (callback: () => void) => () => void;
      onToggleVoiceAgent?: (callback: () => void) => () => void;
      onToggleTranslation?: (callback: () => void) => () => void;
      onStartDictation?: (callback: () => void) => () => void;
      onStopDictation?: (callback: () => void) => () => void;
      onPrepareDictation?: (callback: () => void) => () => void;
      onCancelDictationPreparation?: (callback: () => void) => () => void;
      micWarmHoldChanged?: (active: boolean) => void;

      // STT config
      getSttConfig?: () => Promise<
        | ({
            success: boolean;
            dictation?: { mode: string };
            notes?: { mode: string };
            streamingProvider?: string;
          } & PolicyFailureMetadata)
        | null
      >;

      getNoteRecordingConfig?: () => Promise<NoteRecordingConfigResult | null>;

      // Database operations
      saveTranscription: (
        text: string,
        rawText?: string | null,
        options?: {
          status?: TranscriptionStatus;
          errorMessage?: string | null;
          errorCode?: TranscriptionErrorCode;
          clientTranscriptionId?: string;
        }
      ) => Promise<{ id: number; success: boolean; transcription?: TranscriptionItem }>;
      getTranscriptions: (
        limit?: number,
        options?: { includeDiscarded?: boolean }
      ) => Promise<TranscriptionItem[]>;
      clearTranscriptions: () => Promise<{ cleared: number; success: boolean }>;
      deleteTranscription: (id: number) => Promise<{ success: boolean }>;
      getTranscriptionById: (id: number) => Promise<TranscriptionItem | null>;

      // Audio retention operations
      saveTranscriptionAudio: (
        id: number,
        audioBuffer: ArrayBuffer,
        metadata?: { durationMs?: number; provider?: string; model?: string }
      ) => Promise<{ success: boolean; path?: string }>;
      mergeAudioSegments: (
        segments: Array<{ buffer: ArrayBuffer; mimeType: string }>
      ) => Promise<
        | { success: true; buffer: ArrayBuffer; mimeType: "audio/webm" }
        | { success: false; error: string }
      >;
      getAudioPath: (id: number) => Promise<string | null>;
      showAudioInFolder: (id: number) => Promise<{ success: boolean }>;
      getAudioBuffer: (id: number) => Promise<ArrayBuffer | null>;
      deleteTranscriptionAudio: (id: number) => Promise<{ success: boolean }>;
      getAudioStorageUsage: () => Promise<{ fileCount: number; totalBytes: number }>;
      deleteAllAudio: () => Promise<{ deleted: number }>;
      syncRetentionSettings?: (settings: {
        audioRetentionDays: number;
        transcriptRetentionDays: number;
      }) => void;
      retryTranscription: (
        id: number,
        settings?: {
          useLocalWhisper: boolean;
          localTranscriptionProvider: string;
          cloudTranscriptionMode: string;
          cloudTranscriptionProvider: string;
          cloudTranscriptionModel: string;
          cloudTranscriptionBaseUrl?: string;
          cortiEnvironment?: string;
          cortiTenant?: string;
          parakeetModel: string;
          whisperModel: string;
          preferredLanguage?: string;
          transcriptionMode?: InferenceMode;
          remoteTranscriptionType?: SelfHostedType;
          remoteTranscriptionUrl?: string;
          remoteTranscriptionModel?: string;
        }
      ) => Promise<{
        success: boolean;
        transcription?: TranscriptionItem;
        error?: string;
        code?: TranscriptionErrorCode;
      }>;
      updateTranscriptionText: (
        id: number,
        text: string,
        rawText: string
      ) => Promise<{ success: boolean; transcription?: TranscriptionItem; error?: string }>;

      // Dictionary operations
      getDictionary: () => Promise<string[]>;
      /** Replaces the whole dictionary â€” omitted words are deleted. Prefer applyDictionaryChanges. */
      setDictionary: (words: string[]) => Promise<{ success: boolean }>;
      applyDictionaryChanges?: (changes: {
        add?: string[];
        remove?: string[];
      }) => Promise<{ success: boolean; added: number; removed: number }>;
      onDictionaryUpdated?: (callback: (words: string[]) => void) => () => void;
      getSnippets?: () => Promise<Array<{ trigger: string; replacement: string }>>;
      setSnippets?: (
        snippets: Array<{ trigger: string; replacement: string }>
      ) => Promise<{ success: boolean }>;
      onSnippetsUpdated?: (
        callback: (snippets: Array<{ trigger: string; replacement: string }>) => void
      ) => () => void;
      setAutoLearnEnabled?: (enabled: boolean) => void;
      onCorrectionsLearned?: (callback: (words: string[]) => void) => () => void;
      undoLearnedCorrections?: (words: string[]) => Promise<{ success: boolean }>;

      // Note operations
      saveNote: (
        title: string,
        content: string,
        noteType?: string,
        sourceFile?: string | null,
        audioDuration?: number | null,
        folderId?: number | null,
        spaceId?: number | null
      ) => Promise<{ success: boolean; note?: NoteItem }>;
      getNote: (id: number) => Promise<NoteItem | null>;
      getNotes: (
        noteType?: string | null,
        limit?: number,
        folderId?: number | null,
        spaceId?: number | null
      ) => Promise<NoteItem[]>;
      getSpaceNotes: (spaceId: number, limit?: number) => Promise<NoteItem[]>;
      updateNote: (
        id: number,
        updates: {
          title?: string;
          content?: string;
          enhanced_content?: string | null;
          enhancement_prompt?: string | null;
          enhanced_at_content_hash?: string | null;
          folder_id?: number | null;
          space_id?: number;
          transcript?: string | null;
          calendar_event_id?: string | null;
          participants?: string | null;
          diarization_enabled?: number | null;
          expected_speaker_count?: number | null;
          meeting_context?: MeetingContext | null;
          client_note_id?: string;
          cloud_id?: string | null;
          cloud_updated_at?: string | null;
          owner_user_id?: string | null;
          updated_by_user_id?: string | null;
          left_team?: number;
        }
      ) => Promise<{ success: boolean; note?: NoteItem }>;
      deleteNote: (id: number) => Promise<{ success: boolean }>;
      listNoteTemplates?: (kind?: NoteTemplateKind) => Promise<NoteTemplate[]>;
      getNoteTemplate?: (
        idOrKey: number | string,
        options?: { includeRaw?: boolean }
      ) => Promise<NoteTemplate | null>;
      getDefaultNoteTemplate?: (
        kind?: NoteTemplateKind,
        options?: { includeRaw?: boolean }
      ) => Promise<NoteTemplate | null>;
      createNoteTemplate?: (input: {
        templateKey?: string;
        name: string;
        description?: string;
        kind: NoteTemplateKind;
        templateText: string;
      }) => Promise<{ success: boolean; template?: NoteTemplate; code?: string; error?: string }>;
      updateNoteTemplate?: (
        id: number,
        updates: { name?: string; description?: string; templateText?: string }
      ) => Promise<{ success: boolean; template?: NoteTemplate; code?: string; error?: string }>;
      deleteNoteTemplate?: (id: number) => Promise<{ success: boolean; code?: string; error?: string }>;
      activateNoteTemplate?: (
        id: number,
        revisionId?: number | null
      ) => Promise<{ success: boolean; template?: NoteTemplate; code?: string; error?: string }>;
      setDefaultNoteTemplate?: (
        id: number,
        revisionId?: number | null
      ) => Promise<{ success: boolean; template?: NoteTemplate; code?: string; error?: string }>;
      createNoteGenerationCandidate?: (input: {
        noteId: number;
        generatedContent: string;
        templateRevisionId?: number;
        clinicalSource?: string | null;
        confirmed?: boolean;
      }) => Promise<{
        success: boolean;
        candidate?: NoteGenerationCandidate;
        code?: string;
        error?: string;
      }>;
      getNoteGenerationCandidate?: (candidateId: string) => Promise<NoteGenerationCandidate | null>;
      applyNoteGenerationCandidate?: (
        candidateId: string,
        options?: { confirmed?: boolean }
      ) => Promise<{
        success: boolean;
        applied?: boolean;
        note?: NoteItem;
        candidate?: NoteGenerationCandidate;
        code?: string;
        error?: string;
      }>;
      discardNoteGenerationCandidate?: (candidateId: string) => Promise<{
        success: boolean;
        candidate?: NoteGenerationCandidate;
        code?: string;
        error?: string;
      }>;
      exportNote: (
        noteId: number,
        format: "txt" | "md"
      ) => Promise<{ success: boolean; error?: string }>;
      exportTranscript: (
        noteId: number,
        format: "txt" | "srt" | "json" | "md"
      ) => Promise<{ success: boolean; error?: string }>;
      getClinicalNoteExportPreview?: (noteId: number) => Promise<ClinicalNoteExportPreview>;
      exportClinicalNotePdf?: (
        noteId: number,
        options: ClinicalNoteExportOptions
      ) => Promise<{ success: boolean; filePath?: string; error?: string }>;
      exportDictionary: (words: string[]) => Promise<{ success: boolean; error?: string }>;
      searchNotes: (
        query: string,
        limit?: number,
        spaceId?: number | null,
        folderId?: number | null
      ) => Promise<NoteItem[]>;
      semanticSearchNotes: (
        query: string,
        limit?: number,
        spaceId?: number | null,
        folderId?: number | null
      ) => Promise<NoteItem[]>;
      semanticReindexAll: () => Promise<{ success: boolean; indexed?: number; error?: string }>;
      onSemanticReindexProgress: (
        callback: (data: { done: number; total: number }) => void
      ) => () => void;

      // Folder operations
      getFolders: (spaceId?: number | null) => Promise<FolderItem[]>;
      createFolder: (
        name: string,
        spaceId?: number | null
      ) => Promise<{ success: boolean; folder?: FolderItem; error?: string }>;
      deleteFolder: (id: number) => Promise<{ success: boolean; error?: string }>;
      renameFolder: (
        id: number,
        name: string
      ) => Promise<{ success: boolean; folder?: FolderItem; error?: string }>;
      moveFolderToSpace: (
        id: number,
        spaceId: number
      ) => Promise<{ success: boolean; folder?: FolderItem; notes?: NoteItem[]; error?: string }>;
      getFolderNoteCounts: () => Promise<
        Array<{ space_id: number; folder_id: number | null; count: number }>
      >;

      // Space operations
      getSpaces?: () => Promise<SpaceItem[]>;
      updateSpace?: (
        id: number,
        updates: { name?: string; emoji?: string | null }
      ) => Promise<{ success: boolean; space?: SpaceItem; error?: string }>;
      purgeSpace?: (
        id: number,
        options?: {
          mode?: "preserve-dirty" | "destructive";
        }
      ) => Promise<{
        success: boolean;
        code?: string;
        error?: string;
        noteIds?: number[];
        folderNames?: string[];
        spaceId?: number;
        relocatedNotes?: NoteItem[];
        relocatedCount?: number;
        relocatedTitles?: string[];
      }>;
      onSpacePurged?: (callback: (payload: { spaceId: number }) => void) => () => void;

      // Note files (markdown mirror)
      noteFilesSetEnabled?: (
        enabled: boolean,
        customPath?: string,
        options?: { skipRebuild?: boolean }
      ) => Promise<{ success: boolean; error?: string }>;
      noteFilesSetPath?: (path: string) => Promise<{ success: boolean; error?: string }>;
      noteFilesRebuild?: () => Promise<{ success: boolean; error?: string }>;
      noteFilesGetDefaultPath?: () => Promise<string>;
      noteFilesPickFolder?: () => Promise<{ canceled: boolean; path?: string }>;
      showNoteFile?: (noteId: number) => Promise<{ success: boolean }>;
      showFolderInExplorer?: (folderName: string) => Promise<{ success: boolean }>;

      // Action operations
      getActions: () => Promise<ActionItem[]>;
      getAction: (id: number) => Promise<ActionItem | null>;
      createAction: (
        name: string,
        description: string,
        prompt: string,
        icon?: string
      ) => Promise<{ success: boolean; action?: ActionItem; error?: string }>;
      updateAction: (
        id: number,
        updates: {
          name?: string;
          description?: string;
          prompt?: string;
          icon?: string;
          sort_order?: number;
        }
      ) => Promise<{ success: boolean; action?: ActionItem; error?: string }>;
      deleteAction: (id: number) => Promise<{ success: boolean; id?: number; error?: string }>;
      onActionCreated?: (callback: (action: ActionItem) => void) => () => void;
      onActionUpdated?: (callback: (action: ActionItem) => void) => () => void;
      onActionDeleted?: (callback: (payload: { id: number }) => void) => () => void;

      // Audio file operations
      selectAudioFile: (options?: { multiple?: boolean }) => Promise<{
        canceled: boolean;
        filePath?: string;
        filePaths?: string[];
      }>;
      getFileSize?: (filePath: string) => Promise<number>;
      transcribeAudioFile: (
        filePath: string,
        options?: {
          provider?: "whisper" | "nvidia";
          model?: string;
          language?: string;
          [key: string]: unknown;
        }
      ) => Promise<{ success: boolean; text?: string; error?: string }>;
      getPathForFile: (file: File) => string;

      // URL audio download
      downloadUrlAudio: (
        url: string,
        downloadId?: string
      ) => Promise<
        | {
            success: true;
            tempPath: string;
            title: string;
            durationSeconds: number | null;
            sizeBytes: number;
          }
        | { success: false; error: string; code?: string }
      >;
      cancelUrlDownload: (downloadId?: string) => Promise<{ success: boolean }>;
      deleteTempFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
      onUrlDownloadProgress?: (
        callback: (data: {
          stage: "resolving" | "downloading" | "ready";
          percent: number;
          title?: string;
          downloadId?: string;
        }) => void
      ) => () => void;

      // Note event listeners
      onNoteAdded?: (callback: (note: NoteItem) => void) => () => void;
      onNoteUpdated?: (callback: (note: NoteItem) => void) => () => void;
      onEncounterRecordingCompleted?: (
        callback: (payload: {
          encounterId?: number | null;
          noteId?: number | null;
          transcriptRevision?: number;
        }) => void
      ) => () => void;
      onNoteDeleted?: (callback: (payload: { id: number }) => void) => () => void;
      onFolderDeleted?: (callback: (payload: { id: number }) => void) => () => void;

      // Database event listeners
      onTranscriptionAdded?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionUpdated?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionDeleted?: (callback: (payload: { id: number }) => void) => () => void;
      onTranscriptionsCleared?: (callback: (payload: { cleared: number }) => void) => () => void;

      // API key management
      getOpenAIKey: () => Promise<string>;
      saveOpenAIKey: (key: string) => Promise<{ success: boolean }>;
      getAnthropicKey: () => Promise<string | null>;
      saveAnthropicKey: (key: string) => Promise<void>;
      getUiLanguage: () => Promise<string>;
      saveUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      setUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      saveAllKeysToEnv: () => Promise<{ success: boolean; path: string }>;
      syncStartupPreferences: (prefs: {
        useLocalWhisper: boolean;
        localTranscriptionProvider: LocalTranscriptionProvider;
        model?: string;
        useCleanupModel: boolean;
        cleanupMode: InferenceMode;
        cleanupModel?: string;
        useDictationAgent: boolean;
        dictationAgentMode: InferenceMode;
        dictationAgentModel?: string;
      }) => Promise<void>;

      // Clipboard operations
      checkAccessibilityPermission: (silent?: boolean) => Promise<boolean>;
      promptAccessibilityPermission: () => Promise<boolean>;
      readClipboard: () => Promise<string>;
      writeClipboard: (text: string) => Promise<{ success: boolean }>;
      checkPasteTools: () => Promise<PasteToolsResult>;

      // Audio
      onNoAudioDetected: (callback: (event: any, data?: any) => void) => () => void;

      // Whisper operations (whisper.cpp)
      transcribeLocalWhisper: (audioBlob: Blob | ArrayBuffer, options?: any) => Promise<any>;
      checkWhisperInstallation: () => Promise<WhisperCheckResult>;
      downloadWhisperModel: (modelName: string) => Promise<WhisperModelResult>;
      onWhisperDownloadProgress: (
        callback: (event: any, data: WhisperDownloadProgressData) => void
      ) => () => void;
      checkModelStatus: (modelName: string) => Promise<WhisperModelResult>;
      listWhisperModels: () => Promise<WhisperModelsListResult>;
      deleteWhisperModel: (modelName: string) => Promise<WhisperModelDeleteResult>;
      deleteAllWhisperModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelWhisperDownload: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;

      // Whisper server lifecycle
      whisperServerStatus: () => Promise<WhisperServerStatus>;
      whisperGpuRetry: () => Promise<{ success: boolean; willRestart: boolean }>;

      // CUDA GPU acceleration
      listGpus?: () => Promise<GpuDevice[]>;
      setGpuDeviceIndex?: (
        purpose: "transcription" | "intelligence",
        uuid: string
      ) => Promise<{ success: boolean }>;
      getGpuDeviceIndex?: (purpose: "transcription" | "intelligence") => Promise<string>;
      detectGpu: () => Promise<GpuInfo>;
      getCudaWhisperStatus: () => Promise<CudaWhisperStatus>;
      downloadCudaWhisperBinary: () => Promise<{
        success: boolean;
        willRestart?: boolean;
        error?: string;
      }>;
      cancelCudaWhisperDownload: () => Promise<{ success: boolean }>;
      deleteCudaWhisperBinary: () => Promise<{ success: boolean }>;
      onCudaDownloadProgress: (
        callback: (data: {
          downloadedBytes: number;
          totalBytes: number;
          percentage: number;
        }) => void
      ) => () => void;
      onCudaFallbackNotification: (callback: () => void) => () => void;

      // Vulkan GPU acceleration (whisper on AMD/Intel GPUs)
      getVulkanWhisperStatus: () => Promise<VulkanWhisperStatus>;
      downloadVulkanWhisperBinary: () => Promise<{
        success: boolean;
        willRestart?: boolean;
        error?: string;
      }>;
      cancelVulkanWhisperDownload: () => Promise<{ success: boolean }>;
      deleteVulkanWhisperBinary: () => Promise<{ success: boolean; deletedCount?: number }>;
      onVulkanWhisperDownloadProgress: (
        callback: (data: {
          downloadedBytes: number;
          totalBytes: number;
          percentage: number;
        }) => void
      ) => () => void;
      onGpuFallbackNotification: (callback: () => void) => () => void;

      // Parakeet operations (NVIDIA via sherpa-onnx)
      transcribeLocalParakeet: (
        audioBlob: ArrayBuffer,
        options?: { model?: string }
      ) => Promise<ParakeetTranscriptionResult>;
      checkParakeetInstallation: () => Promise<ParakeetCheckResult>;
      downloadParakeetModel: (modelName: string) => Promise<ParakeetModelResult>;
      onParakeetDownloadProgress: (
        callback: (event: any, data: ParakeetDownloadProgressData) => void
      ) => () => void;
      checkParakeetModelStatus: (modelName: string) => Promise<ParakeetModelResult>;
      listParakeetModels: () => Promise<ParakeetModelsListResult>;
      deleteParakeetModel: (modelName: string) => Promise<ParakeetModelDeleteResult>;
      deleteAllParakeetModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelParakeetDownload: () => Promise<
        {
          success: boolean;
          message?: string;
        } & PolicyFailureMetadata
      >;
      getParakeetDiagnostics: () => Promise<ParakeetDiagnosticsResult>;

      // Local AI model management
      modelGetAll: () => Promise<LocalLLMModelStatus[]>;
      modelCheck: (modelId: string) => Promise<boolean>;
      modelDownload: (modelId: string) => Promise<{
        success: boolean;
        path?: string;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelDelete: (modelId: string) => Promise<{
        success: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelDeleteAll: () => Promise<{
        success: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelCheckRuntime: () => Promise<{
        available: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelCancelDownload: (modelId: string) => Promise<{ success: boolean; error?: string }>;
      onModelDownloadProgress: (
        callback: (event: any, data: LocalLLMDownloadProgressEvent) => void
      ) => () => void;

      // Local reasoning
      processLocalReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string }>;
      checkLocalReasoningAvailable: () => Promise<boolean>;

      // Anthropic reasoning
      processAnthropicReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string }>;

      // Enterprise reasoning (Bedrock, Azure, Vertex)
      processEnterpriseReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string; retryable?: boolean }>;
      enterpriseStreamStart?: (payload: {
        streamId: string;
        provider: string;
        modelId: string;
        config: Record<string, unknown>;

        options: Record<string, unknown>;
      }) => Promise<{ success: boolean; error?: string }>;
      enterpriseStreamCancel?: (streamId: string) => Promise<void>;
      onEnterpriseStreamPart?: (
        callback: (payload: {
          streamId: string;
          part?: unknown;
          done?: boolean;
          error?: string;
        }) => void
      ) => () => void;
      listBedrockModels?: (config: Record<string, unknown>) => Promise<{
        success: boolean;
        models?: Array<{ value: string; label: string; vendor: string }>;
        error?: string;
      }>;

      // llama.cpp management
      llamaCppCheck: () => Promise<{ isInstalled: boolean; version?: string }>;
      llamaCppInstall: () => Promise<{ success: boolean; error?: string }>;
      llamaCppUninstall: () => Promise<{ success: boolean; error?: string }>;

      // llama-server
      llamaServerStart: (
        modelId: string
      ) => Promise<{ success: boolean; port?: number; error?: string }>;
      llamaServerStop: () => Promise<{ success: boolean; error?: string }>;
      llamaServerStatus: () => Promise<LlamaServerStatus>;
      llamaGpuReset: () => Promise<{ success: boolean; error?: string }>;
      detectVulkanGpu?: () => Promise<VulkanGpuResult>;
      getLlamaVulkanStatus?: () => Promise<LlamaVulkanStatus>;
      downloadLlamaVulkanBinary?: () => Promise<{
        success: boolean;
        cancelled?: boolean;
        error?: string;
      }>;
      cancelLlamaVulkanDownload?: () => Promise<{ success: boolean }>;
      deleteLlamaVulkanBinary?: () => Promise<{
        success: boolean;
        deletedCount?: number;
        error?: string;
      }>;
      onLlamaVulkanDownloadProgress?: (
        callback: (data: LlamaVulkanDownloadProgress) => void
      ) => () => void;

      // Window control operations
      windowMinimize: () => Promise<void>;
      windowMaximize: () => Promise<void>;
      windowClose: () => Promise<void>;
      windowIsMaximized: () => Promise<boolean>;
      snapToMeetingMode: () => Promise<void>;
      restoreFromMeetingMode: () => Promise<void>;
      getPlatform: () => string;
      startWindowDrag: () => Promise<void>;
      stopWindowDrag: () => Promise<void>;
      setMainWindowInteractivity: (interactive: boolean) => Promise<void>;
      setNotificationInteractivity: (interactive: boolean) => Promise<void>;

      // App management
      cleanupApp: () => Promise<{ success: boolean; message: string; errors?: string[] }>;

      // Update operations
      checkForUpdates: () => Promise<UpdateCheckResult>;
      downloadUpdate: () => Promise<UpdateResult>;
      installUpdate: () => Promise<UpdateResult>;
      getAppVersion: () => Promise<AppVersionResult>;
      getPostMigrationState: () => Promise<{ justMigrated: boolean }>;
      markBundleMigrated: () => Promise<void>;
      markBundleMigrationDismissed: () => Promise<void>;
      getUpdateStatus: () => Promise<UpdateStatusResult>;
      getUpdateInfo: () => Promise<UpdateInfoResult | null>;

      // Update event listeners
      onUpdateAvailable: (callback: (event: any, info: any) => void) => () => void;
      onUpdateNotAvailable: (callback: (event: any, info: any) => void) => () => void;
      onUpdateDownloaded: (callback: (event: any, info: any) => void) => () => void;
      onUpdateDownloadProgress: (callback: (event: any, progressObj: any) => void) => () => void;
      onUpdateError: (callback: (event: any, error: any) => void) => () => void;

      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;

      // Hotkey management
      updateHotkey: (key: string) => Promise<{ success: boolean; message: string }>;
      setHotkeyListeningMode?: (enabled: boolean) => Promise<{ success: boolean }>;
      getHotkeyModeInfo?: () => Promise<{
        isUsingGnome: boolean;
        isUsingHyprland: boolean;
        isUsingNativeShortcut: boolean;
        supportsPushToTalk: boolean;
      }>;
      getHyprlandConfigStatus?: () => Promise<{ canWrite: boolean; path: string } | null>;

      // Wayland paste diagnostics
      getYdotoolStatus?: () => Promise<{
        isLinux: boolean;
        isWayland: boolean;
        hasYdotool: boolean;
        hasYdotoold: boolean;
        daemonRunning: boolean;
        hasService: boolean;
        hasUinput: boolean;
        hasUdevRule: boolean;
        hasGroup: boolean;
        isNixOS: boolean;
        allGood: boolean;
      }>;

      // Globe key listener for hotkey capture (macOS only)
      onGlobeKeyPressed?: (callback: () => void) => () => void;
      onGlobeKeyReleased?: (callback: () => void) => () => void;

      // Hotkey registration events
      onHotkeyFallbackUsed?: (
        callback: (data: { original: string; fallback: string }) => void
      ) => () => void;
      onHotkeyRegistrationFailed?: (
        callback: (data: { hotkey: string; error: string; suggestions: string[] }) => void
      ) => () => void;
      onSettingUpdated?: (callback: (data: { key: string; value: unknown }) => void) => () => void;
      onDictationKeyActive?: (callback: (key: string) => void) => () => void;
      onLinuxPttPermissionDenied?: (callback: () => void) => () => void;

      // Settings shortcut (Cmd+, / Ctrl+,)
      onShowSettings?: (callback: () => void) => () => void;

      // Accessibility permission events (macOS)
      onAccessibilityMissing?: (callback: () => void) => () => void;
      checkAccessibilityTrusted?: () => Promise<boolean>;

      // Gemini API key management
      getGeminiKey: () => Promise<string | null>;
      saveGeminiKey: (key: string) => Promise<void>;

      // Groq API key management
      getGroqKey: () => Promise<string | null>;
      saveGroqKey: (key: string) => Promise<void>;
      getOpenrouterKey: () => Promise<string | null>;
      saveOpenrouterKey: (key: string) => Promise<void>;

      // xAI API key management
      getXaiKey?: () => Promise<string | null>;
      saveXaiKey?: (key: string) => Promise<void>;
      proxyXaiTranscription?: (data: {
        audioBuffer: ArrayBuffer;
        language?: string;
        keyterms?: string[];
      }) => Promise<ProxyTranscriptionResult>;

      // Mistral API key management
      getMistralKey: () => Promise<string | null>;
      saveMistralKey: (key: string) => Promise<void>;
      proxyMistralTranscription: (data: {
        audioBuffer: ArrayBuffer;
        model?: string;
        language?: string;
        contextBias?: string[];
      }) => Promise<ProxyTranscriptionResult>;

      // Corti credential management
      getCortiClientId?: () => Promise<string | null>;
      saveCortiClientId?: (key: string) => Promise<void>;
      getCortiClientSecret?: () => Promise<string | null>;
      saveCortiClientSecret?: (key: string) => Promise<void>;
      getCortiKey?: () => Promise<string | null>;
      saveCortiKey?: (key: string) => Promise<void>;
      proxyCortiTranscription?: (data: {
        audioBuffer: ArrayBuffer;
        language: string;
        environment: string;
        tenant: string;
      }) => Promise<ProxyTranscriptionResult>;
      getTinfoilKey?: () => Promise<string | null>;
      saveTinfoilKey?: (key: string) => Promise<void>;
      getTinfoilChatModels?: () => Promise<TinfoilCatalogModel[]>;
      proxyTinfoilTranscription?: (data: {
        audioBuffer: ArrayBuffer;
        language?: string;
        prompt?: string;
      }) => Promise<ProxyTranscriptionResult>;

      // Custom endpoint API keys
      getCustomTranscriptionKey?: () => Promise<string | null>;
      saveCustomTranscriptionKey?: (key: string) => Promise<void>;
      getCleanupCustomKey?: () => Promise<string | null>;
      saveCleanupCustomKey?: (key: string) => Promise<void>;
      getNoteFormattingCustomKey?: () => Promise<string | null>;
      saveNoteFormattingCustomKey?: (key: string) => Promise<void>;
      getTranslationCustomKey?: () => Promise<string | null>;
      saveTranslationCustomKey?: (key: string) => Promise<void>;
      getDictationAgentCustomKey?: () => Promise<string | null>;
      saveDictationAgentCustomKey?: (key: string) => Promise<void>;
      getDictationAgentVisionCustomKey?: () => Promise<string | null>;
      saveDictationAgentVisionCustomKey?: (key: string) => Promise<void>;
      getChatAgentCustomKey?: () => Promise<string | null>;
      saveChatAgentCustomKey?: (key: string) => Promise<void>;

      // Enterprise provider key persistence
      getBedrockRegion?: () => Promise<string | null>;
      saveBedrockRegion?: (value: string) => Promise<void>;
      getBedrockProfile?: () => Promise<string | null>;
      saveBedrockProfile?: (value: string) => Promise<void>;
      getBedrockAccessKeyId?: () => Promise<string | null>;
      saveBedrockAccessKeyId?: (key: string) => Promise<void>;
      getBedrockSecretAccessKey?: () => Promise<string | null>;
      saveBedrockSecretAccessKey?: (key: string) => Promise<void>;
      getBedrockSessionToken?: () => Promise<string | null>;
      saveBedrockSessionToken?: (key: string) => Promise<void>;
      getAzureEndpoint?: () => Promise<string | null>;
      saveAzureEndpoint?: (value: string) => Promise<void>;
      getAzureApiKey?: () => Promise<string | null>;
      saveAzureApiKey?: (key: string) => Promise<void>;
      getAzureDeployment?: () => Promise<string | null>;
      saveAzureDeployment?: (value: string) => Promise<void>;
      getAzureApiVersion?: () => Promise<string | null>;
      saveAzureApiVersion?: (value: string) => Promise<void>;
      getVertexProject?: () => Promise<string | null>;
      saveVertexProject?: (value: string) => Promise<void>;
      getVertexLocation?: () => Promise<string | null>;
      saveVertexLocation?: (value: string) => Promise<void>;
      getVertexApiKey?: () => Promise<string | null>;
      saveVertexApiKey?: (key: string) => Promise<void>;
      testEnterpriseConnection?: (
        provider: string,
        config: Record<string, unknown>
      ) => Promise<{ success: boolean; error?: string; action?: string; copyCommand?: string }>;
      // Dictation key persistence (file-based for reliable startup)
      getDictationKey?: () => Promise<string | null>;
      getActiveDictationKey?: () => Promise<string>;
      getEffectiveDefaultHotkey?: () => Promise<string>;
      saveDictationKey?: (key: string) => Promise<void>;

      // Activation mode persistence (file-based for reliable startup)
      getActivationMode?: () => Promise<"tap" | "push">;
      saveActivationMode?: (mode: "tap" | "push") => Promise<void>;

      // Debug logging
      getLogLevel?: () => Promise<string>;
      log?: (entry: {
        level: string;
        message: string;
        meta?: any;
        scope?: string;
        source?: string;
      }) => Promise<void>;
      getDebugState: () => Promise<{
        enabled: boolean;
        logPath: string | null;
        logLevel: string;
      }>;
      setDebugLogging: (enabled: boolean) => Promise<{
        success: boolean;
        enabled?: boolean;
        logPath?: string | null;
        error?: string;
      }>;
      openLogsFolder: () => Promise<{ success: boolean; error?: string }>;

      // FFmpeg availability
      checkFFmpegAvailability: () => Promise<FFmpegAvailabilityResult>;
      getAudioDiagnostics: () => Promise<AudioDiagnosticsResult>;

      // System settings helpers
      requestMicrophoneAccess?: () => Promise<{ granted: boolean }>;
      checkMicrophoneAccess?: () => Promise<{ granted: boolean; status: string }>;
      checkSystemAudioAccess?: () => Promise<SystemAudioAccessResult>;
      requestSystemAudioAccess?: () => Promise<SystemAudioAccessResult>;
      openMicrophoneSettings?: () => Promise<{ success: boolean; error?: string }>;
      openSoundInputSettings?: () => Promise<{ success: boolean; error?: string }>;
      openAccessibilitySettings?: () => Promise<{ success: boolean; error?: string }>;
      openSystemAudioSettings?: () => Promise<{ success: boolean; error?: string }>;
      openScreenRecordingSettings?: () => Promise<{ success: boolean; error?: string }>;
      openLoginItemsSettings?: () => Promise<{ success: boolean; error?: string }>;
      checkScreenRecordingAccess?: () => Promise<ScreenRecordingAccessResult>;
      requestScreenRecordingAccess?: () => Promise<ScreenRecordingAccessResult>;
      captureScreenContext?: () => Promise<ScreenContextImage | null>;
      setScreenContextEnabled?: (enabled: boolean) => Promise<{ success: boolean }>;
      showEmojiPanel?: () => Promise<boolean>;
      toggleMediaPlayback?: () => Promise<boolean>;
      pauseMediaPlayback?: () => Promise<boolean>;
      resumeMediaPlayback?: () => Promise<boolean>;
      openWhisperModelsFolder?: () => Promise<{ success: boolean; error?: string }>;

      // Windows Push-to-Talk notifications
      notifyActivationModeChanged?: (mode: "tap" | "push") => void;
      notifyHotkeyChanged?: (hotkey: string) => void;
      registerMeetingHotkey?: (hotkey: string) => Promise<{ success: boolean; message?: string }>;
      notifyFloatingIconAutoHideChanged?: (enabled: boolean) => void;
      onFloatingIconAutoHideChanged?: (callback: (enabled: boolean) => void) => () => void;
      notifyStartMinimizedChanged?: (enabled: boolean) => void;
      notifyPanelStartPositionChanged?: (position: string) => void;

      // Auto-start at login. requiresApproval is macOS-only: SMAppService can
      // register the login item and still leave it awaiting approval in System
      // Settings, which otherwise looks like a toggle that will not stick.
      getAutoStartEnabled?: () => Promise<{ enabled: boolean; requiresApproval: boolean }>;
      setAutoStartEnabled?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;

      // BYOK audio file transcription
      transcribeAudioFileByok?: (options: {
        filePath: string;
        apiKey: string;
        baseUrl: string;
        model: string;
        diarize?: boolean;
        provider?: string;
        language?: string;
        environment?: string;
        tenant?: string;
        transcriptionMode?: string;
        remoteTranscriptionUrl?: string;
        remoteTranscriptionModel?: string;
      }) => Promise<{
        success: boolean;
        text?: string;
        error?: string;
        diarized?: boolean;
      }>;

      // AssemblyAI Streaming
      assemblyAiStreamingWarmup?: (options?: { sampleRate?: number; language?: string }) => Promise<
        {
          success: boolean;
          alreadyWarm?: boolean;
        } & PolicyFailureMetadata
      >;
      assemblyAiStreamingStart?: (options?: { sampleRate?: number; language?: string }) => Promise<
        {
          success: boolean;
          usedWarmConnection?: boolean;
        } & PolicyFailureMetadata
      >;
      assemblyAiStreamingSend?: (audioBuffer: ArrayBuffer) => void;
      assemblyAiStreamingForceEndpoint?: () => void;
      assemblyAiStreamingStop?: () => Promise<{
        success: boolean;
        text?: string;
        error?: string;
      }>;
      assemblyAiStreamingStatus?: () => Promise<{
        isConnected: boolean;
        sessionId: string | null;
      }>;
      onAssemblyAiPartialTranscript?: (callback: (text: string) => void) => () => void;
      onAssemblyAiFinalTranscript?: (callback: (text: string) => void) => () => void;
      onAssemblyAiError?: (callback: (error: string) => void) => () => void;
      onAssemblyAiSessionEnd?: (
        callback: (data: { audioDuration?: number; text?: string }) => void
      ) => () => void;

      // Agent Mode
      updateAgentHotkey?: (hotkey: string) => Promise<{ success: boolean; message: string }>;
      updateVoiceAgentHotkey?: (hotkey: string) => Promise<{ success: boolean; message: string }>;
      getVoiceAgentKey?: () => Promise<string>;
      updateTranslationHotkey?: (hotkey: string) => Promise<{ success: boolean; message: string }>;
      getTranslationKey?: () => Promise<string>;
      getAgentKey?: () => Promise<string>;
      saveAgentKey?: (key: string) => Promise<void>;
      createAgentConversation?: (
        title: string,
        noteId?: number | null,
        spaceId?: number | null,
        folderId?: number | null
      ) => Promise<{
        id: number;
        title: string;
        note_id?: number | null;
        space_id?: number | null;
        folder_id?: number | null;
        created_at: string;
        updated_at: string;
      } | null>;
      getConversationsForNote?: (
        noteId: number,
        limit?: number
      ) => Promise<
        Array<{
          id: number;
          title: string;
          created_at: string;
          updated_at: string;
          message_count: number;
        }>
      >;
      getConversationsForContainer?: (
        spaceId: number,
        folderId?: number | null,
        limit?: number
      ) => Promise<
        Array<{
          id: number;
          title: string;
          created_at: string;
          updated_at: string;
          message_count: number;
        }>
      >;
      getAgentConversations?: (limit?: number) => Promise<
        Array<{
          id: number;
          title: string;
          archived_at?: string;
          cloud_id?: string;
          client_conversation_id?: string;
          created_at: string;
          updated_at: string;
        }>
      >;
      getAgentConversation?: (id: number) => Promise<{
        id: number;
        title: string;
        archived_at?: string;
        cloud_id?: string;
        created_at: string;
        updated_at: string;
        messages: Array<{
          id: number;
          conversation_id: number;
          role: "user" | "assistant" | "system";
          content: string;
          metadata?: string;
          created_at: string;
        }>;
      } | null>;
      deleteAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      updateAgentConversationTitle?: (id: number, title: string) => Promise<{ success: boolean }>;
      addAgentMessage?: (
        conversationId: number,
        role: "user" | "assistant" | "system",
        content: string,
        metadata?: Record<string, unknown>
      ) => Promise<{
        id: number;
        conversation_id: number;
        role: string;
        content: string;
        metadata?: string;
        created_at: string;
      } | null>;
      getAgentMessages?: (conversationId: number) => Promise<
        Array<{
          id: number;
          conversation_id: number;
          role: "user" | "assistant" | "system";
          content: string;
          metadata?: string;
          created_at: string;
        }>
      >;
      getAgentConversationsWithPreview?: (
        limit?: number,
        offset?: number,
        includeArchived?: boolean
      ) => Promise<ConversationPreview[]>;
      searchAgentConversations?: (query: string, limit?: number) => Promise<ConversationPreview[]>;
      archiveAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      unarchiveAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      updateAgentConversationCloudId?: (
        id: number,
        cloudId: string
      ) => Promise<{ success: boolean }>;
      semanticSearchConversations?: (
        query: string,
        limit?: number
      ) => Promise<ConversationPreview[]>;

      // Deepgram Streaming
      deepgramStreamingWarmup?: (options?: { sampleRate?: number; language?: string }) => Promise<{
        success: boolean;
        alreadyWarm?: boolean;
        error?: string;
        code?: string;
      }>;
      deepgramStreamingStart?: (options?: {
        sampleRate?: number;
        language?: string;
        forceNew?: boolean;
      }) => Promise<
        {
          success: boolean;
          usedWarmConnection?: boolean;
        } & PolicyFailureMetadata
      >;
      deepgramStreamingSend?: (audioBuffer: ArrayBuffer) => void;
      deepgramStreamingFinalize?: () => void;
      deepgramStreamingStop?: () => Promise<{
        success: boolean;
        text?: string;
        error?: string;
      }>;
      deepgramStreamingStatus?: () => Promise<{
        isConnected: boolean;
        sessionId: string | null;
      }>;
      onDeepgramPartialTranscript?: (callback: (text: string) => void) => () => void;
      onDeepgramFinalTranscript?: (callback: (text: string) => void) => () => void;
      onDeepgramError?: (callback: (error: string) => void) => () => void;
      onDeepgramSessionEnd?: (
        callback: (data: { audioDuration?: number; text?: string }) => void
      ) => () => void;

      // Corti streaming (BYOK)
      cortiStreamingWarmup?: (options?: {
        environment?: string;
        tenant?: string;
        language?: string;
        keyterms?: string[];
      }) => Promise<{ success: boolean } & PolicyFailureMetadata>;
      cortiStreamingStart?: (options?: {
        environment?: string;
        tenant?: string;
        language?: string;
        keyterms?: string[];
      }) => Promise<{ success: boolean } & PolicyFailureMetadata>;
      cortiStreamingSend?: (audioBuffer: ArrayBuffer) => void;
      cortiStreamingFinalize?: () => void;
      cortiStreamingStop?: () => Promise<{
        success: boolean;
        text?: string;
        model?: string;
        audioBytesSent?: number;
        error?: string;
      }>;
      cortiStreamingStatus?: () => Promise<{ isConnected: boolean; sessionId: string | null }>;
      onCortiPartialTranscript?: (callback: (text: string) => void) => () => void;
      onCortiFinalTranscript?: (callback: (text: string) => void) => () => void;
      onCortiError?: (callback: (error: string) => void) => () => void;
      onCortiSessionEnd?: (callback: (data: { text?: string }) => void) => () => void;

      // Agent overlay
      resizeAgentWindow?: (width: number, height: number) => Promise<void>;
      getAgentWindowBounds?: () => Promise<{
        x: number;
        y: number;
        width: number;
        height: number;
      } | null>;
      setAgentWindowBounds?: (x: number, y: number, width: number, height: number) => Promise<void>;
      hideAgentOverlay?: () => Promise<void>;
      onAgentStartRecording?: (callback: () => void) => () => void;
      onAgentStopRecording?: (callback: () => void) => () => void;
      onAgentToggleRecording?: (callback: () => void) => () => void;

      // Local agent tools
      agentOpenNote?: (noteId: number) => Promise<{ success: boolean; error?: string }>;
      // Google Calendar
      gcalGetConnectionStatus?: () => Promise<{
        connected: boolean;
        accounts: Array<{ email: string }>;
        email?: string | null;
        source?: string;
        managed?: boolean;
        state?: string;
        lastSyncAt?: string | null;
        lastSuccessfulSyncAt?: string | null;
        error?: { code: string; message: string } | null;
        errorCode?: string | null;
      }>;
      gcalGetCalendars?: () => Promise<{ success: boolean; calendars: any[] }>;
      gcalSyncEvents?: (range?: CalendarRangeRequest) => Promise<{
        success: boolean;
        error?: { code: string; message: string };
      }>;
      gcalListEvents?: (range: CalendarRangeRequest) => Promise<{
        success: boolean;
        range?: CalendarRangeRequest;
        events: CalendarEvent[];
        cached?: boolean;
        refreshing?: boolean;
        tombstones?: Array<{ calendar_id?: string; event_id?: string }>;
        error?: { code: string; message: string };
      }>;
      onGcalConnectionChanged?: (callback: (data: any) => void) => () => void;
      onGcalEventsSynced?: (
        callback: (payload?: {
          provider?: string;
          eventCount?: number;
          success?: boolean;
          errorCode?: string | null;
        }) => void
      ) => () => void;
      gcalGetCalendarStatus?: () => Promise<{
        connected: boolean;
        managed?: boolean;
        source?: string;
        state: string;
        email?: string | null;
        lastSuccessfulSyncAt?: string | null;
        error?: { code: string; message: string } | null;
        errorCode?: string | null;
      }>;
      gcalConnectGoogle?: () => Promise<{
        success: boolean;
        managed?: boolean;
        error?: { code: string; message: string };
      }>;
      gcalGetUpcomingEvents?: (
        windowMinutes?: number
      ) => Promise<{ success: boolean; events: any[] }>;
      gcalGetEvent?: (eventId: string) => Promise<{
        success: boolean;
        event: {
          id: string;
          summary: string | null;
          start_time: string;
          end_time: string;
          attendees_count: number;
          attendees: string | null;
          hangout_link: string | null;
          html_link: string | null;
        } | null;
      }>;
      listPatientRegistry?: (query?: string) => Promise<{
        success: boolean;
        patients: PatientRegistryRecord[];
        error?: { code: string; message: string };
      }>;
      getPatientRegistryPatient?: (patientId: string) => Promise<{
        success: boolean;
        patient: PatientRegistryRecord | null;
        error?: { code: string; message: string };
      }>;
      savePatientRegistryPatient?: (payload: PatientRegistryPayload) => Promise<{
        success: boolean;
        patient: PatientRegistryRecord | null;
        error?: { code: string; message: string };
      }>;
      getPatientEncounterHistory?: (patientId: string, limit?: number) => Promise<{
        success: boolean;
        encounters: PatientEncounterHistoryItem[];
        error?: { code: string; message: string };
      }>;
      getPatientMergeCandidates?: (patientId: string) => Promise<{
        success: boolean;
        patients: PatientRegistryRecord[];
        error?: { code: string; message: string };
      }>;
      mergePatientRegistryPatients?: (payload: {
        survivorPatientId: string;
        duplicatePatientId: string;
        phone?: string | null;
        email?: string | null;
      }) => Promise<{
        success: boolean;
        patient: PatientRegistryRecord | null;
        error?: { code: string; message: string; field?: string; survivorValue?: string | null; duplicateValue?: string | null };
      }>;
      getEncounters?: (limit?: number) => Promise<{
        success: boolean;
        encounters: LocalEncounter[];
        error?: string;
      }>;
      getEncountersInRange?: (range: CalendarRangeRequest) => Promise<{
        success: boolean;
        encounters: LocalEncounter[];
        error?: string;
      }>;
      getEncountersForLocalDay?: (
        dateIso?: string,
        limit?: number
      ) => Promise<{
        success: boolean;
        encounters: LocalEncounter[];
        error?: string;
        code?: string;
      }>;
      getAppointmentActions?: (eventId: string) => Promise<CalendarActionResult>;
      getAppointmentReminderStatuses?: (eventIds: string[]) => Promise<{
        success: boolean;
        statuses?: Record<string, { email: boolean; sms: boolean }>;
        error?: { code: string; message: string };
      }>;
      sendAppointmentEmail?: (eventId: string) => Promise<CalendarActionResult>;
      sendAppointmentSms?: (eventId: string) => Promise<CalendarActionResult>;
      renameAppointment?: (input: {
        eventId: string;
        summary: string;
        calendarId?: string;
      }) => Promise<CalendarActionResult>;
      cancelAppointment?: (input: {
        eventId: string;
        confirmed?: boolean;
        calendarId?: string;
      }) => Promise<CalendarActionResult>;
      rescheduleAppointment?: (input: {
        eventId: string;
        newStartIso: string;
        confirmed?: boolean;
      }) => Promise<CalendarActionResult>;
      getReceptionistConfig?: () => Promise<{
        success: boolean;
        config: Record<string, unknown> | null;
        error?: { code: string; message: string };
      }>;
      saveReceptionistConfig?: (config: Record<string, unknown>) => Promise<{
        success: boolean;
        config: Record<string, unknown> | null;
        requiresRestart?: boolean;
        error?: { code: string; message: string };
      }>;
      getMessageConfig?: () => Promise<{
        success: boolean;
        config: Record<string, unknown> | null;
        error?: { code: string; message: string };
      }>;
      saveMessageConfig?: (config: Record<string, unknown>) => Promise<{
        success: boolean;
        config: Record<string, unknown> | null;
        error?: { code: string; message: string };
      }>;
      getPostAppointmentWorkspace?: () => Promise<{
        success: boolean;
        config: Record<string, unknown> | null;
        error?: { code: string; message: string };
      }>;
      savePostAppointmentConfig?: (config: Record<string, unknown>) => Promise<{
        success: boolean;
        config: Record<string, unknown> | null;
        error?: { code: string; message: string };
      }>;
      getEmailSetup?: () => Promise<{
        success: boolean;
        config: Record<string, unknown> | null;
        error?: { code: string; message: string };
      }>;
      saveEmailSetup?: (config: Record<string, unknown>) => Promise<{
        success: boolean;
        config: Record<string, unknown> | null;
        error?: { code: string; message: string };
      }>;
      getEncounter?: (encounterId: number) => Promise<{
        success: boolean;
        encounter: LocalEncounter | null;
        error?: string;
        code?: string;
      }>;
      getEncounterByNote?: (noteId: number) => Promise<{
        success: boolean;
        encounter: LocalEncounter | null;
        error?: string;
        code?: string;
      }>;
      getEncountersNeedingOutputGeneration?: (limit?: number) => Promise<{
        success: boolean;
        encounters: LocalEncounter[];
        error?: string;
        code?: string;
      }>;
      startEncounter?: (
        eventId: string,
        options?: { meetingContext?: MeetingContext }
      ) => Promise<{
        success: boolean;
        encounter?: LocalEncounter;
        note?: { id: number; folder_id: number | null };
        patient_id?: string | null;
        appointment_id?: string | null;
        createdNote?: boolean;
        error?: string;
        code?: string;
      }>;
      getEncounterOutput?: (encounterId: number) => Promise<{
        success: boolean;
        output: EncounterOutput | null;
        error?: string;
        code?: string;
      }>;
      beginEncounterOutputGeneration?: (
        encounterId: number,
        outputTypes?: EncounterOutputType | Array<Exclude<EncounterOutputType, "all">>
      ) => Promise<{
        success: boolean;
        output: EncounterOutput | null;
        transcript: string | null;
        token: EncounterTranscriptToken | null;
        busy?: boolean;
        error?: string;
        code?: string;
      }>;
      finishEncounterOutputGeneration?: (
        encounterId: number,
        token: EncounterTranscriptToken,
        updates: EncounterOutputGenerationUpdate
      ) => Promise<{
        success: boolean;
        applied: boolean;
        output: EncounterOutput | null;
        error?: string;
        code?: string;
      }>;
      retryEncounterOutput?: (
        encounterId: number,
        outputType?: EncounterOutputType
      ) => Promise<{
        success: boolean;
        output: EncounterOutput | null;
        error?: string;
        code?: string;
      }>;
      onEncounterOutputRetryRequested?: (
        callback: (payload: { encounterId?: number | null }) => void
      ) => () => void;
      onEncounterOutputUpdated?: (
        callback: (payload: { encounterId?: number | null; applied?: boolean }) => void
      ) => () => void;
      completeEncounterRecording?: (
        noteId: number,
        transcript: string
      ) => Promise<{
        success: boolean;
        note?: NoteItem;
        encounter?: LocalEncounter | null;
        output?: EncounterOutput | null;
        error?: string;
        code?: string;
      }>;
      aiReceptionistGetStatus?: () => Promise<{
        available: boolean;
        sourceAvailable?: boolean;
        runtimeAvailable?: boolean;
        seedAvailable?: boolean;
        bundledPythonAvailable?: boolean | null;
        mode?: string;
        error?: { code: string; message: string };
        agent?: {
          enabled: boolean;
          running: boolean;
          pid?: number | null;
          state: string;
          message?: string;
          errorCode?: string | null;
        };
      }>;
      aiReceptionistStart?: (options?: { playgroundMode?: boolean }) => Promise<{
        ok: boolean;
        pid?: number | null;
        error?: { code?: string; message?: string };
      }>;
      aiReceptionistStop?: () => Promise<{
        ok: boolean;
        stopped?: boolean;
        error?: { code?: string; message?: string };
      }>;

      // Contacts
      searchContacts: (query: string) => Promise<{
        success: boolean;
        contacts: Array<{ email: string; display_name: string | null }>;
      }>;
      upsertContact: (contact: {
        email: string;
        displayName?: string | null;
      }) => Promise<{ success: boolean }>;
      getMD5Hash: (text: string) => Promise<string>;

      // Meeting transcription (streaming, dual-channel)
      meetingTranscriptionPrepare?: (options: {
        provider?: string;
        model?: string;
        language?: string;
        meetingContext?: MeetingContext;
      }) => Promise<{ success: boolean; alreadyPrepared?: boolean } & PolicyFailureMetadata>;
      meetingTranscriptionStart?: (options: {
        provider?: string;
        model?: string;
        language?: string;
        noteId?: number | null;
        meetingContext?: MeetingContext;
      }) => Promise<
        {
          success: boolean;
          reused?: boolean;
          recordingNoteId?: number | null;
          encounterId?: number | null;
          systemAudioMode?: SystemAudioMode;
          systemAudioStrategy?: SystemAudioStrategy;
          oneOnOneAttendee?: { displayName: string; email: string | null } | null;
        } & PolicyFailureMetadata
      >;
      meetingTranscriptionSend?: (buffer: ArrayBuffer, source: "mic" | "system") => void;
      meetingTranscriptionStop?: () => Promise<{
        success: boolean;
        transcript?: string;
        diarizationSessionId?: string;
        error?: string;
      }>;
      meetingTranscriptionCancel?: () => Promise<{
        success: boolean;
        reason?: "recording-active";
      }>;
      onMeetingTranscriptionSegment?: (
        callback: (data: {
          text: string;
          source: "mic" | "system";
          type: "partial" | "final" | "retract";
          timestamp?: number;
        }) => void
      ) => () => void;
      onMeetingSpeakerIdentified?: (
        callback: (data: {
          speakerId: string;

          displayName?: string | null;
          startTime: number;
          endTime: number;
        }) => void
      ) => () => void;
      onMeetingSpeakersMerged?: (
        callback: (
          merges: Array<{
            keep: string;
            remove: string;
            displayName?: string | null;
            similarity: number;
          }>
        ) => void
      ) => () => void;
      onMeetingSessionSpeakerConfigUpdated?: (
        callback: (config: { enabled: boolean; expectedCount: number }) => void
      ) => () => void;
      onMeetingTranscriptionError?: (callback: (error: string) => void) => () => void;
      onMeetingTranscriptionFatalError?: (callback: (error: string) => void) => () => void;

      // Speaker diarization
      downloadDiarizationModels?: () => Promise<{ success: boolean; error?: string }>;
      getDiarizationModelStatus?: () => Promise<{
        available: boolean;
        modelsDownloaded: boolean;
      }>;
      deleteDiarizationModels?: () => Promise<{ success: boolean }>;
      cancelDiarizationDownload?: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;
      mergeSpeakerText?: (
        segments: Array<{ start: number; end: number; speaker: string }>,
        text: string,
        duration: number
      ) => Promise<{ success: boolean; text?: string; error?: string }>;
      diarizeAudioFile?: (
        filePath: string,
        options?: { numSpeakers?: number; threshold?: number }
      ) => Promise<{
        success: boolean;
        segments?: Array<{ start: number; end: number; speaker: string }>;
        error?: string;
      }>;
      onDiarizationDownloadProgress?: (callback: (data: any) => void) => () => void;
      onMeetingDiarizationComplete?: (
        callback: (data: {
          sessionId?: string;
          noteId?: number | null;
          segments: Array<{
            id: string;
            text: string;
            source: "mic" | "system";
            timestamp?: number;
            speaker?: string;
            speakerName?: string;
            speakerIsPlaceholder?: boolean;
            suggestedName?: string;
            suggestedProfileId?: number;
            speakerStatus?: "provisional" | "confirmed" | "suggested" | "locked";
            speakerLocked?: boolean;
            speakerLockSource?: "user" | "diarization" | "suggestion";
          }>;
          speakerEmbeddings?: Record<string, number[]> | null;
          status?: MeetingDiarizationStatus;
          error?: string;
        }) => void
      ) => () => void;

      // Speaker name mapping
      getSpeakerMappings?: (noteId: number) => Promise<
        Array<{
          note_id: number;
          speaker_id: string;
          profile_id: number | null;
          display_name: string;
        }>
      >;
      setSpeakerMapping?: (
        noteId: number,
        speakerId: string,
        displayName: string,
        email?: string | null,
        profileId?: number | null
      ) => Promise<{ success: boolean; profileId: number | null }>;
      removeSpeakerMapping?: (noteId: number, speakerId: string) => Promise<{ success: boolean }>;
      getSpeakerProfiles?: () => Promise<
        Array<{
          id: number;
          display_name: string;
          email: string | null;
          sample_count: number;
          created_at: string;
          updated_at: string;
        }>
      >;
      attachSpeakerEmail?: (
        profileId: number,
        email: string | null
      ) => Promise<{
        success: boolean;
        error?: string;
        profile?: {
          id: number;
          display_name: string;
          email: string | null;
          sample_count: number;
        };
      }>;
      saveNoteSpeakerEmbeddings?: (
        noteId: number,
        embeddings: Record<string, number[]>
      ) => Promise<{ success: boolean }>;

      // Dictation realtime streaming
      dictationRealtimeWarmup?: (options: {
        model?: string;
        mode?: "byok";
      }) => Promise<{ success: boolean } & PolicyFailureMetadata>;
      dictationRealtimeStart?: (options: {
        model?: string;
        mode?: "byok";
      }) => Promise<{ success: boolean } & PolicyFailureMetadata>;
      dictationRealtimeSend?: (buffer: ArrayBuffer) => void;
      dictationRealtimeStop?: () => Promise<{ success: boolean; text: string }>;
      onDictationRealtimePartial?: (callback: (text: string) => void) => () => void;
      onDictationRealtimeFinal?: (callback: (text: string) => void) => () => void;
      onDictationRealtimeError?: (callback: (error: string) => void) => () => void;
      onDictationRealtimeSessionEnd?: (callback: (data: { text: string }) => void) => () => void;

      // Microsoft Calendar
      mcalStartOAuth?: () => Promise<{ success: boolean; email?: string; error?: string }>;
      mcalDisconnect?: (email?: string) => Promise<{ success: boolean; error?: string }>;
      mcalGetConnectionStatus?: () => Promise<{
        connected: boolean;
        accounts: Array<{ email: string }>;
      }>;
      mcalSetPrimaryOnly?: (value: boolean) => Promise<{ success: boolean; error?: string }>;
      onMcalConnectionChanged?: (callback: (data: any) => void) => () => void;
      onMcalEventsSynced?: (callback: (data: any) => void) => () => void;

      // Apple Calendar (macOS EventKit)
      acalConnect?: () => Promise<{ success: boolean; reason?: string; error?: string }>;
      acalDisconnect?: () => Promise<{ success: boolean; error?: string }>;
      acalGetConnectionStatus?: () => Promise<{ connected: boolean; sourceNames: string[] }>;
      openCalendarPrivacySettings?: () => Promise<{ success: boolean; error?: string }>;
      onAcalConnectionChanged?: (
        callback: (data: { connected: boolean; sourceNames: string[] }) => void
      ) => () => void;
      onAcalEventsSynced?: (callback: (data: any) => void) => () => void;

      meetingDetectionGetPreferences?: () => Promise<{ success: boolean; preferences?: any }>;
      meetingDetectionSetPreferences?: (
        prefs: Record<string, boolean>
      ) => Promise<{ success: boolean }>;
      syncNotificationPreferences?: (
        prefs: Record<string, boolean>
      ) => Promise<{ success: boolean }>;
      setSpeakerDiarizationEnabled?: (
        enabled: boolean
      ) => Promise<{ success: boolean; error?: string }>;
      setMeetingSessionSpeakerConfig?: (config: {
        enabled: boolean;
        expectedCount: number;
        countIsExplicit?: boolean;
      }) => Promise<{ success: boolean; error?: string }>;
      getWhisperVadConfig?: () => Promise<{
        success: boolean;
        config?: {
          dictationSileroEnabled: boolean;
          noteRecordingSileroEnabled: boolean;
          meetingSileroEnabled: boolean;
          threshold: number;
          minSpeechDurationMs: number;
          minSilenceDurationMs: number;
          maxSpeechDurationS: number;
          speechPadMs: number;
          samplesOverlap: number;
        };
        error?: string;
      }>;
      setWhisperVadConfig?: (config: {
        dictationSileroEnabled?: boolean;
        noteRecordingSileroEnabled?: boolean;
        meetingSileroEnabled?: boolean;
        threshold?: number;
        minSpeechDurationMs?: number;
        minSilenceDurationMs?: number;
        maxSpeechDurationS?: number;
        speechPadMs?: number;
        samplesOverlap?: number;
      }) => Promise<{ success: boolean; config?: Record<string, unknown>; error?: string }>;
      onMeetingNotificationData?: (callback: (data: any) => void) => () => void;
      getMeetingNotificationData?: () => Promise<any>;
      meetingNotificationReady?: () => Promise<void>;
      meetingNotificationRespond?: (
        detectionId: string,
        action: string
      ) => Promise<{ success: boolean }>;
      joinCalendarMeeting?: (
        eventId: string,
        options?: { meetingContext?: MeetingContext }
      ) => Promise<{
        success: boolean;
        encounter?: LocalEncounter;
        note?: { id: number; folder_id: number | null };
        createdNote?: boolean;
        error?: string;
      }>;
      getPendingMeetingNoteNavigation?: () => Promise<{
        noteId: number;
        folderId: number;
        event: any;
        trigger?: "hotkey" | "manual" | "calendar-join";
      } | null>;
      onMeetingNoteNavigationPending?: (callback: () => void) => () => void;
      getPendingNoteNavigation?: () => Promise<{
        noteId: number;
        folderId: number | null;
      } | null>;
      onNoteNavigationPending?: (callback: () => void) => () => void;
      onUpdateNotificationData?: (
        callback: (data: { version: string; releaseDate?: string }) => void
      ) => () => void;
      getUpdateNotificationData?: () => Promise<{
        version: string;
        releaseDate?: string;
      } | null>;
      updateNotificationReady?: () => Promise<void>;
      updateNotificationRespond?: (action: string) => Promise<{ success: boolean }>;
      onPreviewText?: (callback: (text: string) => void) => () => void;
      onPreviewAppend?: (callback: (text: string) => void) => () => void;
      onPreviewHold?: (callback: (payload: { showCleanup: boolean }) => void) => () => void;
      onPreviewResult?: (callback: (payload: { text: string }) => void) => () => void;
      onPreviewHide?: (callback: () => void) => () => void;
      startDictationPreview?: (opts: {
        provider: string;
        model: string;
        language?: string;
        display?: boolean;
      }) => Promise<{ success: boolean }>;
      stopDictationPreview?: (opts?: {
        showCleanup?: boolean;
        flushed?: boolean;
      }) => Promise<{ success: boolean; streamed?: boolean; text?: string }>;
      dismissDictationPreview?: () => Promise<{ success: boolean }>;
      completeDictationPreview?: (payload: { text?: string }) => Promise<{ success: boolean }>;
      hideDictationPreview?: () => Promise<{ success: boolean }>;
      resizeTranscriptionPreviewWindow?: (
        width: number,
        height: number
      ) => Promise<{
        success: boolean;
        bounds?: { x: number; y: number; width: number; height: number };
      }>;
      sendDictationPreviewAudio?: (data: ArrayBuffer) => void;
    };
    api?: {
      sendDebugLog: (message: string) => void;
    };
  }
}
