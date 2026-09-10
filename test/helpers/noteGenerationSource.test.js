const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCanonicalNoteGenerationSource,
} = require("../../src/helpers/noteGenerationSource.js");

test("canonical generation source preserves real speaker names and prioritizes manual notes", () => {
  const source = buildCanonicalNoteGenerationSource({
    content: "Remember that the patient prefers conservative care.",
    transcript: JSON.stringify([
      { id: "1", source: "mic", speaker: "speaker_0", speakerName: "Dr. Rivera", text: "How is the pain?", timestamp: 1 },
      { id: "2", source: "system", speaker: "speaker_1", speakerName: "Alex", text: "It is improving.", timestamp: 2 },
    ]),
  });

  assert.match(source.sourceText, /TYPED NOTES/);
  assert.match(source.sourceText, /Dr\. Rivera: How is the pain\?/);
  assert.match(source.sourceText, /Alex: It is improving\./);
  assert.equal(source.segments[1].speaker, "Alex");
});

test("canonical source hash ignores volatile transcript metadata but changes with evidence", () => {
  const first = buildCanonicalNoteGenerationSource({
    content: "Manual note",
    transcript: JSON.stringify([
      { id: "a", source: "mic", speaker: "speaker_0", text: "Same evidence", timestamp: 1, suggestedName: "Ignored" },
    ]),
  });
  const metadataOnly = buildCanonicalNoteGenerationSource({
    content: "Manual note",
    transcript: JSON.stringify([
      { id: "different", source: "mic", speaker: "speaker_0", text: "Same evidence", timestamp: 99, status: "reviewed" },
    ]),
  });
  const changed = buildCanonicalNoteGenerationSource({
    content: "Manual note",
    transcript: JSON.stringify([
      { id: "a", source: "mic", speaker: "speaker_0", text: "Changed evidence", timestamp: 1 },
    ]),
  });

  assert.equal(first.sourceHash, metadataOnly.sourceHash);
  assert.notEqual(first.sourceHash, changed.sourceHash);
});
