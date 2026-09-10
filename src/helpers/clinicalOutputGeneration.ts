import type { ReasoningConfig } from "../services/BaseReasoningService";
import { selectResolvedNoteFormatting, getSettings } from "../stores/settingsStore";
import { buildNoteFormattingOverrides } from "./noteFormattingOverrides.js";
import { stripThinkingTags } from "./stripThinking.js";
import { countGenerationTokens, guardLocalRequest, localRequestBudget } from "./localGenerationBudget";
import {
  getClinicalOutputSystemPrompt,
  getClinicalOutputsSystemPrompt,
  type ClinicalOutputKind,
} from "../config/prompts/clinicalOutputs";
import {
  CLINICAL_EVIDENCE_SCHEMA_VERSION,
  clinicalEvidenceChunkHash,
  extractClinicalEvidenceChunk,
  planClinicalEvidenceChunks,
  mergeClinicalEvidence,
  serializeClinicalEvidence,
  type ClinicalEvidenceChunk,
  type ClinicalEvidenceFact,
  type ClinicalEvidenceV1,
  isClinicalClaimGrounded,
} from "./clinicalEvidence";

export type ClinicalOutputErrorCode =
  | "LOCAL_MODEL_NOT_CONFIGURED"
  | "BYOK_NOT_CONFIGURED"
  | "GENERATION_FAILED";

export type ClinicalGenerationPhase = "mapping" | "synthesizing";

export type ClinicalGenerationProgress = {
  phase: ClinicalGenerationPhase;
  current: number;
  total: number;
};

export type ClinicalGenerationConfig = {
  mode: "local" | "providers" | "self-hosted" | "enterprise" | string;
  provider?: string;
  model?: string;
  cloudMode?: string;
  cloudBaseUrl?: string;
  remoteUrl?: string;
  customApiKey?: string;
  disableThinking?: boolean;
};

export type ClinicalOutputResult =
  | { success: true; kind: ClinicalOutputKind; content: string; provider: string; model: string }
  | {
      success: false;
      kind: ClinicalOutputKind;
      errorCode: ClinicalOutputErrorCode;
      error: string;
      retryable?: boolean;
    };

export type ClinicalOutputsResult = {
  summary: ClinicalOutputResult;
  soap: ClinicalOutputResult;
  focus: ClinicalOutputResult;
};

export type ClinicalReasoner = {
  processText(
    text: string,
    model: string,
    agentName?: string | null,
    config?: ReasoningConfig
  ): Promise<string>;
};

async function resolveReasoner(reasoner?: ClinicalReasoner): Promise<ClinicalReasoner> {
  if (reasoner) return reasoner;
  // Keep this dependency lazy: consumers that only render output state do not
  // start the local reasoning service or its model-server lifecycle.
  const module = await import("../services/ReasoningService");
  return module.default;
}

const CLINICAL_SOURCE_CHUNK_CHARS = 14_000;
const CLINICAL_SOURCE_CHUNK_OVERLAP = 900;
const MAX_SYNTHESIS_SOURCE_CHARS = 24_000;
const MAX_SUMMARY_CHARS = 8_000;
const MAX_SOAP_FIELD_CHARS = 4_000;
const MAX_FOCUS_CHARS = 120;
const NOT_DOCUMENTED = "Not documented";
const COMBINED_OUTPUT_MAX_TOKENS = 2_048;

const PUBLIC_ERRORS: Record<ClinicalOutputErrorCode, string> = {
  LOCAL_MODEL_NOT_CONFIGURED: "Choose a downloaded local note model before generating clinical notes.",
  BYOK_NOT_CONFIGURED: "Configure a BYOK note provider before generating clinical notes.",
  GENERATION_FAILED: "Clinical note generation could not be completed. Your transcript is saved; try again.",
};

const SOAP_SECTION_LABELS = ["Subjective", "Objective", "Assessment", "Plan"] as const;

function soapSectionHeader(line: string): (typeof SOAP_SECTION_LABELS)[number] | null {
  const normalized = line
    .trim()
    .replace(/^#{1,3}\s*/, "")
    .replace(/^\*\*(.+)\*\*:?$/, "$1")
    .replace(/:$/, "")
    .trim()
    .toLowerCase();
  return SOAP_SECTION_LABELS.find((label) => label.toLowerCase() === normalized) || null;
}

/**
 * SOAP is generated as concise plain text, but it is displayed in the same
 * rich editor as Enhanced notes. Normalize only its known section boundaries;
 * never reinterpret clinical prose or invent list structure.
 */
export function formatClinicalOutputForDisplay(
  kind: ClinicalOutputKind,
  content: string | null | undefined
): string {
  const clean = typeof content === "string" ? content.trim() : "";
  if (!clean || kind !== "soap") return clean;

  const lines = clean.split(/\r?\n/);
  const sections: Array<{ label: (typeof SOAP_SECTION_LABELS)[number]; lines: string[] }> = [];
  let current: { label: (typeof SOAP_SECTION_LABELS)[number]; lines: string[] } | null = null;

  for (const line of lines) {
    const label = soapSectionHeader(line);
    if (label) {
      current = { label, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }

  if (sections.length === 0) return clean;

  const firstSectionIndex = lines.findIndex((line) => soapSectionHeader(line) !== null);
  const preamble = firstSectionIndex > 0 ? lines.slice(0, firstSectionIndex).join("\n").trim() : "";
  const renderedSections = sections
    .map(({ label, lines: sectionLines }) => {
      const body = sectionLines.join("\n").trim() || NOT_DOCUMENTED;
      return `## ${label}\n\n${body}`;
    })
    .join("\n\n");

  // Preserve any model text before the first recognized section. The formatter
  // only normalizes known SOAP boundaries; it must never silently delete an
  // unexpected preamble or unsupported content.
  return preamble ? `## SOAP note\n\n${preamble}\n\n${renderedSections}` : renderedSections;
}

export function splitClinicalTranscript(
  transcript: string,
  maxChars = CLINICAL_SOURCE_CHUNK_CHARS
): Array<{ text: string; start: number; end: number }> {
  const clean = transcript.trim();
  if (clean.length <= maxChars) return [{ text: clean, start: 0, end: clean.length }];

  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let offset = 0;
  while (offset < clean.length) {
    const remaining = clean.length - offset;
    if (remaining <= maxChars) {
      chunks.push({ text: clean.slice(offset), start: offset, end: clean.length });
      break;
    }

    const hardEnd = offset + maxChars;
    const searchStart = offset + Math.floor(maxChars * 0.55);
    const candidate = clean.slice(searchStart, hardEnd);
    const boundaries = [...candidate.matchAll(/[.!?\r\n](?=\s|$)/g)];
    const boundary = boundaries.at(-1);
    const end = boundary?.index == null ? hardEnd : searchStart + boundary.index + 1;
    chunks.push({ text: clean.slice(offset, end), start: offset, end });
    offset = Math.max(end - Math.min(CLINICAL_SOURCE_CHUNK_OVERLAP, Math.floor(maxChars / 4)), offset + 1);
  }
  return chunks.filter((chunk) => chunk.text.trim());
}

function synthesisSource(partials: string[]): string {
  const joined = partials
    .map((partial, index) => `EXTRACTED ENCOUNTER EVIDENCE ${index + 1}\n${partial.trim()}`)
    .join("\n\n");
  if (joined.length <= MAX_SYNTHESIS_SOURCE_CHARS) return joined;
  return joined.slice(0, MAX_SYNTHESIS_SOURCE_CHARS);
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function isTransientGenerationError(error: unknown): boolean {
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
    code?: unknown;
    message?: unknown;
  } | null;
  const status = Number(candidate?.status ?? candidate?.response?.status);
  if (status === 429 || (status >= 500 && status < 600)) return true;

  const code = typeof candidate?.code === "string" ? candidate.code.toUpperCase() : "";
  if (
    [
      "ECONNABORTED",
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "FETCH_FAILED",
      "INFERENCE_FAILED",
      "LOCAL_SERVER_UNAVAILABLE",
      "LOCAL_SERVER_TIMEOUT",
    ].includes(code)
  ) {
    return true;
  }

  const message = typeof candidate?.message === "string" ? candidate.message.toLowerCase() : "";
  return /timeout|timed out|network|connection|temporar|rate limit|server unavailable|fetch failed|llama-server.*(?:failed|died|unavailable)|local model server.*(?:failed|unavailable)/.test(message);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const clean = stripThinkingTags(raw)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(clean);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(clean.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

export function parseClinicalOutput(kind: ClinicalOutputKind, raw: string): string {
  const parsed = parseJsonObject(raw);
  if (kind === "summary") {
    const summary = boundedText(parsed?.summary, MAX_SUMMARY_CHARS);
    return summary || boundedText(stripThinkingTags(raw), MAX_SUMMARY_CHARS);
  }

  if (kind === "focus") {
    const focus = boundedText(parsed?.focus, MAX_FOCUS_CHARS).replace(/\s+/g, " ");
    return focus || boundedText(stripThinkingTags(raw), MAX_FOCUS_CHARS).replace(/\s+/g, " ");
  }

  const soap = parsed?.soap;
  if (soap && typeof soap === "object" && !Array.isArray(soap)) {
    const fields = soap as Record<string, unknown>;
    return [
      ["Subjective", fields.subjective],
      ["Objective", fields.objective],
      ["Assessment", fields.assessment],
      ["Plan", fields.plan],
    ]
      .map(([label, value]) => `${label}\n${boundedText(value, MAX_SOAP_FIELD_CHARS) || "Not documented"}`)
      .join("\n\n");
  }
  return boundedText(stripThinkingTags(raw), MAX_SUMMARY_CHARS);
}

function routeFor(config: ClinicalGenerationConfig):
  | { ok: true; provider: string; model: string; overrides: ReasoningConfig }
  | { ok: false; errorCode: ClinicalOutputErrorCode } {
  const model = config.model?.trim() || "";
  if (config.mode === "local") {
    if (!model) return { ok: false, errorCode: "LOCAL_MODEL_NOT_CONFIGURED" };
    return {
      ok: true,
      provider: "local",
      model,
      overrides: { ...buildNoteFormattingOverrides(config, false), disableThinking: true },
    };
  }

  if (config.mode === "self-hosted") {
    if (!model || !config.remoteUrl?.trim()) return { ok: false, errorCode: "LOCAL_MODEL_NOT_CONFIGURED" };
    return {
      ok: true,
      provider: "self-hosted",
      model,
      overrides: { ...buildNoteFormattingOverrides(config, false), disableThinking: true },
    };
  }

  // A provider route is intentionally opt-in. Never inherit the cleanup route,
  // even when it happens to have a remote key configured.
  if (config.mode === "providers" && config.cloudMode === "byok" && config.provider?.trim() && model) {
    if (config.provider === "custom" && !config.cloudBaseUrl?.trim()) {
      return { ok: false, errorCode: "BYOK_NOT_CONFIGURED" };
    }
    return {
      ok: true,
      provider: config.provider,
      model,
      overrides: { ...buildNoteFormattingOverrides(config, false), disableThinking: true },
    };
  }
  return { ok: false, errorCode: "BYOK_NOT_CONFIGURED" };
}

export function getClinicalGenerationConfig(): ClinicalGenerationConfig {
  const settings = getSettings();
  const config = selectResolvedNoteFormatting(settings);
  // Automatic encounter output is a local PHI-processing workflow. Keep the
  // explicit-config overload for tests/legacy callers, but never let runtime
  // settings silently reroute encounter data to a cloud provider.
  return {
    mode: "local",
    provider: "local",
    // A model ID selected under a cloud/self-hosted mode is not necessarily a
    // local registry ID. Fail with LOCAL_MODEL_NOT_CONFIGURED instead of
    // handing that stale ID to llama.cpp and producing a misleading server
    // failure.
    model: config.mode === "local" ? config.model : "",
    disableThinking: true,
  };
}

async function generateClinicalOutputOnce(
  kind: ClinicalOutputKind,
  sourceText: string,
  route: Extract<ReturnType<typeof routeFor>, { ok: true }>,
  reasoner: ClinicalReasoner
): Promise<ClinicalOutputResult> {
  try {
    const output = await reasoner.processText(sourceText, route.model, null, {
      ...route.overrides,
      systemPrompt: getClinicalOutputSystemPrompt(kind),
      maxTokens: kind === "focus" ? 80 : kind === "summary" ? 700 : 1_200,
      temperature: 0.1,
      requireCompleteOutput: true,
      queuePriority: -10,
    });
    const content = parseClinicalOutput(kind, output);
    if (!content) throw new Error("empty clinical output");
    return { success: true, kind, content, provider: route.provider, model: route.model };
  } catch {
    return {
      success: false,
      kind,
      errorCode: "GENERATION_FAILED",
      error: PUBLIC_ERRORS.GENERATION_FAILED,
    };
  }
}

type CombinedClinicalDraft = {
  summary: string;
  soap: string;
  focus: string;
};

export function parsePartialClinicalOutputs(
  raw: string,
  allowedEvidence?: Set<string> | Map<string, ClinicalEvidenceFact>
): Partial<CombinedClinicalDraft> {
  const parsed = parseJsonObject(raw);
  if (!parsed) return {};

  const readEntry = (value: unknown, maxLength: number) => {
    if (typeof value === "string" && !allowedEvidence) {
      return { text: boundedText(value, maxLength), valid: true };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { text: "", valid: false };
    }
    const record = value as Record<string, unknown>;
    const text = boundedText(record.text, maxLength);
    const ids = Array.isArray(record.evidenceIds)
      ? record.evidenceIds.map(String).filter(Boolean)
      : [];
    const isNotDocumented = text.toLocaleLowerCase() === NOT_DOCUMENTED.toLocaleLowerCase();
    const controlText = /^(?:sorry|i (?:cannot|can't|am unable)|system prompt:|instructions:|error:|you are a)/i.test(text);
    const idsValid = !allowedEvidence || ids.every((id) => allowedEvidence.has(id));
    const claimsGrounded = !(allowedEvidence instanceof Map) || isNotDocumented ||
      isClinicalClaimGrounded(text, ids.flatMap((id) => {
        const fact = allowedEvidence.get(id);
        return fact ? [fact.value, ...fact.sourceRefs] : [];
      }).join(" "));
    return {
      text,
      valid: Boolean(text) && !controlText && idsValid && claimsGrounded &&
        (isNotDocumented ? ids.length === 0 : ids.length > 0),
    };
  };

  const soap = parsed.soap;
  const soapFields = soap && typeof soap === "object" && !Array.isArray(soap) ? soap : {};
  const fields = soapFields as Record<string, unknown>;
  const summaryEntry = readEntry(parsed.summary, MAX_SUMMARY_CHARS);
  const focusEntry = readEntry(parsed.focus, MAX_FOCUS_CHARS);
  const soapEntries = [
    ["Subjective", readEntry(fields.subjective, MAX_SOAP_FIELD_CHARS)],
    ["Objective", readEntry(fields.objective, MAX_SOAP_FIELD_CHARS)],
    ["Assessment", readEntry(fields.assessment, MAX_SOAP_FIELD_CHARS)],
    ["Plan", readEntry(fields.plan, MAX_SOAP_FIELD_CHARS)],
  ] as const;
  const documentedValues = [summaryEntry, focusEntry, ...soapEntries.map(([, entry]) => entry)]
    .map((entry) => entry.text)
    .filter((value) => value && value.toLocaleLowerCase() !== NOT_DOCUMENTED.toLocaleLowerCase());
  if (allowedEvidence && documentedValues.length === 0) return {};
  const summary = summaryEntry.text || NOT_DOCUMENTED;
  const focus = focusEntry.text.replace(/\s+/g, " ") || NOT_DOCUMENTED;
  const soapText = soapEntries
    .map(([label, entry]) => `${label}\n${entry.text || NOT_DOCUMENTED}`)
    .join("\n\n");

  const documented = (text: string) => text.toLocaleLowerCase() !== NOT_DOCUMENTED.toLocaleLowerCase();
  return {
    ...(!allowedEvidence || (summaryEntry.valid && documented(summary)) ? { summary } : {}),
    ...(!allowedEvidence || (focusEntry.valid && documented(focus)) ? { focus } : {}),
    ...(!allowedEvidence || (
      soapEntries.every(([, entry]) => entry.valid) &&
      soapEntries.some(([, entry]) => documented(entry.text))
    ) ? { soap: soapText } : {}),
  };
}

async function synthesizeEvidenceOutputs(
  sourceText: string,
  route: Extract<ReturnType<typeof routeFor>, { ok: true }>,
  reasoner: ClinicalReasoner,
  evidence: ClinicalEvidenceV1
): Promise<ClinicalOutputsResult> {
  const kinds = ["summary", "soap", "focus"] as const;
  const catalog = new Map(evidence.facts.map((fact) => [fact.id, fact]));
  const draft: Partial<CombinedClinicalDraft> = {};
  let retryable = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const missing = kinds.filter((kind) => !draft[kind]);
    if (!missing.length) break;
    const config: ReasoningConfig = {
      ...route.overrides,
      systemPrompt: `${getClinicalOutputsSystemPrompt()}\nReturn only these output types: ${missing.join(", ")}. Every documented entry needs valid evidence IDs. Do not return refusals, instructions, or an entirely undocumented result when documented evidence exists.${attempt ? " The previous response had invalid or missing output types; correct only the requested types." : ""}`,
      maxTokens: COMBINED_OUTPUT_MAX_TOKENS,
      temperature: 0.1,
      requireCompleteOutput: true,
      disableThinking: true,
      queuePriority: route.overrides.queuePriority ?? -10,
    };
    try {
      const boundedConfig = await guardLocalRequest(route.model, sourceText, config);
      const response = await reasoner.processText(sourceText, route.model, null, boundedConfig);
      const parsed = parsePartialClinicalOutputs(response, catalog);
      for (const kind of missing) if (parsed[kind]) draft[kind] = parsed[kind];
    } catch (error) {
      retryable = isTransientGenerationError(error);
      if (!retryable) break;
    }
  }
  const fallback = deterministicClinicalOutputs(evidence);
  const result = combinedFailureResult(retryable);
  for (const kind of kinds) {
    const content = draft[kind] ?? fallback[kind];
    if (content) result[kind] = {
      success: true, kind, content, provider: route.provider, model: route.model,
    };
  }
  return result;
}

function deterministicClinicalOutputs(evidence: ClinicalEvidenceV1): CombinedClinicalDraft {
  const values = (categories: ClinicalEvidenceFact["category"][]) => evidence.facts
    .filter((fact) => categories.includes(fact.category)).map((fact) => fact.value);
  const render = (items: string[], limit: number) => boundedText(
    [...new Set(items)].map((value) => `- ${value}`).join("\n"), limit
  ) || NOT_DOCUMENTED;
  const subjective = values(["chief_concern", "history", "symptom", "medication", "additional"]);
  const objective = values(["objective"]);
  const assessment = values(["assessment"]);
  const plan = values(["plan", "follow_up"]);
  const focusValues = values(["chief_concern", "symptom", "assessment", "follow_up"]);
  return {
    summary: render(evidence.facts.map((fact) => fact.value), MAX_SUMMARY_CHARS),
    soap: [
      ["Subjective", render(subjective, MAX_SOAP_FIELD_CHARS)],
      ["Objective", render(objective, MAX_SOAP_FIELD_CHARS)],
      ["Assessment", render(assessment, MAX_SOAP_FIELD_CHARS)],
      ["Plan", render(plan, MAX_SOAP_FIELD_CHARS)],
    ].map(([label, content]) => `${label}\n${content}`).join("\n\n"),
    focus: render(focusValues.length ? focusValues : evidence.facts.map((fact) => fact.value), MAX_FOCUS_CHARS)
      .replace(/^- /, "").replace(/\n- /g, "; "),
  };
}

export async function boundedEvidenceSource(
  evidence: ClinicalEvidenceV1,
  route: Extract<ReturnType<typeof routeFor>, { ok: true }>,
  reasoner: ClinicalReasoner,
  finalSystemPrompt = `${getClinicalOutputsSystemPrompt()}\n${"Reserved corrective instructions. ".repeat(20)}`
): Promise<string> {
  let groups = evidence.facts.map((fact) => ({ evidenceIds: [fact.id], text: `${fact.category} (${fact.provenance}): ${fact.value}` }));
  const serialize = (items: typeof groups) => items.map((item) => `[${item.evidenceIds.join(",")}] ${item.text}`).join("\n");
  const wrap = (value: string) => `DOCUMENTED EVIDENCE START\n${value}\nDOCUMENTED EVIDENCE END`;
  const finalBudget = await localRequestBudget(route.model, {
    systemPrompt: finalSystemPrompt,
    maxTokens: COMBINED_OUTPUT_MAX_TOKENS,
  });
  const reductionConfig: ReasoningConfig = {
    ...route.overrides,
    systemPrompt: "Organize clinical evidence into a shorter digest without adding claims. Preserve negation, uncertainty, disagreements, manual-note priority, medication details, and follow-up. Return JSON {groups:[{evidenceIds:[string],text:string}]}. Every supplied evidence ID must occur exactly once; combine related facts but never drop an ID or create an ID. Return only JSON.",
    maxTokens: 1024,
    disableThinking: true,
    requireCompleteOutput: true,
    queuePriority: route.overrides.queuePriority ?? -10,
  };
  const reductionBudget = await localRequestBudget(route.model, reductionConfig);
  for (let round = 0; round < 5; round += 1) {
    const current = wrap(serialize(groups));
    if (await countGenerationTokens(route.model, current) <= finalBudget.inputTokens) return current;
    const batches: Array<typeof groups> = [];
    let batch: typeof groups = [];
    for (const group of groups) {
      if (await countGenerationTokens(route.model, wrap(serialize([...batch, group]))) > reductionBudget.inputTokens) {
        if (!batch.length) throw Object.assign(new Error("Clinical evidence cannot fit the local context."), { code: "LOCAL_CONTEXT_EXCEEDED" });
        batches.push(batch);
        batch = [];
      }
      batch.push(group);
    }
    if (batch.length) batches.push(batch);
    const reduced: typeof groups = [];
    for (const items of batches) {
      const input = wrap(serialize(items));
      const boundedConfig = await guardLocalRequest(route.model, input, reductionConfig);
      const expectedIds = new Set(items.flatMap((item) => item.evidenceIds));
      let valid: typeof groups | null = null;
      for (let attempt = 0; attempt < 2 && !valid; attempt += 1) {
        const raw = await reasoner.processText(input, route.model, null, boundedConfig);
        const parsed = parseJsonObject(raw);
        if (!Array.isArray(parsed?.groups)) continue;
        const seen = new Set<string>();
        const candidate: typeof groups = [];
        for (const entry of parsed.groups) {
          if (!entry || typeof entry.text !== "string" || !entry.text.trim() || !Array.isArray(entry.evidenceIds) || !entry.evidenceIds.length) break;
          if (entry.evidenceIds.some((id: unknown) => typeof id !== "string" || !expectedIds.has(id) || seen.has(id))) break;
          for (const id of entry.evidenceIds) seen.add(id);
          candidate.push({ evidenceIds: entry.evidenceIds, text: entry.text.trim() });
        }
        if (candidate.length === parsed.groups.length && seen.size === expectedIds.size) valid = candidate;
      }
      if (!valid) throw Object.assign(new Error("Clinical evidence could not be organized."), { code: "CLINICAL_OUTPUT_INVALID" });
      reduced.push(...valid);
    }
    if (serialize(reduced).length >= serialize(groups).length) {
      throw Object.assign(new Error("Clinical evidence could not be reduced without loss."), { code: "CLINICAL_OUTPUT_INVALID" });
    }
    groups = reduced;
  }
  throw Object.assign(new Error("Clinical evidence could not fit the local context."), { code: "LOCAL_CONTEXT_EXCEEDED" });
}

function combinedSuccessResult(
  draft: CombinedClinicalDraft,
  route: Extract<ReturnType<typeof routeFor>, { ok: true }>
): ClinicalOutputsResult {
  return {
    summary: { success: true, kind: "summary", content: draft.summary, provider: route.provider, model: route.model },
    soap: { success: true, kind: "soap", content: draft.soap, provider: route.provider, model: route.model },
    focus: { success: true, kind: "focus", content: draft.focus, provider: route.provider, model: route.model },
  };
}

function combinedFailureResult(retryable: boolean): ClinicalOutputsResult {
  const retryMetadata = retryable ? { retryable: true as const } : {};
  return {
    summary: { success: false, kind: "summary", errorCode: "GENERATION_FAILED", error: PUBLIC_ERRORS.GENERATION_FAILED, ...retryMetadata },
    soap: { success: false, kind: "soap", errorCode: "GENERATION_FAILED", error: PUBLIC_ERRORS.GENERATION_FAILED, ...retryMetadata },
    focus: { success: false, kind: "focus", errorCode: "GENERATION_FAILED", error: PUBLIC_ERRORS.GENERATION_FAILED, ...retryMetadata },
  };
}

export async function generateClinicalOutput(
  kind: ClinicalOutputKind,
  transcript: string,
  options: { config?: ClinicalGenerationConfig; reasoner?: ClinicalReasoner } = {}
): Promise<ClinicalOutputResult> {
  const route = routeFor(options.config ?? getClinicalGenerationConfig());
  if (route.ok === false) {
    return { success: false, kind, errorCode: route.errorCode, error: PUBLIC_ERRORS[route.errorCode] };
  }
  const cleanTranscript = transcript.trim();
  if (!cleanTranscript) {
    return { success: false, kind, errorCode: "GENERATION_FAILED", error: PUBLIC_ERRORS.GENERATION_FAILED };
  }

  const reasoner = await resolveReasoner(options.reasoner);
  const chunks = splitClinicalTranscript(cleanTranscript);
  if (chunks.length === 1) {
    return generateClinicalOutputOnce(kind, chunks[0].text, route, reasoner);
  }

  // Map each chunk first so the middle of a long encounter is never silently
  // discarded. Reduce the bounded chunk outputs only after every source chunk
  // has produced a valid result.
  const partials: string[] = [];
  for (const chunk of chunks) {
    const partial = await generateClinicalOutputOnce(kind, chunk.text, route, reasoner);
    if (!partial.success) return partial;
    partials.push(partial.content);
  }

  const synthesis = await generateClinicalOutputOnce(
    kind,
    [
      "The following are evidence-preserving summaries of every chronological transcript chunk.",
      "Synthesize them into one final clinical output. Do not mention chunks or this instruction.",
      synthesisSource(partials),
    ].join("\n\n"),
    route,
    reasoner
  );
  return synthesis;
}

export async function generateClinicalOutputs(
  sourceText: string,
  options: {
    config?: ClinicalGenerationConfig;
    reasoner?: ClinicalReasoner;
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
    /** Higher values run first between local model requests. */
    queuePriority?: number;
  } = {}
): Promise<ClinicalOutputsResult> {
  const route = routeFor(options.config ?? getClinicalGenerationConfig());
  if (route.ok === false) {
    return {
      summary: { success: false, kind: "summary", errorCode: route.errorCode, error: PUBLIC_ERRORS[route.errorCode] },
      soap: { success: false, kind: "soap", errorCode: route.errorCode, error: PUBLIC_ERRORS[route.errorCode] },
      focus: { success: false, kind: "focus", errorCode: route.errorCode, error: PUBLIC_ERRORS[route.errorCode] },
    };
  }
  const cleanSource = sourceText.trim();
  if (!cleanSource) return combinedFailureResult(false);
  const reasoner = await resolveReasoner(options.reasoner);
  const executionRoute = {
    ...route,
    overrides: {
      ...route.overrides,
      queuePriority: options.queuePriority ?? route.overrides.queuePriority ?? -10,
    },
  };
  const chunks = await planClinicalEvidenceChunks(cleanSource, route.model, executionRoute.overrides);
  const reusable = new Map(
    (options.reusableEvidenceChunks ?? []).map((entry) => [entry.chunk_index, entry])
  );
  const evidenceChunks: ClinicalEvidenceChunk[] = [];
  options.onProgress?.({ phase: "mapping", current: 0, total: chunks.length });
  for (const [index, chunk] of chunks.entries()) {
    const chunkHash = clinicalEvidenceChunkHash(chunk.text);
    const cached = reusable.get(index);
    let evidenceChunk: ClinicalEvidenceChunk;
    if (
      cached &&
      cached.chunk_count === chunks.length &&
      cached.chunk_hash === chunkHash &&
      cached.evidence?.schemaVersion === CLINICAL_EVIDENCE_SCHEMA_VERSION
    ) {
      evidenceChunk = cached.evidence;
    } else {
      evidenceChunk = await extractClinicalEvidenceChunk({
        source: chunk.text,
        chunkIndex: index,
        modelId: route.model,
        reasoner,
        config: route.overrides,
        onRetry: () => options.onProgress?.({ phase: "mapping", current: index, total: chunks.length }),
      });
      await options.onEvidenceChunk?.(evidenceChunk, {
        chunkIndex: index,
        chunkCount: chunks.length,
        chunkHash,
      });
    }
    evidenceChunks.push(evidenceChunk);
    options.onProgress?.({ phase: "mapping", current: index + 1, total: chunks.length });
  }
  const evidence = mergeClinicalEvidence(evidenceChunks);
  await options.onEvidenceReady?.(evidence);
  if (evidence.facts.length === 0) {
    return combinedSuccessResult(
      {
        summary: NOT_DOCUMENTED,
        soap: SOAP_SECTION_LABELS.map((label) => `${label}\n${NOT_DOCUMENTED}`).join("\n\n"),
        focus: NOT_DOCUMENTED,
      },
      route
    );
  }
  options.onProgress?.({ phase: "synthesizing", current: 0, total: 1 });
  const synthesis = await synthesizeEvidenceOutputs(
    await boundedEvidenceSource(evidence, executionRoute, reasoner),
    executionRoute,
    reasoner,
    evidence
  );
  options.onProgress?.({ phase: "synthesizing", current: 1, total: 1 });
  return synthesis;
}
