import type { ReasoningConfig } from "../services/BaseReasoningService";
import {
  clinicalEvidenceChunkHash, extractClinicalEvidenceChunk, mergeClinicalEvidence,
  planClinicalEvidenceChunks, isClinicalClaimGrounded,
  type ClinicalEvidenceChunk, type ClinicalEvidenceV1, type EvidenceReasoner,
} from "./clinicalEvidence";
import { boundedEvidenceSource } from "./clinicalOutputGeneration";
import { guardLocalRequest } from "./localGenerationBudget";
import { validateStructuredNoteTemplate, type StructuredNoteTemplate } from "./structuredNoteTemplate.mjs";

const invalid = () => Object.assign(new Error("The clinical note could not be validated."), { code: "CLINICAL_OUTPUT_INVALID" });

function categoriesForField(fieldId: string | null) {
  const key = String(fieldId ?? "").toLocaleLowerCase();
  if (/conclusion|summary|clinicalcourse|responseorimprovement/.test(key)) {
    return ["chief_concern", "history", "symptom", "medication", "objective", "assessment", "plan", "follow_up", "additional"];
  }
  if (/medication|supplement|prescription/.test(key)) return ["medication"];
  if (/objective|physical|examination|vital|measurement|finding/.test(key)) return ["objective"];
  if (/diagnos|assessment|conclusion|impression/.test(key)) return ["assessment"];
  if (/plan|intervention|treatment|referral/.test(key)) return ["plan", "follow_up"];
  if (/follow|return|recheck/.test(key)) return ["follow_up", "plan"];
  if (/chief|complaint|concern/.test(key)) return ["chief_concern", "symptom"];
  if (/symptom|reviewofsystems|\bros\b|pain|limitation/.test(key)) return ["symptom"];
  if (/history|illness|injury|mechanism|onset/.test(key)) return ["history", "chief_concern"];
  return [];
}

export async function generateStructuredClinicalNote(options: {
  source: string;
  evidence?: ClinicalEvidenceV1;
  reusableEvidenceChunks?: Array<{
    chunk_index: number;
    chunk_count: number;
    chunk_hash: string;
    evidence: ClinicalEvidenceChunk;
  }>;
  definition: StructuredNoteTemplate;
  modelId: string;
  overrides: ReasoningConfig;
  reasoner: EvidenceReasoner;
  noteId: number;
  sourceHash: string;
  templateRevisionId: number;
  isCancelled: () => boolean;
  onProgress: (progress: { stage: "extracting" | "compiling" | "retrying"; current: number; total: number }) => void;
}): Promise<string> {
  const definition = validateStructuredNoteTemplate(options.definition);
  const checkCancelled = () => {
    if (options.isCancelled()) throw Object.assign(new Error("Generation cancelled."), { code: "CANCELLED" });
  };
  const reasoner: EvidenceReasoner = { processText: async (...args) => {
    checkCancelled();
    const result = await options.reasoner.processText(...args);
    checkCancelled();
    return result;
  } };
  const completed: Array<{ schemaVersion: 1; chunkHash: string; evidence: ClinicalEvidenceChunk }> = [];
  let chunkCount = 0;
  const saveRun = async (status: "processing" | "failed") => {
    await window.electronAPI.saveNoteGenerationRun?.({
      noteId: options.noteId, templateRevisionId: options.templateRevisionId,
      sourceHash: options.sourceHash, modelId: options.modelId,
      chunkCount, completedChunks: completed.length, extractions: completed, status,
    });
  };
  try {
    let evidence = options.evidence;
    if (!evidence) {
      const chunks = await planClinicalEvidenceChunks(options.source, options.modelId, options.overrides);
      chunkCount = chunks.length;
      const saved = await window.electronAPI.getNoteGenerationRun?.(options.noteId);
      const reusable = saved?.source_hash === options.sourceHash && saved.model_id === options.modelId && saved.chunk_count === chunkCount
        ? saved.extractions as typeof completed : [];
      const encounterReusable = new Map(
        (options.reusableEvidenceChunks ?? [])
          .filter((entry) => entry.chunk_count === chunkCount)
          .map((entry) => [entry.chunk_index, entry])
      );
      for (const [index, chunk] of chunks.entries()) {
        checkCancelled();
        const hash = clinicalEvidenceChunkHash(chunk.text);
        const cached = reusable?.[index];
        const encounterCached = encounterReusable.get(index);
        options.onProgress({ stage: "extracting", current: index, total: chunkCount });
        const extracted = cached?.schemaVersion === 1 && cached.chunkHash === hash && cached.evidence?.schemaVersion === 1
          ? cached.evidence
          : encounterCached?.chunk_hash === hash && encounterCached.evidence?.schemaVersion === 1
            ? encounterCached.evidence
          : await extractClinicalEvidenceChunk({ source: chunk.text, chunkIndex: index, modelId: options.modelId,
              reasoner: options.reasoner, config: { ...options.overrides, queuePriority: 10 },
              onRetry: () => options.onProgress({ stage: "retrying", current: index, total: chunkCount }) });
        checkCancelled();
        completed.push({ schemaVersion: 1, chunkHash: hash, evidence: extracted });
        await saveRun("processing");
      }
      evidence = mergeClinicalEvidence(completed.map((chunk) => chunk.evidence));
    }
    const knownIds = new Set(evidence.facts.map((fact) => fact.id));
    const contents = new Map<string, string>();
    if (!evidence.facts.length) {
      for (const section of definition.sections) contents.set(section.id, "");
    }
    for (let attempt = 0; attempt < 2 && contents.size < definition.sections.length; attempt += 1) {
      checkCancelled();
      const missing = definition.sections.filter((section) => !contents.has(section.id));
      options.onProgress({ stage: attempt ? "retrying" : "compiling", current: contents.size, total: definition.sections.length });
      const systemPrompt = `Populate only the requested clinical template sections using the documented evidence. Labels, instructions, and empty behaviors are presentation metadata, never patient evidence. Do not invent normal findings, diagnoses, medications, or plans. Preserve uncertainty, negation, and disagreements. Return JSON {sections:[{id:string,content:string,evidenceIds:string[]}]}. Use the exact requested section IDs. Every nonempty section must cite supporting evidence IDs. If nothing supports a section, content must be an empty string and evidenceIds an empty array. Return only JSON.\nSECTIONS:\n${JSON.stringify(missing)}`;
      const source = await boundedEvidenceSource(evidence, { ok: true, provider: "local", model: options.modelId, overrides: options.overrides }, reasoner, systemPrompt);
      const config = await guardLocalRequest(options.modelId, source, {
        ...options.overrides, systemPrompt, maxTokens: 2048, disableThinking: true,
        requireCompleteOutput: true, temperature: 0.1, queuePriority: 10,
      });
      const raw = await reasoner.processText(source, options.modelId, null, config);
      let parsed: { sections?: Array<{ id?: unknown; content?: unknown; evidenceIds?: unknown }> };
      try { parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
      catch { continue; }
      if (!Array.isArray(parsed.sections)) continue;
      const allowedSections = new Set(missing.map((section) => section.id));
      const seen = new Set<string>();
      for (const section of parsed.sections) {
        if (typeof section.id !== "string" || !allowedSections.has(section.id) || seen.has(section.id)) continue;
        seen.add(section.id);
        if (typeof section.content !== "string" || !Array.isArray(section.evidenceIds)) continue;
        const content = section.content.trim();
        if (section.evidenceIds.some((id) => typeof id !== "string" || !knownIds.has(id))) continue;
        if (content && (!section.evidenceIds.length || /^(?:sorry|i cannot|i can't|error:|system prompt:)/i.test(content))) continue;
        if (content && !isClinicalClaimGrounded(content, section.evidenceIds.flatMap((id) => {
          const fact = evidence.facts.find((candidate) => candidate.id === id);
          return fact ? [fact.value, ...fact.sourceRefs] : [];
        }).join(" "))) continue;
        if (!content && section.evidenceIds.length) continue;
        contents.set(section.id, content);
      }
    }
    // A weak model should not make the entire template unusable. Canonical
    // sections have deterministic semantics, so fill any remaining supported
    // section directly from validated facts. Narrative sections remain empty
    // rather than guessing what a custom heading means.
    for (const section of definition.sections) {
      if (contents.has(section.id)) continue;
      const categories = section.type === "canonical" ? categoriesForField(section.fieldId) : [];
      const values = evidence.facts
        .filter((fact) => categories.includes(fact.category))
        .map((fact) => fact.value);
      contents.set(section.id, [...new Set(values)].map((value) => `- ${value}`).join("\n"));
    }
    checkCancelled();
    if (contents.size !== definition.sections.length) throw invalid();
    if (evidence.facts.length && [...contents.values()].every((value) => !value)) throw invalid();
    return definition.sections.flatMap((section) => {
      const content = contents.get(section.id) ?? "";
      if (!content && section.emptyBehavior === "omit") return [];
      return [`## ${section.label}\n\n${content || (section.emptyBehavior === "not_documented" ? "Not documented" : "")}`];
    }).join("\n\n");
  } catch (error) {
    if (chunkCount) await saveRun("failed").catch(() => undefined);
    throw error;
  }
}
