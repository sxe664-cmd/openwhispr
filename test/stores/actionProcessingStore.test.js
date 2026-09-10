import assert from "node:assert/strict";
import test from "node:test";

import {
  getActionLifecycleSettlement,
  generateLocalClinicalEncounter,
  isEncounterNoteForGeneration,
  planLocalClinicalEncounterRequests,
  resolveEncounterTemplate,
} from "../../src/stores/actionProcessingStore.ts";
import reasoningService from "../../src/services/ReasoningService.ts";

test.after(() => {
  reasoningService.destroy();
});

test("candidate success clears processing while keeping review state until scheduled cleanup", () => {
  assert.deepEqual(getActionLifecycleSettlement("success"), {
    clearProcessing: true,
    clearNoteState: false,
    scheduleSuccessCleanup: true,
  });
});

test("candidate cancellation and failure settle processing immediately", () => {
  for (const outcome of ["cancelled", "failed"]) {
    assert.deepEqual(getActionLifecycleSettlement(outcome), {
      clearProcessing: true,
      clearNoteState: true,
      scheduleSuccessCleanup: false,
    });
  }
});

test("only a real encounter row classifies a meeting note as clinical", () => {
  assert.equal(
    isEncounterNoteForGeneration({
      isMeetingNote: false,
      noteType: "meeting",
      calendarEventId: "calendar-event-123",
    }),
    false
  );
  assert.equal(
    isEncounterNoteForGeneration({
      isMeetingNote: true,
      noteType: "meeting",
      calendarEventId: null,
      hasEncounterLinkage: true,
    }),
    true
  );
  assert.equal(
    isEncounterNoteForGeneration({
      isMeetingNote: true,
      noteType: "note",
      calendarEventId: "calendar-event-123",
    }),
    false
  );
  assert.equal(
    isEncounterNoteForGeneration({
      isMeetingNote: true,
      noteType: "meeting",
      calendarEventId: null,
      hasEncounterLinkage: false,
    }),
    false
  );
});

test("invalid or missing selected encounter templates fall back to the built-in default", async () => {
  const originalWindow = globalThis.window;
  const defaultTemplate = "## History of Present Illness\n### Current Complaints:\n## Plan\n### Follow-up:";
  globalThis.window = {
    localStorage: { getItem: () => null },
    electronAPI: {
      getNoteTemplate: async () => ({
        kind: "encounter",
        active_revision_id: 10,
        template_text: "not a valid encounter template",
      }),
      getDefaultNoteTemplate: async () => ({
        active_revision_id: 11,
        template_text: defaultTemplate,
      }),
    },
  };
  try {
    const result = await resolveEncounterTemplate({ encounterNoteTemplateId: 10 });
    assert.equal(result.revisionId, 11);
    assert.equal(result.templateText, defaultTemplate);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("local clinical extraction uses one evidence request per source chunk", () => {
  const template = "## History of Present Illness\n### Current Complaints:\n## Plan\n### Follow-up:";
  const requests = planLocalClinicalEncounterRequests("Patient reports back pain.", template, 100_000);

  assert.equal(requests.length, 1);
  assert.ok(requests.every((request) => !request.sectionKey));
  assert.ok(requests[0].fieldKeys.includes("historyOfPresentIllness.currentComplaints"));
  assert.match(requests[0].systemPrompt, /Current Complaints/);
});

test("local clinical extraction splits long transcripts with overlapping evidence chunks", () => {
  const template = "## History of Present Illness\n### Current Complaints:\n## Plan\n### Follow-up:";
  const requests = planLocalClinicalEncounterRequests("x".repeat(12_000), template, 5_000);

  assert.ok(requests.length > 1);
  assert.ok(requests.every((request) => !request.sectionKey));
  assert.equal(requests[0].sourceStart, 0);
  assert.equal(requests.at(-1).sourceEnd, 12_000);
  assert.ok(requests.some((request, index) => index > 0 && request.sourceStart < requests[index - 1].sourceEnd));
  assert.ok(requests.every((request) => request.fieldKeys.length > 0));
});

test("local clinical generation keeps native schema output when it validates", async () => {
  const originalWindow = globalThis.window;
  const originalProcessText = reasoningService.processText;
  const calls = [];
  globalThis.window = { electronAPI: {} };
  reasoningService.processText = async (_text, _model, _agent, config) => {
    calls.push(config);
    return JSON.stringify({ fields: [] });
  };
  try {
    const result = await generateLocalClinicalEncounter(
      "Patient reports back pain.",
      "## History of Present Illness\n### Current Complaints:\n## Plan\n### Follow-up:",
      "local-model",
      {}
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].responseFormat.type, "json_schema");
    assert.match(result, /Not documented/);
  } finally {
    reasoningService.processText = originalProcessText;
    globalThis.window = originalWindow;
  }
});

test("local clinical generation retries malformed schema output with simple validated JSON", async () => {
  const originalWindow = globalThis.window;
  const originalProcessText = reasoningService.processText;
  const calls = [];
  globalThis.window = { electronAPI: {} };
  reasoningService.processText = async (_text, _model, _agent, config) => {
    calls.push(config);
    return config.responseFormat ? "{\"wrong\":true}" : JSON.stringify({ fields: [] });
  };
  try {
    const result = await generateLocalClinicalEncounter(
      "Patient reports back pain.",
      "## History of Present Illness\n### Current Complaints:\n## Plan\n### Follow-up:",
      "local-model",
      {}
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].responseFormat.type, "json_schema");
    assert.equal(calls[1].responseFormat, undefined);
    assert.match(result, /Not documented/);
  } finally {
    reasoningService.processText = originalProcessText;
    globalThis.window = originalWindow;
  }
});

test("local clinical generation falls back when the local server rejects native schema", async () => {
  const originalWindow = globalThis.window;
  const originalProcessText = reasoningService.processText;
  const calls = [];
  globalThis.window = { electronAPI: {} };
  reasoningService.processText = async (_text, _model, _agent, config) => {
    calls.push(config);
    if (config.responseFormat) {
      const error = new Error("Local schema unsupported");
      error.code = "LOCAL_SCHEMA_UNSUPPORTED";
      throw error;
    }
    return JSON.stringify({ fields: [] });
  };
  try {
    const result = await generateLocalClinicalEncounter(
      "Patient reports back pain.",
      "## History of Present Illness\n### Current Complaints:\n## Plan\n### Follow-up:",
      "local-model",
      {}
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1].responseFormat, undefined);
    assert.match(result, /Not documented/);
  } finally {
    reasoningService.processText = originalProcessText;
    globalThis.window = originalWindow;
  }
});

test("local clinical generation retries a transient local server failure once", async () => {
  const originalWindow = globalThis.window;
  const originalProcessText = reasoningService.processText;
  const calls = [];
  globalThis.window = { electronAPI: {} };
  reasoningService.processText = async (_text, _model, _agent, config) => {
    calls.push(config);
    if (calls.length === 1) {
      const error = new Error("local server timed out");
      error.code = "LOCAL_SERVER_TIMEOUT";
      throw error;
    }
    return JSON.stringify({ fields: [] });
  };
  try {
    await generateLocalClinicalEncounter(
      "Patient reports back pain.",
      "## History of Present Illness\n### Current Complaints:\n## Plan\n### Follow-up:",
      "local-model",
      {}
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].responseFormat.type, "json_schema");
    assert.equal(calls[1].responseFormat.type, "json_schema");
  } finally {
    reasoningService.processText = originalProcessText;
    globalThis.window = originalWindow;
  }
});

test("local clinical generation rejects malformed fallback output without Markdown", async () => {
  const originalWindow = globalThis.window;
  const originalProcessText = reasoningService.processText;
  const calls = [];
  globalThis.window = { electronAPI: {} };
  reasoningService.processText = async (_text, _model, _agent, config) => {
    calls.push(config);
    return config.responseFormat ? "{\"wrong\":true}" : "## unsupported markdown";
  };
  try {
    await assert.rejects(
      generateLocalClinicalEncounter(
        "Patient reports back pain.",
        "## History of Present Illness\n### Current Complaints:\n## Plan\n### Follow-up:",
        "local-model",
        {}
      ),
      (error) => error.code === "CLINICAL_OUTPUT_INVALID"
    );
    assert.equal(calls.length, 2);
  } finally {
    reasoningService.processText = originalProcessText;
    globalThis.window = originalWindow;
  }
});
