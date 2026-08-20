import assert from "node:assert/strict";
import test from "node:test";

import {
  getActionLifecycleSettlement,
  isEncounterNoteForGeneration,
  planLocalClinicalEncounterRequests,
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

test("linked meeting encounters use the clinical template without parsed speaker segments", () => {
  assert.equal(
    isEncounterNoteForGeneration({
      isMeetingNote: false,
      noteType: "meeting",
      calendarEventId: "calendar-event-123",
    }),
    true
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
