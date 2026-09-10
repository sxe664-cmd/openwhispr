const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/lib/encounterTemplateInsertion.ts");

test("inserts a template into an empty note", async () => {
  const { insertEncounterTemplate } = await load();

  assert.equal(insertEncounterTemplate("", "  Template body  "), "Template body");
  assert.equal(insertEncounterTemplate("\n  \n", "Template body"), "Template body");
});

test("appends a template after existing content without trailing whitespace", async () => {
  const { insertEncounterTemplate } = await load();

  assert.equal(
    insertEncounterTemplate("Existing notes  \n", "Template body\n"),
    "Existing notes\n\nTemplate body"
  );
});

test("does not change content when the template body is empty", async () => {
  const { insertEncounterTemplate } = await load();

  assert.equal(insertEncounterTemplate("Existing notes", "  \n"), "Existing notes");
});
