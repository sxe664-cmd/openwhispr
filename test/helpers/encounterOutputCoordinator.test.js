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
