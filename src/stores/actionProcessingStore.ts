import { create } from "zustand";
import reasoningService from "../services/ReasoningService";
import { getSettings, selectResolvedNoteFormatting } from "./settingsStore";
import { appendDictionarySuffix } from "../config/prompts";
import { generateNoteTitle } from "../utils/generateTitle";
import { buildNoteFormattingOverrides } from "../helpers/noteFormattingOverrides";
import {
  buildClinicalEncounterActionRequest,
  buildClinicalEncounterCompactActionRequest,
  compileClinicalEncounterMarkdown,
  mergeClinicalEncounterCompactExtractions,
  parseClinicalEncounterCompactOutput,
  parseClinicalEncounterOutput,
  type ClinicalEncounterCompactExtraction,
} from "../services/clinicalEncounterTemplateEngine";
import type { ActionItem, NoteGenerationCandidate, NoteItem } from "../types/electron";

export type ActionProcessingStatus = "idle" | "processing" | "success";

export type ActionProcessingProgress = {
  stage: "preparing" | "extracting" | "compiling" | "generating";
  current: number;
  total: number;
};

export interface NoteActionState {
  status: ActionProcessingStatus;
  actionName: string | null;
  progress: ActionProcessingProgress | null;
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
const processingFlags = new Map<number, boolean>();
const successTimers = new Map<number, NodeJS.Timeout>();

const IDLE_STATE: NoteActionState = { status: "idle", actionName: null, progress: null };

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
    (Boolean(options.calendarEventId) || options.hasEncounterLinkage === true)
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
  try {
    const stored = window.localStorage.getItem("encounterNoteTemplateId");
    return stored?.trim() || null;
  } catch {
    return null;
  }
}

async function resolveEncounterTemplate(
  settings: ReturnType<typeof getSettings>
): Promise<{ revisionId: number; templateText: string }> {
  const api = window.electronAPI;
  const configuredId = configuredEncounterTemplateId(settings);
  if (configuredId != null && api.getNoteTemplate) {
    const template = await api.getNoteTemplate(configuredId, { includeRaw: true });
    if (template?.kind === "encounter" && template.active_revision_id != null && typeof template.template_text === "string") {
      return { revisionId: template.active_revision_id, templateText: template.template_text };
    }
  }
  if (api.getDefaultNoteTemplate) {
    const template = await api.getDefaultNoteTemplate("encounter", { includeRaw: true });
    if (template?.active_revision_id != null && typeof template.template_text === "string") {
      return { revisionId: template.active_revision_id, templateText: template.template_text };
    }
  }
  throw new Error(
    "Unsupported clinical encounter template: the selected/default active template body is unavailable."
  );
}

async function generateLocalClinicalEncounter(
  noteContent: string,
  templateText: string,
  modelId: string,
  providerOverrides: Record<string, unknown>,
  onProgress?: (progress: ActionProcessingProgress) => void,
  resumeContext?: {
    noteId: number;
    templateRevisionId: number;
    sourceHash: string;
  }
): Promise<string> {
  const runExtraction = async (
    request: ReturnType<typeof buildClinicalEncounterCompactActionRequest>
  ) => {
    const compactSchema = JSON.stringify(request.responseSchema);
    const rawOutput = await reasoningService.processText(
      request.userPrompt,
      modelId,
      null,
      {
        systemPrompt: `${request.systemPrompt}\nCompact response contract:\n${compactSchema}`,
        ...providerOverrides,
        temperature: 0.1,
        // Clinical extraction must never emit a reasoning trace alongside the
        // structured response, regardless of the general note setting.
        disableThinking: true,
        requireCompleteOutput: true,
        maxTokens: 3_072,
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "openwhispr_compact_clinical_evidence",
            strict: true,
            schema: request.responseSchema,
          },
        },
      }
    );
    const sourceText = request.sourceText ?? noteContent;
    const parsed = parseClinicalEncounterCompactOutput(rawOutput, sourceText, {
      allowedFieldKeys: request.fieldKeys,
    });
    if (!parsed.ok || !parsed.extraction) {
      throw new Error("Local clinical evidence extraction returned unsupported output.");
    }
    return rebaseCompactExtraction(
      parsed.extraction,
      request.sourceStart ?? 0,
      request.chunkIndex ?? 0
    );
  };

  const extractionRequests = planLocalClinicalEncounterRequests(noteContent, templateText);
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
  // Keep each batch independent and sequential. The local reasoning bridge
  // also serializes requests, but explicit sequencing makes the merge order
  // deterministic and avoids unnecessary queue growth for long encounters.
  for (const [index, request] of extractionRequests.entries()) {
    if (index < resumeCount) continue;
    onProgress?.({
      stage: "extracting",
      current: index,
      total: extractionRequests.length,
    });
    extractions.push(await runExtraction(request));
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
        });
      } catch {
        // Progress persistence is best effort; the current generation remains
        // authoritative even if an older database cannot store the run.
      }
    }
  }

  onProgress?.({ stage: "compiling", current: 0, total: 1 });
  const parsed = mergeClinicalEncounterCompactExtractions(extractions, noteContent);
  if (!parsed.ok || !parsed.document) {
    throw new Error("Local clinical evidence could not be validated against the transcript.");
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

export interface RunActionOptions {
  isCloudMode: boolean;
  modelId: string;
  isMeetingNote?: boolean;
  noteType?: NoteItem["note_type"];
  calendarEventId?: string | null;
  /** Opt-in so enhancement never renames a note the user has titled. */
  allowTitleGeneration?: boolean;
}

export interface RunActionLabels {
  noModel: string;
  noEndpoint: string;
  actionFailed: string;
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

  const modelId = options.modelId;
  if (!modelId && !options.isCloudMode) {
    pushErrorEvent({ noteId, message: labels.noModel });
    return;
  }

  const settings = getSettings();
  const noteFormatting = selectResolvedNoteFormatting(settings);
  // A self-hosted config without a URL would fall through to a cloud provider.
  if (!options.isCloudMode && noteFormatting.mode === "self-hosted" && !noteFormatting.remoteUrl) {
    pushErrorEvent({ noteId, message: labels.noEndpoint });
    return;
  }

  cancelledFlags.set(noteId, false);
  const previousTimer = successTimers.get(noteId);
  if (previousTimer) {
    clearTimeout(previousTimer);
    successTimers.delete(noteId);
  }
  processingFlags.set(noteId, true);
  setNoteState(noteId, {
    status: "processing",
    actionName: action.name,
    progress: { stage: "preparing", current: 0, total: 1 },
  });

  (async () => {
    try {
      const providerOverrides = buildNoteFormattingOverrides(noteFormatting, options.isCloudMode);
      let enhanced: string;
      const hasEncounterLinkage =
        !options.calendarEventId && typeof window.electronAPI.getEncounterByNote === "function"
          ? Boolean((await window.electronAPI.getEncounterByNote(noteId))?.encounter)
          : false;
      const isEncounterNote = isEncounterNoteForGeneration({ ...options, hasEncounterLinkage });

      if (isEncounterNote && settings.encounterEnhancedNotesEnabled !== false) {
        const template = await resolveEncounterTemplate(settings);
        if (!options.isCloudMode && noteFormatting.mode === "local") {
          enhanced = await generateLocalClinicalEncounter(
            noteContent,
            template.templateText,
            modelId,
            providerOverrides,
            (progress) => setNoteState(noteId, { progress }),
            {
              noteId,
              templateRevisionId: template.revisionId,
              sourceHash: contentHash,
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
        const candidateResult = await window.electronAPI.createNoteGenerationCandidate({
          noteId,
          generatedContent: enhanced,
          templateRevisionId: template.revisionId,
          clinicalSource: noteContent,
        });
        if (!candidateResult.success || !candidateResult.candidate) {
          throw new Error(candidateResult.error || candidateResult.code || "Unable to create note review candidate.");
        }
        await window.electronAPI.clearNoteGenerationRun?.(noteId);
        setCandidate(noteId, candidateResult.candidate);
      } else {
        const basePrompt = options.isMeetingNote ? MEETING_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT;
        const systemPrompt = appendDictionarySuffix(
          basePrompt + action.prompt,
          options.isMeetingNote ? settings.customDictionary : undefined,
          settings.uiLanguage
        );
        enhanced = await reasoningService.processText(noteContent, modelId, null, {
          systemPrompt,
          temperature: 0.3,
          disableThinking: settings.noteFormattingDisableThinking,
          ...providerOverrides,
        });
      }

      if (cancelledFlags.get(noteId)) return;

      let title: string | undefined;
      if (options.allowTitleGeneration && getSettings().autoGenerateNoteTitle) {
        const generated = await generateNoteTitle(enhanced, modelId, providerOverrides);
        if (generated) title = generated;
      }

      if (cancelledFlags.get(noteId)) return;

      if (isEncounterNote && settings.encounterEnhancedNotesEnabled !== false) {
        setNoteState(noteId, { status: "success", actionName: action.name, progress: null });
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
      await window.electronAPI.updateNote(noteId, updates);

      setNoteState(noteId, { status: "success", actionName: action.name, progress: null });
      if (getActionLifecycleSettlement("success").scheduleSuccessCleanup) {
        scheduleSuccessCleanup(noteId);
      }
    } catch (err) {
      if (cancelledFlags.get(noteId)) {
        settleAbortedOrFailedAction(noteId, "cancelled");
        return;
      }
      settleAbortedOrFailedAction(noteId, "failed");
      const message = err instanceof Error ? err.message : labels.actionFailed;
      pushErrorEvent({ noteId, message });
    } finally {
      // Cancellation is intentionally soft: the request may settle after the
      // caller has already cleared the state. This guard also covers any
      // cancellation/early-return path that occurs before an explicit catch.
      if (processingFlags.get(noteId) && !successTimers.has(noteId)) {
        settleAbortedOrFailedAction(
          noteId,
          cancelledFlags.get(noteId) ? "cancelled" : "failed"
        );
      }
      cancelledFlags.delete(noteId);
    }
  })();
}

/** Soft cancel: the HTTP request continues but the result is discarded. */
export function cancelAction(noteId: number): void {
  cancelledFlags.set(noteId, true);
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
