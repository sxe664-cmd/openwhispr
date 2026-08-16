const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildClinicalNoteDocument,
  buildClinicalNotePreview,
  renderClinicalNoteHtml,
} = require("../../src/helpers/clinicalNoteExport");

function fixture() {
  return {
    note: {
      id: 10,
      title: "Follow-up <visit>",
      created_at: "2026-08-15 14:00:00",
      audio_duration_seconds: 125,
      participants: JSON.stringify([
        { displayName: "Dr. Example" },
        { email: "hidden@example.com" },
      ]),
      transcript: JSON.stringify([
        { speaker: "SPEAKER_00", timestamp: 0, text: "Patient reports feeling better." },
      ]),
    },
    encounter: {
      id: 3,
      title: "Follow-up <visit>",
      start_time: "2026-08-15 14:00:00",
      lifecycle_state: "completed",
      meeting_context: "telehealth",
    },
    output: {
      summary_status: "ready",
      summary: "Improvement discussed.",
      soap_status: "ready",
      soap: "Subjective\nReports improvement.\n\nObjective\n\nAssessment\nImproving.\n\nPlan\nContinue follow-up.",
    },
  };
}

test("clinical document defaults to summary, SOAP, and encounter details", () => {
  const document = buildClinicalNoteDocument(fixture());
  assert.deepEqual(document.selectedSections, ["summary", "soap", "encounterDetails"]);
  assert.equal(document.duration, "00:02:05");
  assert.equal(document.soap.subjective, "Reports improvement.");
  assert.equal(document.soap.objective, "Not documented");
});

test("clinical HTML escapes generated and transcript content", () => {
  const data = fixture();
  data.output.summary = "<script>alert('x')</script>";
  const document = buildClinicalNoteDocument({ ...data, sections: ["summary", "transcript"] });
  const html = renderClinicalNoteHtml(document);
  assert.match(html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /Transcript/);
});

test("preview reports clinical section readiness without returning private contact data", () => {
  const preview = buildClinicalNotePreview(fixture());
  assert.equal(preview.sections.summary.available, true);
  assert.equal(preview.sections.soap.available, true);
  assert.equal(preview.sections.transcript.available, true);
  assert.equal("email" in preview, false);

  const html = renderClinicalNoteHtml(
    buildClinicalNoteDocument({ ...fixture(), sections: ["participants"] })
  );
  assert.match(html, /Dr\. Example/);
  assert.doesNotMatch(html, /hidden@example\.com/);
});
