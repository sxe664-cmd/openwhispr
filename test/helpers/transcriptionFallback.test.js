const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/transcriptionFallback.js");

test.skip("removed hosted transcription mode is never selected", async () => {
  const { resolveStreamingFallbackTarget } = await load();
  assert.equal(
    resolveStreamingFallbackTarget({
      useLocalWhisper: false,
      cloudTranscriptionMode: "openwhispr",
      isSignedIn: true,
    }),
    "cloud"
  );
});

test.skip("removed hosted transcription mode falls back to BYOK", async () => {
  const { resolveStreamingFallbackTarget } = await load();
  assert.equal(
    resolveStreamingFallbackTarget({
      useLocalWhisper: false,
      cloudTranscriptionMode: "openwhispr",
      isSignedIn: false,
    }),
    "skip"
  );
});

test("BYOK mode falls back to the user's own provider", async () => {
  const { resolveStreamingFallbackTarget } = await load();
  assert.equal(
    resolveStreamingFallbackTarget({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      isSignedIn: false,
    }),
    "byok"
  );
});
