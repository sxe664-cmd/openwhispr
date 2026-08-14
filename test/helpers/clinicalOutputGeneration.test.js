const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/clinicalOutputGeneration.ts");

test("local generation creates separate summary, SOAP, and focus outputs", async () => {
  const { generateClinicalOutputs } = await load();
  const calls = [];
  const reasoner = { processText: async (text, model, _agent, config) => {
    calls.push({ text, model, config });
    if (config.systemPrompt.includes('"summary"')) {
      return '{"summary":"Follow-up visit discussed medication tolerance."}';
    }
    if (config.systemPrompt.includes('"focus"')) return '{"focus":"Medication tolerance follow-up"}';
    return '{"soap":{"subjective":"Reports improvement.","objective":"Not documented","assessment":"Improving symptoms.","plan":"Continue current plan."}}';
  }};
  const result = await generateClinicalOutputs("Patient reports improvement.", {
    reasoner,
    config: { mode: "local", model: "qwen-local" },
  });
  assert.equal(result.summary.success, true);
  assert.equal(result.soap.success, true);
  assert.equal(result.focus.success, true);
  assert.equal(result.focus.content, "Medication tolerance follow-up");
  assert.match(result.soap.content, /Subjective\nReports improvement/);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].config.provider, "local");
  assert.equal(calls[0].config.inferenceScope, "noteFormatting");
  assert.equal(calls[0].config.maxTokens, 700);
  assert.equal(calls.find((call) => call.config.maxTokens === 1200).config.maxTokens, 1200);
  assert.equal(calls.find((call) => call.config.maxTokens === 80).config.maxTokens, 80);
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
