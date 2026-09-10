const test = require("node:test");
const assert = require("node:assert/strict");

async function load() {
  return import("../../src/helpers/encounterOutputGeneration.ts");
}

function output(overrides = {}) {
  return {
    encounter_id: 42,
    transcript_hash: "canonical-sha256",
    transcript_revision: 8,
    summary: null,
    soap: null,
    focus: null,
    summary_status: "processing",
    soap_status: "processing",
    focus_status: "processing",
    status: "processing",
    summary_provider: null,
    summary_model: null,
    soap_provider: null,
    soap_model: null,
    focus_provider: null,
    focus_model: null,
    summary_error_code: null,
    soap_error_code: null,
    focus_error_code: null,
    created_at: "2026-08-14 13:00:00",
    updated_at: "2026-08-14 13:00:00",
    summary_updated_at: null,
    soap_updated_at: null,
    focus_updated_at: null,
    ...overrides,
  };
}

function generatedResult() {
  return {
    summary: {
      success: true,
      kind: "summary",
      content: "Current summary",
      provider: "local",
      model: "qwen-local",
    },
    soap: {
      success: true,
      kind: "soap",
      content: "Current SOAP",
      provider: "local",
      model: "qwen-local",
    },
    focus: {
      success: true,
      kind: "focus",
      content: "Medication follow-up",
      provider: "local",
      model: "qwen-local",
    },
  };
}

test("guarded renderer orchestration generates from begin's canonical transcript", async () => {
  const { runEncounterOutputGeneration } = await load();
  const calls = [];
  const begunOutput = output();
  const readyOutput = output({
    transcript_revision: 8,
    summary: "Current summary",
    soap: "Current SOAP",
    focus: "Medication follow-up",
    summary_status: "ready",
    soap_status: "ready",
    focus_status: "ready",
    status: "ready",
  });
  const bridge = {
    beginEncounterOutputGeneration: async (encounterId, outputTypes) => {
      calls.push(["begin", encounterId, outputTypes]);
      return {
        success: true,
        output: begunOutput,
        transcript: "Canonical transcript from main",
        token: { transcriptRevision: 8, transcriptHash: "canonical-sha256", generationId: "generation-1" },
      };
    },
    finishEncounterOutputGeneration: async (encounterId, token, updates) => {
      calls.push(["finish", encounterId, token, updates]);
      return { success: true, applied: true, output: readyOutput };
    },
  };

  let generatedTranscript;
  const result = await runEncounterOutputGeneration(bridge, 42, false, async (transcript) => {
    generatedTranscript = transcript;
    return generatedResult();
  });

  assert.equal(generatedTranscript, "Canonical transcript from main");
  assert.equal(result.status, "applied");
  assert.equal(result.output.summary, "Current summary");
  assert.equal(calls[0][0], "begin");
  assert.equal(calls[1][0], "finish");
  assert.deepEqual(calls[1][2], {
    transcriptRevision: 8,
    transcriptHash: "canonical-sha256",
    generationId: "generation-1",
  });
  assert.equal(calls[1][3].summary_status, "ready");
  assert.equal(calls[1][3].soap_status, "ready");
  assert.equal(calls[1][3].focus, "Medication follow-up");
  assert.equal(calls[1][3].focus_status, "ready");
  assert.equal(calls[1][3].focus_provider, "local");
  assert.equal(calls[1][3].focus_model, "qwen-local");
});

test("deferred finish adopts the newer non-ready output and releases the attempt", async () => {
  const { runEncounterOutputGeneration } = await load();
  const newerOutput = output({
    transcript_hash: "newer-sha256",
    transcript_revision: 9,
    summary_status: "pending",
    soap_status: "pending",
    focus_status: "pending",
    status: "pending",
  });
  let finishedUpdates;
  const bridge = {
    beginEncounterOutputGeneration: async () => ({
      success: true,
      output: output(),
      transcript: "Older canonical snapshot",
      token: { transcriptRevision: 8, transcriptHash: "older-sha256", generationId: "generation-2" },
    }),
    finishEncounterOutputGeneration: async (_encounterId, _token, updates) => {
      finishedUpdates = updates;
      return { success: true, applied: false, output: newerOutput };
    },
  };

  const result = await runEncounterOutputGeneration(bridge, 42, false, async () =>
    generatedResult()
  );

  assert.equal(result.status, "superseded");
  assert.equal(result.output, newerOutput);
  assert.notEqual(result.output.status, "ready");
  assert.equal(finishedUpdates.summary_status, "ready");
  assert.equal(finishedUpdates.soap_status, "ready");
  assert.equal(finishedUpdates.focus, "Medication follow-up");
  assert.equal(finishedUpdates.focus_status, "ready");
});

test("generation failure also uses guarded finish for the safe failed state", async () => {
  const { runEncounterOutputGeneration } = await load();
  let failureUpdates;
  const failedOutput = output({
    summary_status: "failed",
    soap_status: "failed",
    focus_status: "failed",
    status: "failed",
    summary_error_code: "GENERATION_FAILED",
    soap_error_code: "GENERATION_FAILED",
    focus_error_code: "GENERATION_FAILED",
  });
  const bridge = {
    beginEncounterOutputGeneration: async () => ({
      success: true,
      output: output(),
      transcript: "Canonical transcript",
      token: { transcriptRevision: 8, transcriptHash: "canonical-sha256", generationId: "generation-3" },
    }),
    finishEncounterOutputGeneration: async (_encounterId, _token, updates) => {
      failureUpdates = updates;
      return { success: true, applied: true, output: failedOutput };
    },
  };

  const result = await runEncounterOutputGeneration(bridge, 42, false, async () => {
    throw new Error("provider detail must stay private");
  });

  assert.equal(result.status, "failed");
  assert.equal(result.output.status, "failed");
  assert.equal(failureUpdates.summary_status, "failed");
  assert.equal(failureUpdates.soap_status, "failed");
  assert.equal(failureUpdates.focus, null);
  assert.equal(failureUpdates.focus_status, "failed");
  assert.equal(failureUpdates.focus_error_code, "GENERATION_FAILED");
  assert.equal(failureUpdates.summary_error_code, "GENERATION_FAILED");
  assert.equal(failureUpdates.soap_error_code, "GENERATION_FAILED");
  assert.equal(failureUpdates.generation_phase, null);
  assert.equal(failureUpdates.generation_next_retry_at, null);
});

test("transient generation failures are marked for bounded automatic retry", async () => {
  const { runEncounterOutputGeneration } = await load();
  let failureUpdates;
  const retryAt = new Date(Date.now() + 5_000).toISOString();
  const bridge = {
    beginEncounterOutputGeneration: async () => ({
      success: true,
      output: output({ generation_attempt: 1 }),
      transcript: "Canonical transcript",
      token: { transcriptRevision: 8, transcriptHash: "canonical-sha256", generationId: "generation-retry" },
    }),
    finishEncounterOutputGeneration: async (_encounterId, _token, updates) => {
      failureUpdates = updates;
      return {
        success: true,
        applied: true,
        output: output({
          summary_status: "failed",
          soap_status: "failed",
          focus_status: "failed",
          status: "failed",
          generation_phase: "retrying",
          generation_next_retry_at: retryAt,
          generation_attempt: 1,
        }),
      };
    },
  };

  const result = await runEncounterOutputGeneration(bridge, 42, false, async () => {
    throw Object.assign(new Error("temporary network timeout"), { code: "ETIMEDOUT" });
  });

  assert.equal(result.status, "failed");
  assert.equal(result.retryable, true);
  assert.equal(result.retryAt, retryAt);
  assert.equal(failureUpdates.generation_phase, "retrying");
  assert.equal(typeof failureUpdates.generation_next_retry_at, "string");

  for (const [attempt, phase] of [
    [2, "retrying"],
    [3, null],
  ]) {
    let updates;
    const boundedBridge = {
      beginEncounterOutputGeneration: async () => ({
        success: true,
        output: output({ generation_attempt: attempt }),
        transcript: "Canonical transcript",
        token: { transcriptRevision: 8, transcriptHash: "canonical-sha256", generationId: `generation-${attempt}` },
      }),
      finishEncounterOutputGeneration: async (_encounterId, _token, nextUpdates) => {
        updates = nextUpdates;
        return { success: true, applied: true, output: output({ generation_phase: phase }) };
      },
    };
    await runEncounterOutputGeneration(boundedBridge, 42, false, async () => {
      throw Object.assign(new Error("temporary network timeout"), { code: "ETIMEDOUT" });
    });
    assert.equal(updates.generation_phase, phase);
  }
});

test("progress callbacks pass through mapping and synthesis state", async () => {
  const { runEncounterOutputGeneration } = await load();
  const progress = [];
  const bridge = {
    beginEncounterOutputGeneration: async () => ({
      success: true,
      output: output({ generation_attempt: 1 }),
      transcript: "Canonical transcript",
      token: { transcriptRevision: 8, transcriptHash: "canonical-sha256", generationId: "generation-progress" },
    }),
    finishEncounterOutputGeneration: async () => ({
      success: true,
      applied: true,
      output: output({ summary_status: "ready", soap_status: "ready", focus_status: "ready", status: "ready" }),
    }),
  };

  await runEncounterOutputGeneration(
    bridge,
    42,
    false,
    async (_transcript, options) => {
      options.onProgress({ phase: "mapping", current: 1, total: 3 });
      options.onProgress({ phase: "synthesizing", current: 1, total: 1 });
      return generatedResult();
    },
    undefined,
    (value) => progress.push(value)
  );

  assert.deepEqual(progress, [
    { phase: "mapping", current: 0, total: 0 },
    { phase: "mapping", current: 1, total: 3 },
    { phase: "synthesizing", current: 1, total: 1 },
  ]);
});
