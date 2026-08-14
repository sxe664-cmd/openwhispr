const MEETING_CONTEXT = Object.freeze({
  IN_PERSON: "in_person",
  TELEHEALTH: "telehealth",
});

function normalizeMeetingContext(value) {
  return value === MEETING_CONTEXT.IN_PERSON
    ? MEETING_CONTEXT.IN_PERSON
    : MEETING_CONTEXT.TELEHEALTH;
}

function resolveMeetingContextRouting(value) {
  const meetingContext = normalizeMeetingContext(value);
  const isInPerson = meetingContext === MEETING_CONTEXT.IN_PERSON;

  return {
    meetingContext,
    diarizationSource: isInPerson ? "mic" : "system",
    ownVoiceSource: isInPerson ? null : "mic",
    usesSystemAudio: !isInPerson,
    usesLiveSpeakerIdentification: !isInPerson,
    usesAec: !isInPerson,
  };
}

function resolveMeetingSegmentTimestamp(value, capturedAt, now = Date.now()) {
  if (normalizeMeetingContext(value) === MEETING_CONTEXT.IN_PERSON && Number.isFinite(capturedAt)) {
    return capturedAt;
  }
  return now;
}

module.exports = {
  MEETING_CONTEXT,
  normalizeMeetingContext,
  resolveMeetingContextRouting,
  resolveMeetingSegmentTimestamp,
};
