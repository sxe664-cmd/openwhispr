const { createHash } = require("crypto");

const SOURCE_SCHEMA_VERSION = 1;

function cleanText(value) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

function parseStoredSegments(transcript) {
  const text = cleanText(transcript);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.segments)) return parsed.segments;
  } catch {
    // Legacy/plain transcripts are represented as one stable segment below.
  }
  return [{ text, source: "unknown", speaker: null, speakerName: null }];
}

function normalizeTranscriptSegments(transcript) {
  const unknownSpeakers = new Map();
  let nextUnknown = 1;
  const segments = [];
  for (const raw of parseStoredSegments(transcript)) {
    const text = cleanText(raw?.text);
    if (!text) continue;
    const source = raw?.source === "mic" || raw?.source === "system" ? raw.source : "unknown";
    let speaker = cleanText(raw?.speakerName);
    if (!speaker) {
      if (source === "mic") speaker = "You";
      else if (source === "system") speaker = "Them";
      else {
        const key = cleanText(raw?.speaker) || "unknown";
        if (!unknownSpeakers.has(key)) unknownSpeakers.set(key, `Speaker ${nextUnknown++}`);
        speaker = unknownSpeakers.get(key);
      }
    }
    segments.push({ speaker, source, text });
  }
  return segments;
}

function buildCanonicalNoteGenerationSource(note) {
  const manualNotes = cleanText(note?.content);
  const segments = normalizeTranscriptSegments(note?.transcript);
  const canonical = {
    schemaVersion: SOURCE_SCHEMA_VERSION,
    manualNotes,
    transcript: segments,
  };
  const sourceHash = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  const transcriptText = segments.map((segment) => `${segment.speaker}: ${segment.text}`).join("\n");
  const sourceText = [
    manualNotes
      ? `TYPED NOTES (prioritize as intentional user evidence):\n${manualNotes}`
      : "",
    transcriptText ? `FINALIZED TRANSCRIPT:\n${transcriptText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { sourceHash, sourceText, manualNotes, transcriptText, segments, schemaVersion: SOURCE_SCHEMA_VERSION };
}

module.exports = {
  SOURCE_SCHEMA_VERSION,
  buildCanonicalNoteGenerationSource,
  normalizeTranscriptSegments,
};
