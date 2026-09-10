import type { ReasoningConfig } from "../services/BaseReasoningService";
import { stripThinkingTags } from "./stripThinking.js";
import { guardLocalRequest, splitGenerationSource } from "./localGenerationBudget";

export const CLINICAL_EVIDENCE_SCHEMA_VERSION = 1;

export type ClinicalEvidenceCategory =
  | "chief_concern"
  | "history"
  | "symptom"
  | "medication"
  | "objective"
  | "assessment"
  | "plan"
  | "follow_up"
  | "additional";

export interface ClinicalEvidenceFact {
  id: string;
  category: ClinicalEvidenceCategory;
  value: string;
  provenance: "transcript" | "manual";
  speaker?: string;
  sourceRefs: string[];
}

export interface ClinicalEvidenceChunk {
  schemaVersion: 1;
  chunkIndex: number;
  noRelevantEvidence: boolean;
  facts: ClinicalEvidenceFact[];
  issues: string[];
}

export interface ClinicalEvidenceV1 {
  schemaVersion: 1;
  facts: ClinicalEvidenceFact[];
  contradictions: Array<{ factIds: string[]; category: ClinicalEvidenceCategory }>;
}

export interface EvidenceReasoner {
  processText(
    text: string,
    model: string,
    agentName?: string | null,
    config?: ReasoningConfig
  ): Promise<string>;
}

const CATEGORIES = new Set<ClinicalEvidenceCategory>([
  "chief_concern",
  "history",
  "symptom",
  "medication",
  "objective",
  "assessment",
  "plan",
  "follow_up",
  "additional",
]);

export const CLINICAL_EVIDENCE_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["facts", "noRelevantEvidence"],
  properties: {
    noRelevantEvidence: { type: "boolean" },
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "value", "provenance", "sourceRefs"],
        properties: {
          category: { type: "string", enum: [...CATEGORIES] },
          value: { type: "string" },
          provenance: { type: "string", enum: ["transcript", "manual"] },
          speaker: { type: "string" },
          sourceRefs: { type: "array", items: { type: "string" }, minItems: 1 },
        },
      },
    },
  },
} as const;

const EXTRACTION_SYSTEM_PROMPT = `Extract only documented clinical evidence from the supplied source portion.
Return JSON matching the provided schema. Every fact must include a concise normalized value and at least one short verbatim source reference copied from the supplied source. Preserve uncertainty and negation. Do not diagnose, infer, calculate, or fill missing information. Typed notes are intentional user evidence and use provenance "manual"; recorded dialogue uses "transcript". Set noRelevantEvidence true only when the source portion genuinely contains no clinical evidence.`;

function parseObject(raw: string): Record<string, unknown> | null {
  const clean = stripThinkingTags(raw)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const candidates = [clean];
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(clean.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }
  return null;
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const GROUNDING_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "by", "for", "from",
  "had", "has", "have", "he", "her", "his", "in", "is", "it", "its", "of", "on",
  "or", "patient", "reports", "reported", "says", "said", "she", "states", "stated",
  "the", "their", "they", "this", "to", "was", "were", "with", "you", "your",
]);

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};
const NEGATION_WORDS = new Set(["no", "not", "never", "denies", "denied", "without", "negative"]);

function groundingTokens(value: string): string[] {
  return (value.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? [])
    .map((token) => NEGATION_WORDS.has(token) ? "__negated__" : NUMBER_WORDS[token] ?? token)
    .filter((token) => token.length > 1 && !GROUNDING_STOP_WORDS.has(token));
}

function tokenMatches(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length > 4 && right.length > 4 && (left.startsWith(right) || right.startsWith(left))) return true;
  // Common inflections such as improve/improving/improvement retain a stable stem.
  return left.length > 5 && right.length > 5 && left.slice(0, 5) === right.slice(0, 5);
}

/** Conservative lexical entailment used after the model has selected citations. */
export function isClinicalClaimGrounded(value: string, evidence: string): boolean {
  const claims = groundingTokens(value);
  if (!claims.length) return false;
  const support = groundingTokens(evidence);
  return claims.every((claim) => support.some((token) => tokenMatches(claim, token)));
}

export function parseClinicalEvidenceChunk(
  raw: string,
  source: string,
  chunkIndex: number
): ClinicalEvidenceChunk {
  const parsed = parseObject(raw);
  if (!parsed) throw Object.assign(new Error("Clinical evidence was malformed."), { code: "CLINICAL_OUTPUT_INVALID" });
  if (!Array.isArray(parsed.facts)) {
    throw Object.assign(new Error("Clinical evidence was malformed."), { code: "CLINICAL_OUTPUT_INVALID" });
  }
  const attempted = parsed.facts;
  const sourceComparable = normalizeSpace(source).toLocaleLowerCase();
  const facts: ClinicalEvidenceFact[] = [];
  const issues: string[] = [];
  for (const [index, candidate] of attempted.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      issues.push(`fact_${index}_invalid`);
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const category = String(record.category ?? "") as ClinicalEvidenceCategory;
    const value = typeof record.value === "string" ? normalizeSpace(record.value).slice(0, 2_000) : "";
    const refs = Array.isArray(record.sourceRefs)
      ? record.sourceRefs.filter((item): item is string => typeof item === "string").map(normalizeSpace).filter(Boolean).slice(0, 6)
      : [];
    const groundedRefs = refs.filter((ref) =>
      sourceComparable.includes(ref.toLocaleLowerCase())
    );
    if (!CATEGORIES.has(category) || !value || groundedRefs.length === 0 ||
        !isClinicalClaimGrounded(value, groundedRefs.join(" ")) ||
        !["manual", "transcript"].includes(String(record.provenance))) {
      issues.push(`fact_${index}_unsupported`);
      continue;
    }
    const provenance = record.provenance === "manual" ? "manual" : "transcript";
    const speaker = normalizeSpace(String(record.speaker ?? ""));
    facts.push({
      id: `e${chunkIndex}-${index}`,
      category,
      value,
      provenance,
      ...(speaker ? { speaker } : {}),
      sourceRefs: groundedRefs,
    });
  }
  const noRelevantEvidence = parsed.noRelevantEvidence === true;
  if (facts.length === 0 && (!noRelevantEvidence || attempted.length > 0)) {
    throw Object.assign(new Error("Clinical evidence could not be grounded."), { code: "CLINICAL_OUTPUT_INVALID" });
  }
  return {
    schemaVersion: CLINICAL_EVIDENCE_SCHEMA_VERSION,
    chunkIndex,
    noRelevantEvidence,
    facts,
    issues,
  };
}

function isTransportFailure(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "").toUpperCase();
  return [
    "INFERENCE_FAILED",
    "LOCAL_INFERENCE_FAILED",
    "LOCAL_SERVER_TIMEOUT",
    "LOCAL_SERVER_UNAVAILABLE",
  ].includes(code);
}

export function clinicalEvidenceRequestConfig(config: ReasoningConfig = {}): ReasoningConfig {
  return {
    ...config,
    systemPrompt: `${EXTRACTION_SYSTEM_PROMPT}\nJSON Schema:\n${JSON.stringify(CLINICAL_EVIDENCE_RESPONSE_SCHEMA)}`,
    temperature: 0.1,
    maxTokens: 2048,
    disableThinking: true,
    requireCompleteOutput: true,
    queuePriority: config.queuePriority ?? -10,
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "openwhispr_clinical_evidence_v1",
        strict: true,
        schema: CLINICAL_EVIDENCE_RESPONSE_SCHEMA,
      },
    },
  };
}

const evidenceSourcePrompt = (source: string) => `SOURCE PORTION START\n${source}\nSOURCE PORTION END`;

export function planClinicalEvidenceChunks(source: string, modelId: string, config: ReasoningConfig = {}) {
  return splitGenerationSource(source, modelId, clinicalEvidenceRequestConfig(config), evidenceSourcePrompt);
}

type EvidenceExtractionOptions = {
  source: string;
  chunkIndex: number;
  modelId: string;
  reasoner: EvidenceReasoner;
  config?: ReasoningConfig;
  onRetry?: () => void;
};

const sharedExtractions = new WeakMap<EvidenceReasoner, Map<string, Promise<ClinicalEvidenceChunk>>>();

export async function extractClinicalEvidenceChunk(options: EvidenceExtractionOptions): Promise<ClinicalEvidenceChunk> {
  let jobs = sharedExtractions.get(options.reasoner);
  if (!jobs) {
    jobs = new Map();
    sharedExtractions.set(options.reasoner, jobs);
  }
  // Exact source equality avoids cross-revision reuse from a weak renderer hash.
  // This bounded in-memory index is private; it is never logged or persisted.
  const key = JSON.stringify([CLINICAL_EVIDENCE_SCHEMA_VERSION, options.modelId, options.config?.provider, options.chunkIndex, options.source]);
  let job = jobs.get(key);
  if (!job) {
    job = extractClinicalEvidenceChunkOnce(options);
    jobs.set(key, job);
    if (jobs.size > 128) jobs.delete(jobs.keys().next().value!);
    void job.catch(() => { if (jobs!.get(key) === job) jobs!.delete(key); });
  }
  return structuredClone(await job);
}

async function extractClinicalEvidenceChunkOnce({
  source,
  chunkIndex,
  modelId,
  reasoner,
  config,
  onRetry,
}: EvidenceExtractionOptions): Promise<ClinicalEvidenceChunk> {
  const userPrompt = evidenceSourcePrompt(source);
  const nativeConfig = await guardLocalRequest(modelId, userPrompt, clinicalEvidenceRequestConfig(config));
  const simpleRequest = async () => {
    onRetry?.();
    const fallbackConfig = await guardLocalRequest(modelId, userPrompt, {
      ...nativeConfig,
      systemPrompt: `${EXTRACTION_SYSTEM_PROMPT}\nJSON contract: ${JSON.stringify(CLINICAL_EVIDENCE_RESPONSE_SCHEMA)}`,
      responseFormat: undefined,
    });
    return parseClinicalEvidenceChunk(
      await reasoner.processText(userPrompt, modelId, null, fallbackConfig), source, chunkIndex
    );
  };
  let raw: string;
  try {
    raw = await reasoner.processText(userPrompt, modelId, null, nativeConfig);
  } catch (error) {
    if ((error as { code?: string })?.code === "LOCAL_SCHEMA_UNSUPPORTED") return simpleRequest();
    if (!isTransportFailure(error)) throw error;
    onRetry?.();
    raw = await reasoner.processText(userPrompt, modelId, null, nativeConfig);
  }
  try {
    return parseClinicalEvidenceChunk(raw, source, chunkIndex);
  } catch (firstError) {
    try {
      return await simpleRequest();
    } catch {
      throw firstError;
    }
  }
}

export function mergeClinicalEvidence(chunks: ClinicalEvidenceChunk[]): ClinicalEvidenceV1 {
  const selected = new Map<string, ClinicalEvidenceFact>();
  for (const fact of chunks.flatMap((chunk) => chunk.facts)) {
    const key = `${fact.category}:${normalizeSpace(fact.value).toLocaleLowerCase()}`;
    const current = selected.get(key);
    if (!current || (fact.provenance === "manual" && current.provenance !== "manual")) {
      selected.set(key, { ...fact, sourceRefs: [...new Set([...(current?.sourceRefs ?? []), ...fact.sourceRefs])] });
    } else {
      current.sourceRefs = [...new Set([...current.sourceRefs, ...fact.sourceRefs])].slice(0, 8);
    }
  }
  const facts = [...selected.values()];
  const contradictions: ClinicalEvidenceV1["contradictions"] = [];
  const byCategory = new Map<ClinicalEvidenceCategory, ClinicalEvidenceFact[]>();
  for (const fact of facts) {
    const list = byCategory.get(fact.category) ?? [];
    list.push(fact);
    byCategory.set(fact.category, list);
  }
  const isNegated = (value: string) => /\b(?:no|not|never|denies|denied|without)\b/i.test(value);
  for (const [category, entries] of byCategory) {
    const conflicting = entries.filter((entry, index) => entries.some((other, otherIndex) => {
      if (index === otherIndex || isNegated(entry.value) === isNegated(other.value)) return false;
      const left = new Set(groundingTokens(entry.value).filter((token) => !["no", "not", "never", "denies", "denied"].includes(token)));
      return groundingTokens(other.value).some((token) => [...left].some((candidate) => tokenMatches(candidate, token)));
    }));
    if (conflicting.length > 1) {
      contradictions.push({ category, factIds: conflicting.map((entry) => entry.id) });
    }
  }
  return { schemaVersion: CLINICAL_EVIDENCE_SCHEMA_VERSION, facts, contradictions };
}

export function serializeClinicalEvidence(evidence: ClinicalEvidenceV1): string {
  return evidence.facts
    .map((fact) => `[${fact.id}] ${fact.category} (${fact.provenance}): ${fact.value}`)
    .join("\n");
}

export function clinicalEvidenceChunkHash(text: string): string {
  let left = 2166136261;
  let right = 2246822519;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ code, 3266489917);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}
