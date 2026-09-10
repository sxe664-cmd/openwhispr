import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeClinicalEvidence,
  parseClinicalEvidenceChunk,
  extractClinicalEvidenceChunk,
} from "../../src/helpers/clinicalEvidence.ts";

test("automatic and manual callers share identical chunk extraction without mutable cache leaks", async () => {
  let calls = 0;
  const reasoner = { processText: async () => {
    calls += 1;
    return JSON.stringify({ facts: [{ category: "symptom", value: "Back pain", provenance: "transcript", sourceRefs: ["back pain"] }], noRelevantEvidence: false });
  } };
  const options = { source: "Patient reports back pain.", chunkIndex: 0, modelId: "local", reasoner };
  const [first, second] = await Promise.all([extractClinicalEvidenceChunk(options), extractClinicalEvidenceChunk(options)]);
  assert.equal(calls, 1);
  first.facts[0].sourceRefs.push("mutation");
  assert.deepEqual(second.facts[0].sourceRefs, ["back pain"]);
});

test("native schema rejection retries once with a complete simple JSON contract", async () => {
  const requests = [];
  const result = await extractClinicalEvidenceChunk({
    source: "Back pain", chunkIndex: 0, modelId: "weak-local",
    reasoner: { processText: async (_source, _model, _agent, config) => {
      requests.push(config);
      if (requests.length === 1) throw Object.assign(new Error("safe"), { code: "LOCAL_SCHEMA_UNSUPPORTED" });
      return '```json\n{"facts":[{"category":"symptom","value":"Back pain","provenance":"transcript","sourceRefs":["Back pain"]}],"noRelevantEvidence":false}\n```';
    } },
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].responseFormat.type, "json_schema");
  assert.equal(requests[1].responseFormat, undefined);
  assert.match(requests[1].systemPrompt, /sourceRefs/);
  assert.equal(result.facts.length, 1);
});

test("clinical evidence keeps grounded valid facts while reporting malformed neighbors", () => {
  const parsed = parseClinicalEvidenceChunk(
    JSON.stringify({
      noRelevantEvidence: false,
      facts: [
        {
          category: "symptom",
          value: "Back pain for two days",
          provenance: "transcript",
          sourceRefs: ["back pain for two days"],
        },
        {
          category: "unsupported_field",
          value: "Invented",
          provenance: "transcript",
          sourceRefs: ["not in source"],
        },
      ],
    }),
    "Patient reports back pain for two days.",
    0
  );
  assert.equal(parsed.facts.length, 1);
  assert.equal(parsed.facts[0].category, "symptom");
  assert.deepEqual(parsed.issues, ["fact_1_unsupported"]);
});

test("clinical evidence rejects semantically empty attempted facts", () => {
  assert.throws(
    () =>
      parseClinicalEvidenceChunk(
        '{"facts":[{"category":"symptom","value":"Pneumonia","provenance":"transcript","sourceRefs":["pneumonia"]}],"noRelevantEvidence":false}',
        "Patient reports back pain.",
        0
      ),
    (error) => error.code === "CLINICAL_OUTPUT_INVALID"
  );
});

test("a real quote cannot support a different clinical claim", () => {
  assert.throws(
    () => parseClinicalEvidenceChunk(
      '{"facts":[{"category":"medication","value":"Continue aspirin","provenance":"transcript","sourceRefs":["back pain"]}],"noRelevantEvidence":false}',
      "Patient reports back pain.", 0
    ),
    { code: "CLINICAL_OUTPUT_INVALID" }
  );
});

test("safe negation and simple inflection normalization are not over-rejected", () => {
  const parsed = parseClinicalEvidenceChunk(
    '{"facts":[{"category":"symptom","value":"No fever; improving","provenance":"transcript","sourceRefs":["denies fever and reports improvement"]}],"noRelevantEvidence":false}',
    "Patient denies fever and reports improvement.", 0
  );
  assert.equal(parsed.facts.length, 1);
});

test("a malformed facts container cannot claim empty evidence", () => {
  for (const facts of [null, {}, "none"]) {
    assert.throws(() => parseClinicalEvidenceChunk(JSON.stringify({ facts, noRelevantEvidence: true }), "Back pain", 0), { code: "CLINICAL_OUTPUT_INVALID" });
  }
});

test("manual evidence wins duplicate presentation priority without deleting transcript provenance", () => {
  const merged = mergeClinicalEvidence([
    {
      schemaVersion: 1,
      chunkIndex: 0,
      noRelevantEvidence: false,
      issues: [],
      facts: [{ id: "e0-0", category: "plan", value: "Follow up in two weeks", provenance: "transcript", sourceRefs: ["follow up in two weeks"] }],
    },
    {
      schemaVersion: 1,
      chunkIndex: 1,
      noRelevantEvidence: false,
      issues: [],
      facts: [{ id: "e1-0", category: "plan", value: "Follow up in two weeks", provenance: "manual", sourceRefs: ["Follow up in two weeks"] }],
    },
  ]);
  assert.equal(merged.facts.length, 1);
  assert.equal(merged.facts[0].provenance, "manual");
});

test("same-category facts are not called contradictions unless their grounded statements conflict", () => {
  const chunk = (index, id, value) => ({ schemaVersion: 1, chunkIndex: index,
    noRelevantEvidence: false, issues: [], facts: [{ id, category: "symptom", value,
      provenance: "transcript", sourceRefs: [value] }] });
  assert.deepEqual(mergeClinicalEvidence([
    chunk(0, "e0-0", "Back pain"), chunk(1, "e1-0", "Shoulder stiffness"),
  ]).contradictions, []);
  assert.equal(mergeClinicalEvidence([
    chunk(0, "e0-0", "Reports back pain"), chunk(1, "e1-0", "Denies back pain"),
  ]).contradictions.length, 1);
});
