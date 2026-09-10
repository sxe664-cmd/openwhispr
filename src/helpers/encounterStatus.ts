import type { EncounterOutput, EncounterOutputStatus } from "../types/electron";
import type { TranscriptPersistenceStatus } from "../stores/meetingRecordingStore";

export type StageStatus =
  | "idle"
  | "queued"
  | "active"
  | "retrying"
  | "ready"
  | "skipped"
  | "failed"
  | "stale";

export function isTranscriptPersistenceBusy(
  transcriptStatus: TranscriptPersistenceStatus,
  isProcessingTranscript = false
): boolean {
  return isProcessingTranscript || ["recording", "finalizing", "saving"].includes(transcriptStatus);
}

export function outputStatus(output: EncounterOutput | null): StageStatus {
  if (!output) return "idle";
  if (output.generation_phase === "retrying") return "retrying";
  const statuses = [output.summary_status, output.soap_status, output.focus_status];
  if (statuses.every((status) => status === "ready")) return "ready";
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "processing")) return "active";
  if (statuses.some((status) => status === "stale")) return "stale";
  if (statuses.some((status) => status === "pending")) return "queued";
  return "idle";
}

export function transcriptStageStatus(output: {
  hasTranscript: boolean;
  isRecording: boolean;
  isProcessingTranscript: boolean;
  transcriptStatus: TranscriptPersistenceStatus;
}): StageStatus {
  const { hasTranscript, isRecording, isProcessingTranscript, transcriptStatus } = output;
  if (isRecording || isTranscriptPersistenceBusy(transcriptStatus, isProcessingTranscript)) {
    return "active";
  }
  if (transcriptStatus === "failed") return "failed";
  return hasTranscript || transcriptStatus === "ready" ? "ready" : "idle";
}

export function clinicalStatus(
  output: EncounterOutput | null,
  options: { hasTranscript: boolean; transcriptBusy: boolean; diarizationBusy: boolean }
): StageStatus {
  if (!options.hasTranscript || options.transcriptBusy || options.diarizationBusy) return "idle";
  return outputStatus(output);
}

export function clinicalOutputStatusCopyKey(
  status: EncounterOutputStatus | null,
  options: {
    hasTranscript: boolean;
    isRecording: boolean;
    isProcessingTranscript: boolean;
    transcriptStatus: TranscriptPersistenceStatus;
    separating: boolean;
    generating: boolean;
    generationPhase?: "mapping" | "synthesizing" | "retrying" | null;
  }
): string {
  if (options.isRecording) return "notes.editor.clinicalOutputs.recording";
  if (options.transcriptStatus === "finalizing") {
    return "notes.editor.processingStatus.finalizingTranscript";
  }
  if (options.transcriptStatus === "saving") {
    return "notes.editor.processingStatus.savingTranscript";
  }
  if (options.isProcessingTranscript) return "notes.editor.clinicalOutputs.processingTranscript";
  if (options.separating) return "notes.editor.clinicalOutputs.separatingSpeakers";
  if (!options.hasTranscript) return "notes.editor.processingStatus.waitingForTranscript";
  if (options.generationPhase === "retrying") {
    return "notes.editor.processingStatus.retryingClinicalNotes";
  }
  if (options.generationPhase === "mapping") {
    return "notes.editor.processingStatus.generatingProgress";
  }
  if (options.generationPhase === "synthesizing") {
    return "notes.editor.processingStatus.finalizingClinicalNotes";
  }
  if (options.generating || status === "processing") {
    return "notes.editor.clinicalOutputs.generatingNotes";
  }
  if (status === "pending") return "notes.editor.processingStatus.queued";
  if (status === "stale") return "notes.editor.processingStatus.needsRegeneration";
  if (status === "failed") return "notes.editor.processingStatus.failedClinicalNotes";
  if (status === "ready") return "notes.editor.processingStatus.readyClinicalNotes";
  return "notes.editor.processingStatus.waitingForTranscript";
}
