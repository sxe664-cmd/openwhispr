const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  CLINICAL_ENCOUNTER_TEMPLATE,
  CLINICAL_ENCOUNTER_TEMPLATE_VERSION,
  MEDICATION_SPAN_END_MARKER,
  MEDICATION_SPAN_START_MARKER,
  NOT_DOCUMENTED,
  buildClinicalEncounterActionRequest,
  buildClinicalEncounterCompactActionRequest,
  compileClinicalEncounterMarkdown,
  mergeClinicalEncounterCompactExtractions,
  parseClinicalEncounterTemplatePresentation,
  parseClinicalEncounterCompactOutput,
  parseClinicalEncounterOutput,
} = require("../../src/services/clinicalEncounterTemplateEngine.ts");

function emptyOutput(overrides = {}) {
  const sections = Object.fromEntries(
    CLINICAL_ENCOUNTER_TEMPLATE.sections.map((section) => [
      section.key,
      {
        key: section.key,
        label: section.label,
        fields: Object.fromEntries(
          section.fields.map((field) => [
            field.key,
            { value: NOT_DOCUMENTED, assertion: "not_documented", sourceRefs: [], spans: [] },
          ])
        ),
      },
    ])
  );
  return {
    templateId: "clinical-encounter",
    templateVersion: CLINICAL_ENCOUNTER_TEMPLATE_VERSION,
    sections,
    additionalInformation: [],
    ...overrides,
  };
}

function setField(output, sectionKey, fieldKey, value, sourceText, options = {}) {
  const quote = options.quote ?? value;
  const start = sourceText.indexOf(quote);
  output.sections[sectionKey].fields[fieldKey] = {
    value,
    assertion: "documented",
    sourceRefs: [{ quote, start, end: start + quote.length }],
    spans: options.spans ?? [],
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("valid output preserves evidence-backed fields and the versioned template", () => {
  const source = "Patient reports a headache for two days. Takes ibuprofen.";
  const output = emptyOutput();
  setField(output, "historyOfPresentIllness", "chiefConcern", "Headache", source, {
    quote: "reports a headache",
  });
  setField(output, "previousAndCurrentIllnesses", "medicationsAndSupplements", "ibuprofen", source);

  const result = parseClinicalEncounterOutput(JSON.stringify(output), source);

  assert.equal(result.ok, true);
  assert.equal(result.document.templateVersion, CLINICAL_ENCOUNTER_TEMPLATE_VERSION);
  assert.equal(
    result.document.sections.historyOfPresentIllness.label,
    "History of Present Illness"
  );
  assert.equal(
    result.document.sections.historyOfPresentIllness.fields.chiefConcern.value,
    "Headache"
  );
  assert.equal(
    result.document.sections.previousAndCurrentIllnesses.fields.medicationsAndSupplements.value,
    "ibuprofen"
  );
});

test("malformed JSON fails closed without a fallback clinical document", () => {
  const result = parseClinicalEncounterOutput("{ diagnosis: pneumonia }", "Patient has a cough.");

  assert.equal(result.ok, false);
  assert.equal(result.document, null);
  assert.equal(result.issues[0].code, "invalid_json");
});

test("compact local request uses sparse qualified evidence fields", () => {
  const source = "Patient reports back pain and takes ibuprofen.";
  const compact = buildClinicalEncounterCompactActionRequest(source);

  assert.ok(compact.fieldKeys.includes("historyOfPresentIllness.currentComplaints"));
  assert.ok(compact.fieldKeys.includes("previousAndCurrentIllnesses.medicationsAndSupplements"));
  assert.match(compact.systemPrompt, /historyOfPresentIllness\.currentComplaints/);
  assert.match(compact.systemPrompt, /Never output a top-level "sectionKey"/);
  assert.doesNotMatch(compact.userPrompt, /JSON Schema/);
  assert.ok(JSON.stringify(compact.responseSchema).length < 5_000);
  assert.equal(compact.responseSchema.properties.fields.type, "array");
  assert.deepEqual(
    compact.responseSchema.properties.fields.items.properties.field.enum,
    compact.fieldKeys
  );

  const full = buildClinicalEncounterActionRequest(source, "## History of Present Illness\n### Current Complaints:");
  assert.ok(full.responseSchema);
});

test("compact evidence is exact and merges through the canonical validator", () => {
  const source = "Patient reports back pain. Takes ibuprofen.";
  const request = buildClinicalEncounterCompactActionRequest(source);
  const parsed = parseClinicalEncounterCompactOutput(
    JSON.stringify({
      fields: [
        {
          field: "historyOfPresentIllness.currentComplaints",
          value: "Back pain",
          evidence: ["reports back pain"],
        },
        {
          field: "previousAndCurrentIllnesses.medicationsAndSupplements",
          value: "ibuprofen",
          evidence: ["Takes ibuprofen."],
        },
        {
          field: "diagnosis.documentedDiagnosis",
          value: "Pneumonia",
          evidence: ["Patient reports back pain."],
        },
        {
          field: "historyOfPresentIllness.painLevel",
          value: "8/10",
          evidence: ["not present"],
        },
      ],
    }),
    source,
    { allowedFieldKeys: request.fieldKeys }
  );

  assert.equal(parsed.ok, true);
  const merged = mergeClinicalEncounterCompactExtractions([parsed.extraction], source);
  assert.equal(merged.ok, true);
  assert.equal(
    merged.document.sections.historyOfPresentIllness.fields.currentComplaints.value,
    "Back pain"
  );
  assert.equal(
    merged.document.sections.previousAndCurrentIllnesses.fields.medicationsAndSupplements.value,
    "ibuprofen"
  );
  assert.equal(
    merged.document.sections.diagnosis.fields.documentedDiagnosis.value,
    NOT_DOCUMENTED
  );
  assert.equal(
    merged.document.sections.historyOfPresentIllness.fields.painLevel.value,
    NOT_DOCUMENTED
  );
});

test("compact parser rejects unknown fields and malformed evidence without inventing values", () => {
  const result = parseClinicalEncounterCompactOutput(
    JSON.stringify({
      fields: [
        { field: "unknown.section", value: "invented", evidence: ["fact"] },
        {
          field: "historyOfPresentIllness.currentComplaints",
          value: "invented",
          evidence: ["not present"],
        },
      ],
    }),
    "fact"
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.extraction.fields, {});
  assert.ok(result.extraction.issues.some((issue) => issue.code === "invalid_field"));
  assert.ok(
    result.extraction.issues.some((issue) => issue.code === "invalid_source_reference")
  );
});

test("compact parser rejects the legacy dynamic object shape", () => {
  const result = parseClinicalEncounterCompactOutput(
    JSON.stringify({
      fields: {
        "historyOfPresentIllness.currentComplaints": {
          value: "Back pain",
          evidence: ["Back pain"],
        },
      },
    }),
    "Back pain"
  );

  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "invalid_root");
});

test("missing fields become Not documented in every supplied section", () => {
  const result = parseClinicalEncounterOutput(
    JSON.stringify(emptyOutput()),
    "No clinical details were stated."
  );

  assert.equal(result.ok, true);
  for (const section of CLINICAL_ENCOUNTER_TEMPLATE.sections) {
    for (const field of section.fields) {
      assert.equal(result.document.sections[section.key].fields[field.key].value, NOT_DOCUMENTED);
      assert.equal(
        result.document.sections[section.key].fields[field.key].assertion,
        "not_documented"
      );
    }
  }
});

test("the fixed template covers the supplied clinical encounter structure", () => {
  const fields = Object.fromEntries(
    CLINICAL_ENCOUNTER_TEMPLATE.sections.map((section) => [
      section.key,
      new Set(section.fields.map((item) => item.key)),
    ])
  );

  for (const key of [
    "mechanismAndDateOfInjury",
    "positionAtTimeOfImpact",
    "immediateSymptoms",
    "delayedOnsetSymptoms",
    "functionalLimitations",
    "workStatus",
    "priorInjuries",
  ])
    assert.equal(fields.historyOfPresentIllness.has(key), true, key);
  for (const key of ["surgeries", "supplements"]) {
    assert.equal(fields.previousAndCurrentIllnesses.has(key), true, key);
  }
  for (const key of [
    "sleep",
    "energyLevels",
    "appetiteAndGastrointestinal",
    "urination",
    "temperatureFeeling",
    "sweating",
    "sexualCycle",
    "exercise",
    "stressMitigation",
    "positiveSocialConnections",
    "riskySubstances",
  ])
    assert.equal(fields.reviewOfSystems.has(key), true, key);
  for (const key of ["pulse", "tongue", "auscultation", "weight", "biowell", "imaging"]) {
    assert.equal(fields.physicalExamination.has(key), true, key);
  }
  for (const key of ["outcomeMeasures"]) assert.equal(fields.conclusion.has(key), true, key);
  assert.equal(fields.diagnosis.has("patterns"), true);
  for (const key of [
    "officeVisit",
    "acupuncture",
    "earSeeds",
    "formulaChoice",
    "coaching",
    "emf",
    "adjunctiveModalities",
  ]) {
    assert.equal(fields.interventions.has(key), true, key);
  }
  assert.equal(CLINICAL_ENCOUNTER_TEMPLATE_VERSION >= 2, true);
});

test("unsupported sensitive claims are rejected instead of becoming clinical facts", () => {
  const source = "Patient reports a cough.";
  const output = emptyOutput();
  output.sections.diagnosis.fields.documentedDiagnosis = {
    value: "Pneumonia",
    assertion: "documented",
    sourceRefs: [],
    spans: [],
  };
  output.sections.interventions.fields.proceduresOrCpt = {
    value: "CPT 99213",
    assertion: "documented",
    sourceRefs: [],
    spans: [],
  };

  const result = parseClinicalEncounterOutput(JSON.stringify(output), source);
  const markdown = compileClinicalEncounterMarkdown(result.document);

  assert.equal(result.ok, true);
  assert.equal(result.document.sections.diagnosis.fields.documentedDiagnosis.value, NOT_DOCUMENTED);
  assert.equal(result.document.sections.interventions.fields.proceduresOrCpt.value, NOT_DOCUMENTED);
  assert.ok(result.issues.some((issue) => issue.code === "unsupported_claim"));
  assert.doesNotMatch(markdown, /Pneumonia|CPT 99213/);
});

test("a sensitive diagnosis cannot be fabricated from an unrelated valid quote", () => {
  const source = "Patient reports a cough.";
  const output = emptyOutput();
  setField(output, "diagnosis", "documentedDiagnosis", "Pneumonia", source, {
    quote: source,
  });

  const result = parseClinicalEncounterOutput(JSON.stringify(output), source);

  assert.equal(result.ok, true);
  assert.equal(result.document.sections.diagnosis.fields.documentedDiagnosis.value, NOT_DOCUMENTED);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code === "unsupported_claim" &&
        issue.path.endsWith("diagnosis.fields.documentedDiagnosis")
    )
  );
  assert.doesNotMatch(compileClinicalEncounterMarkdown(result.document), /Pneumonia/);
});

test("unmatched source material is retained under Additional Information", () => {
  const source = "Patient reports a headache. Also asks about travel vaccines.";
  const output = emptyOutput();
  setField(output, "historyOfPresentIllness", "chiefConcern", "Headache", source, {
    quote: "reports a headache",
  });

  const result = parseClinicalEncounterOutput(JSON.stringify(output), source);
  const additional = result.document.additionalInformation.map((item) => item.text).join(" ");

  assert.equal(result.ok, true);
  assert.match(additional, /Also asks about travel vaccines\./);
  assert.match(compileClinicalEncounterMarkdown(result.document), /## Additional Information/);
});

test("source references and additional information must be exact source spans", () => {
  const source = "Patient reports pain. Additional detail.";
  const output = emptyOutput();
  setField(output, "historyOfPresentIllness", "chiefConcern", "Pain", source, {
    quote: "reports pain",
  });
  output.additionalInformation = [
    {
      text: "Additional detail",
      sourceRefs: [
        {
          quote: "Additional detail.",
          start: source.indexOf("Additional detail"),
          end: source.length,
        },
      ],
    },
  ];

  const result = parseClinicalEncounterOutput(JSON.stringify(output), source);
  assert.equal(result.ok, true);
  assert.ok(result.issues.some((issue) => issue.code === "invalid_additional_information"));

  const nonVerbatim = emptyOutput();
  nonVerbatim.sections.historyOfPresentIllness.fields.chiefConcern = {
    value: "Pain",
    assertion: "documented",
    sourceRefs: [{ quote: "reports   pain" }],
    spans: [],
  };
  const nonVerbatimResult = parseClinicalEncounterOutput(JSON.stringify(nonVerbatim), source);
  assert.equal(
    nonVerbatimResult.document.sections.historyOfPresentIllness.fields.chiefConcern.value,
    NOT_DOCUMENTED
  );
  assert.ok(nonVerbatimResult.issues.some((issue) => issue.code === "invalid_source_reference"));
});

test("Markdown formatting is deterministic and marks medication spans for the editor", () => {
  test("only the uncited portion of a source sentence is added as Additional Information", () => {
    const source = "Patient reports a headache and asks about travel vaccines.";
    const output = emptyOutput();
    setField(output, "historyOfPresentIllness", "chiefConcern", "Headache", source, {
      quote: "reports a headache",
    });

    const result = parseClinicalEncounterOutput(JSON.stringify(output), source);
    const additional = result.document.additionalInformation.map((item) => item.text).join(" ");

    assert.equal(result.ok, true);
    assert.match(additional, /asks about travel vaccines/);
    assert.doesNotMatch(additional, /reports a headache/);
  });
  const source = "Takes ibuprofen daily. Intervention: stretching.";
  const output = emptyOutput();
  setField(
    output,
    "previousAndCurrentIllnesses",
    "medicationsAndSupplements",
    "ibuprofen",
    source,
    {
      quote: "ibuprofen",
    }
  );
  setField(output, "interventions", "interventionsPerformed", "Stretching", source, {
    quote: "stretching",
  });
  const result = parseClinicalEncounterOutput(JSON.stringify(output), source);
  const first = compileClinicalEncounterMarkdown(result.document);
  const second = compileClinicalEncounterMarkdown(result.document);

  assert.equal(first, second);
  assert.equal(first.indexOf("# Clinical Encounter"), 0);
  assert.ok(first.indexOf("## History of Present Illness") < first.indexOf("## Diagnosis"));
  assert.match(
    first,
    new RegExp(
      `\\*\\*Medications and Supplements:\\*\\* ${escapeRegex(MEDICATION_SPAN_START_MARKER)}ibuprofen${escapeRegex(MEDICATION_SPAN_END_MARKER)}`
    )
  );
  assert.match(first, /\*\*Interventions Performed:\*\*\n1\. Stretching/);
});

test("a custom template changes presentation order, visibility, labels, and formats", () => {
  const source = "Patient reports shoulder pain. Take ibuprofen. Rest and hydrate.";
  const output = emptyOutput();
  setField(output, "historyOfPresentIllness", "currentComplaints", "Shoulder pain", source, {
    quote: "shoulder pain",
  });
  setField(output, "plan", "medicationsOrSupplements", "ibuprofen", source, {
    quote: "ibuprofen",
  });
  setField(output, "plan", "patientInstructions", "Rest and hydrate", source, {
    quote: "Rest and hydrate",
  });

  const customTemplate = `# Follow-up Note
## Plan
### Patient Instructions [bullets]:
### Medications or Supplements:
## History of Present Illness
### Current Complaints [bullets]:`;
  const markdown = compileClinicalEncounterMarkdown(output, customTemplate);

  assert.ok(markdown.indexOf("## Plan") < markdown.indexOf("## History of Present Illness"));
  assert.match(markdown, /\*\*Patient Instructions:\*\*\n- Rest and hydrate/);
  assert.match(
    markdown,
    new RegExp(
      `\\*\\*Medications or Supplements:\\*\\* ${escapeRegex(MEDICATION_SPAN_START_MARKER)}ibuprofen${escapeRegex(MEDICATION_SPAN_END_MARKER)}`
    )
  );
  assert.match(markdown, /\*\*Current Complaints:\*\*\n- Shoulder pain/);
  assert.doesNotMatch(markdown, /## Diagnosis|## Review of Systems|## Interventions/);
  assert.match(markdown, /## Additional Information/);
});

test("the supplied colon-packed and numbered encounter template parses into canonical fields", () => {
  const definition = parseClinicalEncounterTemplatePresentation(`History of Present Illness:
Current complaints: Area. Pain Level (0–10). Quality. Radiation. Frequency. Aggravating factors:
Interventions:
1. Office Visit:
2. Acupuncture:
3. Formula choice:`);

  assert.deepEqual(
    definition.sections.map((section) => section.id),
    ["historyOfPresentIllness", "interventions"]
  );
  assert.deepEqual(
    definition.sections[0].fields.map((field) => field.id),
    [
      "currentComplaints",
      "painLevel",
      "painQuality",
      "painRadiation",
      "painFrequency",
      "aggravatingFactors",
    ]
  );
  assert.equal(
    definition.sections[1].fields.find((field) => field.id === "officeVisit").format,
    "numbered"
  );
  assert.equal(
    definition.sections[1].fields.find((field) => field.id === "formulaChoice").format,
    "medication"
  );
});

test("the actual seeded Clinical Encounter template parses successfully", () => {
  const databaseSource = fs.readFileSync(
    path.resolve(__dirname, "../../src/helpers/database.js"),
    "utf8"
  );
  const match = databaseSource.match(
    /const CLINICAL_ENCOUNTER_TEMPLATE_TEXT = String\.raw`([\s\S]*?)`;/
  );
  assert.ok(match, "database.js should contain the seeded Clinical Encounter template body");

  const definition = parseClinicalEncounterTemplatePresentation(match[1]);
  assert.ok(definition.sections.some((section) => section.id === "historyOfPresentIllness"));
  assert.ok(definition.sections.some((section) => section.id === "physicalExamination"));
  assert.ok(definition.sections.some((section) => section.id === "interventions"));
  assert.ok(
    definition.sections
      .flatMap((section) => section.fields)
      .some((field) => field.id === "formulaChoice")
  );
});

test("unknown headings, duplicate fields, markup, and empty templates fail closed", () => {
  for (const invalidTemplate of [
    "## Unknown Section\n### Chief Concern:",
    "## History of Present Illness\n### Chief Concern:\n### Chief Concern:",
    "## Plan\n<b>Patient Instructions:</b>",
    "## Plan\nOnly boilerplate with no recognized fields.",
  ]) {
    assert.throws(
      () => parseClinicalEncounterTemplatePresentation(invalidTemplate),
      /Unsupported clinical encounter template:/
    );
  }
});
