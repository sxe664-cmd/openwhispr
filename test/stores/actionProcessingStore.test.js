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

test("local clinical extraction always uses section-scoped requests", () => {
  const template = "## History of Present Illness\n### Current Complaints:\n## Plan\n### Follow-up:";
  const requests = planLocalClinicalEncounterRequests("Patient reports back pain.", template, 100_000);

  assert.equal(requests.length, 8);
  assert.ok(requests.every((request) => request.sectionKey));
});

test("local clinical extraction splits unusually long transcripts within each section", () => {
  const template = "## History of Present Illness\n### Current Complaints:\n## Plan\n### Follow-up:";
  const requests = planLocalClinicalEncounterRequests("x".repeat(12_000), template, 5_000);

  assert.ok(requests.length > 8);
  assert.deepEqual(new Set(requests.map((request) => request.sectionKey)), new Set([
    "historyOfPresentIllness",
    "previousAndCurrentIllnesses",
    "reviewOfSystems",
    "physicalExamination",
    "conclusion",
    "diagnosis",
    "interventions",
    "plan",
  ]));
  assert.ok(requests.every((request) => request.fieldKeys.length > 0));
});
