import assert from "node:assert/strict";
import test from "node:test";
import markdownit from "markdown-it";
import {
  MEDICATION_MARKER_END,
  MEDICATION_MARKER_START,
  medicationMarkerMarkdownSpec,
} from "../../src/components/ui/medicationMarkerMark.ts";

function renderMarkdown(source) {
  const md = markdownit({ html: false });
  medicationMarkerMarkdownSpec.parse.setup(md);
  return md.render(source);
}

test("clinical marker pairs render as a safe, static inline span without changing Markdown structure", () => {
  const rendered = renderMarkdown(
    [
      "## Medications",
      `**Medications and Supplements:** ${MEDICATION_MARKER_START}ibuprofen${MEDICATION_MARKER_END}`,
      "- Continue hydration",
      "1. Follow up next week",
    ].join("\n\n")
  );

  assert.match(rendered, /<h2>Medications<\/h2>/);
  assert.match(
    rendered,
    new RegExp(
      `<strong>Medications and Supplements:<\\/strong> <span data-ow-medication="true">ibuprofen<\\/span>`
    )
  );
  assert.match(rendered, /<ul>\s*<li>Continue hydration<\/li>/);
  assert.match(rendered, /<ol>\s*<li>Follow up next week<\/li>/);
});

test("raw HTML remains escaped while the generated medication wrapper stays fixed", () => {
  const rendered = renderMarkdown(
    `${MEDICATION_MARKER_START}<script>alert(1)</script>${MEDICATION_MARKER_END}`
  );

  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(rendered, /<script>/);
  assert.match(rendered, /<span data-ow-medication="true">/);
});

test("unmatched markers stay literal and the mark serializer preserves the marker form", () => {
  const unmatched = `${MEDICATION_MARKER_START}ibuprofen`;
  assert.equal(renderMarkdown(unmatched), `<p>${unmatched}</p>\n`);
  assert.equal(medicationMarkerMarkdownSpec.serialize.open, MEDICATION_MARKER_START);
  assert.equal(medicationMarkerMarkdownSpec.serialize.close, MEDICATION_MARKER_END);
});
