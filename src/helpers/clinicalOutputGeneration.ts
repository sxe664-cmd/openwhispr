import type { ReasoningConfig } from "../services/BaseReasoningService";
import { selectResolvedNoteFormatting, getSettings } from "../stores/settingsStore";
import { buildNoteFormattingOverrides } from "./noteFormattingOverrides.js";
import { stripThinkingTags } from "./stripThinking.js";
import { getClinicalOutputSystemPrompt, type ClinicalOutputKind } from "../config/prompts/clinicalOutputs";

export type ClinicalOutputErrorCode =
  | "LOCAL_MODEL_NOT_CONFIGURED"
  | "BYOK_NOT_CONFIGURED"
  | "GENERATION_FAILED";

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
  | { success: false; kind: ClinicalOutputKind; errorCode: ClinicalOutputErrorCode; error: string };

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
  return { ...config, disableThinking: true };
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
    });
    const content = parseClinicalOutput(kind, output);
    if (!content) throw new Error("empty clinical output");
    return { success: true, kind, content, provider: route.provider, model: route.model };
  } catch {
    return { success: false, kind, errorCode: "GENERATION_FAILED", error: PUBLIC_ERRORS.GENERATION_FAILED };
  }
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
  transcript: string,
  options: { config?: ClinicalGenerationConfig; reasoner?: ClinicalReasoner } = {}
): Promise<ClinicalOutputsResult> {
  const [summary, soap, focus] = await Promise.all([
    generateClinicalOutput("summary", transcript, options),
    generateClinicalOutput("soap", transcript, options),
    generateClinicalOutput("focus", transcript, options),
  ]);
  return { summary, soap, focus };
}
