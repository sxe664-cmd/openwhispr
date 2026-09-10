const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/clinicalOutputGeneration.ts");

test("invalid SOAP retries alone while valid summary and focus remain unchanged", async () => {
  const { generateClinicalOutputs } = await load();
  const prompts = [];
  const entry = (text) => ({ text, evidenceIds: ["e0-0"] });
  const missing = { text: "Not documented", evidenceIds: [] };
  const result = await generateClinicalOutputs("Patient reports back pain.", {
    config: { mode: "local", model: "local-model" },
    reasoner: { processText: async (_text, _model, _agent, config) => {
      if (config.responseFormat?.json_schema?.name === "openwhispr_clinical_evidence_v1") {
        return JSON.stringify({ facts: [{ category: "symptom", value: "Back pain", provenance: "transcript", sourceRefs: ["back pain"] }], noRelevantEvidence: false });
      }
      prompts.push(config.systemPrompt);
      if (prompts.length === 1) return JSON.stringify({ summary: entry("Back pain."), focus: entry("Back pain"), soap: {} });
      return JSON.stringify({ summary: entry("Do not overwrite."), soap: { subjective: entry("Back pain."), objective: missing, assessment: missing, plan: missing } });
    } },
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Return only these output types: soap\./);
  assert.equal(result.summary.content, "Back pain.");
  assert.equal(result.focus.content, "Back pain");
  assert.equal(result.soap.success, true);
});

test("unsupported synthesis is replaced with grounded deterministic clinical outputs", async () => {
  const { generateClinicalOutputs } = await load();
  const calls = [];
  const reasoner = { processText: async (text, model, _agent, config) => {
    calls.push({ text, model, config });
    if (config.responseFormat?.json_schema?.name === "openwhispr_clinical_evidence_v1") {
      return '{"facts":[{"category":"symptom","value":"Improvement reported","provenance":"transcript","sourceRefs":["Patient reports improvement."]}],"noRelevantEvidence":false}';
    }
    return '{"summary":{"text":"Follow-up visit discussed medication tolerance.","evidenceIds":["e0-0"]},"soap":{"subjective":{"text":"Reports improvement.","evidenceIds":["e0-0"]},"objective":{"text":"Not documented","evidenceIds":[]},"assessment":{"text":"Improving symptoms.","evidenceIds":["e0-0"]},"plan":{"text":"Continue current plan.","evidenceIds":["e0-0"]}},"focus":{"text":"Medication tolerance follow-up","evidenceIds":["e0-0"]}}';
  }};
  const progress = [];
  const result = await generateClinicalOutputs("Patient reports improvement.", {
    reasoner,
    config: { mode: "local", model: "qwen-local" },
    onProgress: (value) => progress.push(value),
  });
  assert.equal(result.summary.success, true);
  assert.equal(result.soap.success, true);
  assert.equal(result.focus.success, true);
  assert.equal(result.focus.content, "Improvement reported");
  assert.doesNotMatch(result.summary.content, /medication|tolerance|continue/i);
  assert.match(result.soap.content, /Subjective\n- Improvement reported/);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].config.provider, "local");
  assert.equal(calls[0].config.inferenceScope, "noteFormatting");
  assert.ok(calls[0].config.maxTokens <= 2048);
  assert.equal(progress[0].phase, "mapping");
  assert.equal(progress.at(-1).phase, "synthesizing");
});

test("long transcript generation shares mapped chunks and one final synthesis", async () => {
  const { generateClinicalOutputs } = await load();
  const { planClinicalEvidenceChunks } = await import("../../src/helpers/clinicalEvidence.ts");
  const transcript = [
    "Beginning of encounter.",
    "routine detail ".repeat(1_500),
    "The middle-only finding is a documented change in shoulder pain.",
    "routine detail ".repeat(1_500),
    "End of encounter.",
  ].join(" ");
  const chunks = await planClinicalEvidenceChunks(transcript, "qwen-local");
  const calls = [];
  const progress = [];
  const result = await generateClinicalOutputs(transcript, {
    reasoner: {
      processText: async (text, _model, _agent, config) => {
        calls.push({ text, config });
        if (config.responseFormat?.json_schema?.name === "openwhispr_clinical_evidence_v1") {
          const sourceRef = text.includes("middle-only")
            ? "The middle-only finding is a documented change in shoulder pain."
            : text.includes("Beginning of encounter.")
              ? "Beginning of encounter."
              : text.includes("End of encounter.")
                ? "End of encounter."
                : "routine detail";
          return JSON.stringify({
            facts: [{ category: "history", value: sourceRef, provenance: "transcript", sourceRefs: [sourceRef] }],
            noRelevantEvidence: false,
          });
        }
        return JSON.stringify({
          summary: { text: "Beginning of encounter.", evidenceIds: ["e0-0"] },
          soap: {
            subjective: { text: "Beginning of encounter.", evidenceIds: ["e0-0"] },
            objective: { text: "Not documented", evidenceIds: [] },
            assessment: { text: "Not documented", evidenceIds: [] },
            plan: { text: "Not documented", evidenceIds: [] },
          },
          focus: { text: "Beginning encounter", evidenceIds: ["e0-0"] },
        });
      },
    },
    config: { mode: "local", model: "qwen-local" },
    onProgress: (value) => progress.push(value),
  });

  assert.ok(chunks.length > 1);
  assert.equal(calls.length, chunks.length + 1);
  assert.ok(calls.some((call) => call.text.includes("middle-only")));
  assert.ok(calls.at(-1).config.maxTokens <= 2048);
  assert.equal(progress.at(-1).phase, "synthesizing");
  assert.equal(progress.at(-1).current, 1);
  assert.equal(result.success, undefined);
  assert.equal(result.summary.success, true);
});

test("hour-scale generation retains grounded beginning, middle, and ending facts", async () => {
  const { generateClinicalOutputs } = await load();
  const filler = "Speaker 1: Discussion continued without a new clinical fact.\n".repeat(1_800);
  const source = [
    "Patient reports neck pain.", filler,
    "Patient denies numbness.", filler,
    "Follow up in two weeks.",
  ].join("\n");
  const result = await generateClinicalOutputs(source, {
    config: { mode: "local", model: "qwen-local" },
    reasoner: { processText: async (text, _model, _agent, config) => {
      if (!config.responseFormat?.json_schema) return "{}";
      const facts = [];
      if (text.includes("reports neck pain")) facts.push({ category: "symptom", value: "Neck pain", provenance: "transcript", sourceRefs: ["reports neck pain"] });
      if (text.includes("denies numbness")) facts.push({ category: "symptom", value: "Denies numbness", provenance: "transcript", sourceRefs: ["denies numbness"] });
      if (text.includes("Follow up in two weeks")) facts.push({ category: "follow_up", value: "Follow up in two weeks", provenance: "transcript", sourceRefs: ["Follow up in two weeks"] });
      return JSON.stringify({ facts, noRelevantEvidence: facts.length === 0 });
    } },
  });
  assert.equal(result.summary.success, true);
  assert.match(result.summary.content, /Neck pain/);
  assert.match(result.summary.content, /Denies numbness/);
  assert.match(result.summary.content, /Follow up in two weeks/);
  assert.match(result.soap.content, /Plan\n- Follow up in two weeks/);
});

test("malformed synthesis falls back to grounded evidence instead of failing the encounter", async () => {
  const { generateClinicalOutputs } = await load();
  const result = await generateClinicalOutputs("Patient reports back pain.", {
    config: { mode: "local", model: "qwen-local" },
    reasoner: {
      processText: async (_text, _model, _agent, config) =>
        config.responseFormat?.json_schema?.name === "openwhispr_clinical_evidence_v1"
          ? '{"facts":[{"category":"symptom","value":"Back pain","provenance":"transcript","sourceRefs":["back pain"]}],"noRelevantEvidence":false}'
          : "{}",
    },
  });
  assert.equal(result.summary.success, true);
  assert.equal(result.summary.content, "- Back pain");
  assert.equal(result.soap.success, true);
  assert.equal(result.focus.content, "Back pain");
});

test("long transcript generation maps every chunk before synthesis", async () => {
  const { generateClinicalOutput, splitClinicalTranscript } = await load();
  const transcript = [
    "Beginning of encounter.",
    "routine detail ".repeat(1_500),
    "The middle-only finding is a documented change in shoulder pain.",
    "routine detail ".repeat(1_500),
    "End of encounter.",
  ].join(" ");
  const chunks = splitClinicalTranscript(transcript);
  const calls = [];
  const result = await generateClinicalOutput("summary", transcript, {
    reasoner: {
      processText: async (text, _model, _agent, config) => {
        calls.push({ text, config });
        return JSON.stringify({ summary: text.includes("middle-only") ? "Middle finding captured." : "Chunk captured." });
      },
    },
    config: { mode: "local", model: "qwen-local" },
  });

  assert.ok(chunks.length > 1);
  assert.ok(chunks.some((chunk) => chunk.text.includes("middle-only")));
  assert.ok(calls.length >= chunks.length + 1);
  assert.ok(calls.some((call) => call.text.includes("middle-only")));
  assert.equal(result.success, true);
});

test("missing local model fails safely without invoking a provider", async () => {
  const { generateClinicalOutput } = await load();
  let called = false;
  const result = await generateClinicalOutput("summary", "Transcript", {
    reasoner: { processText: async () => { called = true; return "bad"; } },
    config: { mode: "local", model: "" },
  });
  assert.deepEqual(result, {
    success: false,
    kind: "summary",
    errorCode: "LOCAL_MODEL_NOT_CONFIGURED",
    error: "Choose a downloaded local note model before generating clinical notes.",
  });
  assert.equal(called, false);
});

test("BYOK requires an explicit selected provider and never inherits a remote fallback", async () => {
  const { generateClinicalOutput } = await load();
  let called = false;
  const reasoner = { processText: async () => { called = true; return '{"summary":"ok"}'; } };
  const noFallback = await generateClinicalOutput("summary", "Transcript", {
    reasoner,
    config: { mode: "providers", provider: "openai", model: "gpt", cloudMode: "" },
  });
  assert.equal(noFallback.success, false);
  assert.equal(noFallback.errorCode, "BYOK_NOT_CONFIGURED");
  assert.equal(called, false);
  const configured = await generateClinicalOutput("summary", "Transcript", {
    reasoner,
    config: { mode: "providers", provider: "openai", model: "gpt", cloudMode: "byok" },
  });
  assert.equal(configured.success, true);
  assert.equal(called, true);
});

test("parser accepts structured JSON and deterministically falls back to plain output", async () => {
  const { parseClinicalOutput } = await load();
  assert.equal(parseClinicalOutput("summary", "```json\n{\"summary\":\"Clear summary\"}\n```"), "Clear summary");
  assert.equal(parseClinicalOutput("focus", '{"focus":"Blood pressure follow-up"}'), "Blood pressure follow-up");
  assert.equal(parseClinicalOutput("soap", "free-form fallback"), "free-form fallback");
  assert.match(
    parseClinicalOutput("soap", '{"soap":{"subjective":"S","objective":"O","assessment":"A","plan":"P"}}'),
    /Assessment\nA/
  );
});

test("SOAP display formatting creates stable headings without changing clinical text", async () => {
  const { formatClinicalOutputForDisplay } = await load();
  const formatted = formatClinicalOutputForDisplay(
    "soap",
    "Generated SOAP note\n\nSubjective\nReports improvement.\n\nObjective\n\nAssessment\nImproving symptoms.\n\nPlan\nFollow-up in two weeks."
  );

  assert.match(formatted, /^## SOAP note\n\nGenerated SOAP note/);
  assert.match(formatted, /## Subjective\n\nReports improvement\./);
  assert.match(formatted, /## Objective\n\nNot documented/);
  assert.match(formatted, /## Assessment\n\nImproving symptoms\./);
  assert.match(formatted, /## Plan\n\nFollow-up in two weeks\./);
});

test("SOAP display formatting leaves unstructured output unchanged", async () => {
  const { formatClinicalOutputForDisplay } = await load();
  assert.equal(
    formatClinicalOutputForDisplay("soap", "The model returned a plain clinical narrative."),
    "The model returned a plain clinical narrative."
  );
  assert.equal(formatClinicalOutputForDisplay("summary", "A concise summary."), "A concise summary.");
});

test("provider failures return a fixed public error and keep raw exception details private", async () => {
  const { generateClinicalOutput } = await load();
  const result = await generateClinicalOutput("soap", "Transcript", {
    config: { mode: "local", model: "qwen" },
    reasoner: { processText: async () => { throw new Error("C:\\private\\secret.json token=abc"); } },
  });
  assert.deepEqual(result, {
    success: false,
    kind: "soap",
    errorCode: "GENERATION_FAILED",
    error: "Clinical note generation could not be completed. Your transcript is saved; try again.",
  });
});
