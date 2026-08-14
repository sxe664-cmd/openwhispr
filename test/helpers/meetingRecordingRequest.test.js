const test = require("node:test");
const assert = require("node:assert/strict");

const { handleMeetingRecordingRequest } = require("../../src/helpers/meetingRecordingRequest.ts");

test("a recording request blocked by another encounter restores the previous meeting mode", async () => {
  let restored = 0;
  let handled = 0;
  await handleMeetingRecordingRequest({
    args: { noteId: 22, noteTitle: "Second encounter", folderId: 4 },
    startRecording: async () => false,
    restoreFromMeetingMode: async () => {
      restored += 1;
    },
    onHandled: () => {
      handled += 1;
    },
  });

  assert.equal(restored, 1);
  assert.equal(handled, 1);
});

test("a same-encounter retry stays on its existing recording session", async () => {
  let restored = 0;
  await handleMeetingRecordingRequest({
    args: { noteId: 22, noteTitle: "Same encounter", folderId: 4 },
    startRecording: async () => true,
    restoreFromMeetingMode: async () => {
      restored += 1;
    },
    onHandled: () => {},
  });

  assert.equal(restored, 0);
});
