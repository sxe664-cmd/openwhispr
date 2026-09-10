const test = require("node:test");
const assert = require("node:assert/strict");

async function load() {
  return import("../../src/helpers/encounterStatus.ts");
}

function output(status) {
  return {
    summary_status: status,
    soap_status: status,
    focus_status: status,
  };
}

test("clinical output stages distinguish queued, active, ready, failed, and stale", async () => {
  const { outputStatus } = await load();

  assert.equal(outputStatus(output("pending")), "queued");
  assert.equal(outputStatus(output("processing")), "active");
  assert.equal(outputStatus(output("ready")), "ready");
  assert.equal(outputStatus(output("failed")), "failed");
  assert.equal(outputStatus(output("stale")), "stale");
  assert.equal(outputStatus({ ...output("failed"), generation_phase: "retrying" }), "retrying");
  assert.equal(outputStatus(null), "idle");
});

test("clinical generation stays waiting while transcript or diarization is incomplete", async () => {
  const { clinicalStatus, isTranscriptPersistenceBusy, transcriptStageStatus } = await load();
  const readyOutput = output("ready");
  const pendingOutput = output("pending");

  for (const transcriptStatus of ["recording", "finalizing", "saving"]) {
    assert.equal(isTranscriptPersistenceBusy(transcriptStatus), true);
    assert.equal(
      transcriptStageStatus({
        hasTranscript: true,
        isRecording: transcriptStatus === "recording",
        isProcessingTranscript: false,
        transcriptStatus,
      }),
      "active"
    );
    assert.equal(
      clinicalStatus(readyOutput, {
        hasTranscript: true,
        transcriptBusy: true,
        diarizationBusy: false,
      }),
      "idle"
    );
  }

  assert.equal(
    clinicalStatus(pendingOutput, {
      hasTranscript: true,
      transcriptBusy: false,
      diarizationBusy: true,
    }),
    "idle"
  );
  assert.equal(
    clinicalStatus(pendingOutput, {
      hasTranscript: true,
      transcriptBusy: false,
      diarizationBusy: false,
    }),
    "queued"
  );
});

test("clinical output copy matches the authoritative lifecycle state", async () => {
  const { clinicalOutputStatusCopyKey: statusCopyKey } = await load();
  const base = {
    hasTranscript: true,
    isRecording: false,
    isProcessingTranscript: false,
    transcriptStatus: "idle",
    separating: false,
    generating: false,
  };

  assert.equal(statusCopyKey("pending", base), "notes.editor.processingStatus.queued");
  assert.equal(statusCopyKey("processing", base), "notes.editor.clinicalOutputs.generatingNotes");
  assert.equal(statusCopyKey("ready", base), "notes.editor.processingStatus.readyClinicalNotes");
  assert.equal(statusCopyKey("failed", base), "notes.editor.processingStatus.failedClinicalNotes");
  assert.equal(statusCopyKey("stale", base), "notes.editor.processingStatus.needsRegeneration");
  assert.equal(
    statusCopyKey("failed", { ...base, generationPhase: "retrying" }),
    "notes.editor.processingStatus.retryingClinicalNotes"
  );
  assert.equal(
    statusCopyKey("processing", { ...base, generationPhase: "mapping" }),
    "notes.editor.processingStatus.generatingProgress"
  );
  assert.equal(
    statusCopyKey("processing", { ...base, generationPhase: "synthesizing" }),
    "notes.editor.processingStatus.finalizingClinicalNotes"
  );
  assert.equal(
    statusCopyKey(null, { ...base, transcriptStatus: "saving" }),
    "notes.editor.processingStatus.savingTranscript"
  );
  assert.equal(
    statusCopyKey("pending", { ...base, hasTranscript: false }),
    "notes.editor.processingStatus.waitingForTranscript"
  );
});
