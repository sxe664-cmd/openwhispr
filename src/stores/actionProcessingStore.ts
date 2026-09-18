import { create } from "zustand";
import reasoningService from "../services/ReasoningService";
import { guardLocalRequest, splitGenerationSource } from "../helpers/localGenerationBudget";
import { prepareNoteGenerationSource } from "../helpers/prepareNoteGenerationSource";
import { getSettings, selectResolvedNoteFormatting } from "./settingsStore";
import { appendDictionarySuffix } from "../config/prompts";
import { generateNoteTitle } from "../utils/generateTitle";
import { buildNoteFormattingOverrides } from "../helpers/noteFormattingOverrides";
import {
  generateLocalGenericNotes,
  type LocalNoteGenerationProgress,
} from "../helpers/localNoteGeneration";
import {
  buildClinicalEncounterActionRequest,
  buildClinicalEncounterCompactActionRequest,
  compileClinicalEncounterMarkdown,
  mergeClinicalEncounterCompactExtractions,
  parseClinicalEncounterCompactOutput,
  parseClinicalEncounterOutput,
  validateClinicalEncounterTemplateText,
  type ClinicalEncounterCompactExtraction,
} from "../services/clinicalEncounterTemplateEngine";
import {
  CLINICAL_EVIDENCE_SCHEMA_VERSION,
  serializeClinicalEvidence,
  type ClinicalEvidenceChunk,
  type ClinicalEvidenceV1,
} from "../helpers/clinicalEvidence";
import { generateStructuredClinicalNote } from "../helpers/structuredTemplateGeneration";
import { migrateLegacyNoteTemplate, validateStructuredNoteTemplate, type StructuredNoteTemplate } from "../helpers/structuredNoteTemplate.mjs";
import type { ActionItem, NoteGenerationCandidate, NoteItem } from "../types/electron";

export type ActionProcessingStatus = "idle" | "processing" | "retrying" | "success" | "failed";

export type ActionProcessingProgress = {
  stage:
    | "preparing"
    | "extracting"
    | "synthesizing"
    | "retrying"
    | "applying"
    | "compiling"
    | "generating";
  current: number;
  total: number;
};

export interface NoteActionState {
  status: ActionProcessingStatus;
  actionName: string | null;
  isBuiltInAction: boolean;
  progress: ActionProcessingProgress | null;
  startedAt: number | null;
  errorMessage?: string | null;
}

export interface ActionErrorEvent {
  noteId: number;
  message: string;
}

export type ActionLifecycleOutcome = "success" | "cancelled" | "failed";

export interface ActionLifecycleSettlement {
  clearProcessing: boolean;
  clearNoteState: boolean;
  scheduleSuccessCleanup: boolean;
}

export function getActionLifecycleSettlement(
  outcome: ActionLifecycleOutcome
): ActionLifecycleSettlement {
  if (outcome === "success") {
    return {
      clearProcessing: true,
      clearNoteState: false,
      scheduleSuccessCleanup: true,
    };
  }
  return {
    clearProcessing: true,
    clearNoteState: true,
    scheduleSuccessCleanup: false,
  };
}

interface ActionProcessingStoreState {
  noteStates: Record<number, NoteActionState>;
  errorEvents: ActionErrorEvent[];
  candidates: Record<number, NoteGenerationCandidate | null>;
}

const cancelledFlags = new Map<number, boolean>();
const actionClaims = new Map<number, symbol>();
const localCancellationKeys = new Map<number, string>();
const processingFlags = new Map<number, boolean>();
const successTimers = new Map<number, NodeJS.Timeout>();

const IDLE_STATE: NoteActionState = {
  status: "idle",
  actionName: null,
  isBuiltInAction: false,
  progress: null,
  startedAt: null,
  errorMessage: null,
};

function setNoteState(noteId: number, patch: Partial<NoteActionState>) {
  const { noteStates } = useActionProcessingStore.getState();
  const prev = noteStates[noteId] ?? IDLE_STATE;
  useActionProcessingStore.setState({
    noteStates: { ...noteStates, [noteId]: { ...prev, ...patch } },
  });
}

function clearNoteState(noteId: number) {
  const { noteStates } = useActionProcessingStore.getState();
  const next = { ...noteStates };
  delete next[noteId];
  useActionProcessingStore.setState({ noteStates: next });
}

function pushErrorEvent(event: ActionErrorEvent) {
  const { errorEvents } = useActionProcessingStore.getState();
  useActionProcessingStore.setState({ errorEvents: [...errorEvents, event] });
}

function scheduleSuccessCleanup(noteId: number): void {
  processingFlags.set(noteId, false);
  const previousTimer = successTimers.get(noteId);
  if (previousTimer) clearTimeout(previousTimer);

  const timer = setTimeout(() => {
    clearNoteState(noteId);
    successTimers.delete(noteId);
  }, 600);
  successTimers.set(noteId, timer);
}

function settleAbortedOrFailedAction(
  noteId: number,
  outcome: "cancelled" | "failed"
): void {
  const settlement = getActionLifecycleSettlement(outcome);
  if (settlement.clearProcessing) processingFlags.set(noteId, false);
  const timer = successTimers.get(noteId);
  if (timer) {
    clearTimeout(timer);
    successTimers.delete(noteId);
  }
  if (settlement.clearNoteState) clearNoteState(noteId);
}

export const useActionProcessingStore = create<ActionProcessingStoreState>()(() => ({
  noteStates: {},
  errorEvents: [],
  candidates: {},
}));

export function isEncounterNoteForGeneration(
  options: Pick<RunActionOptions, "isMeetingNote" | "noteType" | "calendarEventId"> & {
    hasEncounterLinkage?: boolean;
  }
): boolean {
  return (
    options.noteType === "meeting" &&
    options.hasEncounterLinkage === true
  );
}

export const LOCAL_CLINICAL_REQUEST_CHAR_BUDGET = 48_000;
const LOCAL_CLINICAL_SOURCE_CHUNK_CHAR_LIMIT = 18_000;
const LOCAL_CLINICAL_SOURCE_CHUNK_OVERLAP = 900;

function clinicalRequestSize(
  request: Pick<ReturnType<typeof buildClinicalEncounterCompactActionRequest>, "systemPrompt" | "userPrompt" | "responseSchema">
): number {
  return (
    request.systemPrompt.length +
    request.userPrompt.length +
    JSON.stringify(request.responseSchema).length
  );
}

interface ClinicalSourceChunk {
  text: string;
  start: number;
  end: number;
}

function splitClinicalSource(sourceText: string, maxChars: number): ClinicalSourceChunk[] {
  if (sourceText.length <= maxChars) return [{ text: sourceText, start: 0, end: sourceText.length }];

  const chunks: ClinicalSourceChunk[] = [];
  let offset = 0;
  while (offset < sourceText.length) {
    const remaining = sourceText.length - offset;
    if (remaining <= maxChars) {
      chunks.push({ text: sourceText.slice(offset), start: offset, end: sourceText.length });
      break;
    }

    const hardEnd = offset + maxChars;
    const windowStart = offset + Math.floor(maxChars * 0.5);
    const candidate = sourceText.slice(windowStart, hardEnd);
    const boundaryMatches = [...candidate.matchAll(/[\r\n.!?](?:\s|$)/g)];
    const boundary = boundaryMatches.at(-1);
    const end = boundary?.index == null
      ? hardEnd
      : windowStart + boundary.index + 1;
    chunks.push({ text: sourceText.slice(offset, end), start: offset, end });
    const overlap = Math.min(LOCAL_CLINICAL_SOURCE_CHUNK_OVERLAP, Math.floor(maxChars / 4));
    offset = Math.max(end - overlap, offset + 1);
  }

  return chunks.filter((chunk) => chunk.text.trim());
}

export function planLocalClinicalEncounterRequests(
  noteContent: string,
  templateText: string,
  budget = LOCAL_CLINICAL_REQUEST_CHAR_BUDGET
): Array<ReturnType<typeof buildClinicalEncounterCompactActionRequest>> {
  // One evidence pass per source chunk prevents the old section × chunk
  // explosion. The active template still constrains the allowed field IDs and
  // supplies labels/aliases inside the request, but the transcript is not
  // repeatedly sent once per section.
  const emptyRequest = buildClinicalEncounterCompactActionRequest("", { templateText });
  const maxSourceChars = Math.max(
    1_000,
    Math.min(LOCAL_CLINICAL_SOURCE_CHUNK_CHAR_LIMIT, budget - clinicalRequestSize(emptyRequest))
  );
  const chunks = splitClinicalSource(noteContent, maxSourceChars);
  return chunks.map((chunk, chunkIndex) => ({
    ...buildClinicalEncounterCompactActionRequest(chunk.text, { templateText }),
    sourceText: chunk.text,
    sourceStart: chunk.start,
    sourceEnd: chunk.end,
    chunkIndex,
    chunkCount: chunks.length,
  }));
}

function setCandidate(noteId: number, candidate: NoteGenerationCandidate | null): void {
  const { candidates } = useActionProcessingStore.getState();
  useActionProcessingStore.setState({ candidates: { ...candidates, [noteId]: candidate } });
}

export async function publishClinicalGenerationCandidate(
  noteId: number,
  candidate: NoteGenerationCandidate,
  isCancelled: () => boolean,
  api: Pick<Window["electronAPI"], "clearNoteGenerationRun" | "discardNoteGenerationCandidate"> = window.electronAPI
): Promise<boolean> {
  if (isCancelled()) {
    await api.discardNoteGenerationCandidate?.(candidate.candidate_id);
    return false;
  }
  // The run row is only a resumable extraction cache. Once the guarded
  // candidate exists, cache cleanup is best-effort and must never hide a
  // successfully generated note from the review UI.
  try {
    await api.clearNoteGenerationRun?.(noteId);
  } catch {
    // A later generation safely replaces the cache for this note.
  }
  if (isCancelled()) {
    await api.discardNoteGenerationCandidate?.(candidate.candidate_id);
    return false;
  }
  setCandidate(noteId, candidate);
  return true;
}

function rebaseCompactExtraction(
  extraction: ClinicalEncounterCompactExtraction,
  sourceStart = 0,
  chunkIndex = 0
): ClinicalEncounterCompactExtraction {
  return {
    issues: extraction.issues,
    fields: Object.fromEntries(
      Object.entries(extraction.fields).map(([fieldKey, fieldValue]) => [
        fieldKey,
        {
          ...fieldValue,
          sourceRefs: fieldValue.sourceRefs.map((reference) => ({
            ...reference,
            ...(reference.start !== undefined ? { start: reference.start + sourceStart } : {}),
            ...(reference.end !== undefined ? { end: reference.end + sourceStart } : {}),
            sourceId: reference.sourceId ?? `clinical-chunk-${chunkIndex}`,
          })),
        },
      ])
    ),
  };
}

function isReusableCompactExtraction(value: unknown): value is ClinicalEncounterCompactExtraction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { fields?: unknown; issues?: unknown };
  return Boolean(
    candidate.fields &&
      typeof candidate.fields === "object" &&
      !Array.isArray(candidate.fields) &&
      Array.isArray(candidate.issues)
  );
}

export function clearNoteGenerationCandidate(noteId: number): void {
  setCandidate(noteId, null);
}

export function selectNoteGenerationCandidate(
  state: ActionProcessingStoreState,
  noteId: number | null
): NoteGenerationCandidate | null {
  return noteId == null ? null : state.candidates[noteId] ?? null;
}

function configuredEncounterTemplateId(settings: ReturnType<typeof getSettings>): number | string | null {
  const configured = (settings as unknown as Record<string, unknown>).encounterNoteTemplateId;
  if (typeof configured === "number" || (typeof configured === "string" && configured.trim())) {
    return configured;
  }
  return null;
}

export async function resolveEncounterTemplate(
  settings: ReturnType<typeof getSettings>,
  useStructuredDefinition = false
): Promise<{ revisionId: number; templateText: string; definition?: StructuredNoteTemplate }> {
  const api = window.electronAPI;
  const resolvedTemplate = (template: { active_revision_id: number; template_text: string; active_revision?: { definition?: unknown } | null }) => {
    if (!useStructuredDefinition) return { revisionId: template.active_revision_id, templateText: validateClinicalEncounterTemplateText(template.template_text) };
    const definition = template.active_revision?.definition
      ? validateStructuredNoteTemplate(template.active_revision.definition)
      : migrateLegacyNoteTemplate(template.template_text).definition;
    if (!definition) throw new Error("Template needs review.");
    return { revisionId: template.active_revision_id, templateText: template.template_text, definition };
  };
  const configuredId = configuredEncounterTemplateId(settings);
  if (configuredId != null && api.getNoteTemplate) {
    let template: Awaited<ReturnType<NonNullable<typeof api.getNoteTemplate>>> = null;
    try {
      template = await api.getNoteTemplate(configuredId, { includeRaw: true });
    } catch {
      template = null;
    }
    if (
      template?.kind === "encounter" &&
      template.active_revision_id != null &&
      typeof template.template_text === "string"
    ) {
      try {
        return resolvedTemplate({ ...template, active_revision_id: template.active_revision_id, template_text: template.template_text });
      } catch {
        // An invalid selected template must never block the built-in action.
      }
    }
  }
  if (api.getDefaultNoteTemplate) {
    let template: Awaited<ReturnType<NonNullable<typeof api.getDefaultNoteTemplate>>> = null;
    try {
      template = await api.getDefaultNoteTemplate("encounter", { includeRaw: true });
    } catch {
      template = null;
    }
    if (template?.active_revision_id != null && typeof template.template_text === "string") {
      try {
        return resolvedTemplate({ ...template, active_revision_id: template.active_revision_id, template_text: template.template_text });
      } catch {
        // The database invariant normally repairs this before it reaches the
        // renderer. Keep the failure safe if an old database is mid-migration.
      }
    }
  }
  // A custom default can also be invalid. The built-in encounter template is
  // the last local fallback and is restored by the database template invariant
  // when an older database is missing its active revision.
  if (api.getNoteTemplate) {
    try {
      const builtin = await api.getNoteTemplate("clinical-encounter", { includeRaw: true });
      if (builtin?.active_revision_id != null && typeof builtin.template_text === "string") {
        return resolvedTemplate({ ...builtin, active_revision_id: builtin.active_revision_id, template_text: builtin.template_text });
      }
    } catch {
      // Fall through to the safe error below if the invariant itself is unavailable.
    }
  }
  throw new Error(
    "Unsupported clinical encounter template: the selected/default active template body is unavailable."
  );
}

export async function generateLocalClinicalEncounter(
  noteContent: string,
  templateText: string,
  modelId: string,
  providerOverrides: Record<string, unknown>,
  onProgress?: (progress: ActionProcessingProgress) => void,
  resumeContext?: {
    noteId: number;
    templateRevisionId: number;
    sourceHash: string;
    isCancelled?: () => boolean;
  }
): Promise<string> {
  const localErrorCode = (error: unknown): string =>
    String((error as { code?: unknown })?.code ?? "").toUpperCase();

  const isTransportFailure = (error: unknown): boolean => {
    const code = localErrorCode(error);
    if (["LOCAL_SERVER_TIMEOUT", "LOCAL_SERVER_UNAVAILABLE", "LOCAL_INFERENCE_FAILED"].includes(code)) {
      return true;
    }
    const message = String(error instanceof Error ? error.message : error ?? "").toLowerCase();
    return /timeout|timed out|connection|socket|econn|server unavailable|inference failed/.test(message);
  };

  const isSchemaCompatibilityFailure = (error: unknown): boolean => {
    const code = String((error as { code?: unknown })?.code ?? "").toUpperCase();
    if (code === "LOCAL_SCHEMA_UNSUPPORTED") return true;
    const message = String(error instanceof Error ? error.message : error ?? "").toLowerCase();
    return /response_format|json.?schema|status 400|status 422|unsupported.*schema|invalid.*schema/.test(
      message
    );
  };

  const parseExtraction = (
    rawOutput: string,
    request: ReturnType<typeof buildClinicalEncounterCompactActionRequest>
  ): ClinicalEncounterCompactExtraction => {
    const sourceText = request.sourceText ?? noteContent;
    const parsed = parseClinicalEncounterCompactOutput(rawOutput, sourceText, {
      allowedFieldKeys: request.fieldKeys,
    });
    if (!parsed.ok || !parsed.extraction) {
      const error = new Error("Clinical evidence could not be validated.");
      (error as Error & { code?: string }).code = "CLINICAL_OUTPUT_INVALID";
      throw error;
    }
    if (parsed.extraction.issues.length > 0 && Object.keys(parsed.extraction.fields).length === 0) {
      const error = new Error("Clinical evidence could not be validated.");
      (error as Error & { code?: string }).code = "CLINICAL_OUTPUT_INVALID";
      throw error;
    }
    return rebaseCompactExtraction(
      parsed.extraction,
      request.sourceStart ?? 0,
      request.chunkIndex ?? 0
    );
  };

  const runExtraction = async (
    request: ReturnType<typeof buildClinicalEncounterCompactActionRequest>
  ) => {
    const compactSchema = JSON.stringify(request.responseSchema);
    const nativeConfig = {
      systemPrompt: `${request.systemPrompt}\nCompact response contract:\n${compactSchema}`,
      ...providerOverrides,
      temperature: 0.1,
      disableThinking: true,
      requireCompleteOutput: true,
      maxTokens: 3_072,
      queuePriority: 10,
      responseFormat: {
        type: "json_schema" as const,
        json_schema: {
          name: "openwhispr_compact_clinical_evidence",
          strict: true,
          schema: request.responseSchema,
        },
      },
    };

    const runSimpleJsonFallback = async (): Promise<string> => {
      onProgress?.({ stage: "retrying", current: request.chunkIndex ?? 0, total: request.chunkCount ?? 1 });
      const fallbackConfig = await guardLocalRequest(modelId, request.userPrompt, {
        ...nativeConfig,
        systemPrompt: `${request.systemPrompt}\nReturn only one JSON object with a fields array. Each item must contain the exact field ID, a value, and evidence strings copied verbatim from the source. Use an empty fields array when nothing is documented.`,
        responseFormat: undefined,
      });
      return reasoningService.processText(request.userPrompt, modelId, null, fallbackConfig);
    };

    let rawOutput: string;
    try {
      const boundedConfig = await guardLocalRequest(modelId, request.userPrompt, nativeConfig);
      rawOutput = await reasoningService.processText(request.userPrompt, modelId, null, boundedConfig);
    } catch (error) {
      if (isSchemaCompatibilityFailure(error)) {
        return parseExtraction(await runSimpleJsonFallback(), request);
      }
      // A local server can briefly fail while loading a model or restarting.
      // Retry the exact schema request once before treating it as failed.
      if (!isTransportFailure(error)) throw error;
      onProgress?.({ stage: "retrying", current: request.chunkIndex ?? 0, total: request.chunkCount ?? 1 });
      rawOutput = await reasoningService.processText(
        request.userPrompt,
        modelId,
        null,
        await guardLocalRequest(modelId, request.userPrompt, nativeConfig)
      );
    }

    try {
      return parseExtraction(rawOutput, request);
    } catch (parseError) {
      // Some local servers accept response_format but their model ignores the
      // native schema. Give the model one simpler JSON-only contract, never a
      // Markdown fallback, and validate it with the same canonical parser.
      const fallbackOutput = await runSimpleJsonFallback();
      try {
        return parseExtraction(fallbackOutput, request);
      } catch {
        throw parseError;
      }
    }
  };

  const emptyRequest = buildClinicalEncounterCompactActionRequest("", { templateText });
  const schema = JSON.stringify(emptyRequest.responseSchema);
  const sourceChunks = await splitGenerationSource(
    noteContent,
    modelId,
    {
      systemPrompt: `${emptyRequest.systemPrompt}\nCompact response contract:\n${schema}`,
      maxTokens: 3072,
      responseFormat: {
        type: "json_schema",
        json_schema: { name: "openwhispr_compact_clinical_evidence", strict: true, schema: emptyRequest.responseSchema },
      },
    },
    (source) => buildClinicalEncounterCompactActionRequest(source, { templateText }).userPrompt
  );
  const extractionRequests = sourceChunks.map((chunk, chunkIndex) => ({
    ...buildClinicalEncounterCompactActionRequest(chunk.text, { templateText }),
    sourceText: chunk.text,
    sourceStart: chunk.start,
    sourceEnd: chunk.end,
    chunkIndex,
    chunkCount: sourceChunks.length,
  }));
  const extractions: ClinicalEncounterCompactExtraction[] = [];
  let resumeCount = 0;
  if (resumeContext && window.electronAPI.getNoteGenerationRun) {
    try {
      const saved = await window.electronAPI.getNoteGenerationRun(resumeContext.noteId);
      if (
        saved &&
        saved.template_revision_id === resumeContext.templateRevisionId &&
        saved.source_hash === resumeContext.sourceHash &&
        saved.model_id === modelId &&
        saved.chunk_count === extractionRequests.length &&
        saved.completed_chunks <= extractionRequests.length &&
        Array.isArray(saved.extractions) &&
        saved.extractions.length >= saved.completed_chunks &&
        saved.extractions.slice(0, saved.completed_chunks).every(isReusableCompactExtraction)
      ) {
        extractions.push(...(saved.extractions as ClinicalEncounterCompactExtraction[]));
        resumeCount = Math.min(saved.completed_chunks, extractions.length);
        extractions.length = resumeCount;
      }
    } catch {
      // A missing/old progress record must never block a fresh generation.
    }
  }
  onProgress?.({ stage: "extracting", current: resumeCount, total: extractionRequests.length });
  const saveFailedRun = async () => {
    if (!resumeContext || !window.electronAPI.saveNoteGenerationRun) return;
    await window.electronAPI.saveNoteGenerationRun({
      noteId: resumeContext.noteId,
      templateRevisionId: resumeContext.templateRevisionId,
      sourceHash: resumeContext.sourceHash,
      modelId,
      chunkCount: extractionRequests.length,
      completedChunks: extractions.length,
      extractions,
      status: "failed",
    }).catch(() => undefined);
  };
  // Keep each batch independent and sequential. The local reasoning bridge
  // also serializes requests, but explicit sequencing makes the merge order
  // deterministic and avoids unnecessary queue growth for long encounters.
  for (const [index, request] of extractionRequests.entries()) {
    if (index < resumeCount) continue;
    if (resumeContext?.isCancelled?.()) {
      await saveFailedRun();
      const error = new Error("Clinical generation cancelled.");
      (error as Error & { code?: string }).code = "CANCELLED";
      throw error;
    }
    onProgress?.({
      stage: "extracting",
      current: index,
      total: extractionRequests.length,
    });
    try {
      extractions.push(await runExtraction(request));
    } catch (error) {
      await saveFailedRun();
      throw error;
    }
    if (resumeContext?.isCancelled?.()) {
      await saveFailedRun();
      const error = new Error("Clinical generation cancelled.");
      (error as Error & { code?: string }).code = "CANCELLED";
      throw error;
    }
    onProgress?.({
      stage: "extracting",
      current: index + 1,
      total: extractionRequests.length,
    });
    if (resumeContext && window.electronAPI.saveNoteGenerationRun) {
      try {
        await window.electronAPI.saveNoteGenerationRun({
          noteId: resumeContext.noteId,
          templateRevisionId: resumeContext.templateRevisionId,
          sourceHash: resumeContext.sourceHash,
          modelId,
          chunkCount: extractionRequests.length,
          completedChunks: index + 1,
          extractions,
          status: "processing",
        });
      } catch {
        // Progress persistence is best effort; the current generation remains
        // authoritative even if an older database cannot store the run.
      }
    }
  }

  onProgress?.({ stage: "compiling", current: 0, total: 1 });
  if (resumeContext?.isCancelled?.()) {
    await saveFailedRun();
    const error = new Error("Clinical generation cancelled.");
    (error as Error & { code?: string }).code = "CANCELLED";
    throw error;
  }
  const parsed = mergeClinicalEncounterCompactExtractions(extractions, noteContent);
  if (!parsed.ok || !parsed.document) {
    await saveFailedRun();
    const error = new Error("Local clinical evidence could not be validated against the transcript.");
    (error as Error & { code?: string }).code = "CLINICAL_OUTPUT_INVALID";
    throw error;
  }
  const compiled = compileClinicalEncounterMarkdown(parsed.document, templateText);
  onProgress?.({ stage: "compiling", current: 1, total: 1 });
  return compiled;
}

const BASE_SYSTEM_PROMPT = `You are a note enhancement assistant. The user will provide raw notes — possibly voice-transcribed, rough, or unstructured. Your job is to clean them up according to the instructions below while preserving all original meaning and information. Output clean markdown.

FORMAT RULES (strict):
- Do NOT include any preamble: no title, no date/time/location, no attendee list, no topic header. Start directly with the content.
- Do NOT use tables, horizontal rules, or block quotes.
- Do NOT list or guess participant names/roles.
- Keep the tone professional and concise. Bias toward brevity.

Instructions: `;

const MEETING_SYSTEM_PROMPT = `You are a professional meeting notes assistant. You will receive a dual-speaker transcript where "You:" marks the user's speech and "Them:" marks the other participant(s), along with any manual notes the user took.

Your job is to produce clean, actionable meeting notes in markdown. Follow these rules:

FORMAT RULES (strict):
- Do NOT include any preamble: no title, no "# Meeting Notes", no date/time/location, no attendee list, no topic header. Start directly with the summary.
- Do NOT use tables, horizontal rules, or block quotes.
- Do NOT list or guess participant names/roles.
- Start with a concise 1–2 sentence summary of what the meeting was about.
- Use clear section headings: ## Key Discussion Points, ## Decisions Made, ## Action Items, ## Follow-ups (omit any section that has no content).
- Under Action Items, use checkboxes (\`- [ ]\`) and attribute each item to "You" or "Them" where clear.

CONTENT RULES:
- Preserve important quotes or specific commitments verbatim when they carry meaning.
- Remove filler, small talk, false starts, and repeated/redundant content.
- Where speakers refer to the same topic across multiple turns, consolidate into a coherent point rather than listing every utterance.
- If the user included manual notes alongside the transcript, integrate them — they represent the user's emphasis on what matters most.
- Keep the tone professional and concise. Bias toward brevity.

Instructions: `;

export const BUILTIN_GENERATE_NOTES_TRANSLATION_KEY = "notes.actions.builtin.generateNotes";

export function isBuiltInGenerateNotesAction(action: Pick<ActionItem, "is_builtin" | "translation_key">): boolean {
  return action.is_builtin === 1 && action.translation_key === BUILTIN_GENERATE_NOTES_TRANSLATION_KEY;
}

export interface RunActionOptions {
  isCloudMode: boolean;
  modelId: string;
  isMeetingNote?: boolean;
  noteType?: NoteItem["note_type"];
  calendarEventId?: string | null;
  sourceRevision?: number;
  /** Opt-in so enhancement never renames a note the user has titled. */
  allowTitleGeneration?: boolean;
}

export interface RunActionLabels {
  noModel: string;
  noEndpoint: string;
  actionFailed: string;
  sourceChanged?: string;
  clinicalValidationFailed?: string;
  localModelFailed?: string;
}

/**
 * Start processing an action on a note. Runs in the background — survives
 * component unmounts and navigation so the user can switch notes mid-action.
 */
export function runBackgroundAction(
  noteId: number,
  noteContent: string,
  contentHash: string,
  action: ActionItem,
  options: RunActionOptions,
  labels: RunActionLabels
): void {
  if (processingFlags.get(noteId)) return;

  const settings = getSettings();
  const noteFormatting = selectResolvedNoteFormatting(settings);
  const builtIn = isBuiltInGenerateNotesAction(action);
  if (builtIn && noteFormatting.mode !== "local") {
    pushErrorEvent({ noteId, message: "Choose a local model for Generate Notes in Settings." });
    return;
  }
  if (builtIn) options = { ...options, isCloudMode: false };
  const modelId = builtIn ? noteFormatting.model : options.modelId;
  if (!modelId && !options.isCloudMode) {
    pushErrorEvent({ noteId, message: labels.noModel });
    return;
  }

  // A self-hosted config without a URL would fall through to a cloud provider.
  if (!options.isCloudMode && noteFormatting.mode === "self-hosted" && !noteFormatting.remoteUrl) {
    pushErrorEvent({ noteId, message: labels.noEndpoint });
    return;
  }

  cancelledFlags.set(noteId, false);
  const claim = Symbol("note-generation");
  const cancellationKey = `note-${noteId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  actionClaims.set(noteId, claim);
  if (builtIn) localCancellationKeys.set(noteId, cancellationKey);
  const isCancelled = () => actionClaims.get(noteId) !== claim || Boolean(cancelledFlags.get(noteId));
  const previousTimer = successTimers.get(noteId);
  if (previousTimer) {
    clearTimeout(previousTimer);
    successTimers.delete(noteId);
  }
  processingFlags.set(noteId, true);
  setNoteState(noteId, {
    status: "processing",
    actionName: action.name,
    isBuiltInAction: isBuiltInGenerateNotesAction(action),
    progress: { stage: "preparing", current: 0, total: 1 },
    startedAt: Date.now(),
    errorMessage: null,
  });

  (async () => {
    try {
      const usePersistedLocalSource = builtIn || (!options.isCloudMode && noteFormatting.mode === "local");
      if (usePersistedLocalSource) {
        const source = await prepareNoteGenerationSource(noteId,
          window.electronAPI.getNoteGenerationSource, isCancelled);
        if (!source || isCancelled()) return;
        noteContent = source.sourceText ?? "";
        contentHash = source.sourceHash!;
        options = { ...options, sourceRevision: source.sourceRevision,
          noteType: source.noteType, isMeetingNote: source.noteType === "meeting" };
      }
      const providerOverrides = {
        ...buildNoteFormattingOverrides(noteFormatting, options.isCloudMode),
        ...(builtIn ? { cancellationKey } : {}),
      };
      let enhanced: string;
      const encounterLookup =
        typeof window.electronAPI.getEncounterByNote === "function"
          ? await window.electronAPI.getEncounterByNote(noteId)
          : null;
      const linkedEncounter = encounterLookup?.encounter ?? null;
      const hasEncounterLinkage = Boolean(linkedEncounter);
      // Only Generate Notes means “create the encounter's clinical template”.
      // Custom actions on a meeting remain the custom action the user chose.
      const isEncounterNote = builtIn &&
        isEncounterNoteForGeneration({ ...options, hasEncounterLinkage });
      const useLocalBoundedGeneric =
        !isEncounterNote && !options.isCloudMode && noteFormatting.mode === "local";

      if (isEncounterNote && settings.encounterEnhancedNotesEnabled !== false) {
        const template = await resolveEncounterTemplate(settings, isBuiltInGenerateNotesAction(action));
        if (!options.isCloudMode && noteFormatting.mode === "local") {
          let clinicalGenerationSource = noteContent;
          let sharedEvidence: ClinicalEvidenceV1 | undefined;
          let reusableEvidenceChunks: Array<{
            chunk_index: number;
            chunk_count: number;
            chunk_hash: string;
            evidence: ClinicalEvidenceChunk;
          }> = [];
          if (
            linkedEncounter &&
            typeof window.electronAPI.getEncounterOutput === "function" &&
            typeof window.electronAPI.getEncounterEvidenceBundle === "function"
          ) {
            const outputResult = await window.electronAPI.getEncounterOutput(linkedEncounter.id);
            const output = outputResult.output;
            if (
              output?.evidence_model === modelId &&
              output.evidence_schema_version === CLINICAL_EVIDENCE_SCHEMA_VERSION &&
              output.source_hash === contentHash &&
              output.source_revision === options.sourceRevision
            ) {
              const evidenceResult = await window.electronAPI.getEncounterEvidenceBundle(
                linkedEncounter.id,
                {
                  sourceRevision: output.source_revision,
                  sourceHash: output.source_hash,
                  schemaVersion: CLINICAL_EVIDENCE_SCHEMA_VERSION,
                  modelId,
                }
              );
              reusableEvidenceChunks = evidenceResult.bundle?.chunks ?? [];
              if (evidenceResult.bundle?.mergedEvidence) {
                sharedEvidence = evidenceResult.bundle.mergedEvidence;
                clinicalGenerationSource = `DOCUMENTED CLINICAL EVIDENCE\n${serializeClinicalEvidence(
                  evidenceResult.bundle.mergedEvidence
                )}`;
              }
            }
          }
          enhanced = template.definition ? await generateStructuredClinicalNote({
            source: noteContent, evidence: sharedEvidence, reusableEvidenceChunks,
            definition: template.definition,
            modelId, overrides: providerOverrides, reasoner: reasoningService,
            noteId, sourceHash: contentHash, templateRevisionId: template.revisionId, isCancelled,
            onProgress: (progress) => {
              if (!isCancelled()) setNoteState(noteId, { status: progress.stage === "retrying" ? "retrying" : "processing", progress });
            },
          }) : await generateLocalClinicalEncounter(
            clinicalGenerationSource,
            template.templateText,
            modelId,
            providerOverrides,
            (progress) => {
              if (!isCancelled()) setNoteState(noteId, {
                status: progress.stage === "retrying" ? "retrying" : "processing",
                progress,
              });
            },
            {
              noteId,
              templateRevisionId: template.revisionId,
              sourceHash: contentHash,
              isCancelled,
            }
          );
        } else {
          setNoteState(noteId, { progress: { stage: "generating", current: 0, total: 1 } });
          const request = buildClinicalEncounterActionRequest(noteContent, template.templateText);
          const schemaText = JSON.stringify(request.responseSchema);
          const systemPrompt = appendDictionarySuffix(
            `${request.systemPrompt}\nJSON Schema:\n${schemaText}`,
            settings.customDictionary,
            settings.uiLanguage
          );
          // The schema belongs in the system instructions once. Repeating it
          // in the user message was the main source of local context overflow.
          const userPrompt = `${request.userPrompt}\nAction context: ${action.prompt}`;
          const rawOutput = await reasoningService.processText(userPrompt, modelId, null, {
            systemPrompt,
            temperature: 0.3,
            disableThinking: settings.noteFormattingDisableThinking,
            ...providerOverrides,
          });
          const parsed = parseClinicalEncounterOutput(rawOutput, noteContent);
          if (!parsed.ok || !parsed.document) {
            throw new Error("Encounter note generation returned unsupported or malformed output.");
          }
          enhanced = compileClinicalEncounterMarkdown(parsed.document, template.templateText);
        }
        if (typeof window.electronAPI.createNoteGenerationCandidate !== "function") {
          throw new Error("Encounter note review is unavailable.");
        }
        if (isCancelled()) return;
        const candidateResult = await window.electronAPI.createNoteGenerationCandidate({
          noteId,
          generatedContent: enhanced,
          templateRevisionId: template.revisionId,
          clinicalSource: noteContent,
          ...(isBuiltInGenerateNotesAction(action)
            ? { sourceHash: contentHash, sourceRevision: options.sourceRevision, preserveStaleDraft: true }
            : {}),
        });
        if (!candidateResult.success || !candidateResult.candidate) {
          const error = new Error(candidateResult.error || candidateResult.code || "Unable to create note review candidate.");
          (error as Error & { code?: string }).code = candidateResult.code;
          throw error;
        }
        if (!await publishClinicalGenerationCandidate(
          noteId,
          candidateResult.candidate,
          isCancelled
        )) return;
      } else {
        const basePrompt = options.isMeetingNote ? MEETING_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT;
        const systemPrompt = appendDictionarySuffix(
          basePrompt,
          options.isMeetingNote ? settings.customDictionary : undefined,
          settings.uiLanguage
        );
        if (useLocalBoundedGeneric) {
          enhanced = await generateLocalGenericNotes({
            sourceText: noteContent,
            systemPrompt,
            actionPrompt: action.prompt,
            modelId,
            providerOverrides,
            reasoner: reasoningService,
            onProgress: (progress: LocalNoteGenerationProgress) => {
              if (!isCancelled()) setNoteState(noteId, {
                status: progress.stage === "retrying" ? "retrying" : "processing",
                progress,
              });
            },
          });
        } else {
          enhanced = await reasoningService.processText(noteContent, modelId, null, {
            systemPrompt: `${systemPrompt}${action.prompt}`,
            temperature: 0.3,
            disableThinking: settings.noteFormattingDisableThinking,
            ...providerOverrides,
          });
        }
      }

      if (isCancelled()) return;

      let title: string | undefined;
      if (options.allowTitleGeneration && getSettings().autoGenerateNoteTitle) {
        const generated = await generateNoteTitle(enhanced, modelId, providerOverrides);
        if (generated) title = generated;
      }

      if (isCancelled()) return;

      if (isEncounterNote && settings.encounterEnhancedNotesEnabled !== false) {
        setNoteState(noteId, {
          status: "success",
          actionName: action.name,
          progress: null,
          errorMessage: null,
        });
        if (getActionLifecycleSettlement("success").scheduleSuccessCleanup) {
          scheduleSuccessCleanup(noteId);
        }
        return;
      }

      const updates: Record<string, string> = {
        enhanced_content: enhanced,
        enhancement_prompt: action.prompt,
        enhanced_at_content_hash: contentHash,
      };
      if (title) updates.title = title;
      setNoteState(noteId, {
        status: "processing",
        progress: { stage: "applying", current: 1, total: 1 },
      });
      if (usePersistedLocalSource && useLocalBoundedGeneric && window.electronAPI.updateNoteEnhancedIfSourceMatches) {
        const applied = await window.electronAPI.updateNoteEnhancedIfSourceMatches(
          noteId,
          contentHash,
          updates,
          options.sourceRevision
        );
        if (!applied.success) {
          if (applied.candidate && !isCancelled()) setCandidate(noteId, applied.candidate);
          const error = new Error("The note changed while it was generating.");
          (error as Error & { code?: string }).code = applied.errorCode || "SOURCE_CHANGED";
          throw error;
        }
      } else {
        await window.electronAPI.updateNote(noteId, updates);
      }

      setNoteState(noteId, {
        status: "success",
        actionName: action.name,
        progress: null,
        errorMessage: null,
      });
      if (getActionLifecycleSettlement("success").scheduleSuccessCleanup) {
        scheduleSuccessCleanup(noteId);
      }
    } catch (err) {
      if (isCancelled()) {
        if (actionClaims.get(noteId) === claim) settleAbortedOrFailedAction(noteId, "cancelled");
        return;
      }
      if (!isBuiltInGenerateNotesAction(action)) {
        settleAbortedOrFailedAction(noteId, "failed");
        const message = !options.isCloudMode && noteFormatting.mode === "local"
          ? labels.localModelFailed || labels.actionFailed
          : labels.actionFailed;
        pushErrorEvent({ noteId, message });
        return;
      }
      processingFlags.set(noteId, false);
      const failureTimer = successTimers.get(noteId);
      if (failureTimer) clearTimeout(failureTimer);
      const errorCode = String((err as { code?: unknown })?.code ?? "").toUpperCase();
      const message =
        errorCode === "SOURCE_CHANGED" || errorCode === "CANDIDATE_STALE"
          ? labels.sourceChanged || "The note changed while it was generating. Try again."
          : errorCode === "CLINICAL_OUTPUT_INVALID"
            ? labels.clinicalValidationFailed || "The clinical note could not be validated. Try again."
            : errorCode.startsWith("LOCAL_")
              ? labels.localModelFailed || labels.actionFailed
              : labels.actionFailed;
      setNoteState(noteId, { status: "failed", progress: null, errorMessage: message });
      pushErrorEvent({ noteId, message });
      const timer = setTimeout(() => {
        clearNoteState(noteId);
        successTimers.delete(noteId);
      }, 4_000);
      successTimers.set(noteId, timer);
    } finally {
      // Cancellation is intentionally soft: the request may settle after the
      // caller has already cleared the state. This guard also covers any
      // cancellation/early-return path that occurs before an explicit catch.
      if (actionClaims.get(noteId) === claim && processingFlags.get(noteId) && !successTimers.has(noteId)) {
        settleAbortedOrFailedAction(
          noteId,
          cancelledFlags.get(noteId) ? "cancelled" : "failed"
        );
      }
      if (actionClaims.get(noteId) === claim) {
        cancelledFlags.delete(noteId);
        actionClaims.delete(noteId);
        localCancellationKeys.delete(noteId);
      }
    }
  })();
}

export function cancelAction(noteId: number): void {
  cancelledFlags.set(noteId, true);
  const cancellationKey = localCancellationKeys.get(noteId);
  if (cancellationKey) void window.electronAPI?.cancelLocalReasoning?.(cancellationKey);
  settleAbortedOrFailedAction(noteId, "cancelled");
}

export function consumeErrorEvents(): ActionErrorEvent[] {
  const { errorEvents } = useActionProcessingStore.getState();
  if (errorEvents.length === 0) return [];
  useActionProcessingStore.setState({ errorEvents: [] });
  return errorEvents;
}

export function selectNoteActionState(
  state: ActionProcessingStoreState,
  noteId: number | null
): NoteActionState {
  if (noteId == null) return IDLE_STATE;
  return state.noteStates[noteId] ?? IDLE_STATE;
}
