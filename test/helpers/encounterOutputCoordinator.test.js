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

test("coordinator serializes duplicate completion events and generates pending output", async () => {
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
    onEncounterRecordingCompleted: (callback) => {
      listeners.completed = callback;
      return () => delete listeners.completed;
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
  listeners.completed({ encounterId: 7 });
  listeners.completed({ encounterId: 7 });
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
