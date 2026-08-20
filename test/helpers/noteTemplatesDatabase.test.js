const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { createDb, skipOrFail } = require("./harness/db.js");
const DatabaseManager = require("../../src/helpers/database.js");

function ensureDb(t) {
  try {
    return createDb(t);
  } catch (error) {
    skipOrFail(t, error);
    return null;
  }
}

function linkNoteToEncounter(db, note, suffix = note.id) {
  db.db
    .prepare(
      `INSERT INTO encounters
        (calendar_event_id, provider, calendar_id, title, note_id, patient_resolution)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      `ai_receptionist:primary:note-template-${suffix}`,
      "ai_receptionist",
      "primary",
      note.title || "Encounter",
      note.id,
      "unassigned_legacy"
    );
}

test("note templates migrate, seed, and remain idempotent", { concurrency: false }, (t) => {
  const db = ensureDb(t);
  if (!db) return;

  assert.equal(db.db.pragma("user_version", { simple: true }), 3);
  assert.equal(db.getCalendarProjectionHealth().errorCode, null);
  const seededClinical = db.getDefaultNoteTemplate("encounter", { includeRaw: true });
  assert.match(seededClinical.template_text, /History of Present Illness:/);
  assert.match(seededClinical.template_text, /Physical Examination:/);
  assert.match(seededClinical.template_text, /Interventions:/);
  assert.deepEqual(
    db.listNoteTemplates("encounter").map((template) => template.template_key),
    ["clinical-encounter"]
  );
  assert.equal(db.getDefaultNoteTemplate("encounter").name, "Clinical Encounter");
  assert.ok(!Object.hasOwn(db.getDefaultNoteTemplate("encounter"), "template_text"));

  db._initializeNoteTemplatesStorage();
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM note_templates").get().count, 2);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS count FROM note_template_revisions").get().count,
    2
  );
});

test("note template migration rolls back schema changes on failure", () => {
  let sqlite;
  try {
    sqlite = new Database(":memory:");
  } catch (error) {
    if (String(error?.message || error).includes("NODE_MODULE_VERSION")) return;
    throw error;
  }
  sqlite.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT)");
  sqlite.exec("CREATE TABLE note_templates (id INTEGER PRIMARY KEY)");
  sqlite.pragma("user_version = 2");
  const db = Object.create(DatabaseManager.prototype);
  db.db = sqlite;

  assert.throws(() => db._migrateNoteTemplatesSchemaToV3());
  assert.equal(sqlite.pragma("user_version", { simple: true }), 2);
  assert.deepEqual(
    sqlite.pragma("table_info('notes')").map((column) => column.name),
    ["id", "content"]
  );
  assert.deepEqual(
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'note_template_revisions'")
      .all(),
    []
  );
  sqlite.close();
});

test("candidate creation never edits regular notes or transcripts and apply is guarded", { concurrency: false }, (t) => {
  const db = ensureDb(t);
  if (!db) return;

  const regular = db.saveNote("Personal", "regular source", "personal").note;
  const rejected = db.createNoteGenerationCandidate({
    noteId: regular.id,
    generatedContent: "must not be written",
  });
  assert.equal(rejected.success, false);
  assert.equal(db.getNote(regular.id).enhanced_content, null);
  assert.equal(db.getNote(regular.id).transcript, null);
  linkNoteToEncounter(db, regular, "malformed-personal");
  const malformedPersonalRejected = db.createNoteGenerationCandidate({
    noteId: regular.id,
    generatedContent: "must still be rejected",
  });
  assert.equal(malformedPersonalRejected.success, false);
  assert.equal(malformedPersonalRejected.code, "ENCOUNTER_REQUIRED");

  const standaloneMeeting = db.saveNote("Standalone meeting", "meeting source", "meeting").note;
  const standaloneRejected = db.createNoteGenerationCandidate({
    noteId: standaloneMeeting.id,
    generatedContent: "must require an encounter",
  });
  assert.equal(standaloneRejected.success, false);
  assert.equal(standaloneRejected.code, "ENCOUNTER_REQUIRED");

  const note = db.saveNote("Encounter", "manual source", "meeting").note;
  linkNoteToEncounter(db, note, "accepted");
  db.updateNote(note.id, { transcript: "private transcript" });
  const blocked = db.updateNote(note.id, { enhanced_content: "existing enhanced" });
  assert.equal(blocked.success, true);
  const preview = db.createNoteGenerationCandidate({
    noteId: note.id,
    generatedContent: "new enhanced",
  });
  assert.equal(preview.success, true);
  assert.equal(db.getNote(note.id).enhanced_content, "existing enhanced");

  const candidateResult = db.createNoteGenerationCandidate({
    noteId: note.id,
    generatedContent: "new enhanced",
    clinicalSource: "private clinical source",
  });
  assert.equal(candidateResult.success, true);
  const candidate = db.getNoteGenerationCandidate(candidateResult.candidate.candidate_id);
  assert.equal(candidate.generated_content, "new enhanced");
  assert.equal(candidate.has_clinical_source, true);
  assert.equal(Object.hasOwn(candidate, "clinical_source"), false);
  assert.equal(db.getNote(note.id).enhanced_content, "existing enhanced");
  assert.equal(db.getNote(note.id).transcript, "private transcript");

  assert.equal(
    db.applyNoteGenerationCandidate(candidate.candidate_id).code,
    "ENHANCED_CONTENT_EXISTS"
  );
  const applied = db.applyNoteGenerationCandidate(candidate.candidate_id, { confirmed: true });
  assert.equal(applied.success, true);
  assert.equal(applied.note.enhanced_content, "new enhanced");
  assert.equal(applied.note.enhanced_template_revision_id, candidate.template_revision_id);
  assert.equal(applied.note.transcript, "private transcript");
});

test("clinical generation runs persist resumable chunk evidence and clear safely", { concurrency: false }, (t) => {
  const db = ensureDb(t);
  if (!db) return;

  const note = db.saveNote("Encounter run", "source", "meeting").note;
  const template = db.getDefaultNoteTemplate("encounter", { includeRaw: true });
  const saved = db.saveNoteGenerationRun({
    noteId: note.id,
    templateRevisionId: template.active_revision_id,
    sourceHash: "source-hash",
    modelId: "local-model",
    chunkCount: 3,
    completedChunks: 1,
    extractions: [{ fields: { "historyOfPresentIllness.currentComplaints": { value: "pain" } } }],
  });
  assert.equal(saved.success, true);
  assert.equal(db.getNoteGenerationRun(note.id).completed_chunks, 1);
  assert.equal(db.getNoteGenerationRun(note.id).extractions.length, 1);

  const updated = db.saveNoteGenerationRun({
    noteId: note.id,
    templateRevisionId: template.active_revision_id,
    sourceHash: "source-hash",
    modelId: "local-model",
    chunkCount: 3,
    completedChunks: 3,
    extractions: [1, 2, 3],
  });
  assert.equal(updated.success, true);
  assert.deepEqual(db.getNoteGenerationRun(note.id).extractions, [1, 2, 3]);
  assert.deepEqual(db.clearNoteGenerationRun(note.id), { success: true });
  assert.equal(db.getNoteGenerationRun(note.id), null);
});

test("editing a template activates the newly created revision", { concurrency: false }, (t) => {
  const db = ensureDb(t);
  if (!db) return;

  const before = db.getDefaultNoteTemplate("encounter", { includeRaw: true });
  const updated = db.updateNoteTemplate(before.id, {
    templateText: `${before.template_text}\n\nAdditional review field: Not documented`,
  });
  assert.equal(updated.success, true);
  assert.notEqual(updated.template.active_revision_id, before.active_revision_id);

  const after = db.getNoteTemplate(before.id, { includeRaw: true });
  assert.equal(after.active_revision_id, updated.template.active_revision_id);
  assert.match(after.template_text, /Additional review field/);
});

test("deleting the encounter default restores the built-in default atomically", { concurrency: false }, (t) => {
  const db = ensureDb(t);
  if (!db) return;

  const created = db.createNoteTemplate({
    name: "Temporary Encounter",
    description: "Test template",
    kind: "encounter",
    templateText: "Temporary encounter template",
  });
  assert.equal(created.success, true);
  assert.equal(db.setDefaultNoteTemplate(created.template.id).success, true);

  const deleted = db.deleteNoteTemplate(created.template.id);
  assert.deepEqual(deleted, { success: true, id: created.template.id });
  const fallback = db.getDefaultNoteTemplate("encounter");
  assert.equal(fallback.template_key, "clinical-encounter");
  assert.equal(db.getNoteTemplate(created.template.id), null);
});

test("stale candidate apply rejects without overwriting enhanced content", { concurrency: false }, (t) => {
  const db = ensureDb(t);
  if (!db) return;
  const note = db.saveNote("Encounter", "source A", "meeting").note;
  linkNoteToEncounter(db, note, "stale-content");
  const candidate = db.createNoteGenerationCandidate({
    noteId: note.id,
    generatedContent: "generated A",
  }).candidate;
  db.updateNote(note.id, { content: "source B" });
  const result = db.applyNoteGenerationCandidate(candidate.candidate_id, { confirmed: true });
  assert.equal(result.success, false);
  assert.equal(result.code, "CANDIDATE_STALE");
  assert.equal(db.getNote(note.id).enhanced_content, null);
});

test("transcript changes stale a candidate even when note content is unchanged", { concurrency: false }, (t) => {
  const db = ensureDb(t);
  if (!db) return;
  const note = db.saveNote("Encounter", "source", "meeting").note;
  linkNoteToEncounter(db, note, "stale-transcript");
  db.updateNote(note.id, { transcript: "transcript A" });
  const candidate = db.createNoteGenerationCandidate({
    noteId: note.id,
    generatedContent: "generated",
  }).candidate;

  db.updateNote(note.id, { transcript: "transcript B" });
  const result = db.applyNoteGenerationCandidate(candidate.candidate_id, { confirmed: true });
  assert.equal(result.code, "CANDIDATE_STALE");
  assert.equal(db.getNote(note.id).enhanced_content, null);
});
