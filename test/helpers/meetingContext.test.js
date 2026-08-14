const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MEETING_CONTEXT,
  normalizeMeetingContext,
  resolveMeetingContextRouting,
  resolveMeetingSegmentTimestamp,
} = require("../../src/helpers/meetingContext.js");

test("missing or invalid meeting context remains compatible with telehealth", () => {
  assert.equal(normalizeMeetingContext(), MEETING_CONTEXT.TELEHEALTH);
  assert.equal(normalizeMeetingContext("unknown"), MEETING_CONTEXT.TELEHEALTH);
  assert.deepEqual(resolveMeetingContextRouting(null), {
    meetingContext: "telehealth",
    diarizationSource: "system",
    ownVoiceSource: "mic",
    usesSystemAudio: true,
    usesLiveSpeakerIdentification: true,
    usesAec: true,
  });
});

test("in-person diarizes the shared microphone without an automatic own voice", () => {
  assert.deepEqual(resolveMeetingContextRouting(MEETING_CONTEXT.IN_PERSON), {
    meetingContext: "in_person",
    diarizationSource: "mic",
    ownVoiceSource: null,
    usesSystemAudio: false,
    usesLiveSpeakerIdentification: false,
    usesAec: false,
  });
});

test("in-person local transcript timestamps use captured audio time", () => {
  assert.equal(resolveMeetingSegmentTimestamp("in_person", 1234, 9000), 1234);
  assert.equal(resolveMeetingSegmentTimestamp("telehealth", 1234, 9000), 9000);
  assert.equal(resolveMeetingSegmentTimestamp("in_person", null, 9000), 9000);
});
