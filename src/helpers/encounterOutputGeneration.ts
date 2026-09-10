import type {
  EncounterOutput,
  EncounterOutputErrorCode,
  EncounterOutputGenerationUpdate,
  EncounterOutputGenerationProgress,
  EncounterOutputType,
  EncounterTranscriptToken,
} from "../types/electron";
import {
  generateClinicalOutputs,
  getClinicalGenerationConfig,
  isTransientGenerationError,
  type ClinicalGenerationProgress,
  type ClinicalOutputResult,
  type ClinicalOutputsResult,
} from "./clinicalOutputGeneration";
import {
  CLINICAL_EVIDENCE_SCHEMA_VERSION,
  type ClinicalEvidenceChunk,
  type ClinicalEvidenceV1,
} from "./clinicalEvidence";

const MAX_AUTOMATIC_RETRIES = 2;
const AUTOMATIC_RETRY_DELAYS_MS = [5_000, 30_000];

export interface EncounterOutputGenerationBridge {
  beginEncounterOutputGeneration?: (
    encounterId: number,
    outputTypes?: EncounterOutputType | Array<Exclude<EncounterOutputType, "all">>
  ) => Promise<{
    success?: boolean;
    output: EncounterOutput | null;
    transcript: string | null;
    sourceText?: string | null;
    token: EncounterTranscriptToken | null;
    busy?: boolean;
  }>;
  finishEncounterOutputGeneration?: (
    encounterId: number,
    token: EncounterTranscriptToken,
    updates: EncounterOutputGenerationUpdate
  ) => Promise<{
    success?: boolean;
    applied: boolean;
    output: EncounterOutput | null;
  }>;
  updateEncounterOutputGenerationProgress?: (
    encounterId: number,
    token: EncounterTranscriptToken,
    progress: EncounterOutputGenerationProgress
  ) => Promise<{
    success?: boolean;
    applied: boolean;
    output: EncounterOutput | null;
  }>;
  retryEncounterOutput?: (
    encounterId: number,
    outputType?: EncounterOutputType
  ) => Promise<{
    success?: boolean;
    output: EncounterOutput | null;
  }>;
  getEncounterEvidenceBundle?: (
    encounterId: number,
    input: { sourceRevision: number; sourceHash: string; schemaVersion: number; modelId: string }
  ) => Promise<{
    success: boolean;
    bundle: {
      chunks: Array<{
        chunk_index: number;
        chunk_count: number;
        chunk_hash: string;
        evidence: ClinicalEvidenceChunk;
      }>;
      mergedEvidence: ClinicalEvidenceV1 | null;
    } | null;
  }>;
  saveEncounterEvidenceChunk?: (
    encounterId: number,
    token: EncounterTranscriptToken,
    input: {
      schemaVersion: number;
      modelId: string;
      chunkIndex: number;
      chunkCount: number;
      chunkHash: string;
      evidence: ClinicalEvidenceChunk;
    }
  ) => Promise<{ applied: boolean }>;
  completeEncounterEvidence?: (
    encounterId: number,
    token: EncounterTranscriptToken,
    input: { schemaVersion: number; modelId: string; evidence: ClinicalEvidenceV1 }
  ) => Promise<{ applied: boolean }>;
}

export type EncounterOutputGenerationOutcome = {
  status: "applied" | "failed" | "superseded" | "busy";
  output: EncounterOutput | null;
  retryable?: boolean;
  retryAt?: string | null;
};

function retryMetadata(retryable: boolean, attempt: number): EncounterOutputGenerationUpdate {
  if (!retryable || attempt <= 0 || attempt > MAX_AUTOMATIC_RETRIES) {
    return {
      generation_phase: null,
      generation_next_retry_at: null,
    };
  }
  const delay = AUTOMATIC_RETRY_DELAYS_MS[Math.min(attempt - 1, AUTOMATIC_RETRY_DELAYS_MS.length - 1)];
  return {
    generation_phase: "retrying",
    generation_next_retry_at: new Date(Date.now() + delay).toISOString(),
  };
}

function resultRetryable(result: ClinicalOutputsResult): boolean {
  const failures = [result.summary, result.soap, result.focus].filter(
    (output): output is Extract<ClinicalOutputResult, { success: false }> => !output.success
  );
  return failures.length > 0 && failures.every((output) => output.retryable === true);
}

function outputUpdates(result: ClinicalOutputsResult, attempt: number): EncounterOutputGenerationUpdate {
  const errorCode = (output: ClinicalOutputResult): EncounterOutputErrorCode | null =>
    "errorCode" in output ? output.errorCode : null;
  const retryable = resultRetryable(result);
  return {
    summary: result.summary.success ? result.summary.content : null,
    summary_status: result.summary.success ? "ready" : "failed",
    summary_provider: result.summary.success ? result.summary.provider : null,
    summary_model: result.summary.success ? result.summary.model : null,
    summary_error_code: errorCode(result.summary),
    soap: result.soap.success ? result.soap.content : null,
    soap_status: result.soap.success ? "ready" : "failed",
    soap_provider: result.soap.success ? result.soap.provider : null,
    soap_model: result.soap.success ? result.soap.model : null,
    soap_error_code: errorCode(result.soap),
    focus: result.focus.success ? result.focus.content : null,
    focus_status: result.focus.success ? "ready" : "failed",
    focus_provider: result.focus.success ? result.focus.provider : null,
    focus_model: result.focus.success ? result.focus.model : null,
    focus_error_code: errorCode(result.focus),
    generation_last_error_code: errorCode(result.summary) || errorCode(result.soap) || errorCode(result.focus),
    ...retryMetadata(retryable, attempt),
  };
}

function failedOutputUpdates(error: unknown, attempt: number): EncounterOutputGenerationUpdate {
  const retryable = isTransientGenerationError(error);
  return {
    summary: null,
    summary_status: "failed",
    summary_error_code: "GENERATION_FAILED",
    soap: null,
    soap_status: "failed",
    soap_error_code: "GENERATION_FAILED",
    focus: null,
    focus_status: "failed",
    focus_error_code: "GENERATION_FAILED",
    generation_last_error_code: "GENERATION_FAILED",
    ...retryMetadata(retryable, attempt),
  };
}

function asProgress(progress: ClinicalGenerationProgress): EncounterOutputGenerationProgress {
  return {
    phase: progress.phase,
    current: Math.max(0, Math.floor(progress.current)),
    total: Math.max(0, Math.floor(progress.total)),
  };
}

export async function runEncounterOutputGeneration(
  bridge: EncounterOutputGenerationBridge,
  encounterId: number,
  force: boolean,
  generate: (
    transcript: string,
    options?: {
      onProgress?: (progress: ClinicalGenerationProgress) => void;
      reusableEvidenceChunks?: Array<{
        chunk_index: number;
        chunk_count: number;
        chunk_hash: string;
        evidence: ClinicalEvidenceChunk;
      }>;
      onEvidenceChunk?: (
        chunk: ClinicalEvidenceChunk,
        metadata: { chunkIndex: number; chunkCount: number; chunkHash: string }
      ) => void | Promise<void>;
      onEvidenceReady?: (evidence: ClinicalEvidenceV1) => void | Promise<void>;
      queuePriority?: number;
    }
  ) => Promise<ClinicalOutputsResult> = generateClinicalOutputs,
  onBegin?: (output: EncounterOutput) => void,
  onProgress?: (progress: ClinicalGenerationProgress) => void,
  queuePriority = -10
): Promise<EncounterOutputGenerationOutcome> {
  if (!bridge.beginEncounterOutputGeneration || !bridge.finishEncounterOutputGeneration) {
    throw new Error("Encounter output generation unavailable");
  }

  if (force && bridge.retryEncounterOutput) {
    const retried = await bridge.retryEncounterOutput(encounterId, "all");
    if (!retried.success || !retried.output) throw new Error("Encounter retry unavailable");
  }

  const begun = await bridge.beginEncounterOutputGeneration(encounterId, "all");
  if (begun.busy) {
    return { status: "busy", output: begun.output };
  }
  if (!begun.success || !begun.output || !begun.token || typeof begun.transcript !== "string") {
    throw new Error("Encounter output unavailable");
  }
  onBegin?.(begun.output);

  let latestProgress: EncounterOutputGenerationProgress = {
    phase: "mapping",
    current: 0,
    total: 0,
  };
  let lastPersistedAt = 0;
  let progressWrite: Promise<unknown> | null = null;
  const publishProgress = (progress: ClinicalGenerationProgress, forcePersist = false) => {
    latestProgress = asProgress(progress);
    onProgress?.(progress);
    if (!bridge.updateEncounterOutputGenerationProgress) return;
    const now = Date.now();
    if (!forcePersist && now - lastPersistedAt < 750) return;
    lastPersistedAt = now;
    const write = bridge
      .updateEncounterOutputGenerationProgress(encounterId, begun.token!, latestProgress)
      .catch(() => undefined);
    progressWrite = write;
    void write.finally(() => {
      if (progressWrite === write) progressWrite = null;
    });
  };
  const heartbeat = setInterval(() => {
    if (!bridge.updateEncounterOutputGenerationProgress || progressWrite) return;
    lastPersistedAt = Date.now();
    const write = bridge
      .updateEncounterOutputGenerationProgress(encounterId, begun.token!, latestProgress)
      .catch(() => undefined);
    progressWrite = write;
    void write.finally(() => {
      if (progressWrite === write) progressWrite = null;
    });
  }, 30_000);

  let generated: ClinicalOutputsResult;
  try {
    const sourceText = begun.sourceText?.trim() || begun.transcript.trim();
    if (!sourceText) throw new Error("Encounter transcript unavailable");
    const modelId = getClinicalGenerationConfig().model?.trim() || "";
    const cached =
      modelId && bridge.getEncounterEvidenceBundle
        ? await bridge.getEncounterEvidenceBundle(encounterId, {
            sourceRevision: begun.token.sourceRevision,
            sourceHash: begun.token.sourceHash,
            schemaVersion: CLINICAL_EVIDENCE_SCHEMA_VERSION,
            modelId,
          })
        : null;
    publishProgress({ phase: "mapping", current: 0, total: 0 }, true);
    generated = await generate(sourceText, {
      queuePriority,
      onProgress: (progress) => publishProgress(progress),
      reusableEvidenceChunks: cached?.bundle?.chunks ?? [],
      onEvidenceChunk:
        modelId && bridge.saveEncounterEvidenceChunk
          ? async (chunk, metadata) => {
              const saved = await bridge.saveEncounterEvidenceChunk!(encounterId, begun.token!, {
                schemaVersion: CLINICAL_EVIDENCE_SCHEMA_VERSION,
                modelId,
                ...metadata,
                evidence: chunk,
              });
              if (!saved.applied) throw Object.assign(new Error("Source changed"), { code: "SOURCE_CHANGED" });
            }
          : undefined,
      onEvidenceReady:
        modelId && bridge.completeEncounterEvidence
          ? async (evidence) => {
              const saved = await bridge.completeEncounterEvidence!(encounterId, begun.token!, {
                schemaVersion: CLINICAL_EVIDENCE_SCHEMA_VERSION,
                modelId,
                evidence,
              });
              if (!saved.applied) throw Object.assign(new Error("Source changed"), { code: "SOURCE_CHANGED" });
            }
          : undefined,
    });
  } catch (error) {
    clearInterval(heartbeat);
    const failed = await bridge.finishEncounterOutputGeneration(
      encounterId,
      begun.token,
      failedOutputUpdates(error, Number(begun.output.generation_attempt) || 1)
    );
    if (!failed.success) throw error;
    const retryAt = failed.output?.generation_next_retry_at ?? null;
    return {
      status: failed.applied ? "failed" : "superseded",
      output: failed.output,
      retryable: isTransientGenerationError(error),
      retryAt,
    };
  }

  clearInterval(heartbeat);
  if (progressWrite) await progressWrite;
  const finished = await bridge.finishEncounterOutputGeneration(
    encounterId,
    begun.token,
    outputUpdates(generated, Number(begun.output.generation_attempt) || 1)
  );
  if (!finished.success) throw new Error("Encounter output unavailable");
  const retryable = resultRetryable(generated);
  return {
    status: finished.applied ? "applied" : "superseded",
    output: finished.output,
    retryable,
    retryAt: finished.output?.generation_next_retry_at ?? null,
  };
}
