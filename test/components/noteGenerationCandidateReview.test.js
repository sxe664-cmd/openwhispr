const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("candidate preview uses the existing read-only RichTextEditor", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../src/components/notes/NoteGenerationCandidateReview.tsx"),
    "utf8"
  );

  assert.match(source, /import \{ RichTextEditor \} from "\.\.\/ui\/RichTextEditor"/);
  assert.match(source, /<RichTextEditor[\s\S]*disabled/);
  assert.doesNotMatch(source, /<pre[\s>]/);
});
