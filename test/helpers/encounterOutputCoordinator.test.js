const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/encounterOutputCoordinator.ts");

function output(status = "pending") {
  return {
    summary_status: status,
    soap_status: status,
    focus_status: status,
  };
}

test("coordinator serializes duplicate recording-saved events and generates pending output", async () => {
  const { createEncounterOutputCoordinator } = await load();
  let beginCalls = 0;
  let generateCalls = 0;
  const listeners = {};
  const bridge = {
    getEncounterOutput: async () => ({ success: true, output: output() }),
    beginEncounterOutputGeneration: async () => {
      beginCalls += 1;
      return {
        success: true,
        output: output("processing"),
        transcript: "Canonical transcript",
        token: { transcriptRevision: 1, transcriptHash: "hash", generationId: "generation-1" },
      };
    },
    finishEncounterOutputGeneration: async () => ({
      success: true,
      applied: true,
      output: output("ready"),
    }),
    onEncounterRecordingSaved: (callback) => {
      listeners.saved = callback;
      return () => delete listeners.saved;
    },
    onNoteUpdated: () => () => {},
    getEncounters: async () => ({ success: true, encounters: [] }),
  };
  const coordinator = createEncounterOutputCoordinator({
    bridge,
    debounceMs: 0,
    generate: async () => {
      generateCalls += 1;
      return {
        summary: {
          success: true,
          kind: "summary",
          content: "Summary",
          provider: "local",
          model: "test",
        },
        soap: { success: true, kind: "soap", content: "SOAP", provider: "local", model: "test" },
        focus: {
          success: true,
          kind: "focus",
          content: "Follow-up",
          provider: "local",
          model: "test",
        },
      };
    },
  });
  coordinator.start();
  listeners.saved({ encounterId: 7 });
  listeners.saved({ encounterId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  coordinator.stop();

  assert.equal(beginCalls, 1);
  assert.equal(generateCalls, 1);
});

test("coordinator reconciles targeted pending outputs instead of scanning the appointment list", async () => {
  const { createEncounterOutputCoordinator } = await load();
  let beginCalls = 0;
  const bridge = {
    getEncountersNeedingOutputGeneration: async () => ({
      success: true,
      encounters: [{ id: 227, note_id: 6, lifecycle_state: "completed" }],
    }),
    getEncounterOutput: async () => ({ success: true, output: output() }),
    beginEncounterOutputGeneration: async () => {
      beginCalls += 1;
      return {
        success: true,
        output: output("processing"),
        transcript: "Canonical transcript",
        token: { transcriptRevision: 1, transcriptHash: "hash", generationId: "generation-1" },
      };
    },
    finishEncounterOutputGeneration: async () => ({
      success: true,
      applied: true,
      output: output("ready"),
    }),
  };
  const coordinator = createEncounterOutputCoordinator({
    bridge,
    debounceMs: 0,
    generate: async () => ({
      summary: { success: true, kind: "summary", content: "Summary", provider: "local", model: "test" },
      soap: { success: true, kind: "soap", content: "SOAP", provider: "local", model: "test" },
      focus: { success: true, kind: "focus", content: "Focus", provider: "local", model: "test" },
    }),
  });
  coordinator.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  coordinator.stop();

  assert.equal(beginCalls, 1);
});

test("a finalized in-progress note update wakes automatic clinical output generation", async () => {
  const { createEncounterOutputCoordinator } = await load();
  const listeners = {};
  let beginCalls = 0;
  const bridge = {
    getEncounterByNote: async () => ({
      success: true,
      encounter: { id: 71, note_id: 9, lifecycle_state: "in_progress" },
    }),
    getEncounterOutput: async () => ({ success: true, output: output() }),
    beginEncounterOutputGeneration: async () => {
      beginCalls += 1;
      return {
        success: true,
        output: { ...output("processing"), generation_attempt: 1 },
        transcript: "Finalized transcript",
        token: {
          transcriptRevision: 4,
          transcriptHash: "transcript-hash",
          sourceRevision: 4,
          sourceHash: "source-hash",
          generationId: "generation-71",
        },
      };
    },
    finishEncounterOutputGeneration: async () => ({
      success: true,
      applied: true,
      output: output("ready"),
    }),
    onNoteUpdated: (callback) => {
      listeners.updated = callback;
      return () => delete listeners.updated;
    },
    getEncountersNeedingOutputGeneration: async () => ({ success: true, encounters: [] }),
  };
  const coordinator = createEncounterOutputCoordinator({
    bridge,
    debounceMs: 0,
    generate: async () => ({
      summary: { success: true, kind: "summary", content: "Summary", provider: "local", model: "test" },
      soap: { success: true, kind: "soap", content: "SOAP", provider: "local", model: "test" },
      focus: { success: true, kind: "focus", content: "Focus", provider: "local", model: "test" },
    }),
  });

  coordinator.start();
  listeners.updated({
    id: 9,
    note_type: "meeting",
    transcript_revision: 4,
    finalized_transcript_revision: 4,
    transcript_persistence_status: "finalized",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  coordinator.stop();

  assert.equal(beginCalls, 1);
});

test("a finalized recording publishes Summary, SOAP, and Focus as one guarded result", async () => {
  const { createEncounterOutputCoordinator } = await load();
  const listeners = {};
  let persistedOutput = {
    ...output(),
    encounter_id: 81,
    transcript_revision: 6,
    transcript_hash: "final-transcript-hash",
    source_revision: 6,
    source_hash: "final-source-hash",
    generation_attempt: 0,
  };
  const token = {
    transcriptRevision: 6,
    transcriptHash: "final-transcript-hash",
    sourceRevision: 6,
    sourceHash: "final-source-hash",
    generationId: "generation-81",
  };
  const bridge = {
    getEncounterOutput: async () => ({ success: true, output: persistedOutput }),
    beginEncounterOutputGeneration: async () => {
      persistedOutput = {
        ...persistedOutput,
        summary_status: "processing",
        soap_status: "processing",
        focus_status: "processing",
        generation_phase: "mapping",
        generation_attempt: 1,
      };
      return {
        success: true,
        output: persistedOutput,
        transcript: "Finalized canonical encounter transcript",
        sourceText: "Finalized canonical encounter transcript",
        token,
      };
    },
    finishEncounterOutputGeneration: async (_encounterId, receivedToken, updates) => {
      assert.deepEqual(receivedToken, token);
      persistedOutput = {
        ...persistedOutput,
        ...updates,
        generation_phase: null,
      };
      return { success: true, applied: true, output: persistedOutput };
    },
    onEncounterRecordingSaved: (callback) => {
      listeners.saved = callback;
      return () => delete listeners.saved;
    },
    getEncountersNeedingOutputGeneration: async () => ({ success: true, encounters: [] }),
  };
  const coordinator = createEncounterOutputCoordinator({
    bridge,
    debounceMs: 0,
    generate: async (source) => {
      assert.equal(source, "Finalized canonical encounter transcript");
      return {
        summary: {
          success: true,
          kind: "summary",
          content: "The patient reports steady improvement.",
          provider: "local",
          model: "test-local",
        },
        soap: {
          success: true,
          kind: "soap",
          content: "Subjective\nImproving\n\nObjective\nDocumented exam\n\nAssessment\nStable\n\nPlan\nFollow up",
          provider: "local",
          model: "test-local",
        },
        focus: {
          success: true,
          kind: "focus",
          content: "Follow-up",
          provider: "local",
          model: "test-local",
        },
      };
    },
  });

  coordinator.start();
  listeners.saved({ encounterId: 81, noteId: 18, transcriptRevision: 6 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  coordinator.stop();

  assert.equal(persistedOutput.summary_status, "ready");
  assert.equal(persistedOutput.soap_status, "ready");
  assert.equal(persistedOutput.focus_status, "ready");
  assert.equal(persistedOutput.summary, "The patient reports steady improvement.");
  assert.match(persistedOutput.soap, /Assessment\nStable/);
  assert.equal(persistedOutput.focus, "Follow-up");
  assert.equal(persistedOutput.summary_provider, "local");
  assert.equal(persistedOutput.soap_model, "test-local");
});

test("coordinator retries a bounded pre-claim hand-off failure", async () => {
  const { createEncounterOutputCoordinator } = await load();
  let beginCalls = 0;
  const bridge = {
    getEncounterOutput: async () => ({ success: true, output: output() }),
    beginEncounterOutputGeneration: async () => {
      beginCalls += 1;
      if (beginCalls === 1) throw new Error("temporary IPC hand-off failure");
      return {
        success: true,
        output: { ...output("processing"), generation_attempt: 1 },
        transcript: "Finalized transcript",
        token: {
          transcriptRevision: 1,
          transcriptHash: "transcript-hash",
          sourceRevision: 1,
          sourceHash: "source-hash",
          generationId: "generation-recovered",
        },
      };
    },
    finishEncounterOutputGeneration: async () => ({
      success: true,
      applied: true,
      output: output("ready"),
    }),
  };
  const coordinator = createEncounterOutputCoordinator({
    bridge,
    debounceMs: 0,
    generate: async () => ({
      summary: { success: true, kind: "summary", content: "Summary", provider: "local", model: "test" },
      soap: { success: true, kind: "soap", content: "SOAP", provider: "local", model: "test" },
      focus: { success: true, kind: "focus", content: "Focus", provider: "local", model: "test" },
    }),
  });

  coordinator.start();
  coordinator.enqueue(72, { priority: 2, delayMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  coordinator.stop();

  assert.equal(beginCalls, 2);
});

test("coordinator gives newly completed encounters priority over delayed backlog", async () => {
  const { createEncounterOutputCoordinator } = await load();
  const beginOrder = [];
  const bridge = {
    getEncounterOutput: async () => ({ success: true, output: output() }),
    beginEncounterOutputGeneration: async (encounterId) => {
      beginOrder.push(encounterId);
      return {
        success: true,
        output: output("processing"),
        transcript: "Canonical transcript",
        token: { transcriptRevision: 1, transcriptHash: "hash", generationId: `generation-${encounterId}` },
      };
    },
    finishEncounterOutputGeneration: async () => ({
      success: true,
      applied: true,
      output: output("ready"),
    }),
  };
  const coordinator = createEncounterOutputCoordinator({
    bridge,
    debounceMs: 0,
    generate: async () => ({
      summary: { success: true, kind: "summary", content: "Summary", provider: "local", model: "test" },
      soap: { success: true, kind: "soap", content: "SOAP", provider: "local", model: "test" },
      focus: { success: true, kind: "focus", content: "Focus", provider: "local", model: "test" },
    }),
  });
  coordinator.start();
  coordinator.enqueue(101, { priority: 0, delayMs: 25 });
  coordinator.enqueue(202, { priority: 2, delayMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  coordinator.stop();

  assert.deepEqual(beginOrder, [202, 101]);
});

test("a current encounter preempts an active historical job between local requests", async () => {
  const { createEncounterOutputCoordinator } = await load();
  const starts = [];
  const priorities = new Map();
  let releaseHistorical;
  const historicalBlocked = new Promise((resolve) => { releaseHistorical = resolve; });
  const bridge = {
    getEncounterOutput: async () => ({ success: true, output: output() }),
    beginEncounterOutputGeneration: async (encounterId) => ({
      success: true,
      output: { ...output("processing"), generation_attempt: 1 },
      transcript: `encounter-${encounterId}`,
      token: {
        transcriptRevision: 1,
        transcriptHash: `transcript-${encounterId}`,
        sourceRevision: 1,
        sourceHash: `source-${encounterId}`,
        generationId: `generation-${encounterId}`,
      },
    }),
    finishEncounterOutputGeneration: async () => ({
      success: true,
      applied: true,
      output: output("ready"),
    }),
  };
  const coordinator = createEncounterOutputCoordinator({
    bridge,
    debounceMs: 0,
    generate: async (source, options) => {
      starts.push(source);
      priorities.set(source, options?.queuePriority);
      if (source === "encounter-101") await historicalBlocked;
      return {
        summary: { success: true, kind: "summary", content: "Summary", provider: "local", model: "test" },
        soap: { success: true, kind: "soap", content: "SOAP", provider: "local", model: "test" },
        focus: { success: true, kind: "focus", content: "Focus", provider: "local", model: "test" },
      };
    },
  });

  coordinator.start();
  coordinator.enqueue(101, { priority: 0, delayMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  coordinator.enqueue(202, { priority: 2, delayMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(starts, ["encounter-101", "encounter-202"]);
  assert.ok(priorities.get("encounter-202") > priorities.get("encounter-101"));
  releaseHistorical();
  await new Promise((resolve) => setTimeout(resolve, 15));
  coordinator.stop();
});
