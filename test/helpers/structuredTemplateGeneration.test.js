import assert from "node:assert/strict";
import test from "node:test";
import { generateStructuredClinicalNote } from "../../src/helpers/structuredTemplateGeneration.ts";
import { clinicalEvidenceChunkHash } from "../../src/helpers/clinicalEvidence.ts";
import { migrateLegacyNoteTemplate, validateStructuredNoteTemplate } from "../../src/helpers/structuredNoteTemplate.mjs";

const definition = { version: 1, sections: [
  { id: "concern", label: "Dad's visit notes", type: "canonical", fieldId: "historyOfPresentIllness.currentComplaints", instruction: "", emptyBehavior: "not_documented" },
  { id: "preferences", label: "What matters to the patient", type: "narrative", fieldId: null, instruction: "Document stated preferences only.", emptyBehavior: "omit" },
] };
const evidence = { schemaVersion: 1, contradictions: [], facts: [
  { id: "e0-0", category: "symptom", value: "Back pain", provenance: "transcript", sourceRefs: ["back pain"] },
] };

test("structured templates preserve custom labels and unknown legacy headings as narrative", () => {
  const migrated = migrateLegacyNoteTemplate("## Patient priorities\nExample content is not patient evidence.");
  assert.equal(migrated.definition.sections[0].type, "narrative");
  assert.equal(migrated.definition.sections[0].instruction, "");
  assert.equal(validateStructuredNoteTemplate(definition).sections[0].label, "Dad's visit notes");
  assert.throws(() => validateStructuredNoteTemplate({ version: 1, sections: [definition.sections[0], definition.sections[0]] }));
});

test("legacy clinical headings migrate to canonical fields while custom headings stay flexible", () => {
  const migrated = migrateLegacyNoteTemplate([
    "## Subjective",
    "## Objective",
    "## Assessment",
    "## Plan",
    "## Medications",
    "## Dad's priorities",
  ].join("\n"));
  assert.deepEqual(
    migrated.definition.sections.map((section) => [section.label, section.type, section.fieldId]),
    [
      ["Subjective", "canonical", "historyOfPresentIllness.currentComplaints"],
      ["Objective", "canonical", "physicalExamination.general"],
      ["Assessment", "canonical", "diagnosis.assessment"],
      ["Plan", "canonical", "plan.treatment"],
      ["Medications", "canonical", "previousAndCurrentIllnesses.medicationsAndSupplements"],
      ["Dad's priorities", "narrative", null],
    ]
  );
});

test("template filling retries only invalid sections, preserves valid content, and obeys empty behavior", async () => {
  const prompts = [];
  const result = await generateStructuredClinicalNote({
    source: "Patient reports back pain.", evidence, definition,
    modelId: "local-model", overrides: {}, noteId: 1, sourceHash: "snapshot", templateRevisionId: 1,
    isCancelled: () => false, onProgress: () => {},
    reasoner: { processText: async (_text, _model, _agent, config) => {
      prompts.push(config.systemPrompt);
      return prompts.length === 1
        ? JSON.stringify({ sections: [{ id: "concern", content: "Back pain.", evidenceIds: ["e0-0"] }, { id: "preferences", content: "Invented", evidenceIds: ["missing"] }] })
        : JSON.stringify({ sections: [{ id: "preferences", content: "", evidenceIds: [] }] });
    } },
  });
  assert.equal(prompts.length, 2);
  assert.ok(!prompts[1].includes('"id":"concern"'));
  assert.equal(result, "## Dad's visit notes\n\nBack pain.");
});

test("cancellation during template filling cannot return publishable content", async () => {
  let cancelled = false;
  await assert.rejects(generateStructuredClinicalNote({
    source: "Back pain", evidence, definition, modelId: "local-model", overrides: {}, noteId: 1,
    sourceHash: "snapshot", templateRevisionId: 1, isCancelled: () => cancelled, onProgress: () => {},
    reasoner: { processText: async () => { cancelled = true; return JSON.stringify({ sections: [] }); } },
  }), { code: "CANCELLED" });
});

test("a valid evidence ID cannot authorize unsupported template prose", async () => {
  let calls = 0;
  const result = await generateStructuredClinicalNote({
    source: "Patient reports back pain.", evidence,
    definition: { version: 1, sections: [definition.sections[0]] },
    modelId: "local-model", overrides: {}, noteId: 1, sourceHash: "snapshot",
    templateRevisionId: 1, isCancelled: () => false, onProgress: () => {},
    reasoner: { processText: async () => {
      calls++;
      return JSON.stringify({ sections: [{ id: "concern",
        content: calls === 1 ? "Pneumonia requiring antibiotics" : "Back pain",
        evidenceIds: ["e0-0"] }] });
    } },
  });
  assert.equal(calls, 2);
  assert.equal(result, "## Dad's visit notes\n\nBack pain");
});

test("a weak model falls back to validated evidence for canonical sections", async () => {
  const result = await generateStructuredClinicalNote({
    source: "Patient reports back pain.", evidence,
    definition: { version: 1, sections: [definition.sections[0]] },
    modelId: "local-model", overrides: {}, noteId: 1, sourceHash: "snapshot",
    templateRevisionId: 1, isCancelled: () => false, onProgress: () => {},
    reasoner: { processText: async () => "not json" },
  });
  assert.equal(result, "## Dad's visit notes\n\n- Back pain");
});

test("template generation reuses partial automatic evidence chunks", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = { electronAPI: {
    countLocalModelTokens: async (_model, text) => ({ success: true, tokenCount: Math.ceil(text.length / 4) }),
    getLocalModelRuntimeProfile: async () => ({ success: true, profile: { contextTokens: 16384, maxOutputTokens: 3072 } }),
    getNoteGenerationRun: async () => null,
    saveNoteGenerationRun: async () => ({ success: true }),
  } };
  const source = "Patient reports back pain.";
  let calls = 0;
  try {
    const result = await generateStructuredClinicalNote({
      source,
      reusableEvidenceChunks: [{
        chunk_index: 0,
        chunk_count: 1,
        chunk_hash: clinicalEvidenceChunkHash(source),
        evidence: { schemaVersion: 1, chunkIndex: 0, noRelevantEvidence: false, facts: evidence.facts, issues: [] },
      }],
      definition: { version: 1, sections: [definition.sections[0]] },
      modelId: "local-model", overrides: {}, noteId: 1, sourceHash: "snapshot",
      templateRevisionId: 1, isCancelled: () => false, onProgress: () => {},
      reasoner: { processText: async () => {
        calls += 1;
        return JSON.stringify({ sections: [{ id: "concern", content: "Back pain", evidenceIds: ["e0-0"] }] });
      } },
    });
    assert.equal(calls, 1, "only template population should call the model");
    assert.equal(result, "## Dad's visit notes\n\nBack pain");
  } finally {
    globalThis.window = originalWindow;
  }
});
