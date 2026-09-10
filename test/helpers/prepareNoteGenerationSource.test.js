import assert from "node:assert/strict";
import test from "node:test";
import { prepareNoteGenerationSource } from "../../src/helpers/prepareNoteGenerationSource.ts";

test("background preparation waits for finalization and rereads the persisted source", async () => {
  const states = [
    { transcriptStatus: "recording", transcript: "", isFinalized: false },
    { transcriptStatus: "checkpointed", transcript: "raw checkpoint", isFinalized: false },
    { transcriptStatus: "finalized", transcript: "named final transcript", isFinalized: true },
  ];
  let waits = 0;
  const result = await prepareNoteGenerationSource(7, async (id) => {
    assert.equal(id, 7);
    return { success: true, sourceHash: "canonical", ...states.shift() };
  }, () => false, async () => { waits++; });
  assert.equal(waits, 2);
  assert.equal(result.transcript, "named final transcript");
});

test("cancelling preparation prevents a late source read from starting generation", async () => {
  let cancel = false;
  const result = await prepareNoteGenerationSource(7, async () => {
    cancel = true;
    return { success: true, sourceHash: "canonical", transcriptStatus: "finalized", isFinalized: true };
  }, () => cancel);
  assert.equal(result, null);
});

test("an ordinary typed note needs no recording while a failed transcript cannot generate", async () => {
  const source = { success: true, sourceHash: "canonical", transcriptStatus: "idle", transcript: "", content: "Ideas" };
  assert.equal(await prepareNoteGenerationSource(7, async () => source, () => false), source);
  await assert.rejects(prepareNoteGenerationSource(7,
    async () => ({ ...source, transcript: "unfinished", transcriptStatus: "failed", isFinalized: false }),
    () => false), { code: "SOURCE_UNAVAILABLE" });
});
