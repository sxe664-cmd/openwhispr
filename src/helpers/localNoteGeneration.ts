import type { ReasoningConfig } from "../services/BaseReasoningService";
import {
  countGenerationTokens,
  guardLocalRequest,
  localRequestBudget,
  splitGenerationSource,
} from "./localGenerationBudget";

export type LocalNoteGenerationStage =
  | "preparing"
  | "extracting"
  | "synthesizing"
  | "retrying"
  | "applying";

export interface LocalNoteGenerationProgress {
  stage: LocalNoteGenerationStage;
  current: number;
  total: number;
}

export interface LocalNoteReasoner {
  processText: (
    text: string,
    modelId: string,
    agentName: string | null,
    config: ReasoningConfig
  ) => Promise<string>;
}

export const LOCAL_NOTE_SOURCE_CHUNK_CHAR_LIMIT = 9_000;
export const LOCAL_NOTE_SOURCE_CHUNK_OVERLAP = 450;
export const LOCAL_NOTE_SHORT_SOURCE_CHAR_LIMIT = 12_000;
export const LOCAL_NOTE_EVIDENCE_CHAR_LIMIT = 22_000;
export const LOCAL_NOTE_REDUCTION_BATCH_CHAR_LIMIT = 7_000;

function splitAtBoundary(source: string, maxChars: number): string[] {
  if (source.length <= maxChars) return [source];

  const chunks: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    const remaining = source.length - offset;
    if (remaining <= maxChars) {
      chunks.push(source.slice(offset));
      break;
    }

    const hardEnd = offset + maxChars;
    const windowStart = offset + Math.floor(maxChars * 0.55);
    const window = source.slice(windowStart, hardEnd);
    const matches = [...window.matchAll(/[\r\n.!?](?:\s|$)/g)];
    const last = matches.at(-1);
    const end = last?.index == null ? hardEnd : windowStart + last.index + 1;
    chunks.push(source.slice(offset, end));
    offset = Math.max(end - LOCAL_NOTE_SOURCE_CHUNK_OVERLAP, offset + 1);
  }
  return chunks.filter((chunk) => chunk.trim());
}

export function splitLocalNoteSource(
  source: string,
  maxChars = LOCAL_NOTE_SOURCE_CHUNK_CHAR_LIMIT
): string[] {
  return splitAtBoundary(source, maxChars);
}

async function calculateSourceCharBudget(
  modelId: string,
  source: string,
  systemPrompt: string,
  outputTokens: number
): Promise<{ maxChars: number; fitsSingleRequest: boolean }> {
  const [budget, sourceTokens] = await Promise.all([
    localRequestBudget(modelId, { systemPrompt, maxTokens: outputTokens }),
    countGenerationTokens(modelId, source),
  ]);
  const usableInputTokens = budget.inputTokens;
  const charsPerToken = Math.max(1, source.length / Math.max(1, sourceTokens));
  return {
    maxChars: Math.max(1, Math.floor(usableInputTokens * charsPerToken)),
    fitsSingleRequest: sourceTokens <= usableInputTokens,
  };
}

export function isUsableGeneratedMarkdown(value: string, sourceText = ""): boolean {
  const text = value.trim();
  if (!text) return false;
  if (text.includes("<think>")) return false;
  // A local server can return a partial fenced block when it reaches its
  // output limit. Treat that as a failed request so the bounded retry runs.
  if ((text.match(/```/g)?.length ?? 0) % 2 !== 0) return false;
  const normalized = text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const sourceNormalized = sourceText.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  if (/^(?:i (?:can(?:not|'t)|am unable to)|sorry[, ]|error:|server error|request failed)/i.test(text)) {
    return false;
  }
  if (/^(?:you are (?:a|an)|instructions?:|system prompt:|source (?:chunk|transcript) start)/i.test(text)) {
    return false;
  }
  if (sourceNormalized.length > 800 && normalized === sourceNormalized) return false;
  // Very concise output can be legitimate (for example, a short action-item
  // list from a long but repetitive meeting), so reject only effectively empty
  // fragments rather than imposing a minimum note length.
  if (sourceNormalized.length > 1_000 && normalized.length < 8) return false;
  return true;
}

function isRetryableLocalError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "").toUpperCase();
  if (["LOCAL_SERVER_TIMEOUT", "LOCAL_SERVER_UNAVAILABLE", "LOCAL_INFERENCE_FAILED"].includes(code)) {
    return true;
  }
  const message = String(error instanceof Error ? error.message : error ?? "").toLowerCase();
  return /timeout|timed out|temporarily|connection|socket|econn|server unavailable|inference failed/.test(
    message
  );
}

async function runMarkdownRequest(
  reasoner: LocalNoteReasoner,
  text: string,
  modelId: string,
  config: ReasoningConfig,
  onProgress?: (progress: LocalNoteGenerationProgress) => void
): Promise<string> {
  config = await guardLocalRequest(modelId, text, config);
  try {
    const result = await reasoner.processText(text, modelId, null, config);
    if (!isUsableGeneratedMarkdown(result, text)) throw new Error("Local model returned incomplete notes.");
    return result.trim();
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error ?? "").toLowerCase();
    const retryable =
      isRetryableLocalError(error) || /empty|incomplete|truncated|output limit/.test(message);
    if (!retryable) throw error;
    onProgress?.({ stage: "retrying", current: 0, total: 1 });
    const result = await reasoner.processText(text, modelId, null, config);
    if (!isUsableGeneratedMarkdown(result, text)) throw new Error("Local model returned incomplete notes.");
    return result.trim();
  }
}

function buildMappingSystemPrompt(systemPrompt: string, actionPrompt: string): string {
  return `${systemPrompt}\n${actionPrompt}\n\nYou are mapping one source chunk. Produce concise markdown evidence only. Preserve concrete facts, decisions, tasks, and wording that carries meaning. Do not invent details, add a preamble, or refer to this chunk.`;
}

function buildSynthesisSystemPrompt(systemPrompt: string, actionPrompt: string): string {
  return `${systemPrompt}\n${actionPrompt}\n\nSynthesize the supplied bounded evidence into the final markdown note. Preserve all supported substantive information, remove duplicates, and omit unsupported claims. Output only the finished note.`;
}

const REDUCTION_SYSTEM_PROMPT =
  "Reduce the supplied note evidence into a shorter evidence-preserving markdown digest. Keep concrete facts, decisions, action items, commitments, and qualifiers. Remove duplication and commentary. Do not add anything that is not present. Output only the digest.";

const boundedSource = (label: string, value: string) =>
  `${label} START\n${value}\n${label} END`;

export async function generateLocalGenericNotes({
  sourceText,
  systemPrompt,
  actionPrompt,
  modelId,
  providerOverrides,
  reasoner,
  onProgress,
}: {
  sourceText: string;
  systemPrompt: string;
  actionPrompt: string;
  modelId: string;
  providerOverrides: Record<string, unknown>;
  reasoner: LocalNoteReasoner;
  onProgress?: (progress: LocalNoteGenerationProgress) => void;
}): Promise<string> {
  const commonConfig = {
    ...providerOverrides,
    temperature: 0.2,
    disableThinking: true,
    requireCompleteOutput: true,
    queuePriority: 10,
  } as ReasoningConfig;

  onProgress?.({ stage: "preparing", current: 0, total: 1 });
  const directSystemPrompt = `${systemPrompt}${actionPrompt}`;
  const directBudget = await calculateSourceCharBudget(
    modelId,
    sourceText,
    directSystemPrompt,
    2_048
  );
  if (directBudget.fitsSingleRequest) {
    return runMarkdownRequest(
      reasoner,
      sourceText,
      modelId,
      {
        ...commonConfig,
        systemPrompt: directSystemPrompt,
        maxTokens: 2_048,
      },
      onProgress
    );
  }

  const mappingSystemPrompt = buildMappingSystemPrompt(systemPrompt, actionPrompt);
  const chunks = await splitGenerationSource(
    sourceText,
    modelId,
    { ...commonConfig, systemPrompt: mappingSystemPrompt, maxTokens: 768 },
    (portion) => boundedSource("SOURCE CHUNK", portion)
  );
  const evidence: string[] = [];
  onProgress?.({ stage: "extracting", current: 0, total: chunks.length });
  for (const [index, chunk] of chunks.entries()) {
    evidence.push(
      await runMarkdownRequest(
        reasoner,
        boundedSource("SOURCE CHUNK", chunk.text),
        modelId,
        { ...commonConfig, systemPrompt: mappingSystemPrompt, maxTokens: 768 },
        onProgress
      )
    );
    onProgress?.({ stage: "extracting", current: index + 1, total: chunks.length });
  }

  let boundedEvidence = evidence.join("\n\n");
  const synthesisSystemPrompt = buildSynthesisSystemPrompt(systemPrompt, actionPrompt);
  let synthesisBudget = await calculateSourceCharBudget(
    modelId,
    boundedSource("EVIDENCE", boundedEvidence),
    synthesisSystemPrompt,
    2_048
  );
  while (!synthesisBudget.fitsSingleRequest) {
    const batches = await splitGenerationSource(
      boundedEvidence,
      modelId,
      { ...commonConfig, systemPrompt: REDUCTION_SYSTEM_PROMPT, maxTokens: 768 },
      (portion) => boundedSource("EVIDENCE", portion)
    );
    const reduced: string[] = [];
    for (const batch of batches) {
      reduced.push(
        await runMarkdownRequest(
          reasoner,
          boundedSource("EVIDENCE", batch.text),
          modelId,
          { ...commonConfig, systemPrompt: REDUCTION_SYSTEM_PROMPT, maxTokens: 768 },
          onProgress
        )
      );
    }
    const next = reduced.join("\n\n");
    if (next.length >= boundedEvidence.length) {
      throw Object.assign(new Error("The local model could not organize all note evidence."), {
        code: "LOCAL_OUTPUT_INVALID",
      });
    }
    boundedEvidence = next;
    synthesisBudget = await calculateSourceCharBudget(
      modelId,
      boundedSource("EVIDENCE", boundedEvidence),
      synthesisSystemPrompt,
      2_048
    );
  }

  onProgress?.({ stage: "synthesizing", current: 0, total: 1 });
  const result = await runMarkdownRequest(
    reasoner,
    boundedSource("EVIDENCE", boundedEvidence),
    modelId,
    { ...commonConfig, systemPrompt: synthesisSystemPrompt, maxTokens: 2_048 },
    onProgress
  );
  onProgress?.({ stage: "synthesizing", current: 1, total: 1 });
  return result;
}
