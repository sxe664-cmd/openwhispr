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

const MAX_TRANSCRIPT_CHARS = 24_000;
const MAX_SUMMARY_CHARS = 8_000;
const MAX_SOAP_FIELD_CHARS = 4_000;
const MAX_FOCUS_CHARS = 120;

const PUBLIC_ERRORS: Record<ClinicalOutputErrorCode, string> = {
  LOCAL_MODEL_NOT_CONFIGURED: "Choose a downloaded local note model before generating clinical notes.",
  BYOK_NOT_CONFIGURED: "Configure a BYOK note provider before generating clinical notes.",
  GENERATION_FAILED: "Clinical note generation could not be completed. Your transcript is saved; try again.",
};

function boundedTranscript(transcript: string): string {
  const clean = transcript.trim();
  if (clean.length <= MAX_TRANSCRIPT_CHARS) return clean;
  const head = Math.floor(MAX_TRANSCRIPT_CHARS * 0.7);
  const tail = MAX_TRANSCRIPT_CHARS - head;
  return `${clean.slice(0, head)}\n\n[Transcript shortened for note generation]\n\n${clean.slice(-tail)}`;
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

export async function generateClinicalOutput(
  kind: ClinicalOutputKind,
  transcript: string,
  options: { config?: ClinicalGenerationConfig; reasoner?: ClinicalReasoner } = {}
): Promise<ClinicalOutputResult> {
  const route = routeFor(options.config ?? getClinicalGenerationConfig());
  if (route.ok === false) {
    return { success: false, kind, errorCode: route.errorCode, error: PUBLIC_ERRORS[route.errorCode] };
  }
  if (!transcript.trim()) {
    return { success: false, kind, errorCode: "GENERATION_FAILED", error: PUBLIC_ERRORS.GENERATION_FAILED };
  }

  try {
    const output = await (await resolveReasoner(options.reasoner)).processText(
      boundedTranscript(transcript),
      route.model,
      null,
      {
        ...route.overrides,
        systemPrompt: getClinicalOutputSystemPrompt(kind),
        maxTokens: kind === "focus" ? 80 : kind === "summary" ? 700 : 1_200,
        temperature: 0.1,
        requireCompleteOutput: true,
      }
    );
    const content = parseClinicalOutput(kind, output);
    if (!content) throw new Error("empty clinical output");
    return { success: true, kind, content, provider: route.provider, model: route.model };
  } catch {
    return { success: false, kind, errorCode: "GENERATION_FAILED", error: PUBLIC_ERRORS.GENERATION_FAILED };
  }
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
