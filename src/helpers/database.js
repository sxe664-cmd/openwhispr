const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { randomUUID, createHash } = require("crypto");
const debugLogger = require("./debugLogger");
const { buildNoteSearchQuery } = require("./noteSearch");
const { normalizeStoredSpeakerCount } = require("./speakerCount");
const { localDayRange, normalizeRange, MAX_CALENDAR_ROWS } = require("./calendarContract");
const {
  formatEncounterAutoTitle,
  normalizeAppointmentId,
  normalizeOpaqueId,
  normalizePatientDob,
  normalizePatientEmail,
  normalizePatientPhone,
  parsePatientMetadata,
  resolvePatientIdentity,
} = require("./patientIdentity");
const { app } = require("electron");

// Server-enforced trigger cap (openwhispr-api); enforced here so one oversized
// trigger can't 400 the whole sync batch.
const MAX_SNIPPET_TRIGGER_LENGTH = 100;

const ENCOUNTER_OUTPUT_STATUSES = new Set(["pending", "processing", "ready", "failed", "stale"]);
const PATIENT_RESOLUTIONS = [
  "created",
  "matched",
  "unassigned_review",
  "unassigned_missing_email",
  "unassigned_missing_demographics",
  "unassigned_no_exact_match",
  "unassigned_unknown_patient_id",
  "unassigned_multiple_attendees",
  "unassigned_conflict",
  "unassigned_invalid_metadata",
  "unassigned_folder_unavailable",
  "unassigned_legacy",
];
const PATIENT_RESOLUTION_SQL = PATIENT_RESOLUTIONS.map((value) => `'${value}'`).join(", ");

function hashEncounterTranscript(transcript) {
  return createHash("sha256")
    .update(String(transcript ?? ""), "utf8")
    .digest("hex");
}

function decorateEncounterOutput(output) {
  if (!output) return null;
  // `status` predates the optional focus output and remains the summary/SOAP
  // aggregate consumed by existing encounter flows. Focus has its own status;
  // letting a pending focus hold this legacy aggregate in pending/processing
  // would regress completed summary/SOAP output publication.
  const statuses = [output.summary_status, output.soap_status];
  let status = "pending";
  if (statuses.includes("processing")) status = "processing";
  else if (statuses.includes("failed")) status = "failed";
  else if (statuses.includes("stale")) status = "stale";
  else if (statuses.every((entry) => entry === "ready")) status = "ready";
  return { ...output, status };
}

// Every local field a note create (POST) carries; the acknowledgement compares
// these atomically against the pushed snapshot. Must mirror NotePushSnapshot
// in src/types/electron.ts.
const NOTE_CREATE_ACK_FIELDS = [
  "client_note_id",
  "title",
  "content",
  "enhanced_content",
  "enhancement_prompt",
  "enhanced_at_content_hash",
  "note_type",
  "source_file",
  "audio_duration_seconds",
  "folder_id",
  "space_id",
  "transcript",
  "calendar_event_id",
  "participants",
  "diarization_enabled",
  "expected_speaker_count",
  "created_at",
  "updated_at",
  "sync_status",
  "deleted_at",
];
// A PATCH additionally pins the server base and any pending scope retraction.
const NOTE_PATCH_ACK_FIELDS = [...NOTE_CREATE_ACK_FIELDS, "cloud_updated_at", "left_team"];
// Must mirror FolderPushSnapshot in src/types/electron.ts.
const FOLDER_ACK_FIELDS = [
  "client_folder_id",
  "name",
  "is_default",
  "sort_order",
  "space_id",
  "created_at",
  "updated_at",
  "sync_status",
  "deleted_at",
  "left_team",
];

function rowMatchesSnapshot(row, snapshot, fields) {
  return fields.every((field) => {
    const expected = snapshot[field] === undefined ? null : snapshot[field];
    return row[field] === expected;
  });
}

// An optimistically deleted folder still holds its server-side name until the
// DELETE is confirmed, so it must keep blocking reuse of that name.
const FOLDER_NAME_TAKEN_FILTER = `(deleted_at IS NULL OR EXISTS (
  SELECT 1 FROM optimistic_folder_delete_rows r
  WHERE r.folder_id = folders.id AND r.entity_type = 'folder'
))`;

// Public calendar APIs must be explicit about their shape. In particular, the
// legacy calendar_events.patient_metadata column is deliberately absent here:
// it is relocated to calendar_patient_metadata and may only be read by the
// private patient resolver inside the encounter-start transaction.
const CALENDAR_EVENT_PUBLIC_COLUMNS = [
  "id",
  "calendar_id",
  "provider",
  "summary",
  "start_time",
  "end_time",
  "is_all_day",
  "status",
  "hangout_link",
  "html_link",
  "conference_data",
  "organizer_email",
  "attendees_count",
  "attendees",
  "event_id",
  "event_uid",
  "occurrence_id",
  "timezone",
  "recurrence",
  "capabilities",
  "patient_id",
  "appointment_id",
  "synced_at",
].join(", ");

const CALENDAR_EVENT_PUBLIC_COLUMNS_QUALIFIED = CALENDAR_EVENT_PUBLIC_COLUMNS.split(", ")
  .map((column) => `calendar_events.${column}`)
  .join(", ");

function normalizePatientMetadataForStorage(value, { allowLegacySource = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowedKeys = new Set([
    "name",
    "email",
    "phone",
    "dob",
    "patient_id",
    "appointment_id",
    "source",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  if (
    value.source != null &&
    value.source !== "structured_description"
  ) {
    return null;
  }
  if (!allowLegacySource && value.source !== "structured_description") return null;

  const parsed = parsePatientMetadata(value);
  return parsed.metadata ? parsed.metadata : null;
}

function parseLegacyPatientMetadata(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return normalizePatientMetadataForStorage(JSON.parse(value), { allowLegacySource: true });
  } catch {
    return null;
  }
}

function normalizeSelfAttendeePresentForStorage(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  return null;
}

function parseStoredSelfAttendeePresent(value) {
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

// A meeting synced by both a REST provider (Google/Microsoft) and Apple
// (Calendar.app mirrors the same accounts) would double-fire reminders and
// duplicate UI rows; suppress the Apple copy when a REST row occupies the same
// time slot + title (REST rows have richer conference data). datetime()
// normalizes the providers' timestamp formats (Google stores offset-form
// RFC3339, Apple/Microsoft store UTC "Z" form). REST rows are never collapsed
// — Google and Microsoft are never mirrors of each other.
function dedupedEventsQuery(where) {
  return `SELECT ${CALENDAR_EVENT_PUBLIC_COLUMNS} FROM (
    SELECT ${CALENDAR_EVENT_PUBLIC_COLUMNS}, MAX(provider != 'apple') OVER (
      PARTITION BY datetime(start_time), datetime(end_time), COALESCE(summary, '')
    ) AS has_synced
    FROM calendar_events
    WHERE ${where}
  ) WHERE provider != 'apple' OR has_synced = 0 ORDER BY datetime(start_time) ASC`;
}

function stripDedupeColumn({ has_synced: _hasSynced, ...event }) {
  return event;
}

// Whitelist for provider-scoped SQL against the per-provider calendars tables.
const CALENDARS_TABLE_BY_PROVIDER = {
  google: "google_calendars",
  microsoft: "microsoft_calendars",
};

class DatabaseManager {
  constructor() {
    this.db = null;
    this.initDatabase();
  }

  initDatabase() {
    try {
      const dbFileName =
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db";

      const dbPath = path.join(app.getPath("userData"), dbFileName);

      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this._attachPatientRegistry();

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS transcriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Audio retention columns
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN raw_text TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN has_audio INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN audio_duration_ms INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN provider TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN model TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec(
          "ALTER TABLE transcriptions ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN error_message TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN error_code TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      // Records the dictation intent (e.g. "translation") so retry/recover re-runs the same route.
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN route_kind TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS custom_dictionary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          word TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS snippets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trigger TEXT NOT NULL,
          replacement TEXT NOT NULL,
          client_snippet_id TEXT,
          cloud_id TEXT,
          sync_status TEXT DEFAULT 'pending',
          deleted_at TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL DEFAULT 'Untitled Note',
          content TEXT NOT NULL DEFAULT '',
          note_type TEXT NOT NULL DEFAULT 'personal',
          source_file TEXT,
          audio_duration_seconds REAL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN enhanced_content TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN enhancement_prompt TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN enhanced_at_content_hash TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          title,
          content,
          enhanced_content,
          content='notes',
          content_rowid='id'
        )
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid, title, content, enhanced_content)
          VALUES (new.id, new.title, new.content, new.enhanced_content);
        END
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content, enhanced_content)
          VALUES ('delete', old.id, old.title, old.content, old.enhanced_content);
          INSERT INTO notes_fts(rowid, title, content, enhanced_content)
          VALUES (new.id, new.title, new.content, new.enhanced_content);
        END
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content, enhanced_content)
          VALUES ('delete', old.id, old.title, old.content, old.enhanced_content);
        END
      `);

      this.db
        .prepare(
          `
        INSERT OR IGNORE INTO notes_fts(rowid, title, content, enhanced_content)
        SELECT id, COALESCE(title, ''), COALESCE(content, ''), COALESCE(enhanced_content, '')
        FROM notes
      `
        )
        .run();

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          is_default INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const folderCount = this.db.prepare("SELECT COUNT(*) as count FROM folders").get();
      if (folderCount.count === 0) {
        const seedFolder = this.db.prepare(
          "INSERT INTO folders (name, is_default, sort_order) VALUES (?, 1, ?)"
        );
        seedFolder.run("Personal", 0);
        seedFolder.run("Meetings", 1);
        seedFolder.run("Videos", 2);
      }

      // Backfill folder_id only when the column is first added: on later
      // launches a NULL folder_id is a legitimate space-root note, not a
      // pre-folders row.
      let folderColumnAdded = true;
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN folder_id INTEGER REFERENCES folders(id)");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
        folderColumnAdded = false;
      }

      if (folderColumnAdded) {
        const personalFolder = this.db
          .prepare("SELECT id FROM folders WHERE name = 'Personal' AND is_default = 1")
          .get();
        if (personalFolder) {
          this.db
            .prepare("UPDATE notes SET folder_id = ? WHERE folder_id IS NULL")
            .run(personalFolder.id);
        }
      }

      // One-time seed (user_version 1): a pre-existing user-created "Videos"
      // folder stays untouched (never promoted to default); URL downloads route
      // to it by name. Guarded so a later delete/rename doesn't resurrect it as
      // an undeletable default on the next launch.
      if (this.db.pragma("user_version", { simple: true }) < 1) {
        const videosFolder = this.db.prepare("SELECT id FROM folders WHERE name = 'Videos'").get();
        if (!videosFolder) {
          const maxOrder = this.db.prepare("SELECT MAX(sort_order) as m FROM folders").get();
          this.db
            .prepare(
              "INSERT OR IGNORE INTO folders (name, is_default, sort_order) VALUES ('Videos', 1, ?)"
            )
            .run((maxOrder?.m ?? 1) + 1);
        }
        this.db.pragma("user_version = 1");
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          prompt TEXT NOT NULL,
          icon TEXT NOT NULL DEFAULT 'sparkles',
          is_builtin INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE actions ADD COLUMN translation_key TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL DEFAULT 'Untitled',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation ON agent_messages(conversation_id)"
      );

      try {
        this.db.exec("ALTER TABLE agent_messages ADD COLUMN metadata TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN archived_at DATETIME");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN note_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_conversations_note ON agent_conversations(note_id)"
      );
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN space_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN folder_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_conversations_container ON agent_conversations(space_id, folder_id)"
      );

      const actionCount = this.db.prepare("SELECT COUNT(*) as count FROM actions").get();
      if (actionCount.count === 0) {
        this.db
          .prepare(
            "INSERT INTO actions (name, description, prompt, icon, is_builtin, sort_order, translation_key) VALUES (?, ?, ?, ?, 1, 0, ?)"
          )
          .run(
            "Generate Notes",
            "Clean up, structure, and enhance your notes",
            "Transform the provided content into clean, well-structured notes in markdown. Preserve the user's intent and all substantive information. Remove filler, small talk, false starts, and redundant content. For personal notes, improve grammar and structure for readability. For meeting transcripts, extract key discussion points, decisions, action items, and follow-ups.",
            "sparkles",
            "notes.actions.builtin.generateNotes"
          );
      }

      // Migrate built-in action to "Generate Notes"
      this.db
        .prepare(
          "UPDATE actions SET name = ?, description = ?, prompt = ?, translation_key = ? WHERE is_builtin = 1 AND translation_key != ?"
        )
        .run(
          "Generate Notes",
          "Clean up, structure, and enhance your notes",
          "Transform the provided content into clean, well-structured notes in markdown. Preserve the user's intent and all substantive information. Remove filler, small talk, false starts, and redundant content. For personal notes, improve grammar and structure for readability. For meeting transcripts, extract key discussion points, decisions, action items, and follow-ups.",
          "notes.actions.builtin.generateNotes",
          "notes.actions.builtin.generateNotes"
        );

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS google_calendar_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          google_email TEXT NOT NULL UNIQUE,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          scope TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Migration: add UNIQUE constraint to google_email if table already existed without it
      try {
        const tableInfo = this.db.pragma("index_list('google_calendar_tokens')");
        const hasUniqueEmail = tableInfo.some((idx) => {
          if (!idx.unique) return false;
          const cols = this.db.pragma(`index_info('${idx.name}')`);
          return cols.length === 1 && cols[0].name === "google_email";
        });
        if (!hasUniqueEmail) {
          this.db.exec(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_google_calendar_tokens_email ON google_calendar_tokens(google_email)"
          );
        }
      } catch (err) {
        debugLogger.error(
          "Migration: google_email unique index",
          { error: err.message },
          "database"
        );
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS google_calendars (
          id TEXT PRIMARY KEY,
          summary TEXT NOT NULL,
          description TEXT,
          background_color TEXT,
          is_selected INTEGER NOT NULL DEFAULT 1,
          sync_token TEXT,
          account_email TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE google_calendars ADD COLUMN account_email TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      try {
        this.db.exec(
          "ALTER TABLE google_calendars ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS microsoft_calendar_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          microsoft_email TEXT NOT NULL UNIQUE,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          scope TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS microsoft_calendars (
          id TEXT PRIMARY KEY,
          summary TEXT NOT NULL,
          background_color TEXT,
          is_selected INTEGER NOT NULL DEFAULT 1,
          is_primary INTEGER NOT NULL DEFAULT 0,
          sync_token TEXT,
          sync_token_expires_at INTEGER,
          account_email TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS calendar_events (
          id TEXT PRIMARY KEY,
          calendar_id TEXT NOT NULL,
          summary TEXT,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          is_all_day INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'confirmed',
          hangout_link TEXT,
          html_link TEXT,
          conference_data TEXT,
          organizer_email TEXT,
          attendees_count INTEGER DEFAULT 0,
          patient_id TEXT,
          dob TEXT,
          normalized_phone TEXT,
          normalized_email TEXT,
          appointment_id TEXT,
          synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec(
          "ALTER TABLE calendar_events ADD COLUMN provider TEXT NOT NULL DEFAULT 'google'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      try {
        this.db.exec("ALTER TABLE calendar_events ADD COLUMN html_link TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      // Phase 2 incorrectly stored the safe Google Calendar event page in
      // hangout_link. Retain it as a non-join fallback and clear only that
      // known legacy shape; genuine conference links stay untouched.
      this.db.exec(`
        UPDATE calendar_events
        SET html_link = COALESCE(html_link, hangout_link), hangout_link = NULL
        WHERE provider = 'ai_receptionist'
          AND hangout_link IS NOT NULL
          AND (
            hangout_link LIKE 'https://calendar.google.com/%'
            OR hangout_link LIKE 'https://www.google.com/calendar/%'
          )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS apple_calendars (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          color TEXT,
          source_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN transcript TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      // The revision is deliberately independent of the hash: a transcript can
      // change A -> B -> A while retaining the same hash. Keeping a monotonic
      // value lets guarded output completion reject that ABA case.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN transcript_revision INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN calendar_event_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      try {
        this.db.exec("ALTER TABLE calendar_events ADD COLUMN attendees TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      for (const column of [
        "event_uid TEXT",
        "event_id TEXT",
        "occurrence_id TEXT",
        "timezone TEXT",
        "recurrence TEXT",
        "capabilities TEXT",
        "patient_id TEXT",
        "dob TEXT",
        "normalized_phone TEXT",
        "normalized_email TEXT",
        "appointment_id TEXT",
        "patient_metadata TEXT",
      ]) {
        try {
          this.db.exec(`ALTER TABLE calendar_events ADD COLUMN ${column}`);
        } catch (err) {
          if (!err.message.includes("duplicate column")) throw err;
        }
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS calendar_patient_metadata (
          calendar_event_id TEXT PRIMARY KEY
            REFERENCES calendar_events(id) ON DELETE CASCADE,
          metadata_json TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source = 'structured_description'),
          patient_id TEXT,
          dob TEXT,
          normalized_phone TEXT,
          normalized_email TEXT,
          appointment_id TEXT,
          self_attendee_present INTEGER
            CHECK (self_attendee_present IN (0, 1) OR self_attendee_present IS NULL),
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      try {
        // Preserve pre-R8 metadata rows as provenance-unknown. Backfilling
        // false could let a historical metadata-only event create a folder.
        this.db.exec(`
          ALTER TABLE calendar_patient_metadata
          ADD COLUMN self_attendee_present INTEGER
            CHECK (self_attendee_present IN (0, 1) OR self_attendee_present IS NULL)
        `);
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      for (const column of [
        "patient_id TEXT",
        "dob TEXT",
        "normalized_phone TEXT",
        "normalized_email TEXT",
        "appointment_id TEXT",
      ]) {
        try {
          this.db.exec(`ALTER TABLE calendar_patient_metadata ADD COLUMN ${column}`);
        } catch (err) {
          if (!err.message.includes("duplicate column")) throw err;
        }
      }

      // Earlier development builds wrote an already-sanitized JSON payload to
      // calendar_events.patient_metadata. Relocate only the valid subset into
      // the resolver-only table, clear the obsolete column (including invalid
      // values), and intentionally do not create any patient entities here.
      // The transaction makes repeat startup/retry safe on upgraded databases.
      const legacyPatientMetadataRows = this.db
        .prepare(
          "SELECT id, patient_metadata FROM calendar_events WHERE patient_metadata IS NOT NULL"
        )
        .all();
      if (legacyPatientMetadataRows.length > 0) {
        const relocateLegacyPatientMetadata = this.db.transaction((rows) => {
          const upsertMetadata = this.db.prepare(`
            INSERT INTO calendar_patient_metadata (calendar_event_id, metadata_json, source, updated_at)
            VALUES (?, ?, 'structured_description', CURRENT_TIMESTAMP)
            ON CONFLICT(calendar_event_id) DO UPDATE SET
              metadata_json = excluded.metadata_json,
              source = excluded.source,
              updated_at = CURRENT_TIMESTAMP
          `);
          const clearLegacyMetadata = this.db.prepare(
            "UPDATE calendar_events SET patient_metadata = NULL WHERE id = ?"
          );
          for (const row of rows) {
            const metadata = parseLegacyPatientMetadata(row.patient_metadata);
            if (metadata) {
              upsertMetadata.run(row.id, JSON.stringify(metadata));
            }
            clearLegacyMetadata.run(row.id);
          }
        });
        relocateLegacyPatientMetadata(legacyPatientMetadataRows);
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN participants TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN diarization_enabled INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN expected_speaker_count INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      // Nullable so legacy notes remain distinguishable from explicitly
      // selected contexts; the renderer resolves NULL to telehealth.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN meeting_context TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN encounter_auto_title_seed TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Encounters are the local scheduling/recording lifecycle. Meeting notes
      // remain the document and transcript store; note_id connects one encounter
      // to the one note created when it is first started.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS encounters (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          calendar_event_id TEXT UNIQUE,
          provider TEXT,
          calendar_id TEXT,
          title TEXT NOT NULL DEFAULT 'Encounter',
          start_time TEXT,
          end_time TEXT,
          source_status TEXT NOT NULL DEFAULT 'confirmed',
          lifecycle_state TEXT NOT NULL DEFAULT 'scheduled'
            CHECK (lifecycle_state IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
          note_id INTEGER UNIQUE,
          meeting_context TEXT
            CHECK (meeting_context IS NULL OR meeting_context IN ('in_person', 'telehealth')),
          attendees_count INTEGER NOT NULL DEFAULT 0,
          attendees TEXT,
          patient_id TEXT,
          dob TEXT,
          normalized_phone TEXT,
          normalized_email TEXT,
          appointment_id TEXT,
          patient_profile_id INTEGER REFERENCES patient_profiles(id),
          patient_resolution TEXT NOT NULL DEFAULT 'unassigned_missing_email'
            CHECK (patient_resolution IN (${PATIENT_RESOLUTION_SQL})),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          started_at DATETIME,
          completed_at DATETIME,
          cancelled_at DATETIME
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_encounters_start_time ON encounters(start_time)"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_encounters_lifecycle_start ON encounters(lifecycle_state, start_time)"
      );
      for (const [column, definition] of [
        ["patient_profile_id", "INTEGER REFERENCES patient_profiles(id)"],
        ["patient_resolution", "TEXT NOT NULL DEFAULT 'unassigned_missing_email'"],
        ["patient_id", "TEXT"],
        ["dob", "TEXT"],
        ["normalized_phone", "TEXT"],
        ["normalized_email", "TEXT"],
        ["appointment_id", "TEXT"],
      ]) {
        try {
          this.db.exec(`ALTER TABLE encounters ADD COLUMN ${column} ${definition}`);
        } catch (err) {
          if (!err.message.includes("duplicate column")) throw err;
        }
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_encounters_patient_profile ON encounters(patient_profile_id)"
      );

      // Existing development databases cannot safely rebuild encounters just to
      // add a CHECK. Normalize the historical/free-form values first, then use
      // triggers to give upgrades the same hard failure semantics as a fresh
      // database. This is intentionally before any new resolver work runs.
      this.db
        .prepare(
          `UPDATE encounters
           SET patient_resolution = 'unassigned_legacy'
           WHERE patient_resolution IS NULL
              OR patient_resolution NOT IN (${PATIENT_RESOLUTION_SQL})`
        )
        .run();
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS validate_encounters_patient_resolution_insert
        BEFORE INSERT ON encounters
        FOR EACH ROW
        WHEN NEW.patient_resolution IS NULL
          OR NEW.patient_resolution NOT IN (${PATIENT_RESOLUTION_SQL})
        BEGIN
          SELECT RAISE(ABORT, 'invalid patient_resolution');
        END;

        CREATE TRIGGER IF NOT EXISTS validate_encounters_patient_resolution_update
        BEFORE UPDATE OF patient_resolution ON encounters
        FOR EACH ROW
        WHEN NEW.patient_resolution IS NULL
          OR NEW.patient_resolution NOT IN (${PATIENT_RESOLUTION_SQL})
        BEGIN
          SELECT RAISE(ABORT, 'invalid patient_resolution');
        END;
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS patient_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          normalized_email TEXT NOT NULL UNIQUE,
          display_name TEXT,
          phone TEXT,
          folder_id INTEGER NOT NULL UNIQUE REFERENCES folders(id),
          identity_source TEXT NOT NULL
            CHECK (identity_source IN ('attendee_email', 'structured_description', 'manual')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_patient_profiles_folder ON patient_profiles(folder_id)"
      );

      // Managed patient demographics stay in the shared registry. This local
      // table owns only the Hira workspace mapping, so notes/folders remain
      // entirely inside transcriptions.db without copying a registry row.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS patient_workspaces (
          patient_id TEXT PRIMARY KEY,
          folder_id INTEGER NOT NULL UNIQUE REFERENCES folders(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_patient_workspaces_folder ON patient_workspaces(folder_id)"
      );

      // Clinical encounter outputs deliberately live beside, rather than in,
      // notes. A note is the user-owned canonical transcript; this record
      // tracks derived summary/SOAP material and the exact transcript revision
      // it was generated from.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS encounter_outputs (
          encounter_id INTEGER PRIMARY KEY REFERENCES encounters(id) ON DELETE CASCADE,
          transcript_hash TEXT NOT NULL,
          transcript_revision INTEGER NOT NULL DEFAULT 0,
          summary TEXT,
          soap TEXT,
          focus TEXT,
          summary_status TEXT NOT NULL DEFAULT 'pending'
            CHECK (summary_status IN ('pending', 'processing', 'ready', 'failed', 'stale')),
          soap_status TEXT NOT NULL DEFAULT 'pending'
            CHECK (soap_status IN ('pending', 'processing', 'ready', 'failed', 'stale')),
          focus_status TEXT NOT NULL DEFAULT 'pending'
            CHECK (focus_status IN ('pending', 'processing', 'ready', 'failed', 'stale')),
          summary_provider TEXT,
          summary_model TEXT,
          soap_provider TEXT,
          soap_model TEXT,
          summary_error_code TEXT,
          soap_error_code TEXT,
          focus_provider TEXT,
          focus_model TEXT,
          focus_error_code TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          summary_updated_at DATETIME,
          soap_updated_at DATETIME
          ,focus_updated_at DATETIME
        )
      `);
      // Keep upgrades safe if a development build created an earlier, partial
      // version of this local-only table.
      for (const [column, definition] of [
        ["transcript_hash", "TEXT NOT NULL DEFAULT ''"],
        ["transcript_revision", "INTEGER NOT NULL DEFAULT 0"],
        ["summary", "TEXT"],
        ["soap", "TEXT"],
        ["focus", "TEXT"],
        ["summary_status", "TEXT NOT NULL DEFAULT 'pending'"],
        ["soap_status", "TEXT NOT NULL DEFAULT 'pending'"],
        ["focus_status", "TEXT NOT NULL DEFAULT 'pending'"],
        ["summary_provider", "TEXT"],
        ["summary_model", "TEXT"],
        ["soap_provider", "TEXT"],
        ["soap_model", "TEXT"],
        ["summary_error_code", "TEXT"],
        ["soap_error_code", "TEXT"],
        ["focus_provider", "TEXT"],
        ["focus_model", "TEXT"],
        ["focus_error_code", "TEXT"],
        ["summary_updated_at", "DATETIME"],
        ["soap_updated_at", "DATETIME"],
        ["focus_updated_at", "DATETIME"],
      ]) {
        try {
          this.db.exec(`ALTER TABLE encounter_outputs ADD COLUMN ${column} ${definition}`);
        } catch (err) {
          if (!err.message.includes("duplicate column")) throw err;
        }
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_encounter_outputs_transcript_hash ON encounter_outputs(transcript_hash)"
      );

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS contacts (
          email TEXT PRIMARY KEY,
          display_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS speaker_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          display_name TEXT NOT NULL,
          email TEXT,
          embedding BLOB NOT NULL,
          sample_count INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS speaker_mappings (
          note_id INTEGER NOT NULL,
          speaker_id TEXT NOT NULL,
          profile_id INTEGER,
          display_name TEXT NOT NULL,
          PRIMARY KEY (note_id, speaker_id),
          FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
          FOREIGN KEY (profile_id) REFERENCES speaker_profiles(id) ON DELETE SET NULL
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS note_speaker_embeddings (
          note_id INTEGER NOT NULL,
          speaker_id TEXT NOT NULL,
          embedding BLOB NOT NULL,
          PRIMARY KEY (note_id, speaker_id),
          FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        )
      `);

      // A cloud folder delete is optimistic until the API answers. Keep the
      // exact pre-delete row state in a durable journal so a permission denial
      // can revive the same folder, notes, speakers, and conversations even
      // after an app restart. Content stays in its owning tables; the journal
      // contains only identity and sync metadata.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS optimistic_folder_delete_rows (
          folder_id INTEGER NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id INTEGER NOT NULL,
          original_sync_status TEXT,
          original_deleted_at TEXT,
          original_updated_at TEXT,
          PRIMARY KEY (folder_id, entity_type, entity_id)
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_optimistic_folder_delete_entity ON optimistic_folder_delete_rows(entity_type, entity_id)"
      );

      // Sync columns for notes
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN client_note_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN share_token TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Existing recorded meetings keep their calendar linkage after the local
      // encounter migration. This runs only after all legacy note columns used
      // by the filter above are available, and never deletes or rewrites a note.
      this.db.exec(`
        INSERT OR IGNORE INTO encounters (
          calendar_event_id, provider, calendar_id, title, start_time, end_time,
          source_status, lifecycle_state, note_id, attendees_count, attendees,
          created_at, updated_at, started_at
        )
        SELECT c.id, c.provider, c.calendar_id, COALESCE(c.summary, n.title),
          c.start_time, c.end_time, COALESCE(c.status, 'confirmed'), 'in_progress',
          n.id, COALESCE(c.attendees_count, 0), c.attendees,
          n.created_at, n.updated_at, n.created_at
        FROM notes n
        JOIN calendar_events c ON c.id = n.calendar_event_id
        WHERE n.calendar_event_id IS NOT NULL AND n.deleted_at IS NULL
      `);

      // Sync columns for folders
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN client_folder_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN updated_at DATETIME");
        this.db.exec("UPDATE folders SET updated_at = created_at WHERE updated_at IS NULL");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Sync columns for agent_conversations
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN client_conversation_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec(
          "ALTER TABLE agent_conversations ADD COLUMN sync_status TEXT DEFAULT 'pending'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Sync columns for transcriptions
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN client_transcription_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Sync columns for custom_dictionary
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN client_dict_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec(
          "ALTER TABLE custom_dictionary ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN updated_at DATETIME");
        this.db.exec(
          "UPDATE custom_dictionary SET updated_at = created_at WHERE updated_at IS NULL"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Backfill client IDs for existing rows
      const syncTables = [
        { table: "notes", col: "client_note_id" },
        { table: "folders", col: "client_folder_id" },
        { table: "agent_conversations", col: "client_conversation_id" },
        { table: "transcriptions", col: "client_transcription_id" },
        { table: "custom_dictionary", col: "client_dict_id" },
        { table: "snippets", col: "client_snippet_id" },
      ];
      for (const { table, col } of syncTables) {
        const rows = this.db.prepare(`SELECT id FROM ${table} WHERE ${col} IS NULL`).all();
        const stmt = this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`);
        for (const row of rows) {
          stmt.run(randomUUID(), row.id);
        }
      }

      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_client_note_id ON notes(client_note_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_client_folder_id ON folders(client_folder_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_client_id ON agent_conversations(client_conversation_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_transcriptions_client_id ON transcriptions(client_transcription_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_dictionary_client_id ON custom_dictionary(client_dict_id)"
      );
      // Cloud batch-create matches responses by client_dict_id, so a row
      // without one can never be marked synced and re-uploads every pass. Rows
      // written straight to SQLite don't set it (#1295), so the schema does.
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS custom_dictionary_client_id_default
        AFTER INSERT ON custom_dictionary
        WHEN new.client_dict_id IS NULL
        BEGIN
          UPDATE custom_dictionary SET client_dict_id =
            lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
            substr(lower(hex(randomblob(2))), 2) || '-' ||
            substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) ||
            '-' || lower(hex(randomblob(6)))
          WHERE id = new.id;
        END
      `);
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_snippets_client_id ON snippets(client_snippet_id) WHERE client_snippet_id IS NOT NULL"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_snippets_trigger_lower_active ON snippets(lower(trigger)) WHERE deleted_at IS NULL"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_snippets_pending_sync ON snippets(sync_status) WHERE sync_status = 'pending'"
      );

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS spaces (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          client_space_id TEXT,
          cloud_team_id   TEXT,
          workspace_id    TEXT,
          kind            TEXT NOT NULL DEFAULT 'team' CHECK (kind IN ('private','team')),
          name            TEXT NOT NULL,
          emoji           TEXT,
          sort_order      INTEGER NOT NULL DEFAULT 0,
          my_role         TEXT,
          member_count    INTEGER,
          sync_status     TEXT NOT NULL DEFAULT 'pending',
          deleted_at      TEXT,
          created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_client_space_id ON spaces(client_space_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_cloud_team_id ON spaces(cloud_team_id) WHERE cloud_team_id IS NOT NULL"
      );

      // First-class spaces: a space mirrors a cloud space with one or more
      // assigned teams. cloud_team_id survives only so pre-spaces rows can be
      // adopted by upsertSpaceFromCloud (matched via the space's single
      // backfilled team).
      try {
        this.db.exec("ALTER TABLE spaces ADD COLUMN cloud_space_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        // JSON array of { id, name, my_role } mirrored from GET /api/me/spaces.
        this.db.exec("ALTER TABLE spaces ADD COLUMN teams TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_cloud_space_id ON spaces(cloud_space_id) WHERE cloud_space_id IS NOT NULL"
      );

      const privateSpaceCount = this.db
        .prepare("SELECT COUNT(*) as count FROM spaces WHERE kind = 'private'")
        .get();
      if (privateSpaceCount.count === 0) {
        this.db
          .prepare(
            "INSERT INTO spaces (client_space_id, kind, name, sort_order, sync_status) VALUES (?, 'private', 'Personal', 0, 'synced')"
          )
          .run(randomUUID());
      }

      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN space_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN space_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Rebuild folders to drop the table-level UNIQUE(name); per-space name
      // uniqueness is enforced by idx_folders_space_name below.
      // better-sqlite3 enables foreign_keys by default, so DROP TABLE folders
      // would fail while notes.folder_id rows reference it; the pragma is a
      // no-op inside a transaction, so toggle it around the rebuild.
      const foldersTable = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'folders'")
        .get();
      if (foldersTable?.sql.includes("UNIQUE")) {
        const foreignKeysWereOn = this.db.pragma("foreign_keys", { simple: true }) === 1;
        this.db.pragma("foreign_keys = OFF");
        try {
          this.db.transaction(() => {
            this.db.exec(`
            CREATE TABLE folders_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              is_default INTEGER NOT NULL DEFAULT 0,
              sort_order INTEGER NOT NULL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              client_folder_id TEXT,
              cloud_id TEXT,
              sync_status TEXT DEFAULT 'pending',
              deleted_at TEXT,
              space_id INTEGER
            )
          `);
            this.db.exec(`
            INSERT INTO folders_new (id, name, is_default, sort_order, created_at, updated_at,
              client_folder_id, cloud_id, sync_status, deleted_at, space_id)
            SELECT id, name, is_default, sort_order, created_at, updated_at,
              client_folder_id, cloud_id, sync_status, deleted_at, space_id
            FROM folders
          `);
            this.db.exec("DROP TABLE folders");
            this.db.exec("ALTER TABLE folders_new RENAME TO folders");
            this.db.exec(
              "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_client_folder_id ON folders(client_folder_id)"
            );
          })();
        } finally {
          if (foreignKeysWereOn) this.db.pragma("foreign_keys = ON");
        }
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_space_name ON folders(space_id, name) WHERE deleted_at IS NULL"
      );

      const privateSpace = this.db.prepare("SELECT id FROM spaces WHERE kind = 'private'").get();
      this.db
        .prepare("UPDATE folders SET space_id = ? WHERE space_id IS NULL")
        .run(privateSpace.id);
      this.db.prepare("UPDATE notes SET space_id = ? WHERE space_id IS NULL").run(privateSpace.id);

      this.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_folder_id ON notes(folder_id)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at)");
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_notes_space_updated ON notes(space_id, updated_at)"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_folders_space_sort ON folders(space_id, sort_order)"
      );

      // Cloud-backed rows that just LEFT a team must keep pushing their scope
      // retraction (D6) even in the backup-off team-only pass, where the
      // pending queues otherwise filter on the row's CURRENT space kind.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN left_team INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN left_team INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Last cloud editor (CloudNote.updated_by_user_id); only populated on
      // cloud pull — local edits don't set it. Resolved to a display name via
      // the team roster when rendering note authorship.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN updated_by_user_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Server updated_at this device last acked (push response or pull),
      // echoed verbatim as base_updated_at on the next PATCH so the server can
      // 409 a stale overwrite. Local edits never touch it; NULL means the note
      // predates the guard and pushes last-write-wins once.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN cloud_updated_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // The note's owner (CloudNote.user_id) — who created it, not who last
      // edited it (updated_by_user_id). Drives the client-side delete/scope
      // permission checks; NULL until a cloud pull or push response fills it.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN owner_user_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Space vector purges owed to Qdrant while the sidecar was down/booting;
      // drained once the vector index is ready.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pending_vector_purges (
          space_id   INTEGER PRIMARY KEY,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      return true;
    } catch (error) {
      debugLogger.error("Database initialization failed", { error: error.message }, "database");
      throw error;
    }
  }

  _attachPatientRegistry() {
    this.patientRegistryPath = null;
    this.patientRegistryTables = null;
    const configuredPath = String(process.env.HIRA_PATIENT_REGISTRY_PATH || "").trim();
    if (!configuredPath) return;

    const registryPath = path.resolve(configuredPath);
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    this.db.prepare("ATTACH DATABASE ? AS hira_registry").run(registryPath);
    this.patientRegistryPath = registryPath;

    // This is the shared v1 contract. The Python receptionist owns writes,
    // while Hira reads it through SQLite's same-file attachment. Keep these
    // names identical across both runtimes; a similar-but-different schema
    // would make identity resolution appear to work while silently dropping
    // appointment links.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hira_registry.patients (
        patient_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        dob TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        normalized_name TEXT NOT NULL,
        normalized_dob TEXT NOT NULL,
        normalized_phone TEXT,
        normalized_email TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS hira_registry.appointments (
        appointment_id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        type TEXT NOT NULL,
        provider TEXT NOT NULL,
        calendar_id TEXT NOT NULL,
        google_event_id TEXT,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const columns = (table) =>
      this.db.prepare(`SELECT name FROM hira_registry.pragma_table_info(?)`).all(table).map((column) => column.name);
    const ensureColumn = (table, name, definition) => {
      if (!columns(table).includes(name)) {
        this.db.exec(`ALTER TABLE hira_registry.${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    // Upgrade the short-lived prototype schema without dropping a local
    // registry. Newly created databases already have these columns; older
    // databases get nullable compatibility columns and are then safe for the
    // Python writer's explicit INSERT statements.
    for (const [name, definition] of [
      ["name", "TEXT"], ["phone", "TEXT"], ["email", "TEXT"],
      ["normalized_name", "TEXT"], ["normalized_dob", "TEXT"],
      ["normalized_phone", "TEXT"], ["normalized_email", "TEXT"],
      ["active", "INTEGER DEFAULT 1"],
    ]) ensureColumn("patients", name, definition);
    for (const [name, definition] of [
      ["start", "TEXT"], ["end", "TEXT"], ["type", "TEXT"],
      ["provider", "TEXT"], ["calendar_id", "TEXT"], ["google_event_id", "TEXT"],
      ["status", "TEXT"], ["source", "TEXT"], ["idempotency_key", "TEXT"],
    ]) ensureColumn("appointments", name, definition);
    if (columns("patients").includes("display_name")) {
      this.db.exec("UPDATE hira_registry.patients SET name = COALESCE(name, display_name) WHERE name IS NULL");
    }
    if (columns("patients").includes("date_of_birth")) {
      this.db.exec("UPDATE hira_registry.patients SET dob = COALESCE(dob, date_of_birth) WHERE dob IS NULL");
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS hira_registry.idx_patients_dob_phone
        ON patients(normalized_dob, normalized_phone);
      CREATE INDEX IF NOT EXISTS hira_registry.idx_patients_dob_email
        ON patients(normalized_dob, normalized_email);
      CREATE INDEX IF NOT EXISTS hira_registry.idx_appointments_patient
        ON appointments(patient_id);
    `);
    this.patientRegistryTables = {
      patients: "patients",
      appointments: "appointments",
      patientColumns: columns("patients"),
      appointmentColumns: columns("appointments"),
    };
  }

  saveTranscription(
    text,
    rawText = null,
    {
      status = "completed",
      errorMessage = null,
      errorCode = null,
      routeKind = null,
      clientTranscriptionId = randomUUID(),
    } = {}
  ) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare(
        "INSERT INTO transcriptions (text, raw_text, status, error_message, error_code, route_kind, client_transcription_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      const result = stmt.run(
        text,
        rawText,
        status,
        errorMessage,
        errorCode,
        routeKind,
        clientTranscriptionId
      );

      const fetchStmt = this.db.prepare("SELECT * FROM transcriptions WHERE id = ?");
      const transcription = fetchStmt.get(result.lastInsertRowid);

      return { id: result.lastInsertRowid, success: true, transcription };
    } catch (error) {
      debugLogger.error("Error saving transcription", { error: error.message }, "database");
      throw error;
    }
  }

  getTranscriptions(limit = 50, { includeDiscarded = false } = {}) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const statusFilter = includeDiscarded ? "" : " AND status != 'discarded'";
      const stmt = this.db.prepare(
        `SELECT * FROM transcriptions WHERE deleted_at IS NULL${statusFilter} ORDER BY timestamp DESC LIMIT ?`
      );
      const transcriptions = stmt.all(limit);
      return transcriptions;
    } catch (error) {
      debugLogger.error("Error getting transcriptions", { error: error.message }, "database");
      throw error;
    }
  }

  clearTranscriptions() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const tombstone = this.db.prepare(
        "UPDATE transcriptions SET deleted_at = datetime('now'), sync_status = 'pending' WHERE cloud_id IS NOT NULL AND deleted_at IS NULL"
      );
      const hardDelete = this.db.prepare("DELETE FROM transcriptions WHERE cloud_id IS NULL");
      const clearAll = this.db.transaction(
        () => tombstone.run().changes + hardDelete.run().changes
      );
      return { cleared: clearAll(), success: true };
    } catch (error) {
      debugLogger.error("Error clearing transcriptions", { error: error.message }, "database");
      throw error;
    }
  }

  /** Purges transcriptions older than the retention window. Returns the affected ids so
   *  callers can drop the matching audio files. */
  deleteTranscriptionsExpiredBefore(retentionDays) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      // Resolve the cutoff once so the ids we report are exactly the rows we purge.
      const cutoff = this.db
        .prepare("SELECT datetime('now', ?) AS cutoff")
        .get(`-${retentionDays} days`).cutoff;
      const expired = this.db
        .prepare("SELECT id FROM transcriptions WHERE deleted_at IS NULL AND created_at < ?")
        .all(cutoff)
        .map((row) => row.id);
      if (expired.length === 0) return { ids: [] };

      const tombstone = this.db.prepare(
        "UPDATE transcriptions SET deleted_at = datetime('now'), sync_status = 'pending' WHERE cloud_id IS NOT NULL AND deleted_at IS NULL AND created_at < ?"
      );
      const hardDelete = this.db.prepare(
        "DELETE FROM transcriptions WHERE cloud_id IS NULL AND created_at < ?"
      );
      this.db.transaction(() => {
        tombstone.run(cutoff);
        hardDelete.run(cutoff);
      })();
      return { ids: expired };
    } catch (error) {
      debugLogger.error(
        "Error purging expired transcriptions",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  deleteTranscription(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const row = this.db
        .prepare("SELECT cloud_id, deleted_at FROM transcriptions WHERE id = ?")
        .get(id);
      if (!row || row.deleted_at) return { success: false, id };
      const stmt = row.cloud_id
        ? this.db.prepare(
            "UPDATE transcriptions SET deleted_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND deleted_at IS NULL"
          )
        : this.db.prepare("DELETE FROM transcriptions WHERE id = ?");
      const result = stmt.run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error deleting transcription", { error: error.message }, "database");
      throw error;
    }
  }

  updateTranscriptionAudio(id, { hasAudio, audioDurationMs, provider, model }) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        "UPDATE transcriptions SET has_audio = ?, audio_duration_ms = ?, provider = ?, model = ? WHERE id = ?"
      );
      stmt.run(hasAudio, audioDurationMs, provider, model, id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating transcription audio", { error: error.message }, "database");
      throw error;
    }
  }

  updateTranscriptionText(id, text, rawText) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare("UPDATE transcriptions SET text = ?, raw_text = ? WHERE id = ?");
      stmt.run(text, rawText, id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating transcription text", { error: error.message }, "database");
      throw error;
    }
  }

  updateTranscriptionStatus(id, status, errorMessage = null, errorCode = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        "UPDATE transcriptions SET status = ?, error_message = ?, error_code = ? WHERE id = ?"
      );
      stmt.run(status, errorMessage, errorCode, id);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error updating transcription status",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getTranscriptionById(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare("SELECT * FROM transcriptions WHERE id = ?");
      return stmt.get(id) || null;
    } catch (error) {
      debugLogger.error("Error getting transcription by id", { error: error.message }, "database");
      throw error;
    }
  }

  clearAudioFlags(ids) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!ids || ids.length === 0) return { success: true };
      const transaction = this.db.transaction((idList) => {
        const stmt = this.db.prepare("UPDATE transcriptions SET has_audio = 0 WHERE id = ?");
        for (const id of idList) {
          stmt.run(id);
        }
      });
      transaction(ids);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing audio flags", { error: error.message }, "database");
      throw error;
    }
  }

  getDictionary() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const rows = this.db
        .prepare("SELECT word FROM custom_dictionary WHERE deleted_at IS NULL ORDER BY id ASC")
        .all();
      return rows.map((row) => row.word);
    } catch (error) {
      debugLogger.error("Error getting dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  // Every dictionary mutation rule lives here once, so the whole-list and
  // delta write paths cannot drift apart.
  _dictionaryWriteStatements() {
    return {
      tombstone: this.db.prepare(
        "UPDATE custom_dictionary SET deleted_at = datetime('now'), updated_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND deleted_at IS NULL"
      ),
      hardDelete: this.db.prepare(
        "DELETE FROM custom_dictionary WHERE id = ? AND cloud_id IS NULL"
      ),
      restore: this.db.prepare(
        "UPDATE custom_dictionary SET deleted_at = NULL, source = CASE WHEN source = 'learned' AND ? = 'manual' THEN 'manual' ELSE source END, word = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?"
      ),
      promoteSource: this.db.prepare(
        "UPDATE custom_dictionary SET word = ?, source = 'manual', updated_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND source = 'learned'"
      ),
      // Guarded on word != ? so an unchanged row keeps its sync_status.
      updateWord: this.db.prepare(
        "UPDATE custom_dictionary SET word = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND word != ?"
      ),
      // INSERT OR IGNORE in case a legacy case-variant row collides on the
      // case-sensitive UNIQUE(word) that the lowercase index didn't catch.
      insert: this.db.prepare(
        "INSERT OR IGNORE INTO custom_dictionary (word, source, client_dict_id, sync_status, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'))"
      ),
    };
  }

  // Dedupe by lower(word), keeping the first occurrence's casing, so no caller
  // can present two spellings of the same word to a write loop.
  _normalizeDictionaryWords(words) {
    const byLower = new Map();
    for (const raw of Array.isArray(words) ? words : []) {
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (!byLower.has(lower)) byLower.set(lower, trimmed);
    }
    return byLower;
  }

  _dictionaryRows() {
    const rows = this.db
      .prepare("SELECT id, word, source, deleted_at FROM custom_dictionary")
      .all();
    return { rows, byLower: new Map(rows.map((r) => [r.word.toLowerCase(), r])) };
  }

  // Returns true when the word became present, so callers can report how many
  // words they actually added rather than how many they asked for.
  _upsertDictionaryWord(stmts, word, existing, source) {
    if (!existing) {
      return stmts.insert.run(word, source, randomUUID()).changes > 0;
    }
    if (existing.deleted_at) {
      stmts.restore.run(source, word, existing.id);
      return true;
    }
    if (source === "manual" && existing.source === "learned") {
      stmts.promoteSource.run(word, existing.id);
    } else {
      stmts.updateWord.run(word, existing.id, word);
    }
    return false;
  }

  // Hard-delete when the row never reached the cloud, else tombstone so the
  // next push tells the server about the deletion.
  _deleteDictionaryRow(stmts, existing) {
    if (!existing || existing.deleted_at) return false;
    const hardResult = stmts.hardDelete.run(existing.id);
    if (hardResult.changes === 0) stmts.tombstone.run(existing.id);
    return true;
  }

  // Add and/or remove specific words, leaving every other row untouched.
  // Prefer this over setDictionary, which deletes whatever the caller omitted
  // and so lets a stale snapshot destroy the rest (#1295).
  // `source` tags additions ('manual' for user-typed, 'learned' for auto-learn).
  applyDictionaryChanges({ add = [], remove = [] } = {}, source = "manual") {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const additions = this._normalizeDictionaryWords(add);
      const removals = this._normalizeDictionaryWords(remove);
      // A word on both sides is a rename to itself; adding wins.
      for (const lower of additions.keys()) removals.delete(lower);
      if (additions.size === 0 && removals.size === 0) {
        return { success: true, added: 0, removed: 0 };
      }

      const { byLower } = this._dictionaryRows();
      const stmts = this._dictionaryWriteStatements();
      let added = 0;
      let removed = 0;

      this.db.transaction(() => {
        for (const lower of removals.keys()) {
          if (this._deleteDictionaryRow(stmts, byLower.get(lower))) removed += 1;
        }
        for (const [lower, word] of additions) {
          if (this._upsertDictionaryWord(stmts, word, byLower.get(lower), source)) added += 1;
        }
      })();

      return { success: true, added, removed };
    } catch (error) {
      debugLogger.error("Error applying dictionary changes", { error: error.message }, "database");
      throw error;
    }
  }

  // Replace the entire dictionary: anything absent from `words` is deleted.
  // Only for deliberate replace-everything callers (settings restore, clear
  // all, first write into an empty database). Everything else wants
  // applyDictionaryChanges.
  //
  // Diff-based so unchanged rows keep their source/created_at/cloud_id.
  setDictionary(words, sourceForNewWords = "manual") {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const incomingByLower = this._normalizeDictionaryWords(words);
      const { rows, byLower } = this._dictionaryRows();
      const stmts = this._dictionaryWriteStatements();

      this.db.transaction(() => {
        for (const existing of rows) {
          if (incomingByLower.has(existing.word.toLowerCase())) continue;
          this._deleteDictionaryRow(stmts, existing);
        }
        for (const [lower, word] of incomingByLower) {
          this._upsertDictionaryWord(stmts, word, byLower.get(lower), sourceForNewWords);
        }
      })();

      return { success: true };
    } catch (error) {
      debugLogger.error("Error setting dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingDictionary() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM custom_dictionary WHERE sync_status = 'pending' AND deleted_at IS NULL"
        )
        .all();
    } catch (error) {
      debugLogger.error("Error getting pending dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingDictionaryDeletes() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM custom_dictionary WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL AND sync_status = 'pending'"
        )
        .all();
    } catch (error) {
      debugLogger.error(
        "Error getting pending dictionary deletes",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  hardDeleteDictionaryEntry(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db.prepare("DELETE FROM custom_dictionary WHERE id = ?").run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error(
        "Error hard deleting dictionary entry",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getDictionaryEntryByClientId(clientDictId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare("SELECT * FROM custom_dictionary WHERE client_dict_id = ?")
          .get(clientDictId) || null
      );
    } catch (error) {
      debugLogger.error(
        "Error getting dictionary entry by client id",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  upsertDictionaryFromCloud(cloudEntry) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // Reject incomplete payloads rather than corrupt a row with defaults.
      if (!cloudEntry || typeof cloudEntry !== "object") return null;
      if (typeof cloudEntry.id !== "string" || !cloudEntry.id) return null;

      const word = typeof cloudEntry.word === "string" ? cloudEntry.word.trim() : "";
      if (!word) return null;

      const clientDictId =
        typeof cloudEntry.client_dict_id === "string" && cloudEntry.client_dict_id
          ? cloudEntry.client_dict_id
          : randomUUID();
      const incomingSource = cloudEntry.source === "learned" ? "learned" : "manual";
      const updatedAt =
        typeof cloudEntry.updated_at === "string" && cloudEntry.updated_at
          ? cloudEntry.updated_at
          : typeof cloudEntry.created_at === "string" && cloudEntry.created_at
            ? cloudEntry.created_at
            : new Date().toISOString();
      const createdAt =
        typeof cloudEntry.created_at === "string" && cloudEntry.created_at
          ? cloudEntry.created_at
          : updatedAt;

      // Resolve the local row deterministically: client_dict_id, then cloud_id,
      // then word.
      const byClient = this.db
        .prepare("SELECT * FROM custom_dictionary WHERE client_dict_id = ? LIMIT 1")
        .get(clientDictId);
      const byCloud =
        byClient ||
        this.db
          .prepare("SELECT * FROM custom_dictionary WHERE cloud_id = ? LIMIT 1")
          .get(cloudEntry.id);
      const existing =
        byCloud ||
        this.db
          .prepare("SELECT * FROM custom_dictionary WHERE lower(word) = lower(?) LIMIT 1")
          .get(word);

      if (existing) {
        // Manual is sticky — a pull never demotes a local manual row to learned.
        const mergedSource =
          existing.source === "manual" || incomingSource === "manual" ? "manual" : "learned";
        this.db
          .prepare(
            `UPDATE custom_dictionary
             SET cloud_id = ?, client_dict_id = ?, word = ?, source = ?,
                 sync_status = 'synced', deleted_at = NULL, updated_at = ?
             WHERE id = ?`
          )
          .run(cloudEntry.id, clientDictId, word, mergedSource, updatedAt, existing.id);
        return this.db.prepare("SELECT * FROM custom_dictionary WHERE id = ?").get(existing.id);
      }

      this.db
        .prepare(
          `INSERT INTO custom_dictionary
             (word, source, client_dict_id, cloud_id, sync_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'synced', ?, ?)`
        )
        .run(word, incomingSource, clientDictId, cloudEntry.id, createdAt, updatedAt);
      return this.db
        .prepare("SELECT * FROM custom_dictionary WHERE client_dict_id = ?")
        .get(clientDictId);
    } catch (error) {
      debugLogger.error(
        "Error upserting dictionary entry from cloud",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  markDictionaryEntrySynced(id, cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // Guard on deleted_at so a delete or tombstone that raced the push isn't
      // flipped back to 'synced' (which would strand the deletion). changes=0
      // signals that race to SyncService, which reconciles the cloud row.
      const result = this.db
        .prepare(
          "UPDATE custom_dictionary SET sync_status = 'synced', cloud_id = ? WHERE id = ? AND deleted_at IS NULL"
        )
        .run(cloudId, id);
      return { success: result.changes > 0, changes: result.changes };
    } catch (error) {
      debugLogger.error(
        "Error marking dictionary entry synced",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Clears cloud_id after a 404 so the next push re-creates the row via
  // batchCreate instead of retrying the dead PATCH.
  clearDictionaryCloudId(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare(
          "UPDATE custom_dictionary SET cloud_id = NULL, sync_status = 'pending' WHERE id = ?"
        )
        .run(id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error("Error clearing dictionary cloud_id", { error: error.message }, "database");
      throw error;
    }
  }

  getSnippets() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      return this.db
        .prepare(
          "SELECT trigger, replacement FROM snippets WHERE deleted_at IS NULL ORDER BY id ASC"
        )
        .all();
    } catch (error) {
      debugLogger.error("Error getting snippets", { error: error.message }, "database");
      throw error;
    }
  }

  setSnippets(snippets) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }

      const incomingByLower = new Map();
      for (const raw of Array.isArray(snippets) ? snippets : []) {
        if (!raw || typeof raw !== "object") continue;
        const trigger = typeof raw.trigger === "string" ? raw.trigger.trim() : "";
        const replacement = typeof raw.replacement === "string" ? raw.replacement.trim() : "";
        if (!trigger || !replacement) continue;
        if (trigger.length > MAX_SNIPPET_TRIGGER_LENGTH) continue;
        const lower = trigger.toLowerCase();
        if (!incomingByLower.has(lower)) incomingByLower.set(lower, { trigger, replacement });
      }
      const cleaned = Array.from(incomingByLower.values());
      const incomingLower = new Set(incomingByLower.keys());

      const existingRows = this.db.prepare("SELECT * FROM snippets").all();
      const existingByLower = new Map();
      for (const row of existingRows) {
        const lower = row.trigger.toLowerCase();
        const current = existingByLower.get(lower);
        if (!current || (current.deleted_at && !row.deleted_at)) existingByLower.set(lower, row);
      }

      const tombstone = this.db.prepare(
        "UPDATE snippets SET deleted_at = datetime('now'), updated_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND deleted_at IS NULL"
      );
      const hardDelete = this.db.prepare("DELETE FROM snippets WHERE id = ? AND cloud_id IS NULL");
      const restore = this.db.prepare(
        "UPDATE snippets SET deleted_at = NULL, trigger = ?, replacement = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?"
      );
      const updateActive = this.db.prepare(
        "UPDATE snippets SET trigger = ?, replacement = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND (trigger != ? OR replacement != ?)"
      );
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO snippets (trigger, replacement, client_snippet_id, sync_status, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'))"
      );

      this.db.transaction(() => {
        for (const existing of existingRows) {
          if (incomingLower.has(existing.trigger.toLowerCase())) continue;
          if (existing.deleted_at) continue;
          const hardResult = hardDelete.run(existing.id);
          if (hardResult.changes === 0) tombstone.run(existing.id);
        }

        for (const snippet of cleaned) {
          const existing = existingByLower.get(snippet.trigger.toLowerCase());
          if (existing) {
            if (existing.deleted_at) {
              restore.run(snippet.trigger, snippet.replacement, existing.id);
            } else {
              updateActive.run(
                snippet.trigger,
                snippet.replacement,
                existing.id,
                snippet.trigger,
                snippet.replacement
              );
            }
            continue;
          }
          insert.run(snippet.trigger, snippet.replacement, randomUUID());
        }
      })();

      return { success: true };
    } catch (error) {
      debugLogger.error("Error setting snippets", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingSnippets() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare("SELECT * FROM snippets WHERE sync_status = 'pending' AND deleted_at IS NULL")
        .all();
    } catch (error) {
      debugLogger.error("Error getting pending snippets", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingSnippetDeletes() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM snippets WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL AND sync_status = 'pending'"
        )
        .all();
    } catch (error) {
      debugLogger.error(
        "Error getting pending snippet deletes",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  hardDeleteSnippet(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db.prepare("DELETE FROM snippets WHERE id = ?").run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error hard deleting snippet", { error: error.message }, "database");
      throw error;
    }
  }

  getSnippetForCloudMerge(cloudEntry) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!cloudEntry || typeof cloudEntry !== "object") return null;

      const clientSnippetId =
        typeof cloudEntry.client_snippet_id === "string" && cloudEntry.client_snippet_id
          ? cloudEntry.client_snippet_id
          : "";
      if (clientSnippetId) {
        const byClient = this.db
          .prepare("SELECT * FROM snippets WHERE client_snippet_id = ? LIMIT 1")
          .get(clientSnippetId);
        if (byClient) return byClient;
      }

      if (typeof cloudEntry.id === "string" && cloudEntry.id) {
        const byCloud = this.db
          .prepare("SELECT * FROM snippets WHERE cloud_id = ? LIMIT 1")
          .get(cloudEntry.id);
        if (byCloud) return byCloud;
      }

      const trigger = typeof cloudEntry.trigger === "string" ? cloudEntry.trigger.trim() : "";
      if (!trigger) return null;
      const byActiveTrigger = this.db
        .prepare(
          "SELECT * FROM snippets WHERE lower(trigger) = lower(?) AND deleted_at IS NULL LIMIT 1"
        )
        .get(trigger);
      if (byActiveTrigger) return byActiveTrigger;
      return (
        this.db
          .prepare(
            "SELECT * FROM snippets WHERE lower(trigger) = lower(?) AND deleted_at IS NOT NULL LIMIT 1"
          )
          .get(trigger) || null
      );
    } catch (error) {
      debugLogger.error(
        "Error getting snippet for cloud merge",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  upsertSnippetFromCloud(cloudEntry) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!cloudEntry || typeof cloudEntry !== "object") return null;
      if (typeof cloudEntry.id !== "string" || !cloudEntry.id) return null;

      const trigger = typeof cloudEntry.trigger === "string" ? cloudEntry.trigger.trim() : "";
      const replacement =
        typeof cloudEntry.replacement === "string" ? cloudEntry.replacement.trim() : "";
      if (!trigger || !replacement) return null;

      const clientSnippetId =
        typeof cloudEntry.client_snippet_id === "string" && cloudEntry.client_snippet_id
          ? cloudEntry.client_snippet_id
          : randomUUID();
      const updatedAt =
        typeof cloudEntry.updated_at === "string" && cloudEntry.updated_at
          ? cloudEntry.updated_at
          : typeof cloudEntry.created_at === "string" && cloudEntry.created_at
            ? cloudEntry.created_at
            : new Date().toISOString();
      const createdAt =
        typeof cloudEntry.created_at === "string" && cloudEntry.created_at
          ? cloudEntry.created_at
          : updatedAt;

      const existing = this.getSnippetForCloudMerge({
        ...cloudEntry,
        client_snippet_id: clientSnippetId,
        trigger,
      });

      if (existing) {
        // A different active row may already hold this trigger (cross-device
        // rename); it must yield first or the UPDATE trips the active-trigger
        // unique index and aborts the pull.
        const collidingActive = this.db
          .prepare(
            "SELECT * FROM snippets WHERE lower(trigger) = lower(?) AND deleted_at IS NULL AND id != ? LIMIT 1"
          )
          .get(trigger, existing.id);
        // Tombstone existing → keep the active collider; else keep existing and
        // drop the stale collider.
        const target = existing.deleted_at && collidingActive ? collidingActive : existing;
        const orphanId = target.id === existing.id ? collidingActive?.id : existing.id;
        if (orphanId) {
          this.db.prepare("DELETE FROM snippets WHERE id = ?").run(orphanId);
        }
        this.db
          .prepare(
            `UPDATE snippets
             SET cloud_id = ?, client_snippet_id = ?, trigger = ?, replacement = ?,
                 sync_status = 'synced', deleted_at = NULL, updated_at = ?
             WHERE id = ?`
          )
          .run(cloudEntry.id, clientSnippetId, trigger, replacement, updatedAt, target.id);
        return this.db.prepare("SELECT * FROM snippets WHERE id = ?").get(target.id);
      }

      this.db
        .prepare(
          `INSERT INTO snippets
             (trigger, replacement, client_snippet_id, cloud_id, sync_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'synced', ?, ?)`
        )
        .run(trigger, replacement, clientSnippetId, cloudEntry.id, createdAt, updatedAt);
      return this.db
        .prepare("SELECT * FROM snippets WHERE client_snippet_id = ?")
        .get(clientSnippetId);
    } catch (error) {
      debugLogger.error("Error upserting snippet from cloud", { error: error.message }, "database");
      throw error;
    }
  }

  markSnippetSynced(
    id,
    cloudId,
    serverUpdatedAt = null,
    expectedTrigger = null,
    expectedReplacement = null
  ) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // If a user edit landed between push and ack, the row no longer matches
      // what was pushed — leave it 'pending' so the next sync re-pushes it.
      const result = this.db
        .prepare(
          `UPDATE snippets
           SET sync_status = 'synced',
               cloud_id = ?,
               updated_at = COALESCE(?, updated_at)
           WHERE id = ? AND deleted_at IS NULL
             AND (? IS NULL OR trigger = ?)
             AND (? IS NULL OR replacement = ?)`
        )
        .run(
          cloudId,
          serverUpdatedAt,
          id,
          expectedTrigger,
          expectedTrigger,
          expectedReplacement,
          expectedReplacement
        );
      return { success: result.changes > 0, changes: result.changes };
    } catch (error) {
      debugLogger.error("Error marking snippet synced", { error: error.message }, "database");
      throw error;
    }
  }

  clearSnippetCloudId(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare("UPDATE snippets SET cloud_id = NULL, sync_status = 'pending' WHERE id = ?")
        .run(id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error("Error clearing snippet cloud_id", { error: error.message }, "database");
      throw error;
    }
  }

  saveNote(
    title,
    content,
    noteType = "personal",
    sourceFile = null,
    audioDuration = null,
    folderId = null,
    spaceId = null
  ) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      if (folderId) {
        // D2: a note's space always follows its folder's space.
        const folder = this.db.prepare("SELECT space_id FROM folders WHERE id = ?").get(folderId);
        spaceId = folder?.space_id ?? spaceId ?? this.getPrivateSpaceId();
      } else {
        if (spaceId == null) spaceId = this.getPrivateSpaceId();
        const defaultFolderName = noteType === "meeting" ? "Meetings" : "Personal";
        const defaultFolder = this.db
          .prepare("SELECT id FROM folders WHERE name = ? AND is_default = 1 AND space_id = ?")
          .get(defaultFolderName, spaceId);
        folderId = defaultFolder?.id || null;
      }
      const clientNoteId = randomUUID();
      const stmt = this.db.prepare(
        "INSERT INTO notes (title, content, note_type, source_file, audio_duration_seconds, folder_id, space_id, client_note_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const result = stmt.run(
        title,
        content,
        noteType,
        sourceFile,
        audioDuration,
        folderId,
        spaceId,
        clientNoteId
      );

      const fetchStmt = this.db.prepare("SELECT * FROM notes WHERE id = ?");
      const note = fetchStmt.get(result.lastInsertRowid);

      return { success: true, note };
    } catch (error) {
      debugLogger.error("Error saving note", { error: error.message }, "notes");
      throw error;
    }
  }

  getNote(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("SELECT * FROM notes WHERE id = ?");
      return stmt.get(id) || null;
    } catch (error) {
      debugLogger.error("Error getting note", { error: error.message }, "notes");
      throw error;
    }
  }

  getNoteByCloudId(cloudId) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare(
        "SELECT * FROM notes WHERE cloud_id = ? AND deleted_at IS NULL LIMIT 1"
      );
      return stmt.get(cloudId) || null;
    } catch (error) {
      debugLogger.error("Error getting note by cloud_id", { error: error.message }, "notes");
      throw error;
    }
  }

  getNotes(noteType = null, limit = 100, folderId = null, spaceId = null) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const conditions = ["deleted_at IS NULL"];
      const params = [];
      if (noteType) {
        conditions.push("note_type = ?");
        params.push(noteType);
      }
      if (folderId != null) {
        conditions.push("folder_id = ?");
        params.push(folderId);
      } else if (spaceId != null) {
        // spaceId without folderId lists a space's root: folderless notes only.
        conditions.push("folder_id IS NULL");
      }
      if (spaceId != null) {
        conditions.push("space_id = ?");
        params.push(spaceId);
      }
      const where = `WHERE ${conditions.join(" AND ")}`;
      const stmt = this.db.prepare(`SELECT * FROM notes ${where} ORDER BY updated_at DESC LIMIT ?`);
      params.push(limit);
      return stmt.all(...params);
    } catch (error) {
      debugLogger.error("Error getting notes", { error: error.message }, "notes");
      throw error;
    }
  }

  // Unlike getNotes(null, limit, null, spaceId) — which is root-only — this
  // lists every note in the space, foldered or not (space overview list).
  getNotesForSpace(spaceId, limit = 50) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM notes WHERE space_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?"
        )
        .all(spaceId, limit);
    } catch (error) {
      debugLogger.error("Error getting notes for space", { error: error.message }, "notes");
      throw error;
    }
  }

  getNoteIdsInFolder(folderId) {
    return this.getNoteIdsInScope(null, folderId);
  }

  // Authoritative scope membership for semantic-search candidates. Qdrant
  // payload writes are asynchronous/best-effort, so its filters are only an
  // optimization and must not decide which space or folder a hit belongs to.
  getNoteIdsInScope(spaceId = null, folderId = null, candidateIds = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (candidateIds && candidateIds.length === 0) return [];
      const conditions = ["deleted_at IS NULL"];
      const params = [];
      if (candidateIds) {
        conditions.push(`id IN (${candidateIds.map(() => "?").join(", ")})`);
        params.push(...candidateIds);
      }
      if (spaceId != null) {
        conditions.push("space_id = ?");
        params.push(spaceId);
      }
      if (folderId != null) {
        conditions.push("folder_id = ?");
        params.push(folderId);
      }
      return this.db
        .prepare(`SELECT id FROM notes WHERE ${conditions.join(" AND ")}`)
        .all(...params)
        .map((row) => row.id);
    } catch (error) {
      debugLogger.error("Error getting scoped note ids", { error: error.message }, "notes");
      throw error;
    }
  }

  updateNote(id, updates) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (updates.folder_id != null) {
        // D2: a note's space always follows its folder's space.
        const folder = this.db
          .prepare("SELECT space_id FROM folders WHERE id = ?")
          .get(updates.folder_id);
        if (folder) updates = { ...updates, space_id: folder.space_id };
      }
      if (updates.space_id !== undefined) {
        // D6: a cloud-backed note leaving a team must keep pushing until the
        // scope retraction lands, even when cloud backup is off (left_team
        // keeps it in the team-only pending queue). Identity forks null the
        // cloud_id — nothing to retract, so they never set the flag.
        const current = this.db
          .prepare(
            "SELECT n.space_id, n.cloud_id, s.kind AS space_kind FROM notes n LEFT JOIN spaces s ON s.id = n.space_id WHERE n.id = ?"
          )
          .get(id);
        if (current && current.space_id !== updates.space_id) {
          const newKind = this.db
            .prepare("SELECT kind FROM spaces WHERE id = ?")
            .get(updates.space_id)?.kind;
          const keepsCloudId =
            updates.cloud_id === undefined ? current.cloud_id != null : updates.cloud_id != null;
          if (current.space_kind === "team" && newKind === "private" && keepsCloudId) {
            updates = { ...updates, left_team: 1 };
          } else if (newKind === "team") {
            updates = { ...updates, left_team: 0 };
          }
        }
      }
      const allowedFields = [
        "title",
        "content",
        "enhanced_content",
        "enhancement_prompt",
        "enhanced_at_content_hash",
        "folder_id",
        "space_id",
        "transcript",
        "calendar_event_id",
        "participants",
        "diarization_enabled",
        "expected_speaker_count",
        "meeting_context",
        "sync_status",
        "deleted_at",
        "client_note_id",
        "cloud_id",
        "cloud_updated_at",
        "owner_user_id",
        "updated_by_user_id",
        "left_team",
      ];
      const fields = [];
      const values = [];
      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key) && value !== undefined) {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }
      if (fields.length === 0) return { success: false };
      // meeting_context is deliberately local-only until the hosted sync schema
      // carries it. Do not enqueue a cloud write for a context-only edit; cloud
      // upserts omit this column and therefore preserve an existing local value.
      const hasCloudSyncableUpdate = Object.keys(updates).some(
        (key) => key !== "meeting_context" && allowedFields.includes(key)
      );
      if (!("sync_status" in updates) && hasCloudSyncableUpdate) {
        fields.push("sync_status = 'pending'");
      }
      const writesTranscript = updates.transcript !== undefined;
      const update = () => {
        const previousTranscript = writesTranscript
          ? this.db.prepare("SELECT transcript FROM notes WHERE id = ?").get(id)?.transcript
          : undefined;
        const updateFields = [...fields];
        const updateValues = [...values];
        if (writesTranscript) {
          updateFields.push(
            "transcript_revision = CASE WHEN transcript IS NOT ? THEN transcript_revision + 1 ELSE transcript_revision END"
          );
          updateValues.push(updates.transcript);
        }
        updateFields.push("updated_at = CURRENT_TIMESTAMP");
        updateValues.push(id);
        this.db
          .prepare(`UPDATE notes SET ${updateFields.join(", ")} WHERE id = ?`)
          .run(...updateValues);
        const note = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
        if (writesTranscript && note && note.transcript !== previousTranscript) {
          this._invalidateEncounterOutputsForNote(id, this._getNoteTranscriptToken(id));
        }
        return { success: true, note };
      };
      return writesTranscript && !this.db.inTransaction ? this.db.transaction(update)() : update();
    } catch (error) {
      debugLogger.error("Error updating note", { error: error.message }, "notes");
      throw error;
    }
  }

  getFolders(spaceId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const conditions = ["deleted_at IS NULL"];
      const params = [];
      if (spaceId != null) {
        conditions.push("space_id = ?");
        params.push(spaceId);
      }
      return this.db
        .prepare(
          `SELECT * FROM folders WHERE ${conditions.join(" AND ")} ORDER BY sort_order ASC, created_at ASC`
        )
        .all(...params);
    } catch (error) {
      debugLogger.error("Error getting folders", { error: error.message }, "notes");
      throw error;
    }
  }

  createFolder(name, spaceId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const trimmed = (name || "").trim();
      if (!trimmed) return { success: false, error: "Folder name is required" };
      if (spaceId == null) spaceId = this.getPrivateSpaceId();
      const existing = this.db
        .prepare(
          `SELECT id FROM folders
           WHERE name = ? AND space_id = ? AND ${FOLDER_NAME_TAKEN_FILTER}`
        )
        .get(trimmed, spaceId);
      if (existing) return { success: false, error: "A folder with that name already exists" };
      const maxOrder = this.db
        .prepare("SELECT MAX(sort_order) as max_order FROM folders WHERE space_id = ?")
        .get(spaceId);
      const sortOrder = (maxOrder?.max_order ?? 0) + 1;
      const clientFolderId = randomUUID();
      const result = this.db
        .prepare(
          "INSERT INTO folders (name, sort_order, space_id, client_folder_id) VALUES (?, ?, ?, ?)"
        )
        .run(trimmed, sortOrder, spaceId, clientFolderId);
      const folder = this.db
        .prepare("SELECT * FROM folders WHERE id = ?")
        .get(result.lastInsertRowid);
      return { success: true, folder };
    } catch (error) {
      debugLogger.error("Error creating folder", { error: error.message }, "notes");
      throw error;
    }
  }

  deleteFolder(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this.db
        .prepare("SELECT * FROM folders WHERE id = ? AND deleted_at IS NULL")
        .get(id);
      if (!folder) return { success: false, error: "Folder not found" };
      if (folder.is_default) return { success: false, error: "Cannot delete default folders" };
      const allChildNotes = "SELECT id FROM notes WHERE folder_id = ?";
      const childNotes = `${allChildNotes} AND deleted_at IS NULL`;
      const noteIds = this.db
        .prepare(childNotes)
        .all(id)
        .map((row) => row.id);
      this.db.transaction(() => {
        if (!folder.cloud_id) {
          // There is no server operation to deny. Local-only folders can
          // finalize immediately, including their local-only child content.
          this._retireConversationsWhere(`note_id IN (${allChildNotes})`, [id], {
            scrubSyncedMessages: true,
          });
          this._deleteSpeakerRowsForNotes(allChildNotes, id);
          this.db.prepare("DELETE FROM notes WHERE folder_id = ?").run(id);
          this._retireConversationsWhere("folder_id = ?", [id], {
            scrubSyncedMessages: true,
          });
          this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
          return;
        }

        const journal = this.db.prepare(
          `INSERT OR IGNORE INTO optimistic_folder_delete_rows
             (folder_id, entity_type, entity_id, original_sync_status,
              original_deleted_at, original_updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        journal.run(
          id,
          "folder",
          id,
          folder.sync_status ?? "synced",
          folder.deleted_at ?? null,
          folder.updated_at ?? null
        );

        const activeNotes = this.db.prepare(
          "SELECT id, sync_status, deleted_at, updated_at FROM notes WHERE folder_id = ? AND deleted_at IS NULL"
        );
        for (const note of activeNotes.all(id)) {
          journal.run(
            id,
            "note",
            note.id,
            note.sync_status ?? "pending",
            note.deleted_at ?? null,
            note.updated_at ?? null
          );
        }

        // Only live conversations belong to this rollback. A tombstone that
        // predates the folder action is an independent user-requested delete
        // and must remain pending on both denial and confirmation.
        const activeConversations = this.db
          .prepare(
            `SELECT id, sync_status, deleted_at, updated_at
             FROM agent_conversations
             WHERE deleted_at IS NULL
               AND (folder_id = ? OR note_id IN (${childNotes}))`
          )
          .all(id, id);
        for (const conversation of activeConversations) {
          journal.run(
            id,
            "conversation",
            conversation.id,
            conversation.sync_status ?? "pending",
            conversation.deleted_at ?? null,
            conversation.updated_at ?? null
          );
        }

        // Keep every child row and message body in place while hiding them
        // from normal readers and all per-note/per-conversation sync queues.
        this.db
          .prepare(
            `UPDATE notes
             SET deleted_at = datetime('now'), sync_status = 'folder_delete_pending',
                 updated_at = datetime('now')
             WHERE id IN (
               SELECT entity_id FROM optimistic_folder_delete_rows
               WHERE folder_id = ? AND entity_type = 'note'
             )`
          )
          .run(id);
        this.db
          .prepare(
            `UPDATE agent_conversations
             SET deleted_at = datetime('now'), sync_status = 'folder_delete_pending',
                 updated_at = datetime('now')
             WHERE id IN (
               SELECT entity_id FROM optimistic_folder_delete_rows
               WHERE folder_id = ? AND entity_type = 'conversation'
             )`
          )
          .run(id);
        this.db
          .prepare(
            `UPDATE folders
             SET deleted_at = datetime('now'), updated_at = datetime('now'),
                 sync_status = 'pending'
             WHERE id = ?`
          )
          .run(id);
      })();
      return { success: true, id, noteIds };
    } catch (error) {
      debugLogger.error("Error deleting folder", { error: error.message }, "notes");
      throw error;
    }
  }

  renameFolder(id, name) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this.db
        .prepare("SELECT * FROM folders WHERE id = ? AND deleted_at IS NULL")
        .get(id);
      if (!folder) return { success: false, error: "Folder not found" };
      if (folder.is_default) return { success: false, error: "Cannot rename default folders" };
      const trimmed = (name || "").trim();
      if (!trimmed) return { success: false, error: "Folder name is required" };
      const existing = this.db
        .prepare(
          `SELECT id FROM folders
           WHERE name = ? AND space_id = ? AND id != ? AND ${FOLDER_NAME_TAKEN_FILTER}`
        )
        .get(trimmed, folder.space_id, id);
      if (existing) return { success: false, error: "A folder with that name already exists" };
      this.db
        .prepare(
          "UPDATE folders SET name = ?, sync_status = 'pending', updated_at = datetime('now') WHERE id = ?"
        )
        .run(trimmed, id);
      const updated = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
      return { success: true, folder: updated };
    } catch (error) {
      debugLogger.error("Error renaming folder", { error: error.message }, "notes");
      throw error;
    }
  }

  moveFolderToSpace(id, spaceId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this.db
        .prepare("SELECT * FROM folders WHERE id = ? AND deleted_at IS NULL")
        .get(id);
      if (!folder) return { success: false, error: "Folder not found" };
      if (folder.is_default) return { success: false, error: "Cannot move default folders" };
      const space = this.db
        .prepare("SELECT id, kind FROM spaces WHERE id = ? AND deleted_at IS NULL")
        .get(spaceId);
      if (!space) return { success: false, error: "Space not found" };
      if (folder.space_id === spaceId) return { success: true, folder, notes: [] };
      const existing = this.db
        .prepare(
          `SELECT id FROM folders
           WHERE name = ? AND space_id = ? AND id != ? AND ${FOLDER_NAME_TAKEN_FILTER}`
        )
        .get(folder.name, spaceId, id);
      if (existing) return { success: false, error: "A folder with that name already exists" };
      // D6: cloud-backed rows leaving a team must keep pushing their scope
      // retraction even in the backup-off team-only pass (left_team).
      const oldKind = this.db
        .prepare("SELECT kind FROM spaces WHERE id = ?")
        .get(folder.space_id)?.kind;
      const leftTeam = oldKind === "team" && space.kind === "private" ? 1 : 0;
      const notes = this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE folders SET space_id = ?, sync_status = 'pending', updated_at = datetime('now'), left_team = ? WHERE id = ?"
          )
          .run(spaceId, leftTeam && folder.cloud_id ? 1 : 0, id);
        this.db
          .prepare(
            "UPDATE notes SET space_id = ?, sync_status = 'pending', updated_at = datetime('now'), left_team = (CASE WHEN ? = 1 AND cloud_id IS NOT NULL THEN 1 ELSE 0 END) WHERE folder_id = ? AND deleted_at IS NULL"
          )
          .run(spaceId, leftTeam, id);
        return this.db
          .prepare("SELECT * FROM notes WHERE folder_id = ? AND deleted_at IS NULL")
          .all(id);
      })();
      const updated = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
      return { success: true, folder: updated, notes };
    } catch (error) {
      debugLogger.error("Error moving folder to space", { error: error.message }, "spaces");
      throw error;
    }
  }

  getFolderNoteCounts() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // folder_id NULL rows are space-root notes; grouping by space_id too
      // attributes them per space so the tree shows true space totals.
      return this.db
        .prepare(
          "SELECT space_id, folder_id, COUNT(*) as count FROM notes WHERE deleted_at IS NULL GROUP BY space_id, folder_id"
        )
        .all();
    } catch (error) {
      debugLogger.error("Error getting folder note counts", { error: error.message }, "notes");
      throw error;
    }
  }

  getPrivateSpaceId() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT id FROM spaces WHERE kind = 'private'").get()?.id ?? null;
    } catch (error) {
      debugLogger.error("Error getting private space id", { error: error.message }, "spaces");
      throw error;
    }
  }

  // Parses the teams JSON mirror so renderer consumers only ever see an array.
  _spaceRow(row) {
    if (!row) return row;
    let teams = [];
    if (row.teams) {
      try {
        teams = JSON.parse(row.teams);
      } catch {
        teams = [];
      }
    }
    return { ...row, teams };
  }

  getSpaces() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM spaces WHERE deleted_at IS NULL ORDER BY CASE WHEN kind = 'private' THEN 0 ELSE 1 END, sort_order ASC, name ASC"
        )
        .all()
        .map((row) => this._spaceRow(row));
    } catch (error) {
      debugLogger.error("Error getting spaces", { error: error.message }, "spaces");
      throw error;
    }
  }

  getSpace(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const row = this.db
        .prepare("SELECT * FROM spaces WHERE id = ? AND deleted_at IS NULL")
        .get(id);
      return row ? this._spaceRow(row) : null;
    } catch (error) {
      debugLogger.error("Error getting space", { error: error.message }, "spaces");
      throw error;
    }
  }

  updateSpace(id, { name, emoji } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const space = this.db.prepare("SELECT * FROM spaces WHERE id = ?").get(id);
      if (!space) return { success: false, error: "Space not found" };
      const fields = [];
      const values = [];
      if (name !== undefined) {
        if (space.kind === "private") {
          return { success: false, error: "Cannot rename the private space" };
        }
        const trimmed = (name || "").trim();
        if (!trimmed) return { success: false, error: "Space name is required" };
        fields.push("name = ?");
        values.push(trimmed);
      }
      if (emoji !== undefined) {
        fields.push("emoji = ?");
        values.push(emoji);
      }
      if (fields.length === 0) return { success: false };
      fields.push("sync_status = 'pending'", "updated_at = datetime('now')");
      values.push(id);
      this.db.prepare(`UPDATE spaces SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      const updated = this._spaceRow(this.db.prepare("SELECT * FROM spaces WHERE id = ?").get(id));
      return { success: true, space: updated };
    } catch (error) {
      debugLogger.error("Error updating space", { error: error.message }, "spaces");
      throw error;
    }
  }

  setSpaceSyncStatus(id, status) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare("UPDATE spaces SET sync_status = ? WHERE id = ? AND deleted_at IS NULL")
        .run(status, id);
      const success = result.changes > 0;
      return { success, space: success ? this.getSpace(id) : null };
    } catch (error) {
      debugLogger.error("Error setting space sync status", { error: error.message }, "spaces");
      throw error;
    }
  }

  getSpaceByCloudSpaceId(cloudSpaceId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const row = this.db
        .prepare("SELECT * FROM spaces WHERE cloud_space_id = ?")
        .get(cloudSpaceId);
      return row ? this._spaceRow(row) : null;
    } catch (error) {
      debugLogger.error(
        "Error getting space by cloud space id",
        { error: error.message },
        "spaces"
      );
      throw error;
    }
  }

  upsertSpaceFromCloud(space) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const updatedAt = space.updated_at || space.created_at || new Date().toISOString();
      const teams = Array.isArray(space.teams) ? space.teams : [];
      const teamsJson = JSON.stringify(teams);
      let existing = this.db.prepare("SELECT * FROM spaces WHERE cloud_space_id = ?").get(space.id);
      if (!existing && teams.length === 1) {
        // Adopt a pre-spaces row: the server backfilled one space per legacy
        // team, so a single-team space claims the local row that mirrored that
        // team. Keeps local ids alive for chats, vector payloads and tree state.
        existing = this.db
          .prepare("SELECT * FROM spaces WHERE cloud_space_id IS NULL AND cloud_team_id = ?")
          .get(teams[0].id);
      }
      if (existing) {
        this.db
          .prepare(
            `UPDATE spaces SET cloud_space_id = ?, workspace_id = ?, name = ?, emoji = ?, my_role = ?,
               member_count = ?, teams = ?, deleted_at = NULL, updated_at = ? WHERE id = ?`
          )
          .run(
            space.id,
            space.workspace_id ?? null,
            space.name,
            space.emoji ?? null,
            space.my_role ?? null,
            space.member_count ?? null,
            teamsJson,
            updatedAt,
            existing.id
          );
        return this._spaceRow(
          this.db.prepare("SELECT * FROM spaces WHERE id = ?").get(existing.id)
        );
      }
      const maxOrder = this.db.prepare("SELECT MAX(sort_order) as max_order FROM spaces").get();
      // New spaces insert as 'pending' (skeletons until the content backfill
      // completes); updates never touch sync_status, so an interrupted
      // backfill's 'pending' survives the next mirror pass and re-runs.
      const result = this.db
        .prepare(
          `INSERT INTO spaces (client_space_id, cloud_space_id, workspace_id, kind, name, emoji,
             sort_order, my_role, member_count, teams, sync_status, created_at, updated_at)
           VALUES (?, ?, ?, 'team', ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(
          randomUUID(),
          space.id,
          space.workspace_id ?? null,
          space.name,
          space.emoji ?? null,
          (maxOrder?.max_order ?? 0) + 1,
          space.my_role ?? null,
          space.member_count ?? null,
          teamsJson,
          space.created_at || updatedAt,
          updatedAt
        );
      return this._spaceRow(
        this.db.prepare("SELECT * FROM spaces WHERE id = ?").get(result.lastInsertRowid)
      );
    } catch (error) {
      debugLogger.error("Error upserting space from cloud", { error: error.message }, "spaces");
      throw error;
    }
  }

  // Speaker rows cascade on note delete (ON DELETE CASCADE), but callers that
  // only tombstone notes still need the explicit cleanup.
  _deleteSpeakerRowsForNotes(noteIdSubquery, param) {
    this.db.prepare(`DELETE FROM speaker_mappings WHERE note_id IN (${noteIdSubquery})`).run(param);
    this.db
      .prepare(`DELETE FROM note_speaker_embeddings WHERE note_id IN (${noteIdSubquery})`)
      .run(param);
  }

  // Conversations whose note or container is being removed must not survive
  // as global chats. Synced rows tombstone (like deleteAgentConversation) so
  // the next push retires the cloud copy; a hard local delete would let the
  // next pull resurrect the conversation. Irreversible purge/revocation
  // callers also scrub their messages, while an optimistic ordinary delete
  // retains synced messages until the server accepts it. Never-synced rows
  // hard-delete: there is no server row to retire, and a bare tombstone would
  // linger forever (getPendingConversationDeletes requires a cloud_id).
  _retireConversationsWhere(
    filter,
    params,
    { scrubSyncedMessages = false, syncedTombstoneStatus = "pending" } = {}
  ) {
    const messageFilter = scrubSyncedMessages ? filter : `cloud_id IS NULL AND (${filter})`;
    this.db
      .prepare(
        `DELETE FROM agent_messages WHERE conversation_id IN (SELECT id FROM agent_conversations WHERE ${messageFilter})`
      )
      .run(...params);
    this.db
      .prepare(`DELETE FROM agent_conversations WHERE cloud_id IS NULL AND (${filter})`)
      .run(...params);
    this.db
      .prepare(
        `UPDATE agent_conversations SET deleted_at = datetime('now'), sync_status = ?, updated_at = datetime('now') WHERE cloud_id IS NOT NULL AND deleted_at IS NULL AND (${filter})`
      )
      .run(syncedTombstoneStatus, ...params);
  }

  // Account transitions are a local privacy boundary, not a cloud mutation:
  // no old-account conversation row (including a pending cloud tombstone)
  // may remain for the next account to see or push.
  _hardDeleteConversationsWhere(filter, params) {
    this.db
      .prepare(
        `DELETE FROM agent_messages WHERE conversation_id IN (SELECT id FROM agent_conversations WHERE ${filter})`
      )
      .run(...params);
    this.db.prepare(`DELETE FROM agent_conversations WHERE ${filter}`).run(...params);
  }

  purgeSpace(localSpaceId, options = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const mode = options?.mode ?? "preserve-dirty";
      if (mode !== "preserve-dirty" && mode !== "destructive") {
        return { success: false, error: "Invalid purge mode" };
      }
      const destructive = mode === "destructive";
      const space = this.db.prepare("SELECT * FROM spaces WHERE id = ?").get(localSpaceId);
      if (!space) return { success: false, error: "Space not found" };
      if (space.kind === "private") {
        return { success: false, error: "Cannot purge the private space" };
      }
      if (!destructive) {
        // Space revocation supersedes any unresolved folder delete. Recover
        // the held rows first so dirty/local-only children are classified by
        // their real pre-delete state and can still relocate to Personal.
        const heldFolderIds = this.db
          .prepare(
            `SELECT DISTINCT r.folder_id
             FROM optimistic_folder_delete_rows r
             JOIN folders f ON f.id = r.folder_id
             WHERE r.entity_type = 'folder' AND f.space_id = ?`
          )
          .all(localSpaceId)
          .map((row) => row.folder_id);
        for (const folderId of heldFolderIds) {
          const rollback = this.restoreFolderAfterDeniedDelete(folderId);
          if (!rollback.success) return rollback;
        }
      }
      const privateSpaceId = this.getPrivateSpaceId();
      const { noteIds, folderNames, relocatedNotes } = this.db.transaction(() => {
        // Dirty or never-synced notes are the only surviving content (plan
        // §7.2, matching relocateRevokedFolder): they move to the private
        // space root with forked identities — the server row (if any) stays
        // the team's, so the next push re-creates them as personal notes.
        let relocated = [];
        if (!destructive && privateSpaceId != null) {
          const preservedIds = this.db
            .prepare(
              "SELECT id FROM notes WHERE space_id = ? AND deleted_at IS NULL AND (sync_status != 'synced' OR cloud_id IS NULL)"
            )
            .all(localSpaceId)
            .map((row) => row.id);
          if (preservedIds.length > 0) {
            const relocateNote = this.db.prepare(
              "UPDATE notes SET space_id = ?, folder_id = NULL, client_note_id = ?, cloud_id = NULL, cloud_updated_at = NULL, owner_user_id = NULL, updated_by_user_id = NULL, sync_status = 'pending', left_team = 0, is_shared = 0, share_token = NULL, updated_at = datetime('now') WHERE id = ?"
            );
            const detachNoteConversation = this.db.prepare(
              "UPDATE agent_conversations SET space_id = NULL, folder_id = NULL WHERE note_id = ?"
            );
            for (const noteId of preservedIds) {
              relocateNote.run(privateSpaceId, randomUUID(), noteId);
              // A note chat follows the dirty note fork into Personal. Clear
              // any redundant team-container scope so the container cleanup
              // below cannot retire a conversation whose note survived.
              detachNoteConversation.run(noteId);
            }
            const getNote = this.db.prepare("SELECT * FROM notes WHERE id = ?");
            relocated = preservedIds.map((id) => getNote.get(id));
          }
        }
        const ids = this.db
          .prepare("SELECT id FROM notes WHERE space_id = ?")
          .all(localSpaceId)
          .map((row) => row.id);
        const names = this.db
          .prepare("SELECT name FROM folders WHERE space_id = ?")
          .all(localSpaceId)
          .map((row) => row.name);
        // Note chats normally carry only note_id, so container cleanup alone
        // cannot see them. Retire them while the doomed note rows still
        // identify the space; relocated dirty-note chats were moved above.
        if (destructive) {
          // Account-boundary cleanup must leave neither visible chats nor
          // cloud-delete tombstones. Match note-only chats and both kinds of
          // container scope before deleting their parent rows.
          this._hardDeleteConversationsWhere(
            `note_id IN (SELECT id FROM notes WHERE space_id = ?)
             OR space_id = ?
             OR folder_id IN (SELECT id FROM folders WHERE space_id = ?)`,
            [localSpaceId, localSpaceId, localSpaceId]
          );
          this.db
            .prepare(
              `DELETE FROM optimistic_folder_delete_rows
               WHERE folder_id IN (SELECT id FROM folders WHERE space_id = ?)`
            )
            .run(localSpaceId);
        } else {
          this._retireConversationsWhere(
            "note_id IN (SELECT id FROM notes WHERE space_id = ?)",
            [localSpaceId],
            { scrubSyncedMessages: true }
          );
        }
        this._deleteSpeakerRowsForNotes("SELECT id FROM notes WHERE space_id = ?", localSpaceId);
        this.db.prepare("DELETE FROM notes WHERE space_id = ?").run(localSpaceId);
        // Deleted-note tombstones in other spaces can still reference folders
        // in this space (folder moved across spaces after the delete); clear
        // the refs or the folder delete below aborts on the FK.
        this.db
          .prepare(
            "UPDATE notes SET folder_id = NULL WHERE space_id != ? AND folder_id IN (SELECT id FROM folders WHERE space_id = ?)"
          )
          .run(localSpaceId, localSpaceId);
        if (!destructive) {
          this._retireConversationsWhere(
            "space_id = ? OR folder_id IN (SELECT id FROM folders WHERE space_id = ?)",
            [localSpaceId, localSpaceId],
            { scrubSyncedMessages: true }
          );
        }
        this.db.prepare("DELETE FROM folders WHERE space_id = ?").run(localSpaceId);
        this.db.prepare("DELETE FROM spaces WHERE id = ?").run(localSpaceId);
        return { noteIds: ids, folderNames: names, relocatedNotes: relocated };
      })();
      return {
        success: true,
        noteIds,
        folderNames,
        spaceId: localSpaceId,
        relocatedNotes,
        relocatedCount: relocatedNotes.length,
        relocatedTitles: relocatedNotes.slice(0, 3).map((note) => note.title),
      };
    } catch (error) {
      debugLogger.error("Error purging space", { error: error.message }, "spaces");
      throw error;
    }
  }

  addPendingVectorPurge(spaceId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("INSERT OR IGNORE INTO pending_vector_purges (space_id) VALUES (?)")
        .run(spaceId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error adding pending vector purge", { error: error.message }, "spaces");
      throw error;
    }
  }

  getPendingVectorPurges() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT space_id FROM pending_vector_purges").all();
    } catch (error) {
      debugLogger.error("Error getting pending vector purges", { error: error.message }, "spaces");
      throw error;
    }
  }

  clearPendingVectorPurge(spaceId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("DELETE FROM pending_vector_purges WHERE space_id = ?").run(spaceId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing pending vector purge", { error: error.message }, "spaces");
      throw error;
    }
  }

  getActions() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM actions ORDER BY sort_order ASC, created_at ASC").all();
    } catch (error) {
      debugLogger.error("Error getting actions", { error: error.message }, "notes");
      throw error;
    }
  }

  getAction(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) || null;
    } catch (error) {
      debugLogger.error("Error getting action", { error: error.message }, "notes");
      throw error;
    }
  }

  createAction(name, description, prompt, icon = "sparkles") {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const trimmedName = (name || "").trim();
      const trimmedPrompt = (prompt || "").trim();
      if (!trimmedName) return { success: false, error: "Action name is required" };
      if (!trimmedPrompt) return { success: false, error: "Action prompt is required" };
      const maxOrder = this.db.prepare("SELECT MAX(sort_order) as max_order FROM actions").get();
      const sortOrder = (maxOrder?.max_order ?? 0) + 1;
      const result = this.db
        .prepare(
          "INSERT INTO actions (name, description, prompt, icon, sort_order) VALUES (?, ?, ?, ?, ?)"
        )
        .run(trimmedName, (description || "").trim(), trimmedPrompt, icon || "sparkles", sortOrder);
      const action = this.db
        .prepare("SELECT * FROM actions WHERE id = ?")
        .get(result.lastInsertRowid);
      return { success: true, action };
    } catch (error) {
      debugLogger.error("Error creating action", { error: error.message }, "notes");
      throw error;
    }
  }

  updateAction(id, updates) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const allowedFields = ["name", "description", "prompt", "icon", "sort_order"];
      const fields = [];
      const values = [];
      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key) && value !== undefined) {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }
      if (fields.length === 0) return { success: false };
      fields.push("updated_at = CURRENT_TIMESTAMP");
      values.push(id);
      this.db.prepare(`UPDATE actions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      const action = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id);
      return { success: true, action };
    } catch (error) {
      debugLogger.error("Error updating action", { error: error.message }, "notes");
      throw error;
    }
  }

  deleteAction(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const action = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id);
      if (!action) return { success: false, error: "Action not found" };
      if (action.is_builtin) return { success: false, error: "Cannot delete built-in actions" };
      this.db.prepare("DELETE FROM actions WHERE id = ?").run(id);
      return { success: true, id };
    } catch (error) {
      debugLogger.error("Error deleting action", { error: error.message }, "notes");
      throw error;
    }
  }

  deleteNote(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare(
        "UPDATE notes SET deleted_at = datetime('now'), sync_status = 'pending', updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"
      );
      const result = stmt.run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error deleting note", { error: error.message }, "notes");
      throw error;
    }
  }

  createAgentConversation(title = "Untitled", noteId = null, spaceId = null, folderId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.transaction(() => {
        let note = null;
        let space = null;
        let folder = null;

        if (noteId != null) {
          note = this.db
            .prepare(
              `SELECT n.id, n.space_id, n.folder_id
               FROM notes n
               JOIN spaces s ON s.id = n.space_id AND s.deleted_at IS NULL
               LEFT JOIN folders f ON f.id = n.folder_id AND f.deleted_at IS NULL
               WHERE n.id = ? AND n.deleted_at IS NULL
                 AND (n.folder_id IS NULL OR (f.id IS NOT NULL AND f.space_id = n.space_id))`
            )
            .get(noteId);
          if (!note) return null;
        }
        if (spaceId != null) {
          space = this.db
            .prepare("SELECT id FROM spaces WHERE id = ? AND deleted_at IS NULL")
            .get(spaceId);
          if (!space) return null;
        }
        if (folderId != null) {
          folder = this.db
            .prepare(
              `SELECT f.id, f.space_id
               FROM folders f
               JOIN spaces s ON s.id = f.space_id AND s.deleted_at IS NULL
               WHERE f.id = ? AND f.deleted_at IS NULL`
            )
            .get(folderId);
          if (!folder) return null;
        }
        if (folder && spaceId != null && folder.space_id !== spaceId) return null;
        if (note && spaceId != null && note.space_id !== spaceId) return null;
        if (note && folderId != null && note.folder_id !== folderId) return null;

        const clientConversationId = randomUUID();
        const result = this.db
          .prepare(
            "INSERT INTO agent_conversations (title, note_id, space_id, folder_id, client_conversation_id) VALUES (?, ?, ?, ?, ?)"
          )
          .run(title, noteId, spaceId, folderId, clientConversationId);
        return this.db
          .prepare("SELECT * FROM agent_conversations WHERE id = ?")
          .get(result.lastInsertRowid);
      })();
    } catch (error) {
      debugLogger.error("Error creating agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  getConversationsForNote(noteId, limit = 20) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          `SELECT c.id, c.title, c.created_at, c.updated_at,
            COUNT(m.id) AS message_count
          FROM agent_conversations c
          LEFT JOIN agent_messages m ON m.conversation_id = c.id
          WHERE c.note_id = ? AND c.deleted_at IS NULL
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT ?`
        )
        .all(noteId, limit);
    } catch (error) {
      debugLogger.error(
        "Error getting conversations for note",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Space-root scope (folderId null) intentionally excludes folder-scoped
  // conversations — each container surfaces only its own chats.
  getConversationsForContainer(spaceId, folderId = null, limit = 20) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const scopeFilter =
        folderId != null ? "c.folder_id = ?" : "c.space_id = ? AND c.folder_id IS NULL";
      const params = folderId != null ? [folderId, limit] : [spaceId, limit];
      return this.db
        .prepare(
          `SELECT c.id, c.title, c.created_at, c.updated_at,
            COUNT(m.id) AS message_count
          FROM agent_conversations c
          LEFT JOIN agent_messages m ON m.conversation_id = c.id
          WHERE ${scopeFilter} AND c.deleted_at IS NULL
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT ?`
        )
        .all(...params);
    } catch (error) {
      debugLogger.error(
        "Error getting conversations for container",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getAgentConversations(limit = 50) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM agent_conversations WHERE deleted_at IS NULL AND space_id IS NULL AND folder_id IS NULL ORDER BY updated_at DESC LIMIT ?"
        )
        .all(limit);
    } catch (error) {
      debugLogger.error("Error getting agent conversations", { error: error.message }, "database");
      throw error;
    }
  }

  getAgentConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const conversation = this.db
        .prepare("SELECT * FROM agent_conversations WHERE id = ? AND deleted_at IS NULL")
        .get(id);
      if (!conversation) return null;
      const messages = this.db
        .prepare("SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY created_at ASC")
        .all(id);
      return { ...conversation, messages };
    } catch (error) {
      debugLogger.error("Error getting agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  deleteAgentConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare(
          "UPDATE agent_conversations SET deleted_at = datetime('now'), sync_status = 'pending', updated_at = datetime('now') WHERE id = ?"
        )
        .run(id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error("Error deleting agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  updateAgentConversationTitle(id, title) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare(
          "UPDATE agent_conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL"
        )
        .run(title, id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error(
        "Error updating agent conversation title",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  saveGoogleTokens(tokens) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        `INSERT INTO google_calendar_tokens (google_email, access_token, refresh_token, expires_at, scope)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(google_email) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           updated_at = CURRENT_TIMESTAMP`
      );
      stmt.run(
        tokens.google_email,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_at,
        tokens.scope
      );
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Google tokens", { error: error.message }, "gcal");
      throw error;
    }
  }

  getGoogleTokens() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM google_calendar_tokens LIMIT 1").get() || null;
    } catch (error) {
      debugLogger.error("Error getting Google tokens", { error: error.message }, "gcal");
      throw error;
    }
  }

  getGoogleTokensByEmail(email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db.prepare("SELECT * FROM google_calendar_tokens WHERE google_email = ?").get(email) ||
        null
      );
    } catch (error) {
      debugLogger.error("Error getting Google tokens by email", { error: error.message }, "gcal");
      throw error;
    }
  }

  addAgentMessage(conversationId, role, content, metadata) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.transaction(() => {
        const conversation = this.db
          .prepare("SELECT id FROM agent_conversations WHERE id = ? AND deleted_at IS NULL")
          .get(conversationId);
        if (!conversation) return null;

        const metadataStr = metadata ? JSON.stringify(metadata) : null;
        const result = this.db
          .prepare(
            "INSERT INTO agent_messages (conversation_id, role, content, metadata) VALUES (?, ?, ?, ?)"
          )
          .run(conversationId, role, content, metadataStr);
        this.db
          .prepare(
            "UPDATE agent_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL"
          )
          .run(conversationId);
        return this.db
          .prepare("SELECT * FROM agent_messages WHERE id = ?")
          .get(result.lastInsertRowid);
      })();
    } catch (error) {
      debugLogger.error("Error adding agent message", { error: error.message }, "database");
      throw error;
    }
  }

  getAllGoogleTokens() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM google_calendar_tokens").all();
    } catch (error) {
      debugLogger.error("Error getting all Google tokens", { error: error.message }, "gcal");
      throw error;
    }
  }

  getGoogleAccounts() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare("SELECT google_email AS email FROM google_calendar_tokens ORDER BY created_at ASC")
        .all();
    } catch (error) {
      debugLogger.error("Error getting Google accounts", { error: error.message }, "gcal");
      throw error;
    }
  }

  removeGoogleAccount(email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        const calendarIds = this.db
          .prepare("SELECT id FROM google_calendars WHERE account_email = ?")
          .all(email)
          .map((c) => c.id);
        if (calendarIds.length > 0) {
          const placeholders = calendarIds.map(() => "?").join(", ");
          this.db
            .prepare(
              `DELETE FROM calendar_events WHERE provider = 'google' AND calendar_id IN (${placeholders})`
            )
            .run(...calendarIds);
        }
        this.db.prepare("DELETE FROM google_calendars WHERE account_email = ?").run(email);
        this.db.prepare("DELETE FROM google_calendar_tokens WHERE google_email = ?").run(email);
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error removing Google account", { error: error.message }, "gcal");
      throw error;
    }
  }

  deleteGoogleTokens() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("DELETE FROM google_calendar_tokens").run();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error deleting Google tokens", { error: error.message }, "gcal");
      throw error;
    }
  }

  saveGoogleCalendars(calendars, accountEmail = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        `INSERT INTO google_calendars (id, summary, description, background_color, account_email, is_primary)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           summary = excluded.summary,
           description = excluded.description,
           background_color = excluded.background_color,
           account_email = excluded.account_email,
           is_primary = excluded.is_primary`
      );
      for (const cal of calendars) {
        stmt.run(
          cal.id,
          cal.summary,
          cal.description || null,
          cal.background_color || null,
          accountEmail,
          cal.is_primary ? 1 : 0
        );
      }
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Google calendars", { error: error.message }, "gcal");
      throw error;
    }
  }

  applyPrimaryOnlyToSelection(primaryOnly) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "UPDATE google_calendars SET is_selected = CASE WHEN ? = 1 THEN is_primary ELSE 1 END"
        )
        .run(primaryOnly ? 1 : 0);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error applying primary-only selection", { error: error.message }, "gcal");
      throw error;
    }
  }

  getGoogleCalendars(accountEmail = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (accountEmail) {
        return this.db
          .prepare("SELECT * FROM google_calendars WHERE account_email = ?")
          .all(accountEmail);
      }
      return this.db.prepare("SELECT * FROM google_calendars").all();
    } catch (error) {
      debugLogger.error("Error getting Google calendars", { error: error.message }, "gcal");
      throw error;
    }
  }

  updateCalendarSelection(calendarId, isSelected) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("UPDATE google_calendars SET is_selected = ? WHERE id = ?")
        .run(isSelected ? 1 : 0, calendarId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating calendar selection", { error: error.message }, "gcal");
      throw error;
    }
  }

  getAgentMessages(conversationId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare("SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY created_at ASC")
        .all(conversationId);
    } catch (error) {
      debugLogger.error("Error getting agent messages", { error: error.message }, "database");
      throw error;
    }
  }

  getSelectedCalendars(accountEmail = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (accountEmail) {
        return this.db
          .prepare("SELECT * FROM google_calendars WHERE is_selected = 1 AND account_email = ?")
          .all(accountEmail);
      }
      return this.db.prepare("SELECT * FROM google_calendars WHERE is_selected = 1").all();
    } catch (error) {
      debugLogger.error("Error getting selected calendars", { error: error.message }, "gcal");
      throw error;
    }
  }

  _upsertPublicCalendarEvents(events) {
    const stmt = this.db.prepare(`
      INSERT INTO calendar_events (
        id, calendar_id, provider, summary, start_time, end_time, is_all_day,
        status, hangout_link, html_link, conference_data, organizer_email,
        attendees_count, attendees, event_id, event_uid, occurrence_id,
        timezone, recurrence, capabilities, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        calendar_id = excluded.calendar_id,
        provider = excluded.provider,
        summary = excluded.summary,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        is_all_day = excluded.is_all_day,
        status = excluded.status,
        hangout_link = excluded.hangout_link,
        html_link = excluded.html_link,
        conference_data = excluded.conference_data,
        organizer_email = excluded.organizer_email,
        attendees_count = excluded.attendees_count,
        attendees = excluded.attendees,
        event_id = excluded.event_id,
        event_uid = excluded.event_uid,
        occurrence_id = excluded.occurrence_id,
        timezone = excluded.timezone,
        recurrence = excluded.recurrence,
        capabilities = excluded.capabilities,
        synced_at = CURRENT_TIMESTAMP
    `);
    for (const event of events) {
      stmt.run(
        event.id,
        event.calendar_id,
        event.provider || "google",
        event.summary || null,
        event.start_time,
        event.end_time,
        event.is_all_day ? 1 : 0,
        event.status || "confirmed",
        event.hangout_link || null,
        event.html_link || null,
        event.conference_data || null,
        event.organizer_email || null,
        event.attendees_count || 0,
        event.attendees || null,
        event.event_id || null,
        event.event_uid || null,
        event.occurrence_id || event.id || null,
        event.timezone || null,
        event.recurrence || null,
        event.capabilities || null
      );
    }
  }

  // Provider callers persist only PublicCalendarEvent fields. Deliberately
  // ignore unexpected object properties instead of serializing a generic row.
  upsertCalendarEvents(publicEvents) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((events) => this._upsertPublicCalendarEvents(events));
      transaction(publicEvents);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error upserting calendar events", { error: error.message }, "gcal");
      throw error;
    }
  }

  // The bridge is the only caller allowed to supply CalendarIngressEnvelope.
  // Keep metadata in a sibling resolver-only table; it must never be attached
  // to public event rows or returned through the general calendar API.
  upsertCalendarIngress(envelopes) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((ingressEnvelopes) => {
        const publicEvents = ingressEnvelopes.map(({ publicEvent }) => publicEvent);
        this._upsertPublicCalendarEvents(publicEvents);

        const upsertMetadata = this.db.prepare(`
          INSERT INTO calendar_patient_metadata (
            calendar_event_id, metadata_json, source, patient_id, dob,
            normalized_phone, normalized_email, appointment_id,
            self_attendee_present, updated_at
          ) VALUES (?, ?, 'structured_description', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(calendar_event_id) DO UPDATE SET
            metadata_json = excluded.metadata_json,
            source = excluded.source,
            patient_id = excluded.patient_id,
            dob = excluded.dob,
            normalized_phone = excluded.normalized_phone,
            normalized_email = excluded.normalized_email,
            appointment_id = excluded.appointment_id,
            self_attendee_present = excluded.self_attendee_present,
            updated_at = CURRENT_TIMESTAMP
        `);
        const updatePrivateEventFields = this.db.prepare(`
          UPDATE calendar_events
          SET patient_id = ?, dob = ?, normalized_phone = ?, normalized_email = ?, appointment_id = ?
          WHERE id = ?
        `);
        const deleteMetadata = this.db.prepare(
          "DELETE FROM calendar_patient_metadata WHERE calendar_event_id = ?"
        );

        for (const { publicEvent, patientMetadata, selfAttendeePresent } of ingressEnvelopes) {
          const metadata = normalizePatientMetadataForStorage(patientMetadata);
          if (metadata) {
            upsertMetadata.run(
              publicEvent.id,
              JSON.stringify(metadata),
              metadata.patient_id || null,
              metadata.dob || null,
              metadata.phone || null,
              metadata.email || null,
              metadata.appointment_id || null,
              normalizeSelfAttendeePresentForStorage(selfAttendeePresent)
            );
            updatePrivateEventFields.run(
              metadata.patient_id || null,
              metadata.dob || null,
              metadata.phone || null,
              metadata.email || null,
              metadata.appointment_id || null,
              publicEvent.id
            );
          } else {
            deleteMetadata.run(publicEvent.id);
            updatePrivateEventFields.run(null, null, null, null, null, publicEvent.id);
          }
        }
      });
      transaction(envelopes);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error upserting calendar ingress", { error: error.message }, "gcal");
      throw error;
    }
  }

  // Calendar feeds own only source/display information. Local recording state,
  // note ownership, and the chosen encounter context are deliberately excluded
  // from the conflict update so a later sync cannot undo local work.
  upsertEncountersFromCalendarEvents(events) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((eventList) => {
        const stmt = this.db.prepare(`
          INSERT INTO encounters (
            calendar_event_id, provider, calendar_id, title, start_time, end_time,
            source_status, attendees_count, attendees, patient_id, dob,
            normalized_phone, normalized_email, appointment_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(calendar_event_id) DO UPDATE SET
            provider = excluded.provider,
            calendar_id = excluded.calendar_id,
            title = excluded.title,
            start_time = excluded.start_time,
            end_time = excluded.end_time,
            source_status = excluded.source_status,
            attendees_count = excluded.attendees_count,
            attendees = excluded.attendees,
            patient_id = COALESCE(excluded.patient_id, encounters.patient_id),
            dob = COALESCE(excluded.dob, encounters.dob),
            normalized_phone = COALESCE(excluded.normalized_phone, encounters.normalized_phone),
            normalized_email = COALESCE(excluded.normalized_email, encounters.normalized_email),
            appointment_id = COALESCE(excluded.appointment_id, encounters.appointment_id),
            lifecycle_state = CASE
              WHEN encounters.note_id IS NULL
                AND encounters.lifecycle_state = 'scheduled'
                AND excluded.source_status = 'cancelled'
              THEN 'cancelled'
              ELSE encounters.lifecycle_state
            END,
            cancelled_at = CASE
              WHEN encounters.note_id IS NULL
                AND encounters.lifecycle_state = 'scheduled'
                AND excluded.source_status = 'cancelled'
              THEN COALESCE(encounters.cancelled_at, CURRENT_TIMESTAMP)
              ELSE encounters.cancelled_at
            END,
            updated_at = CURRENT_TIMESTAMP
        `);
        for (const event of eventList || []) {
          if (!event?.id || !event.start_time || !event.end_time) continue;
          const privateFields = this.db
            .prepare("SELECT patient_id, dob, normalized_phone, normalized_email, appointment_id FROM calendar_events WHERE id = ?")
            .get(event.id) || {};
          stmt.run(
            event.id,
            event.provider || null,
            event.calendar_id || null,
            event.summary || "Encounter",
            event.start_time,
            event.end_time,
            event.status || "confirmed",
            Number(event.attendees_count) || 0,
            event.attendees || null,
            privateFields.patient_id || event.patient_id || null,
            privateFields.dob || event.dob || null,
            privateFields.normalized_phone || event.normalized_phone || null,
            privateFields.normalized_email || event.normalized_email || null,
            privateFields.appointment_id || event.appointment_id || event.id || null
          );
        }
      });
      transaction(events);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error projecting calendar encounters",
        { error: error.message },
        "encounter"
      );
      throw error;
    }
  }

  getEncounterById(encounterId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare(
            `
        SELECT encounters.*,
          CASE WHEN calendar_events.hangout_link IS NOT NULL THEN 1 ELSE 0 END AS has_conference_url,
          CASE WHEN calendar_events.html_link IS NOT NULL THEN 1 ELSE 0 END AS has_calendar_event_url
        FROM encounters
        LEFT JOIN calendar_events ON calendar_events.id = encounters.calendar_event_id
        WHERE encounters.id = ?
      `
          )
          .get(encounterId) || null
      );
    } catch (error) {
      debugLogger.error("Error getting encounter", { error: error.message }, "encounter");
      throw error;
    }
  }

  getEncounterByCalendarEventId(eventId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare(
            `
            SELECT encounters.*,
              CASE WHEN calendar_events.hangout_link IS NOT NULL THEN 1 ELSE 0 END AS has_conference_url,
              CASE WHEN calendar_events.html_link IS NOT NULL THEN 1 ELSE 0 END AS has_calendar_event_url
            FROM encounters
            LEFT JOIN calendar_events ON calendar_events.id = encounters.calendar_event_id
            WHERE encounters.calendar_event_id = ?
          `
          )
          .get(eventId) || null
      );
    } catch (error) {
      debugLogger.error(
        "Error getting encounter by calendar event",
        { error: error.message },
        "encounter"
      );
      throw error;
    }
  }

  getEncounters(limit = 100) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
      return this.db
        .prepare(
          `
          SELECT encounters.*,
            CASE WHEN calendar_events.hangout_link IS NOT NULL THEN 1 ELSE 0 END AS has_conference_url,
            CASE WHEN calendar_events.html_link IS NOT NULL THEN 1 ELSE 0 END AS has_calendar_event_url
          FROM encounters
          LEFT JOIN calendar_events ON calendar_events.id = encounters.calendar_event_id
          ORDER BY CASE lifecycle_state
            WHEN 'in_progress' THEN 0
            WHEN 'scheduled' THEN 1
            WHEN 'completed' THEN 2
            ELSE 3
          END, datetime(encounters.start_time) ASC, encounters.id DESC
          LIMIT ?
        `
        )
        .all(normalizedLimit);
    } catch (error) {
      debugLogger.error("Error getting encounters", { error: error.message }, "encounter");
      throw error;
    }
  }

  /**
   * Bounded encounter read for Home/calendar surfaces. The legacy getEncounters
   * query intentionally remains unbounded for History/Search callers.
   */
  getEncountersInRange(startIso, endIso, limit = 100) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const range = normalizeRange({ startIso, endIso, limit });
      return this.db
        .prepare(
          `
          SELECT encounters.*,
            CASE WHEN calendar_events.hangout_link IS NOT NULL THEN 1 ELSE 0 END AS has_conference_url,
            CASE WHEN calendar_events.html_link IS NOT NULL THEN 1 ELSE 0 END AS has_calendar_event_url
          FROM encounters
          LEFT JOIN calendar_events ON calendar_events.id = encounters.calendar_event_id
          WHERE datetime(encounters.start_time) >= datetime(?)
            AND datetime(encounters.start_time) < datetime(?)
          ORDER BY datetime(encounters.start_time) ASC, encounters.id DESC
          LIMIT ?
        `
        )
        .all(range.startIso, range.endIso, range.limit);
    } catch (error) {
      debugLogger.error("Error getting bounded encounters", { error: error.message }, "encounter");
      throw error;
    }
  }

  getEncountersForLocalDay(date = new Date(), limit = 100) {
    const range = localDayRange(date);
    return this.getEncountersInRange(range.startIso, range.endIso, limit);
  }

  getCalendarEventsInRange(startIso, endIso, limit = MAX_CALENDAR_ROWS, provider = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const range = normalizeRange({ startIso, endIso, limit });
      const providerClause = provider ? " AND provider = ?" : "";
      const params = provider
        ? [range.startIso, range.endIso, provider, range.limit]
        : [range.startIso, range.endIso, range.limit];
      return this.db
        .prepare(
          `
          SELECT ${CALENDAR_EVENT_PUBLIC_COLUMNS} FROM calendar_events
          WHERE datetime(start_time) >= datetime(?)
            AND datetime(start_time) < datetime(?)
            ${providerClause}
          ORDER BY datetime(start_time) ASC, id ASC
          LIMIT ?
        `
        )
        .all(...params);
    } catch (error) {
      debugLogger.error("Error getting bounded calendar events", { error: error.message }, "calendar");
      throw error;
    }
  }

  markEncountersCancelledByCalendarEventPrefix(provider, calendarId, idPrefix) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare(
          `
          UPDATE encounters
          SET source_status = 'cancelled',
            lifecycle_state = CASE
              WHEN note_id IS NULL AND lifecycle_state = 'scheduled' THEN 'cancelled'
              ELSE lifecycle_state
            END,
            cancelled_at = CASE
              WHEN note_id IS NULL AND lifecycle_state = 'scheduled'
              THEN COALESCE(cancelled_at, CURRENT_TIMESTAMP)
              ELSE cancelled_at
            END,
            updated_at = CURRENT_TIMESTAMP
          WHERE provider = ? AND calendar_id = ? AND calendar_event_id LIKE ?
        `
        )
        .run(provider, calendarId, `${idPrefix}%`);
      return { success: true, changes: result.changes };
    } catch (error) {
      debugLogger.error(
        "Error cancelling calendar encounters",
        { error: error.message },
        "encounter"
      );
      throw error;
    }
  }

  _resolvePatientForEncounter(calendarEvent, encounter) {
    if (this.patientRegistryPath) return this._resolveManagedPatientForEncounter(calendarEvent, encounter);
    const privateSpaceId = this.getPrivateSpaceId();
    const loadProfile = (where, value) =>
      this.db
        .prepare(
          `SELECT p.*, f.space_id, f.deleted_at AS folder_deleted_at
           FROM patient_profiles p
           LEFT JOIN folders f ON f.id = p.folder_id
           WHERE ${where}`
        )
        .get(value);
    const hasAvailablePrivateFolder = (profile) =>
      !!profile && profile.folder_deleted_at == null && profile.space_id === privateSpaceId;
    if (encounter?.patient_profile_id) {
      const profile = loadProfile("p.id = ?", encounter.patient_profile_id);
      if (hasAvailablePrivateFolder(profile)) {
        return { profile, resolution: "matched", folderAvailable: true };
      }
      // Preserve the established audit link even when the folder has since
      // been deleted or moved out of the private space. The note remains in
      // Meetings and the renderer receives only the review enum.
      return { profile: profile || null, resolution: "unassigned_folder_unavailable", folderAvailable: false };
    }

    const identity = resolvePatientIdentity({
      attendees: calendarEvent.attendees,
      patientMetadata: parseLegacyPatientMetadata(calendarEvent.patient_metadata),
      selfAttendeePresent: parseStoredSelfAttendeePresent(calendarEvent.self_attendee_present),
    });
    if (!identity.normalizedEmail) {
      return { profile: null, resolution: identity.status, folderAvailable: false };
    }

    const existing = loadProfile("p.normalized_email = ?", identity.normalizedEmail);
    if (existing) {
      if (!hasAvailablePrivateFolder(existing)) {
        return {
          profile: existing,
          resolution: "unassigned_folder_unavailable",
          folderAvailable: false,
        };
      }
      if (identity.displayName || identity.phone) {
        this.db
          .prepare(
            `UPDATE patient_profiles
             SET display_name = COALESCE(?, display_name),
                 phone = COALESCE(?, phone),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
          .run(identity.displayName || null, identity.phone || null, existing.id);
      }
      return {
        profile: loadProfile("p.id = ?", existing.id),
        resolution: "matched",
        folderAvailable: true,
      };
    }

    const labelBase = String(identity.displayName || identity.normalizedEmail)
      .replace(/[\\/:*?"<>|]/g, "-")
      .trim()
      .slice(0, 100) || "Patient";
    let label = labelBase;
    let counter = 2;
    while (
      this.db
        .prepare(`SELECT id FROM folders WHERE name = ? AND space_id = ? AND ${FOLDER_NAME_TAKEN_FILTER}`)
        .get(label, privateSpaceId)
    ) {
      label = `${labelBase} (${counter})`;
      counter += 1;
    }
    const maxOrder = this.db
      .prepare("SELECT MAX(sort_order) as max_order FROM folders WHERE space_id = ?")
      .get(privateSpaceId);
    const folderResult = this.db
      .prepare(
        "INSERT INTO folders (name, sort_order, space_id, client_folder_id) VALUES (?, ?, ?, ?)"
      )
      .run(label, (maxOrder?.max_order ?? 0) + 1, privateSpaceId, randomUUID());
    const profileResult = this.db
      .prepare(
        `INSERT INTO patient_profiles (normalized_email, display_name, phone, folder_id, identity_source)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        identity.normalizedEmail,
        identity.displayName,
        identity.phone,
        folderResult.lastInsertRowid,
        identity.identitySource
      );
    return {
      profile: loadProfile("p.id = ?", profileResult.lastInsertRowid),
      resolution: "created",
      folderAvailable: true,
    };
  }

  _getManagedRegistryPatients() {
    if (!this.patientRegistryPath) return [];
    try {
      return this.db
        .prepare("SELECT patient_id, name, dob, normalized_dob, normalized_phone, normalized_email, phone, email, active FROM hira_registry.patients WHERE active = 1")
        .all();
    } catch {
      // A partially initialized registry should fail closed. Returning a
      // guessed legacy projection here could attach an encounter to a
      // patient without the v1 identity evidence.
      return [];
    }
  }

  _getManagedAppointmentPatient(appointmentId) {
    if (!this.patientRegistryPath || !appointmentId) return null;
    return this.db
      .prepare("SELECT appointment_id, patient_id FROM hira_registry.appointments WHERE appointment_id = ?")
      .get(appointmentId) || null;
  }

  _getOrCreateUnlinkedEncountersFolder() {
    const privateSpaceId = this.getPrivateSpaceId();
    let folder = this.db
      .prepare("SELECT * FROM folders WHERE name = ? AND space_id = ? AND deleted_at IS NULL LIMIT 1")
      .get("Unlinked Encounters", privateSpaceId);
    if (folder) return folder;
    const maxOrder = this.db
      .prepare("SELECT MAX(sort_order) AS max_order FROM folders WHERE space_id = ?")
      .get(privateSpaceId);
    const result = this.db
      .prepare("INSERT INTO folders (name, sort_order, space_id, client_folder_id) VALUES (?, ?, ?, ?)")
      .run("Unlinked Encounters", (maxOrder?.max_order ?? 0) + 1, privateSpaceId, randomUUID());
    return this.db.prepare("SELECT * FROM folders WHERE id = ?").get(result.lastInsertRowid);
  }

  _resolveManagedPatientForEncounter(calendarEvent, encounter) {
    const metadata = parseLegacyPatientMetadata(calendarEvent.patient_metadata) || {
      patient_id: calendarEvent.patient_id || null,
      appointment_id: calendarEvent.appointment_id || null,
      dob: calendarEvent.dob || null,
      phone: calendarEvent.normalized_phone || null,
      email: calendarEvent.normalized_email || null,
      source: "structured_description",
    };
    if (!metadata.patient_id && calendarEvent.patient_id) metadata.patient_id = calendarEvent.patient_id;
    if (!metadata.appointment_id && calendarEvent.appointment_id) metadata.appointment_id = calendarEvent.appointment_id;
    const appointmentPatient = this._getManagedAppointmentPatient(metadata.appointment_id);
    const identity = resolvePatientIdentity({
      patientMetadata: metadata,
      registryPatients: this._getManagedRegistryPatients(),
      appointmentPatient,
    });
    const privateSpaceId = this.getPrivateSpaceId();

    if (!identity.patientId) {
      const folder = this._getOrCreateUnlinkedEncountersFolder();
      return {
        profile: null,
        patientId: null,
        appointmentId: normalizeAppointmentId(identity.appointmentId || calendarEvent.appointment_id),
        dob: identity.normalizedDob || metadata.dob || null,
        normalizedEmail: identity.normalizedEmail || metadata.email || null,
        normalizedPhone: identity.phone || metadata.phone || null,
        resolution: "unassigned_review",
        folderAvailable: !!folder,
        folderId: folder?.id || null,
      };
    }

    let workspace = this.db
      .prepare(
        `SELECT pw.*, f.space_id, f.deleted_at AS folder_deleted_at
         FROM patient_workspaces pw JOIN folders f ON f.id = pw.folder_id
         WHERE pw.patient_id = ?`
      )
      .get(identity.patientId);
    if (workspace && (workspace.folder_deleted_at != null || workspace.space_id !== privateSpaceId)) {
      return {
        profile: null,
        patientId: identity.patientId,
        appointmentId: normalizeAppointmentId(identity.appointmentId || calendarEvent.appointment_id),
        dob: identity.normalizedDob,
        normalizedEmail: identity.normalizedEmail,
        normalizedPhone: identity.phone,
        resolution: "unassigned_folder_unavailable",
        folderAvailable: false,
        folderId: null,
      };
    }

    if (!workspace) {
      const registryPatient = this._getManagedRegistryPatients().find(
        (patient) => String(patient.patient_id) === identity.patientId
      );
      const labelBase = String(identity.displayName || registryPatient?.name || `Patient ${identity.patientId.slice(0, 12)}`)
        .replace(/[\\/:*?"<>|]/g, "-")
        .trim()
        .slice(0, 100) || "Patient";
      let label = labelBase;
      let counter = 2;
      while (this.db.prepare("SELECT id FROM folders WHERE name = ? AND space_id = ? AND deleted_at IS NULL").get(label, privateSpaceId)) {
        label = `${labelBase} (${counter})`;
        counter += 1;
      }
      const maxOrder = this.db.prepare("SELECT MAX(sort_order) AS max_order FROM folders WHERE space_id = ?").get(privateSpaceId);
      const folderResult = this.db.prepare("INSERT INTO folders (name, sort_order, space_id, client_folder_id) VALUES (?, ?, ?, ?)").run(label, (maxOrder?.max_order ?? 0) + 1, privateSpaceId, randomUUID());
      this.db.prepare("INSERT INTO patient_workspaces (patient_id, folder_id) VALUES (?, ?)").run(identity.patientId, folderResult.lastInsertRowid);
      workspace = this.db.prepare("SELECT * FROM patient_workspaces WHERE patient_id = ?").get(identity.patientId);
    }
    return {
      profile: null,
      patientId: identity.patientId,
      appointmentId: normalizeAppointmentId(identity.appointmentId || calendarEvent.appointment_id),
      dob: identity.normalizedDob,
      normalizedEmail: identity.normalizedEmail,
      normalizedPhone: identity.phone,
      resolution: "matched",
      folderAvailable: true,
      folderId: workspace.folder_id,
    };
  }

  _getCalendarEventForPatientResolution(eventId) {
    return (
      this.db
        .prepare(
          `SELECT ${CALENDAR_EVENT_PUBLIC_COLUMNS_QUALIFIED},
                  calendar_patient_metadata.metadata_json AS patient_metadata,
                  calendar_patient_metadata.self_attendee_present
           FROM calendar_events
           LEFT JOIN calendar_patient_metadata
             ON calendar_patient_metadata.calendar_event_id = calendar_events.id
           WHERE calendar_events.id = ?`
        )
        .get(eventId) || null
    );
  }

  // The database transaction is the idempotency boundary for every calendar
  // start entry point. No async work occurs inside it, so retries all resolve
  // to the same encounter/note pair on this local database.
  startEncounterForCalendarEvent(eventId, { meetingContext = null } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!eventId || typeof eventId !== "string") {
        return { success: false, error: "A calendar event is required." };
      }
      const context = ["in_person", "telehealth"].includes(meetingContext) ? meetingContext : null;
      const transaction = this.db.transaction(() => {
        const calendarEvent = this._getCalendarEventForPatientResolution(eventId);
        if (!calendarEvent) return { success: false, error: "Calendar event not found." };

        let encounter = this.db
          .prepare("SELECT * FROM encounters WHERE calendar_event_id = ?")
          .get(eventId);
        if (!encounter) {
          const linkedNote = this.db
            .prepare(
              "SELECT * FROM notes WHERE calendar_event_id = ? AND deleted_at IS NULL LIMIT 1"
            )
            .get(eventId);
          this.db
            .prepare(
              `
              INSERT INTO encounters (
                calendar_event_id, provider, calendar_id, title, start_time, end_time,
                source_status, lifecycle_state, note_id, attendees_count, attendees,
                patient_id, dob, normalized_phone, normalized_email, appointment_id, started_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            )
            .run(
              calendarEvent.id,
              calendarEvent.provider || null,
              calendarEvent.calendar_id || null,
              calendarEvent.summary || "Encounter",
              calendarEvent.start_time,
              calendarEvent.end_time,
              calendarEvent.status || "confirmed",
              linkedNote ? "in_progress" : "scheduled",
              linkedNote?.id || null,
              Number(calendarEvent.attendees_count) || 0,
              calendarEvent.attendees || null,
              calendarEvent.patient_id || null,
              calendarEvent.dob || null,
              calendarEvent.normalized_phone || null,
              calendarEvent.normalized_email || null,
              calendarEvent.appointment_id || null,
              linkedNote ? linkedNote.created_at : null
            );
          encounter = this.db
            .prepare("SELECT * FROM encounters WHERE calendar_event_id = ?")
            .get(eventId);
        }

        let note = encounter.note_id
          ? this.db
              .prepare("SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL")
              .get(encounter.note_id)
          : null;
        if (!note) {
          note = this.db
            .prepare(
              "SELECT * FROM notes WHERE calendar_event_id = ? AND deleted_at IS NULL LIMIT 1"
            )
            .get(eventId);
        }

        let createdNote = false;
        // Never retroactively classify a legacy/existing meeting note. New
        // encounters resolve before their note is created; retries reuse the
        // stored profile relationship from that first transaction.
        const patient = encounter.patient_profile_id || !note
          ? this._resolvePatientForEncounter(calendarEvent, encounter)
          : {
              profile: null,
              resolution: encounter.patient_resolution || "unassigned_legacy",
              folderAvailable: false,
            };
        if (!note) {
          const noteResult = this.saveNote(
            formatEncounterAutoTitle({
              startTime: calendarEvent.start_time,
              timezone: calendarEvent.timezone,
              focus: calendarEvent.summary || "Encounter",
            }),
            "",
            "meeting",
            null,
            null,
            patient.folderAvailable ? patient.folderId || patient.profile?.folder_id || null : this._getOrCreateUnlinkedEncountersFolder()?.id || null
          );
          note = noteResult?.note || null;
          createdNote = !!note;
          if (note?.id) {
            this.db
              .prepare("UPDATE notes SET encounter_auto_title_seed = ? WHERE id = ?")
              .run(note.title, note.id);
            note = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id);
          }
        }
        if (!note?.id) return { success: false, error: "Unable to create meeting note." };

        const noteUpdates = {};
        if (note.calendar_event_id !== eventId) noteUpdates.calendar_event_id = eventId;
        if (calendarEvent.attendees && note.participants !== calendarEvent.attendees) {
          noteUpdates.participants = calendarEvent.attendees;
        }
        if (patient.folderAvailable && patient.folderId && note.folder_id !== patient.folderId) {
          noteUpdates.folder_id = patient.folderId;
        }
        if (context && note.meeting_context !== context) noteUpdates.meeting_context = context;
        if (Object.keys(noteUpdates).length > 0) {
          note = this.updateNote(note.id, noteUpdates)?.note || note;
        }

        this.db
          .prepare(
            `
            UPDATE encounters
            SET note_id = ?,
              patient_profile_id = COALESCE(patient_profile_id, ?),
              patient_id = COALESCE(patient_id, ?),
              dob = COALESCE(dob, ?),
              normalized_phone = COALESCE(normalized_phone, ?),
              normalized_email = COALESCE(normalized_email, ?),
              appointment_id = COALESCE(appointment_id, ?),
              patient_resolution = ?,
              lifecycle_state = CASE
                WHEN lifecycle_state = 'completed' THEN 'completed'
                ELSE 'in_progress'
              END,
              meeting_context = CASE WHEN ? IS NULL THEN meeting_context ELSE ? END,
              started_at = CASE
                WHEN lifecycle_state = 'completed' THEN started_at
                ELSE COALESCE(started_at, CURRENT_TIMESTAMP)
              END,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `
          )
          .run(
            note.id,
            patient.profile?.id || null,
            patient.patientId || calendarEvent.patient_id || null,
            patient.dob || calendarEvent.dob || null,
            patient.normalizedPhone || calendarEvent.normalized_phone || null,
            patient.normalizedEmail || calendarEvent.normalized_email || null,
            patient.appointmentId || calendarEvent.appointment_id || null,
            patient.resolution,
            context,
            context,
            encounter.id
          );

        encounter = this.db.prepare("SELECT * FROM encounters WHERE id = ?").get(encounter.id);
        const token = this._getNoteTranscriptToken(note.id);
        this.db
          .prepare(
            `INSERT INTO encounter_outputs (encounter_id, transcript_hash, transcript_revision)
             VALUES (?, ?, ?)
             ON CONFLICT(encounter_id) DO NOTHING`
          )
          .run(encounter.id, token.transcriptHash, token.transcriptRevision);
        const rendererEncounter = { ...encounter };
        // Demographics are needed for the local resolver, not for renderer
        // consumers. Keep only opaque linkage in the IPC result so contact
        // data and DOB never cross the calendar/renderer boundary.
        delete rendererEncounter.dob;
        delete rendererEncounter.normalized_phone;
        delete rendererEncounter.normalized_email;
        return {
          success: true,
          encounter: rendererEncounter,
          note,
          createdNote,
          // The resolver profile contains contact data and stays main-process
          // only. Encounter consumers receive the foreign-key audit link and
          // controlled review state, never the profile/folder payload.
          patientProfileId: encounter.patient_profile_id || null,
          patientResolution: encounter.patient_resolution,
          patient_id: encounter.patient_id || null,
          appointment_id: encounter.appointment_id || null,
          patientId: encounter.patient_id || null,
          appointmentId: encounter.appointment_id || null,
        };
      });
      return transaction();
    } catch (error) {
      debugLogger.error("Error starting encounter", { error: error.message }, "encounter");
      throw error;
    }
  }

  getEncounterByNoteId(noteId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare(
            `SELECT encounters.*,
              CASE WHEN calendar_events.hangout_link IS NOT NULL THEN 1 ELSE 0 END AS has_conference_url,
              CASE WHEN calendar_events.html_link IS NOT NULL THEN 1 ELSE 0 END AS has_calendar_event_url
             FROM encounters
             LEFT JOIN calendar_events ON calendar_events.id = encounters.calendar_event_id
             WHERE encounters.note_id = ?`
          )
          .get(noteId) || null
      );
    } catch (error) {
      debugLogger.error("Error getting encounter by note", { error: error.message }, "encounter");
      throw error;
    }
  }

  _getEncounterOutputRow(encounterId) {
    return (
      this.db.prepare("SELECT * FROM encounter_outputs WHERE encounter_id = ?").get(encounterId) ||
      null
    );
  }

  _getNoteTranscriptToken(noteId) {
    const row = this.db
      .prepare("SELECT transcript, transcript_revision FROM notes WHERE id = ?")
      .get(noteId);
    if (!row) return null;
    return {
      transcriptRevision: Number(row.transcript_revision) || 0,
      transcriptHash: hashEncounterTranscript(row.transcript),
    };
  }

  _getEncounterTranscriptSnapshot(encounterId) {
    const row = this.db
      .prepare(
        `SELECT notes.id AS note_id, notes.transcript, notes.transcript_revision
         FROM encounters
         LEFT JOIN notes ON notes.id = encounters.note_id
         WHERE encounters.id = ?`
      )
      .get(encounterId);
    if (!row?.note_id) return null;
    return {
      transcript: String(row.transcript ?? ""),
      token: {
        transcriptRevision: Number(row.transcript_revision) || 0,
        transcriptHash: hashEncounterTranscript(row.transcript),
      },
    };
  }

  _ensureEncounterOutputForToken(encounterId, token) {
    this.db
      .prepare(
        `INSERT INTO encounter_outputs (encounter_id, transcript_hash, transcript_revision)
         VALUES (?, ?, ?)
         ON CONFLICT(encounter_id) DO NOTHING`
      )
      .run(encounterId, token.transcriptHash, token.transcriptRevision);
    return this._getEncounterOutputRow(encounterId);
  }

  _invalidateEncounterOutputsForNote(noteId, token) {
    const encounter = this.db.prepare("SELECT id FROM encounters WHERE note_id = ?").get(noteId);
    if (!encounter || !token) return null;
    const result = this.db
      .prepare(
        `UPDATE encounter_outputs
         SET transcript_hash = ?,
           transcript_revision = ?,
           summary_status = CASE
             WHEN COALESCE(summary, '') = '' THEN 'pending'
             ELSE 'stale'
           END,
           soap_status = CASE
             WHEN COALESCE(soap, '') = '' THEN 'pending'
             ELSE 'stale'
           END,
           focus_status = CASE
             WHEN COALESCE(focus, '') = '' THEN 'pending'
             ELSE 'stale'
           END,
           updated_at = CURRENT_TIMESTAMP
         WHERE encounter_id = ?
           AND (transcript_hash != ? OR transcript_revision != ?)`
      )
      .run(
        token.transcriptHash,
        token.transcriptRevision,
        encounter.id,
        token.transcriptHash,
        token.transcriptRevision
      );
    return { encounterId: encounter.id, ...token, changes: result.changes };
  }

  _getEncounterTranscriptHash(encounterId) {
    return this._getEncounterTranscriptSnapshot(encounterId)?.token.transcriptHash || null;
  }

  getEncounterOutput(encounterId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return decorateEncounterOutput(this._getEncounterOutputRow(encounterId));
    } catch (error) {
      debugLogger.error("Error getting encounter output", { error: error.message }, "encounter");
      throw error;
    }
  }

  getOrCreateEncounterOutput(encounterId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedId = Number(encounterId);
      if (!Number.isInteger(normalizedId) || normalizedId <= 0) return null;
      const transaction = this.db.transaction(() => {
        const snapshot = this._getEncounterTranscriptSnapshot(normalizedId);
        if (!snapshot) return null;
        return decorateEncounterOutput(
          this._ensureEncounterOutputForToken(normalizedId, snapshot.token)
        );
      });
      return transaction();
    } catch (error) {
      debugLogger.error("Error creating encounter output", { error: error.message }, "encounter");
      throw error;
    }
  }

  getEncounterTranscriptToken(encounterId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedId = Number(encounterId);
      if (!Number.isInteger(normalizedId) || normalizedId <= 0) return null;
      return this._getEncounterTranscriptSnapshot(normalizedId)?.token || null;
    } catch (error) {
      debugLogger.error(
        "Error getting encounter transcript token",
        { error: error.message },
        "encounter"
      );
      throw error;
    }
  }

  _normalizeEncounterOutputTypes(outputTypes) {
    const requested =
      outputTypes === "all" || outputTypes == null
        ? ["summary", "soap", "focus"]
        : Array.isArray(outputTypes)
          ? outputTypes
          : [outputTypes];
    return [...new Set(requested.filter((type) => type === "summary" || type === "soap" || type === "focus"))];
  }

  beginEncounterOutputGeneration(encounterId, outputTypes = "all") {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedId = Number(encounterId);
      const types = this._normalizeEncounterOutputTypes(outputTypes);
      if (!Number.isInteger(normalizedId) || normalizedId <= 0 || types.length === 0) return null;
      const transaction = this.db.transaction(() => {
        const snapshot = this._getEncounterTranscriptSnapshot(normalizedId);
        if (!snapshot) return null;
        this._ensureEncounterOutputForToken(normalizedId, snapshot.token);
        const fields = ["updated_at = CURRENT_TIMESTAMP"];
        for (const type of types) {
          fields.push(
            `${type}_status = 'processing'`,
            `${type}_error_code = NULL`,
            `${type}_updated_at = CURRENT_TIMESTAMP`
          );
        }
        this.db
          .prepare(`UPDATE encounter_outputs SET ${fields.join(", ")} WHERE encounter_id = ?`)
          .run(normalizedId);
        return {
          transcript: snapshot.transcript,
          token: snapshot.token,
          output: decorateEncounterOutput(this._getEncounterOutputRow(normalizedId)),
        };
      });
      return transaction();
    } catch (error) {
      debugLogger.error(
        "Error beginning encounter output generation",
        { error: error.message },
        "encounter"
      );
      throw error;
    }
  }

  finishEncounterOutputGeneration(encounterId, token, updates = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedId = Number(encounterId);
      const expectedRevision = Number(token?.transcriptRevision);
      const expectedHash = token?.transcriptHash;
      if (
        !Number.isInteger(normalizedId) ||
        normalizedId <= 0 ||
        !Number.isInteger(expectedRevision) ||
        expectedRevision < 0 ||
        typeof expectedHash !== "string"
      ) {
        return { applied: false, output: null };
      }
      const transaction = this.db.transaction(() => {
        const snapshot = this._getEncounterTranscriptSnapshot(normalizedId);
        if (!snapshot) return { applied: false, output: null };
        this._ensureEncounterOutputForToken(normalizedId, snapshot.token);
        const output = decorateEncounterOutput(this._getEncounterOutputRow(normalizedId));
        if (
          snapshot.token.transcriptRevision !== expectedRevision ||
          snapshot.token.transcriptHash !== expectedHash
        ) {
          return { applied: false, output };
        }

        const fields = [];
        const values = [];
        for (const type of ["summary", "soap", "focus"]) {
          const status = updates?.[`${type}_status`];
          if (status !== "ready" && status !== "failed") continue;
          for (const field of [
            type,
            `${type}_status`,
            `${type}_provider`,
            `${type}_model`,
            `${type}_error_code`,
          ]) {
            if (updates[field] === undefined) continue;
            fields.push(`${field} = ?`);
            values.push(updates[field]);
          }
          fields.push(`${type}_updated_at = CURRENT_TIMESTAMP`);
        }
        if (fields.length === 0) return { applied: false, output };
        fields.push("updated_at = CURRENT_TIMESTAMP");
        values.push(normalizedId);
        this.db
          .prepare(`UPDATE encounter_outputs SET ${fields.join(", ")} WHERE encounter_id = ?`)
          .run(...values);
        let note = null;
        if (updates.focus_status === "ready" && typeof updates.focus === "string") {
          const titleTarget = this.db
            .prepare(
              `SELECT n.id, n.title, n.encounter_auto_title_seed, e.start_time, calendar_events.timezone
               FROM encounters e
               JOIN notes n ON n.id = e.note_id
               LEFT JOIN calendar_events ON calendar_events.id = e.calendar_event_id
               WHERE e.id = ?`
            )
            .get(normalizedId);
          if (
            titleTarget?.encounter_auto_title_seed &&
            titleTarget.title === titleTarget.encounter_auto_title_seed
          ) {
            const title = formatEncounterAutoTitle({
              startTime: titleTarget.start_time,
              timezone: titleTarget.timezone,
              focus: updates.focus,
            });
            this.db
              .prepare(
                "UPDATE notes SET title = ?, sync_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
              )
              .run(title, titleTarget.id);
            note = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(titleTarget.id);
          }
        }
        return {
          applied: true,
          output: decorateEncounterOutput(this._getEncounterOutputRow(normalizedId)),
          note,
        };
      });
      return transaction();
    } catch (error) {
      debugLogger.error(
        "Error finishing encounter output generation",
        { error: error.message },
        "encounter"
      );
      throw error;
    }
  }

  updateEncounterOutput(encounterId, updates = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedId = Number(encounterId);
      if (!Number.isInteger(normalizedId) || normalizedId <= 0) return null;
      const existing = this.getOrCreateEncounterOutput(normalizedId);
      if (!existing) return null;
      const allowedFields = new Set([
        "summary",
        "soap",
        "focus",
        "summary_status",
        "soap_status",
        "focus_status",
        "summary_provider",
        "summary_model",
        "soap_provider",
        "soap_model",
        "focus_provider",
        "focus_model",
        "summary_error_code",
        "soap_error_code",
        "focus_error_code",
      ]);
      const fields = [];
      const values = [];
      for (const [key, value] of Object.entries(updates || {})) {
        if (!allowedFields.has(key) || value === undefined) continue;
        if (key.endsWith("_status") && !ENCOUNTER_OUTPUT_STATUSES.has(value)) continue;
        fields.push(`${key} = ?`);
        values.push(value);
        if (key === "summary" || key.startsWith("summary_")) {
          if (!fields.includes("summary_updated_at = CURRENT_TIMESTAMP")) {
            fields.push("summary_updated_at = CURRENT_TIMESTAMP");
          }
        }
        if (key === "soap" || key.startsWith("soap_")) {
          if (!fields.includes("soap_updated_at = CURRENT_TIMESTAMP")) {
            fields.push("soap_updated_at = CURRENT_TIMESTAMP");
          }
        }
        if (key === "focus" || key.startsWith("focus_")) {
          if (!fields.includes("focus_updated_at = CURRENT_TIMESTAMP")) {
            fields.push("focus_updated_at = CURRENT_TIMESTAMP");
          }
        }
      }
      if (fields.length === 0) return existing;
      fields.push("updated_at = CURRENT_TIMESTAMP");
      values.push(normalizedId);
      this.db
        .prepare(`UPDATE encounter_outputs SET ${fields.join(", ")} WHERE encounter_id = ?`)
        .run(...values);
      return decorateEncounterOutput(this._getEncounterOutputRow(normalizedId));
    } catch (error) {
      debugLogger.error("Error updating encounter output", { error: error.message }, "encounter");
      throw error;
    }
  }

  retryEncounterOutput(encounterId, outputType = "all") {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!["summary", "soap", "focus", "all"].includes(outputType)) return null;
      const normalizedId = Number(encounterId);
      if (!Number.isInteger(normalizedId) || normalizedId <= 0) return null;
      const output = this.getOrCreateEncounterOutput(normalizedId);
      if (!output) return null;
      const snapshot = this._getEncounterTranscriptSnapshot(normalizedId);
      if (!snapshot) return null;
      const fields = [
        "transcript_hash = ?",
        "transcript_revision = ?",
        "updated_at = CURRENT_TIMESTAMP",
      ];
      const values = [snapshot.token.transcriptHash, snapshot.token.transcriptRevision];
      if (outputType === "summary" || outputType === "all") {
        fields.push(
          "summary_status = 'pending'",
          "summary_error_code = NULL",
          "summary_updated_at = CURRENT_TIMESTAMP"
        );
      }
      if (outputType === "soap" || outputType === "all") {
        fields.push(
          "soap_status = 'pending'",
          "soap_error_code = NULL",
          "soap_updated_at = CURRENT_TIMESTAMP"
        );
      }
      if (outputType === "focus" || outputType === "all") {
        fields.push(
          "focus_status = 'pending'",
          "focus_error_code = NULL",
          "focus_updated_at = CURRENT_TIMESTAMP"
        );
      }
      values.push(normalizedId);
      this.db
        .prepare(`UPDATE encounter_outputs SET ${fields.join(", ")} WHERE encounter_id = ?`)
        .run(...values);
      return decorateEncounterOutput(this._getEncounterOutputRow(normalizedId));
    } catch (error) {
      debugLogger.error("Error retrying encounter output", { error: error.message }, "encounter");
      throw error;
    }
  }

  markEncounterOutputsStaleForNote(noteId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this._invalidateEncounterOutputsForNote(noteId, this._getNoteTranscriptToken(noteId));
    } catch (error) {
      debugLogger.error(
        "Error marking encounter output stale",
        { error: error.message },
        "encounter"
      );
      throw error;
    }
  }

  completeEncounterRecording(noteId, transcript) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedNoteId = Number(noteId);
      if (!Number.isInteger(normalizedNoteId) || normalizedNoteId <= 0) {
        return { success: false, errorCode: "ENCOUNTER_RECORDING_INVALID_NOTE" };
      }
      const transaction = this.db.transaction(() => {
        const note = this.db
          .prepare("SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL")
          .get(normalizedNoteId);
        if (!note) return { success: false, errorCode: "ENCOUNTER_RECORDING_INVALID_NOTE" };

        const nextTranscript = typeof transcript === "string" ? transcript : note.transcript || "";
        const transcriptChanged = nextTranscript !== note.transcript;
        this.db
          .prepare(
            `UPDATE notes
             SET transcript = ?,
               transcript_revision = CASE
                 WHEN transcript IS NOT ? THEN transcript_revision + 1
                 ELSE transcript_revision
               END,
               sync_status = 'pending', updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
          .run(nextTranscript, nextTranscript, normalizedNoteId);

        const encounter = this.db
          .prepare("SELECT * FROM encounters WHERE note_id = ?")
          .get(normalizedNoteId);
        if (!encounter) {
          return {
            success: true,
            note: this.db.prepare("SELECT * FROM notes WHERE id = ?").get(normalizedNoteId),
            encounter: null,
            output: null,
          };
        }

        if (transcriptChanged) {
          this._invalidateEncounterOutputsForNote(
            normalizedNoteId,
            this._getNoteTranscriptToken(normalizedNoteId)
          );
        }
        this.db
          .prepare(
            `UPDATE encounters
             SET lifecycle_state = 'completed',
               completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
          .run(encounter.id);
        return {
          success: true,
          note: this.db.prepare("SELECT * FROM notes WHERE id = ?").get(normalizedNoteId),
          encounter: this.db.prepare("SELECT * FROM encounters WHERE id = ?").get(encounter.id),
          output: decorateEncounterOutput(this._getEncounterOutputRow(encounter.id)),
        };
      });
      return transaction();
    } catch (error) {
      debugLogger.error(
        "Error completing encounter recording",
        { error: error.message },
        "encounter"
      );
      throw error;
    }
  }

  getActiveEvents() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          dedupedEventsQuery(
            "datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now') AND is_all_day = 0 AND status IN ('confirmed', 'tentative')"
          )
        )
        .all()
        .map(stripDedupeColumn);
    } catch (error) {
      debugLogger.error("Error getting active events", { error: error.message }, "gcal");
      throw error;
    }
  }

  searchNotes(query, limit = 50, spaceId = null, folderId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const ftsQuery = buildNoteSearchQuery(query);
      if (!ftsQuery) return [];
      const params = [ftsQuery];
      let scopeFilter = "";
      if (spaceId != null) {
        scopeFilter += " AND n.space_id = ?";
        params.push(spaceId);
      }
      if (folderId != null) {
        scopeFilter += " AND n.folder_id = ?";
        params.push(folderId);
      }
      params.push(limit);
      return this.db
        .prepare(
          `
        SELECT n.*
        FROM notes n
        JOIN notes_fts ON notes_fts.rowid = n.id
        WHERE notes_fts MATCH ? AND n.deleted_at IS NULL${scopeFilter}
        ORDER BY notes_fts.rank
        LIMIT ?
      `
        )
        .all(...params);
    } catch (error) {
      debugLogger.error("Error searching notes", { error: error.message }, "database");
      throw error;
    }
  }

  getUpcomingEvents(windowMinutes = 1440) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          dedupedEventsQuery(
            "((datetime(start_time) > datetime('now') AND datetime(start_time) <= datetime('now', '+' || ? || ' minutes')) OR (datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now'))) AND is_all_day = 0 AND status IN ('confirmed', 'tentative')"
          )
        )
        .all(windowMinutes)
        .map(stripDedupeColumn);
    } catch (error) {
      debugLogger.error("Error getting upcoming events", { error: error.message }, "gcal");
      throw error;
    }
  }

  getCalendarEventById(eventId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare(`SELECT ${CALENDAR_EVENT_PUBLIC_COLUMNS} FROM calendar_events WHERE id = ?`)
          .get(eventId) || null
      );
    } catch (error) {
      debugLogger.error("Error getting calendar event by id", { error: error.message }, "gcal");
      return null;
    }
  }

  getNoteByCalendarEventId(eventId, excludeNoteId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const base = "SELECT * FROM notes WHERE calendar_event_id = ? AND deleted_at IS NULL";
      if (excludeNoteId) {
        return this.db.prepare(`${base} AND id != ? LIMIT 1`).get(eventId, excludeNoteId) || null;
      }
      return this.db.prepare(`${base} LIMIT 1`).get(eventId) || null;
    } catch (error) {
      debugLogger.error(
        "Error getting note by calendar event id",
        { error: error.message },
        "notes"
      );
      return null;
    }
  }

  upsertContacts(contacts) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((list) => {
        const stmt = this.db.prepare(
          "INSERT INTO contacts (email, display_name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(email) DO UPDATE SET display_name = COALESCE(excluded.display_name, contacts.display_name), updated_at = CURRENT_TIMESTAMP"
        );
        for (const c of list) {
          if (c.email) stmt.run(c.email.toLowerCase().trim(), c.displayName || null);
        }
      });
      transaction(contacts);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error upserting contacts", { error: error.message }, "database");
      throw error;
    }
  }

  searchContacts(query) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const pattern = `%${query || ""}%`;
      return this.db
        .prepare(
          "SELECT * FROM contacts WHERE email LIKE ? OR display_name LIKE ? ORDER BY display_name ASC, email ASC LIMIT 20"
        )
        .all(pattern, pattern);
    } catch (error) {
      debugLogger.error("Error searching contacts", { error: error.message }, "database");
      throw error;
    }
  }

  clearGoogleCalendarData() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        this.db.prepare("DELETE FROM calendar_events WHERE provider = 'google'").run();
        this.db.prepare("DELETE FROM google_calendars").run();
        this.db.prepare("DELETE FROM google_calendar_tokens").run();
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing calendar data", { error: error.message }, "gcal");
      throw error;
    }
  }

  updateCalendarSyncToken(calendarId, syncToken) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("UPDATE google_calendars SET sync_token = ? WHERE id = ?")
        .run(syncToken, calendarId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating sync token", { error: error.message }, "gcal");
      throw error;
    }
  }

  removeCalendarEvents(eventIds) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const placeholders = eventIds.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM calendar_events WHERE id IN (${placeholders})`).run(...eventIds);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error removing calendar events", { error: error.message }, "gcal");
      throw error;
    }
  }

  removeCalendarEventsByPrefix(provider, calendarId, idPrefix) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          `DELETE FROM calendar_events
           WHERE provider = ? AND calendar_id = ? AND id LIKE ?
             AND id NOT IN (
               SELECT calendar_event_id
               FROM notes
               WHERE calendar_event_id IS NOT NULL AND deleted_at IS NULL
             )`
        )
        .run(provider, calendarId, `${idPrefix}%`);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error removing calendar event occurrences",
        { error: error.message },
        "calendar"
      );
      throw error;
    }
  }

  removeStaleCalendarEventsInWindow(provider, calendarId, freshEventIds, startTime, endTime) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const placeholders = freshEventIds.map(() => "?").join(", ");
      const freshFilter = freshEventIds.length > 0 ? `AND id NOT IN (${placeholders})` : "";
      this.db
        .prepare(
          `DELETE FROM calendar_events
           WHERE provider = ? AND calendar_id = ?
             AND datetime(start_time) >= datetime(?)
             AND datetime(start_time) < datetime(?)
             ${freshFilter}
             AND id NOT IN (
               SELECT calendar_event_id
               FROM notes
               WHERE calendar_event_id IS NOT NULL AND deleted_at IS NULL
             )`
        )
        .run(provider, calendarId, startTime, endTime, ...freshEventIds);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error reconciling calendar event window",
        { error: error.message },
        "calendar"
      );
      throw error;
    }
  }

  // A complete AIReceptionist window is authoritative for both local cache
  // tables. Keep recorded work intact, but cancel a never-started encounter
  // when its source occurrence no longer appears in that authoritative feed.
  reconcileStaleCalendarWindow(provider, calendarId, freshEventIds, startTime, endTime) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const fresh = Array.isArray(freshEventIds) ? freshEventIds : [];
      const placeholders = fresh.map(() => "?").join(", ");
      const freshFilter = fresh.length > 0 ? `AND calendar_event_id NOT IN (${placeholders})` : "";
      const eventFreshFilter = fresh.length > 0 ? `AND id NOT IN (${placeholders})` : "";
      const transaction = this.db.transaction(() => {
        const cancelled = this.db
          .prepare(
            `
          UPDATE encounters
          SET source_status = 'cancelled', lifecycle_state = 'cancelled',
            cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
          WHERE provider = ? AND calendar_id = ?
            AND datetime(start_time) >= datetime(?)
            AND datetime(start_time) < datetime(?)
            ${freshFilter}
            AND lifecycle_state = 'scheduled' AND note_id IS NULL
        `
          )
          .run(provider, calendarId, startTime, endTime, ...fresh);
        const pruned = this.db
          .prepare(
            `
          DELETE FROM calendar_events
          WHERE provider = ? AND calendar_id = ?
            AND datetime(start_time) >= datetime(?)
            AND datetime(start_time) < datetime(?)
            ${eventFreshFilter}
            AND id NOT IN (
              SELECT calendar_event_id FROM notes
              WHERE calendar_event_id IS NOT NULL AND deleted_at IS NULL
            )
        `
          )
          .run(provider, calendarId, startTime, endTime, ...fresh);
        return { cancelled: cancelled.changes, pruned: pruned.changes };
      });
      const result = transaction();
      return { success: true, ...result };
    } catch (error) {
      debugLogger.error(
        "Error reconciling stale encounter window",
        { error: error.message },
        "encounter"
      );
      throw error;
    }
  }

  // A full (non-incremental) REST sync is authoritative for its calendar's
  // window: rows the provider no longer returns were deleted while no valid
  // sync token existed (e.g. the app was offline past the token TTL), so they
  // would otherwise linger and fire reminders for cancelled meetings. Rows
  // referenced by meeting notes are kept so notes retain calendar metadata.
  removeStaleCalendarEvents(provider, calendarId, freshEventIds) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const placeholders = freshEventIds.map(() => "?").join(", ");
      const freshFilter = freshEventIds.length > 0 ? `AND id NOT IN (${placeholders})` : "";
      this.db
        .prepare(
          `DELETE FROM calendar_events
           WHERE provider = ? AND calendar_id = ? ${freshFilter}
             AND id NOT IN (
               SELECT calendar_event_id
               FROM notes
               WHERE calendar_event_id IS NOT NULL AND deleted_at IS NULL
             )`
        )
        .run(provider, calendarId, ...freshEventIds);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error removing stale calendar events",
        { error: error.message },
        provider === "microsoft" ? "mcal" : "gcal"
      );
      throw error;
    }
  }

  removeEventsFromDeselectedCalendars(provider) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const calendarsTable = CALENDARS_TABLE_BY_PROVIDER[provider];
      if (!calendarsTable) throw new Error(`Unknown calendar provider: ${provider}`);
      this.db
        .prepare(
          `DELETE FROM calendar_events WHERE provider = ? AND calendar_id NOT IN (SELECT id FROM ${calendarsTable} WHERE is_selected = 1)`
        )
        .run(provider);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error removing events from deselected calendars",
        { error: error.message },
        provider === "microsoft" ? "mcal" : "gcal"
      );
      throw error;
    }
  }

  saveMicrosoftTokens(tokens) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        `INSERT INTO microsoft_calendar_tokens (microsoft_email, access_token, refresh_token, expires_at, scope)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(microsoft_email) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           updated_at = CURRENT_TIMESTAMP`
      );
      stmt.run(
        tokens.microsoft_email,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_at,
        tokens.scope
      );
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Microsoft tokens", { error: error.message }, "mcal");
      throw error;
    }
  }

  getMicrosoftTokensByEmail(email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare("SELECT * FROM microsoft_calendar_tokens WHERE microsoft_email = ?")
          .get(email) || null
      );
    } catch (error) {
      debugLogger.error(
        "Error getting Microsoft tokens by email",
        { error: error.message },
        "mcal"
      );
      throw error;
    }
  }

  getMicrosoftAccounts() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT microsoft_email AS email FROM microsoft_calendar_tokens ORDER BY created_at ASC"
        )
        .all();
    } catch (error) {
      debugLogger.error("Error getting Microsoft accounts", { error: error.message }, "mcal");
      throw error;
    }
  }

  removeMicrosoftAccount(email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        const calendarIds = this.db
          .prepare("SELECT id FROM microsoft_calendars WHERE account_email = ?")
          .all(email)
          .map((c) => c.id);
        if (calendarIds.length > 0) {
          const placeholders = calendarIds.map(() => "?").join(", ");
          this.db
            .prepare(
              `DELETE FROM calendar_events WHERE provider = 'microsoft' AND calendar_id IN (${placeholders})`
            )
            .run(...calendarIds);
        }
        this.db.prepare("DELETE FROM microsoft_calendars WHERE account_email = ?").run(email);
        this.db
          .prepare("DELETE FROM microsoft_calendar_tokens WHERE microsoft_email = ?")
          .run(email);
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error removing Microsoft account", { error: error.message }, "mcal");
      throw error;
    }
  }

  saveMicrosoftCalendars(calendars, accountEmail) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        `INSERT INTO microsoft_calendars (id, summary, background_color, account_email, is_primary)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           summary = excluded.summary,
           background_color = excluded.background_color,
           account_email = excluded.account_email,
           is_primary = excluded.is_primary`
      );
      for (const cal of calendars) {
        stmt.run(
          cal.id,
          cal.summary,
          cal.background_color || null,
          accountEmail,
          cal.is_primary ? 1 : 0
        );
      }
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Microsoft calendars", { error: error.message }, "mcal");
      throw error;
    }
  }

  applyMicrosoftPrimaryOnlyToSelection(primaryOnly) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "UPDATE microsoft_calendars SET is_selected = CASE WHEN ? = 1 THEN is_primary ELSE 1 END"
        )
        .run(primaryOnly ? 1 : 0);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error applying primary-only selection", { error: error.message }, "mcal");
      throw error;
    }
  }

  getSelectedMicrosoftCalendars() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM microsoft_calendars WHERE is_selected = 1").all();
    } catch (error) {
      debugLogger.error(
        "Error getting selected Microsoft calendars",
        { error: error.message },
        "mcal"
      );
      throw error;
    }
  }

  updateMicrosoftCalendarSyncToken(calendarId, syncToken, expiresAt) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "UPDATE microsoft_calendars SET sync_token = ?, sync_token_expires_at = ? WHERE id = ?"
        )
        .run(syncToken, expiresAt, calendarId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating sync token", { error: error.message }, "mcal");
      throw error;
    }
  }

  clearMicrosoftCalendarData() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        this.db.prepare("DELETE FROM calendar_events WHERE provider = 'microsoft'").run();
        this.db.prepare("DELETE FROM microsoft_calendars").run();
        this.db.prepare("DELETE FROM microsoft_calendar_tokens").run();
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing calendar data", { error: error.message }, "mcal");
      throw error;
    }
  }

  saveAppleCalendars(calendars) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((list) => {
        // Snapshots are complete: prune calendars removed from Calendar.app,
        // upsert the rest so created_at survives.
        if (list.length === 0) {
          this.db.prepare("DELETE FROM apple_calendars").run();
          return;
        }
        const placeholders = list.map(() => "?").join(", ");
        this.db
          .prepare(`DELETE FROM apple_calendars WHERE id NOT IN (${placeholders})`)
          .run(...list.map((cal) => cal.id));

        const stmt = this.db.prepare(
          `INSERT INTO apple_calendars (id, title, color, source_name)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             color = excluded.color,
             source_name = excluded.source_name`
        );
        for (const cal of list) {
          stmt.run(cal.id, cal.title, cal.color || null, cal.source_name || null);
        }
      });
      transaction(calendars);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Apple calendars", { error: error.message }, "acal");
      throw error;
    }
  }

  getAppleCalendars() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM apple_calendars").all();
    } catch (error) {
      debugLogger.error("Error getting Apple calendars", { error: error.message }, "acal");
      throw error;
    }
  }

  // Snapshots cover the full current/future window, so missing unreferenced
  // events can be removed while note-linked history is retained.
  replaceAppleCalendarEvents(events) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((list) => {
        // The helper snapshot only contains current/future events. Keep past or
        // rescheduled rows that are still referenced by meeting notes so those
        // notes retain their calendar metadata.
        this.db
          .prepare(
            `DELETE FROM calendar_events
             WHERE provider = 'apple'
               AND id NOT IN (
                 SELECT calendar_event_id
                 FROM notes
                 WHERE calendar_event_id IS NOT NULL AND deleted_at IS NULL
               )`
          )
          .run();
        if (list.length > 0) this.upsertCalendarEvents(list);
      });
      transaction(events);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error replacing Apple calendar events", { error: error.message }, "acal");
      throw error;
    }
  }

  clearAppleCalendarData() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        this.db.prepare("DELETE FROM calendar_events WHERE provider = 'apple'").run();
        this.db.prepare("DELETE FROM apple_calendars").run();
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing Apple calendar data", { error: error.message }, "acal");
      throw error;
    }
  }

  getMeetingsFolder(spaceId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare(
            "SELECT id FROM folders WHERE name = 'Meetings' AND is_default = 1 AND space_id = ?"
          )
          .get(spaceId ?? this.getPrivateSpaceId()) || null
      );
    } catch (error) {
      debugLogger.error("Error getting meetings folder", { error: error.message }, "gcal");
      throw error;
    }
  }

  updateNoteCloudId(id, cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("UPDATE notes SET cloud_id = ? WHERE id = ?").run(cloudId, id);
      return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
    } catch (error) {
      debugLogger.error("Error updating note cloud_id", { error: error.message }, "database");
      throw error;
    }
  }

  // Share bookkeeping, not a content edit — must not bump updated_at (which
  // would reorder note lists and churn sync last-write-wins comparisons).
  updateNoteShareState(id, { is_shared, share_token }) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (share_token !== undefined) {
        this.db
          .prepare("UPDATE notes SET is_shared = ?, share_token = ? WHERE id = ?")
          .run(is_shared, share_token, id);
      } else {
        this.db.prepare("UPDATE notes SET is_shared = ? WHERE id = ?").run(is_shared, id);
      }
      return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
    } catch (error) {
      debugLogger.error("Error updating note share state", { error: error.message }, "database");
      throw error;
    }
  }

  cleanup() {
    try {
      if (this.db) {
        try {
          this.db.close();
        } catch (closeError) {
          debugLogger.error("Error closing database", { error: closeError.message }, "database");
        }
        this.db = null;
      }
      const dbPath = path.join(
        app.getPath("userData"),
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db"
      );
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    } catch (error) {
      debugLogger.error("Error deleting database file", { error: error.message }, "database");
    }
  }
  getAgentConversationsWithPreview(limit = 50, offset = 0, includeArchived = false) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const archiveFilter = includeArchived
        ? "WHERE c.archived_at IS NOT NULL AND c.deleted_at IS NULL AND c.space_id IS NULL AND c.folder_id IS NULL"
        : "WHERE c.archived_at IS NULL AND c.deleted_at IS NULL AND c.space_id IS NULL AND c.folder_id IS NULL";
      return this.db
        .prepare(
          `SELECT c.id, c.title, c.created_at, c.updated_at, c.archived_at, c.cloud_id,
            COUNT(m.id) AS message_count,
            (SELECT content FROM agent_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT role FROM agent_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_role
          FROM agent_conversations c
          LEFT JOIN agent_messages m ON m.conversation_id = c.id
          ${archiveFilter}
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT ? OFFSET ?`
        )
        .all(limit, offset);
    } catch (error) {
      debugLogger.error(
        "Error getting agent conversations with preview",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  searchAgentConversations(query, limit = 20) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const pattern = `%${query}%`;
      return this.db
        .prepare(
          `SELECT DISTINCT c.id, c.title, c.created_at, c.updated_at, c.archived_at, c.cloud_id,
            COUNT(m.id) AS message_count,
            (SELECT content FROM agent_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT role FROM agent_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_role
          FROM agent_conversations c
          LEFT JOIN agent_messages m ON m.conversation_id = c.id
          LEFT JOIN agent_messages ms ON ms.conversation_id = c.id
          WHERE c.archived_at IS NULL AND c.deleted_at IS NULL
            AND c.space_id IS NULL AND c.folder_id IS NULL
            AND (c.title LIKE ? OR ms.content LIKE ?)
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT ?`
        )
        .all(pattern, pattern, limit);
    } catch (error) {
      debugLogger.error(
        "Error searching agent conversations",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  archiveAgentConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare(
          "UPDATE agent_conversations SET archived_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL"
        )
        .run(id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error("Error archiving agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  unarchiveAgentConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare(
          "UPDATE agent_conversations SET archived_at = NULL WHERE id = ? AND deleted_at IS NULL"
        )
        .run(id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error(
        "Error unarchiving agent conversation",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  updateAgentConversationCloudId(id, cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare("UPDATE agent_conversations SET cloud_id = ? WHERE id = ? AND deleted_at IS NULL")
        .run(cloudId, id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error(
        "Error updating agent conversation cloud_id",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  _normalizeEmail(email) {
    const trimmed = (email || "").trim().toLowerCase();
    return trimmed || null;
  }

  _findProfileByEmail(email) {
    const normalized = this._normalizeEmail(email);
    if (!normalized) return null;
    return this.db.prepare("SELECT * FROM speaker_profiles WHERE lower(email) = ?").get(normalized);
  }

  upsertSpeakerProfile(name, email, embeddingBuffer, profileId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedEmail = this._normalizeEmail(email);
      let existing = profileId
        ? this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId)
        : null;
      if (!existing && normalizedEmail) {
        existing = this._findProfileByEmail(normalizedEmail);
      }
      if (!existing) {
        existing = this.db
          .prepare("SELECT * FROM speaker_profiles WHERE display_name = ?")
          .get(name);
      }
      if (existing) {
        const stored = new Float32Array(
          existing.embedding.buffer,
          existing.embedding.byteOffset,
          existing.embedding.byteLength / 4
        );
        const incoming = new Float32Array(
          embeddingBuffer.buffer,
          embeddingBuffer.byteOffset,
          embeddingBuffer.byteLength / 4
        );
        const updated = new Float32Array(stored.length);
        for (let i = 0; i < stored.length; i++) {
          updated[i] = 0.3 * incoming[i] + 0.7 * stored[i];
        }
        const updatedBuf = Buffer.from(updated.buffer);
        const finalEmail = normalizedEmail || existing.email || null;
        this.db
          .prepare(
            "UPDATE speaker_profiles SET display_name = ?, email = ?, embedding = ?, sample_count = sample_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          )
          .run(name, finalEmail, updatedBuf, existing.id);
        const resolved = this.db
          .prepare("SELECT * FROM speaker_profiles WHERE id = ?")
          .get(existing.id);
        if (normalizedEmail) {
          const collision = this.db
            .prepare("SELECT * FROM speaker_profiles WHERE lower(email) = ? AND id != ?")
            .get(normalizedEmail, existing.id);
          if (collision) {
            return this.mergeSpeakerProfiles(resolved, collision);
          }
        }
        return resolved;
      }
      const result = this.db
        .prepare("INSERT INTO speaker_profiles (display_name, email, embedding) VALUES (?, ?, ?)")
        .run(name, normalizedEmail, embeddingBuffer);
      return this.db
        .prepare("SELECT * FROM speaker_profiles WHERE id = ?")
        .get(result.lastInsertRowid);
    } catch (error) {
      debugLogger.error("Error upserting speaker profile", { error: error.message }, "database");
      throw error;
    }
  }

  attachEmailToProfile(profileId, email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedEmail = this._normalizeEmail(email);
      const profile = this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId);
      if (!profile) throw new Error(`Speaker profile ${profileId} not found`);

      if (!normalizedEmail) {
        this.db
          .prepare(
            "UPDATE speaker_profiles SET email = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          )
          .run(profileId);
        return this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId);
      }

      const collision = this._findProfileByEmail(normalizedEmail);
      if (collision && collision.id !== profileId) {
        return this.mergeSpeakerProfiles(collision, profile);
      }

      this.db
        .prepare(
          "UPDATE speaker_profiles SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(normalizedEmail, profileId);
      return this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId);
    } catch (error) {
      debugLogger.error(
        "Error attaching email to speaker profile",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  mergeSpeakerProfiles(a, b) {
    const winner = (a.sample_count || 0) >= (b.sample_count || 0) ? a : b;
    const loser = winner === a ? b : a;

    const winnerEmb = new Float32Array(
      winner.embedding.buffer,
      winner.embedding.byteOffset,
      winner.embedding.byteLength / 4
    );
    const loserEmb = new Float32Array(
      loser.embedding.buffer,
      loser.embedding.byteOffset,
      loser.embedding.byteLength / 4
    );
    const wSamples = winner.sample_count || 1;
    const lSamples = loser.sample_count || 1;
    const total = wSamples + lSamples;
    const blended = new Float32Array(winnerEmb.length);
    for (let i = 0; i < winnerEmb.length; i++) {
      blended[i] = (winnerEmb[i] * wSamples + loserEmb[i] * lSamples) / total;
    }

    const finalEmail = winner.email || loser.email || null;
    const finalName = winner.display_name || loser.display_name;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE speaker_profiles SET display_name = ?, email = ?, embedding = ?, sample_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(finalName, finalEmail, Buffer.from(blended.buffer), total, winner.id);
      this.db
        .prepare(
          "UPDATE speaker_mappings SET profile_id = ?, display_name = ? WHERE profile_id = ?"
        )
        .run(winner.id, finalName, loser.id);
      this.db.prepare("DELETE FROM speaker_profiles WHERE id = ?").run(loser.id);
    });
    tx();

    return this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(winner.id);
  }

  getSpeakerProfiles(includeEmbedding = false) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const query = includeEmbedding
        ? "SELECT * FROM speaker_profiles"
        : `SELECT id, display_name, email, sample_count, created_at, updated_at
           FROM speaker_profiles`;
      return this.db.prepare(query).all();
    } catch (error) {
      debugLogger.error("Error getting speaker profiles", { error: error.message }, "database");
      throw error;
    }
  }

  setSpeakerMapping(noteId, speakerId, profileId, displayName) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "INSERT OR REPLACE INTO speaker_mappings (note_id, speaker_id, profile_id, display_name) VALUES (?, ?, ?, ?)"
        )
        .run(noteId, speakerId, profileId, displayName);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error setting speaker mapping", { error: error.message }, "database");
      throw error;
    }
  }

  getSpeakerMappings(noteId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM speaker_mappings WHERE note_id = ?").all(noteId);
    } catch (error) {
      debugLogger.error("Error getting speaker mappings", { error: error.message }, "database");
      throw error;
    }
  }

  saveNoteSpeakerEmbeddings(noteId, embeddings) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((entries) => {
        const stmt = this.db.prepare(
          "INSERT OR REPLACE INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)"
        );
        for (const [speakerId, buffer] of entries) {
          stmt.run(noteId, speakerId, buffer);
        }
      });
      transaction(Object.entries(embeddings));
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error saving note speaker embeddings",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getNoteSpeakerEmbeddings(noteId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM note_speaker_embeddings WHERE note_id = ?").all(noteId);
    } catch (error) {
      debugLogger.error(
        "Error getting note speaker embeddings",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getPendingNotes(spaceKind = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (spaceKind != null) {
        // 'team' also returns cloud-backed rows that just LEFT a team: their
        // scope retraction must push even when cloud backup is off (D6).
        const leftTeam =
          spaceKind === "team" ? " OR (n.left_team = 1 AND n.cloud_id IS NOT NULL)" : "";
        return this.db
          .prepare(
            `SELECT n.* FROM notes n JOIN spaces s ON s.id = n.space_id WHERE n.sync_status IN ('pending', 'error') AND n.deleted_at IS NULL AND (s.kind = ?${leftTeam})`
          )
          .all(spaceKind);
      }
      // 'error' rows retry too: a transient failure (e.g. one offline pass)
      // must not strand a note until its next local edit.
      return this.db
        .prepare(
          "SELECT * FROM notes WHERE sync_status IN ('pending', 'error') AND deleted_at IS NULL"
        )
        .all();
    } catch (error) {
      debugLogger.error("Error getting pending notes", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingNoteDeletes() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          `SELECT * FROM notes n
           WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL
             AND sync_status = 'pending'
             AND NOT EXISTS (
               SELECT 1 FROM optimistic_folder_delete_rows r
               WHERE r.entity_type = 'note' AND r.entity_id = n.id
             )`
        )
        .all();
    } catch (error) {
      debugLogger.error("Error getting pending note deletes", { error: error.message }, "database");
      throw error;
    }
  }

  getNoteByClientId(clientNoteId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare(
            `SELECT n.*,
               EXISTS (
                 SELECT 1 FROM optimistic_folder_delete_rows r
                 WHERE r.entity_type = 'note' AND r.entity_id = n.id
               ) AS folder_delete_pending
             FROM notes n
             WHERE n.client_note_id = ?`
          )
          .get(clientNoteId) || null
      );
    } catch (error) {
      debugLogger.error("Error getting note by client id", { error: error.message }, "database");
      throw error;
    }
  }

  upsertNoteFromCloud(cloudNote, localFolderId, localSpaceId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        const previousNote = this.db
          .prepare("SELECT id, transcript FROM notes WHERE client_note_id = ?")
          .get(cloudNote.client_note_id);
        // Sync must never replace non-empty local content/enhanced_content/
        // transcript with an empty cloud value (#1290, the #938 invariant).
        // The enhancement prompt/hash travel with enhanced_content.
        const stmt = this.db.prepare(`
        INSERT INTO notes (client_note_id, cloud_id, title, content, enhanced_content,
          enhancement_prompt, enhanced_at_content_hash, note_type, source_file,
          audio_duration_seconds, transcript, folder_id, space_id, participants, calendar_event_id,
          diarization_enabled, expected_speaker_count, updated_by_user_id, owner_user_id, sync_status, created_at, updated_at,
          cloud_updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?)
        ON CONFLICT(client_note_id) DO UPDATE SET
          cloud_id = excluded.cloud_id,
          title = excluded.title,
          content = CASE
            WHEN COALESCE(excluded.content, '') = '' AND COALESCE(content, '') <> ''
            THEN content ELSE excluded.content END,
          enhanced_content = CASE
            WHEN COALESCE(excluded.enhanced_content, '') = '' AND COALESCE(enhanced_content, '') <> ''
            THEN enhanced_content ELSE excluded.enhanced_content END,
          enhancement_prompt = CASE
            WHEN COALESCE(excluded.enhanced_content, '') = '' AND COALESCE(enhanced_content, '') <> ''
            THEN enhancement_prompt ELSE excluded.enhancement_prompt END,
          enhanced_at_content_hash = CASE
            WHEN COALESCE(excluded.enhanced_content, '') = '' AND COALESCE(enhanced_content, '') <> ''
            THEN enhanced_at_content_hash ELSE excluded.enhanced_at_content_hash END,
          transcript = CASE
            WHEN COALESCE(excluded.transcript, '') = '' AND COALESCE(transcript, '') <> ''
            THEN transcript ELSE excluded.transcript END,
          folder_id = excluded.folder_id,
          space_id = excluded.space_id,
          participants = COALESCE(excluded.participants, participants),
          calendar_event_id = COALESCE(excluded.calendar_event_id, calendar_event_id),
          diarization_enabled = COALESCE(excluded.diarization_enabled, diarization_enabled),
          expected_speaker_count = COALESCE(excluded.expected_speaker_count, expected_speaker_count),
          updated_by_user_id = COALESCE(excluded.updated_by_user_id, updated_by_user_id),
          owner_user_id = COALESCE(excluded.owner_user_id, owner_user_id),
          sync_status = 'synced',
          left_team = 0,
          updated_at = excluded.updated_at,
          cloud_updated_at = excluded.cloud_updated_at
      `);
        stmt.run(
          cloudNote.client_note_id,
          cloudNote.id,
          cloudNote.title,
          cloudNote.content,
          cloudNote.enhanced_content || null,
          cloudNote.enhancement_prompt || null,
          cloudNote.enhanced_at_content_hash || null,
          cloudNote.note_type || "personal",
          cloudNote.source_file || null,
          cloudNote.audio_duration_seconds || null,
          cloudNote.transcript || null,
          localFolderId,
          localSpaceId ?? this.getPrivateSpaceId(),
          cloudNote.participants || null,
          cloudNote.calendar_event_id || null,
          cloudNote.diarization_enabled ?? null,
          normalizeStoredSpeakerCount(cloudNote.expected_speaker_count),
          cloudNote.updated_by_user_id || null,
          cloudNote.user_id || null,
          cloudNote.created_at,
          cloudNote.updated_at,
          cloudNote.updated_at
        );
        let note = this.db
          .prepare("SELECT * FROM notes WHERE client_note_id = ?")
          .get(cloudNote.client_note_id);
        if (previousNote && note && note.transcript !== previousNote.transcript) {
          this.db
            .prepare("UPDATE notes SET transcript_revision = transcript_revision + 1 WHERE id = ?")
            .run(note.id);
          this._invalidateEncounterOutputsForNote(note.id, this._getNoteTranscriptToken(note.id));
          note = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id);
        }
        return note;
      });
      return transaction();
    } catch (error) {
      debugLogger.error("Error upserting note from cloud", { error: error.message }, "database");
      throw error;
    }
  }

  markNoteSynced(id, cloudId, cloudUpdatedAt = null, ownerUserId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // cloud_updated_at and owner_user_id are overwritten even with null: a
      // forked row that re-creates under a new cloud_id must not keep the old
      // note's base or its previous owner (a null base settles last-write-wins
      // once; a null owner fails closed until a pull records the real one).
      this.db
        .prepare(
          "UPDATE notes SET sync_status = 'synced', cloud_id = ?, left_team = 0, cloud_updated_at = ?, owner_user_id = ? WHERE id = ?"
        )
        .run(cloudId, cloudUpdatedAt, ownerUserId, id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error marking note synced", { error: error.message }, "database");
      throw error;
    }
  }

  // A row moved from a team space to Personal while its push was in flight
  // still owes the server a scope retraction for the returned team-side copy.
  _leftTeamDuringPush(snapshotSpaceId, currentSpaceId) {
    const kindOf = this.db.prepare("SELECT kind FROM spaces WHERE id = ?");
    return kindOf.get(snapshotSpaceId)?.kind === "team" &&
      kindOf.get(currentSpaceId)?.kind === "private"
      ? 1
      : 0;
  }

  // A create response arrives after an arbitrary network delay. Adopt it only
  // for the exact local identity that issued the request, and settle only when
  // every pushed field still matches that request's snapshot. A newer edit
  // adopts the cloud identity/base but remains pending. Response metadata is
  // assigned even when null because a fork may still carry the old identity's
  // base/owner. A purge forks the client_note_id, so the relocated Personal
  // row is never mutated. Partial migration creates explicitly opt out of
  // settling so a later full PATCH still delivers fields the POST omitted.
  acknowledgeNoteCreate(
    id,
    snapshot,
    cloudId,
    cloudUpdatedAt = null,
    ownerUserId = null,
    settleIfUnchanged = true
  ) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const expectedClientNoteId = snapshot?.client_note_id;
      if (!expectedClientNoteId || !cloudId) {
        return { success: false, outcome: "unresolved" };
      }

      return this.db.transaction(() => {
        const current = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
        if (!current || current.client_note_id !== expectedClientNoteId) {
          // If the same identity exists under an unexpected numeric row, do
          // not mutate it and do not authorize deletion of its cloud result.
          const identityStillExists = this.db
            .prepare("SELECT 1 FROM notes WHERE client_note_id = ?")
            .get(expectedClientNoteId);
          return {
            success: true,
            outcome: identityStillExists ? "unresolved" : "orphaned",
          };
        }

        if (current.cloud_id) {
          // Concurrent creates should be idempotent and return the same id.
          // A different id is ambiguous, though, so never replace the adopted
          // identity or authorize destructive cleanup in that case.
          return {
            success: true,
            outcome: current.cloud_id === cloudId ? "already-linked" : "unresolved",
          };
        }

        const unchanged = rowMatchesSnapshot(current, snapshot, NOTE_CREATE_ACK_FIELDS);

        // If a team note was moved to Personal while POST was in flight, the
        // returned cloud row still lives in the old team. Mark the attached
        // identity as owing a scope retraction even when backup is disabled.
        const leftTeam = this._leftTeamDuringPush(snapshot.space_id, current.space_id);

        if (unchanged && settleIfUnchanged) {
          this.db
            .prepare(
              `UPDATE notes
               SET sync_status = 'synced', cloud_id = ?, left_team = 0,
                   cloud_updated_at = ?,
                   owner_user_id = ?
               WHERE id = ? AND client_note_id = ? AND cloud_id IS NULL`
            )
            .run(cloudId, cloudUpdatedAt, ownerUserId, id, expectedClientNoteId);
          return { success: true, outcome: "synced" };
        }

        this.db
          .prepare(
            `UPDATE notes
             SET cloud_id = ?,
                 cloud_updated_at = ?,
                 owner_user_id = ?,
                 sync_status = 'pending',
                 left_team = CASE WHEN ? = 1 THEN 1 ELSE left_team END
             WHERE id = ? AND client_note_id = ? AND cloud_id IS NULL`
          )
          .run(cloudId, cloudUpdatedAt, ownerUserId, leftTeam, id, expectedClientNoteId);
        return { success: true, outcome: "pending" };
      })();
    } catch (error) {
      debugLogger.error("Error acknowledging note create", { error: error.message }, "database");
      throw error;
    }
  }

  // A PATCH response belongs to both the local client identity and the cloud
  // identity that issued it. Purge/revocation forks in place, so numeric id
  // alone is never sufficient. An exact pushed snapshot settles; newer work
  // on the same identity remains pending while advancing its server base.
  markNoteSyncedIfUnchanged(
    id,
    snapshot,
    expectedCloudId,
    cloudUpdatedAt = null,
    ownerUserId = null
  ) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!snapshot?.client_note_id || !expectedCloudId) {
        return { success: false, outcome: "identity-changed", changes: 0 };
      }

      return this.db.transaction(() => {
        const current = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
        if (
          !current ||
          current.client_note_id !== snapshot.client_note_id ||
          current.cloud_id !== expectedCloudId
        ) {
          return { success: true, outcome: "identity-changed", changes: 0 };
        }

        const unchanged = rowMatchesSnapshot(current, snapshot, NOTE_PATCH_ACK_FIELDS);
        const nextCloudUpdatedAt = (() => {
          if (!cloudUpdatedAt) return current.cloud_updated_at;
          if (!current.cloud_updated_at) return cloudUpdatedAt;
          const incomingMs = Date.parse(cloudUpdatedAt);
          const currentMs = Date.parse(current.cloud_updated_at);
          if (Number.isFinite(incomingMs) && Number.isFinite(currentMs)) {
            return incomingMs > currentMs ? cloudUpdatedAt : current.cloud_updated_at;
          }
          return cloudUpdatedAt > current.cloud_updated_at
            ? cloudUpdatedAt
            : current.cloud_updated_at;
        })();

        if (unchanged) {
          const result = this.db
            .prepare(
              `UPDATE notes
               SET sync_status = 'synced', left_team = 0,
                   cloud_updated_at = ?,
                   owner_user_id = COALESCE(?, owner_user_id)
               WHERE id = ? AND client_note_id = ? AND cloud_id = ?`
            )
            .run(nextCloudUpdatedAt, ownerUserId, id, snapshot.client_note_id, expectedCloudId);
          return { success: true, outcome: "synced", changes: result.changes };
        }

        // The delivered PATCH still advances this identity's base; otherwise
        // the next push would 409 against this device's own write. An older
        // response arriving out of order must not regress a newer base. Never
        // run this update for an identity/cloud mismatch.
        this.db
          .prepare(
            `UPDATE notes
             SET cloud_updated_at = ?,
                 owner_user_id = COALESCE(?, owner_user_id)
             WHERE id = ? AND client_note_id = ? AND cloud_id = ?`
          )
          .run(nextCloudUpdatedAt, ownerUserId, id, snapshot.client_note_id, expectedCloudId);
        return { success: true, outcome: "pending", changes: 0 };
      })();
    } catch (error) {
      debugLogger.error(
        "Error marking note synced if unchanged",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Copies the cloud owner onto a local row without touching updated_at or
  // sync_status: an unchanged note skips the last-write-wins upsert but must
  // still gain its owner (the owner_user_id backfill relies on this).
  setNoteOwnerFromCloud(id, ownerUserId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("UPDATE notes SET owner_user_id = ? WHERE id = ?").run(ownerUserId, id);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error setting note owner from cloud",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Live cloud-backed team notes whose owner is still unknown — the UI fails
  // closed on them, so a snapshot backfill runs while any remain.
  countTeamNotesMissingOwner() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM notes n
             JOIN spaces s ON s.id = n.space_id
            WHERE s.kind = 'team' AND n.deleted_at IS NULL
              AND n.cloud_id IS NOT NULL AND n.owner_user_id IS NULL`
        )
        .get();
      return row?.count ?? 0;
    } catch (error) {
      debugLogger.error(
        "Error counting team notes missing owner",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Records the server revision the user knowingly overwrites ("Keep editing"
  // on the conflict banner). Deliberately leaves updated_at and sync_status
  // alone — the local edit stays pending and pushes with the advanced base.
  setNoteCloudBase(id, cloudUpdatedAt) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("UPDATE notes SET cloud_updated_at = ? WHERE id = ?").run(cloudUpdatedAt, id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error setting note cloud base", { error: error.message }, "database");
      throw error;
    }
  }

  markNoteSyncError(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("UPDATE notes SET sync_status = 'error' WHERE id = ?").run(id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error marking note sync error", { error: error.message }, "database");
      throw error;
    }
  }

  // A denied optimistic delete leaves the server row untouched. Revive the
  // local tombstone in place so its numeric id, chats and speaker rows survive;
  // the deliberately old timestamp lets the mandatory snapshot pull replace
  // it with the authoritative cloud row.
  restoreNoteAfterDeniedDelete(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare(
          `UPDATE notes
           SET deleted_at = NULL, sync_status = 'synced',
               updated_at = '1970-01-01 00:00:00'
           WHERE id = ? AND deleted_at IS NOT NULL`
        )
        .run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error(
        "Error restoring note after denied delete",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Confirmed cloud deletes and access revocation retire note chats; denied
  // deletes use the restore method above instead.
  hardDeleteNote(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db.transaction(() => {
        this._retireConversationsWhere("note_id = ?", [id], {
          scrubSyncedMessages: true,
        });
        this._deleteSpeakerRowsForNotes("SELECT id FROM notes WHERE id = ?", id);
        return this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
      })();
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error hard deleting note", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingFolders(spaceKind = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (spaceKind != null) {
        // 'team' also returns cloud-backed rows that just LEFT a team: their
        // scope retraction must push even when cloud backup is off (D6).
        const leftTeam =
          spaceKind === "team" ? " OR (f.left_team = 1 AND f.cloud_id IS NOT NULL)" : "";
        return this.db
          .prepare(
            `SELECT f.* FROM folders f JOIN spaces s ON s.id = f.space_id WHERE f.sync_status = 'pending' AND f.deleted_at IS NULL AND (s.kind = ?${leftTeam})`
          )
          .all(spaceKind);
      }
      return this.db
        .prepare("SELECT * FROM folders WHERE sync_status = 'pending' AND deleted_at IS NULL")
        .all();
    } catch (error) {
      debugLogger.error("Error getting pending folders", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingFolderDeletes() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          `SELECT * FROM folders f
           WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL
             AND (sync_status = 'pending' OR EXISTS (
               SELECT 1 FROM optimistic_folder_delete_rows r
               WHERE r.folder_id = f.id AND r.entity_type = 'folder'
             ))`
        )
        .all();
    } catch (error) {
      debugLogger.error(
        "Error getting pending folder deletes",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // A folder DELETE permission denial means the server changed nothing.
  // Restore only rows hidden by that exact optimistic operation; independent
  // note/conversation tombstones were never journaled and remain deleted.
  restoreFolderAfterDeniedDelete(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.transaction(() => {
        const journalRows = this.db
          .prepare(
            `SELECT * FROM optimistic_folder_delete_rows
             WHERE folder_id = ?
             ORDER BY CASE entity_type
               WHEN 'folder' THEN 0 WHEN 'note' THEN 1 ELSE 2 END, entity_id`
          )
          .all(id);
        const folderState = journalRows.find((row) => row.entity_type === "folder");
        if (!folderState) {
          return { success: false, id, error: "Folder delete rollback not found" };
        }

        const folder = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
        if (!folder) {
          return { success: false, id, error: "Folder row is missing" };
        }
        const collision = this.db
          .prepare(
            "SELECT id FROM folders WHERE name = ? AND space_id = ? AND deleted_at IS NULL AND id != ?"
          )
          .get(folder.name, folder.space_id, id);
        if (collision) {
          return {
            success: false,
            id,
            reason: "name-taken",
            error: "Folder name is no longer available",
          };
        }

        const noteStates = journalRows.filter((row) => row.entity_type === "note");
        const conversationStates = journalRows.filter((row) => row.entity_type === "conversation");
        const noteExists = this.db.prepare("SELECT 1 FROM notes WHERE id = ?");
        const conversationExists = this.db.prepare(
          "SELECT 1 FROM agent_conversations WHERE id = ?"
        );
        if (noteStates.some((row) => !noteExists.get(row.entity_id))) {
          return { success: false, id, error: "A folder note row is missing" };
        }
        if (conversationStates.some((row) => !conversationExists.get(row.entity_id))) {
          return { success: false, id, error: "A folder conversation row is missing" };
        }

        this.db
          .prepare(
            `UPDATE folders
             SET deleted_at = ?, sync_status = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(
            folderState.original_deleted_at,
            folderState.original_sync_status,
            folderState.original_updated_at,
            id
          );
        const restoreNote = this.db.prepare(
          `UPDATE notes
           SET deleted_at = ?, sync_status = ?, updated_at = ?
           WHERE id = ?`
        );
        for (const state of noteStates) {
          restoreNote.run(
            state.original_deleted_at,
            state.original_sync_status,
            state.original_updated_at,
            state.entity_id
          );
        }
        const restoreConversation = this.db.prepare(
          `UPDATE agent_conversations
           SET deleted_at = ?, sync_status = ?, updated_at = ?
           WHERE id = ?`
        );
        for (const state of conversationStates) {
          restoreConversation.run(
            state.original_deleted_at,
            state.original_sync_status,
            state.original_updated_at,
            state.entity_id
          );
        }

        this.db.prepare("DELETE FROM optimistic_folder_delete_rows WHERE folder_id = ?").run(id);
        const getNote = this.db.prepare("SELECT * FROM notes WHERE id = ?");
        return {
          success: true,
          id,
          folder: this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id),
          notes: noteStates.map((state) => getNote.get(state.entity_id)),
          conversationIds: conversationStates.map((state) => state.entity_id),
        };
      })();
    } catch (error) {
      debugLogger.error(
        "Error restoring folder after denied delete",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  hardDeleteFolder(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this.db.prepare("SELECT name FROM folders WHERE id = ?").get(id);
      if (!folder) return { success: false, id, error: "Folder not found" };
      const childNotes = "SELECT id FROM notes WHERE folder_id = ?";
      const heldNotes =
        "SELECT entity_id FROM optimistic_folder_delete_rows WHERE folder_id = ? AND entity_type = 'note'";
      const heldConversations =
        "SELECT entity_id FROM optimistic_folder_delete_rows WHERE folder_id = ? AND entity_type = 'conversation'";
      const noteIds = this.db
        .prepare(childNotes)
        .all(id)
        .map((row) => row.id);
      const result = this.db.transaction(() => {
        // Note chats normally have note_id only. Retire them while the child
        // rows still identify which chats belong to this folder cleanup, then
        // handle independently folder-scoped conversations.
        this._retireConversationsWhere(`note_id IN (${childNotes})`, [id], {
          scrubSyncedMessages: true,
        });
        // The journal is the authoritative ownership record for the
        // optimistic operation. Use it as well as current parent columns so a
        // late stale write cannot strand a held row by changing its scope.
        this.db
          .prepare(
            `DELETE FROM agent_messages
             WHERE conversation_id IN (${heldConversations})`
          )
          .run(id);
        this.db
          .prepare(
            `DELETE FROM agent_conversations
             WHERE cloud_id IS NULL AND id IN (${heldConversations})`
          )
          .run(id);
        this.db
          .prepare(
            `UPDATE agent_conversations
             SET deleted_at = COALESCE(deleted_at, datetime('now')),
                 sync_status = 'pending', updated_at = datetime('now')
             WHERE cloud_id IS NOT NULL AND id IN (${heldConversations})`
          )
          .run(id);
        this._deleteSpeakerRowsForNotes(childNotes, id);
        this._deleteSpeakerRowsForNotes(heldNotes, id);
        this.db.prepare(`DELETE FROM notes WHERE id IN (${heldNotes})`).run(id);
        this.db.prepare(`DELETE FROM notes WHERE id IN (${childNotes})`).run(id);
        this._retireConversationsWhere("folder_id = ?", [id], {
          scrubSyncedMessages: true,
        });
        // Held cloud chats now become ordinary pending cloud deletes. Rows
        // tombstoned before the folder action were never journaled and keep
        // their existing pending state.
        const deleted = this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
        this.db.prepare("DELETE FROM optimistic_folder_delete_rows WHERE folder_id = ?").run(id);
        return deleted;
      })();
      return { success: result.changes > 0, id, noteIds, name: folder?.name ?? null };
    } catch (error) {
      debugLogger.error("Error hard deleting folder", { error: error.message }, "database");
      throw error;
    }
  }

  // The folder's server row moved into a team this user can't access
  // (access_removed stub or a team_access_revoked push rejection). Clean
  // server-owned child notes are no longer ours to keep — the server retains
  // them; dirty or never-synced children are the only surviving content
  // (plan §7.2): they relocate to the private space with forked identities so
  // the next push re-creates them as personal rows. The folder row itself
  // survives in the private space only when it carries unpushed changes
  // (preserveFolder), renamed "name (2)" on a collision; otherwise it is
  // deleted.
  relocateRevokedFolder(id, privateSpaceId, preserveFolder = false) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // If access revocation overtakes an optimistic delete, first recover the
      // held rows so the normal dirty-note preservation rules can classify
      // them from their real pre-delete state.
      const held = this.db
        .prepare(
          "SELECT 1 FROM optimistic_folder_delete_rows WHERE folder_id = ? AND entity_type = 'folder'"
        )
        .get(id);
      if (held) {
        const rollback = this.restoreFolderAfterDeniedDelete(id);
        if (!rollback.success) return rollback;
      }

      const folder = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
      if (!folder) return { success: false, error: "Folder not found" };
      const serverOwnedChildren =
        "SELECT id FROM notes WHERE folder_id = ? AND (deleted_at IS NOT NULL OR (sync_status = 'synced' AND cloud_id IS NOT NULL))";
      const result = this.db.transaction(() => {
        const preservedIds = this.db
          .prepare(
            "SELECT id FROM notes WHERE folder_id = ? AND deleted_at IS NULL AND (sync_status != 'synced' OR cloud_id IS NULL)"
          )
          .all(id)
          .map((row) => row.id);
        const deletedNoteIds = this.db
          .prepare(serverOwnedChildren)
          .all(id)
          .map((row) => row.id);
        // Note chats have no folder_id, so retire them before deleting the
        // server-owned notes that prove they belonged to this revoked folder.
        this._retireConversationsWhere(`note_id IN (${serverOwnedChildren})`, [id], {
          scrubSyncedMessages: true,
        });
        this._deleteSpeakerRowsForNotes(serverOwnedChildren, id);
        this.db.prepare(`DELETE FROM notes WHERE id IN (${serverOwnedChildren})`).run(id);
        const relocateNote = this.db.prepare(
          "UPDATE notes SET space_id = ?, folder_id = ?, client_note_id = ?, cloud_id = NULL, cloud_updated_at = NULL, owner_user_id = NULL, updated_by_user_id = NULL, sync_status = 'pending', left_team = 0, is_shared = 0, share_token = NULL, updated_at = datetime('now') WHERE id = ?"
        );
        const detachNoteConversation = this.db.prepare(
          "UPDATE agent_conversations SET space_id = NULL, folder_id = NULL WHERE note_id = ?"
        );
        for (const noteId of preservedIds) {
          relocateNote.run(privateSpaceId, preserveFolder ? id : null, randomUUID(), noteId);
          // Note-scoped chats follow a preserved dirty note, not the revoked
          // team container. Folder-only chats are handled separately below.
          detachNoteConversation.run(noteId);
        }
        let preservedFolder = null;
        if (preserveFolder) {
          let name = folder.name;
          const taken = this.db.prepare(
            "SELECT 1 FROM folders WHERE name = ? AND space_id = ? AND deleted_at IS NULL AND id != ?"
          );
          for (let n = 2; taken.get(name, privateSpaceId, id); n++) {
            name = `${folder.name} (${n})`;
          }
          this.db
            .prepare(
              "UPDATE folders SET space_id = ?, name = ?, client_folder_id = ?, cloud_id = NULL, sync_status = 'pending', left_team = 0, updated_at = datetime('now') WHERE id = ?"
            )
            .run(privateSpaceId, name, randomUUID(), id);
          preservedFolder = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
          // Folder-scoped chats follow the preserved folder into the private
          // space so their space ref doesn't dangle on the revoked space.
          this.db
            .prepare("UPDATE agent_conversations SET space_id = ? WHERE folder_id = ?")
            .run(privateSpaceId, id);
        } else {
          this._retireConversationsWhere("folder_id = ?", [id], {
            scrubSyncedMessages: true,
          });
          this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
        }
        const getNote = this.db.prepare("SELECT * FROM notes WHERE id = ?");
        return {
          folder: preservedFolder,
          relocatedNotes: preservedIds.map((noteId) => getNote.get(noteId)),
          deletedNoteIds,
        };
      })();
      return { success: true, folderName: folder.name, ...result };
    } catch (error) {
      debugLogger.error("Error relocating revoked folder", { error: error.message }, "database");
      throw error;
    }
  }

  getFolderByClientId(clientFolderId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db.prepare("SELECT * FROM folders WHERE client_folder_id = ?").get(clientFolderId) ||
        null
      );
    } catch (error) {
      debugLogger.error("Error getting folder by client id", { error: error.message }, "database");
      throw error;
    }
  }

  upsertFolderFromCloud(cloudFolder, localSpaceId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const spaceId = localSpaceId ?? this.getPrivateSpaceId();
      const updatedAt = cloudFolder.updated_at || cloudFolder.created_at;
      const stmt = this.db.prepare(`
        INSERT INTO folders (client_folder_id, cloud_id, name, is_default, sort_order, space_id, sync_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'synced', ?, ?)
        ON CONFLICT(client_folder_id) DO UPDATE SET
          cloud_id = excluded.cloud_id,
          name = excluded.name,
          sort_order = excluded.sort_order,
          space_id = excluded.space_id,
          sync_status = 'synced',
          left_team = 0,
          updated_at = excluded.updated_at
      `);
      try {
        stmt.run(
          cloudFolder.client_folder_id,
          cloudFolder.id,
          cloudFolder.name,
          cloudFolder.is_default ? 1 : 0,
          cloudFolder.sort_order || 0,
          spaceId,
          cloudFolder.created_at,
          updatedAt
        );
      } catch (err) {
        // A live same-named folder already exists in this space (partial unique
        // index idx_folders_space_name is a different conflict target than the
        // client_folder_id upsert). Converge on the existing folder by adopting
        // the cloud row's identity instead of wedging the pull.
        // Match the error code, not the message text (which SQLite could
        // reformat); the column check keeps client_folder_id collisions on
        // the rethrow path.
        if (err.code !== "SQLITE_CONSTRAINT_UNIQUE" || !err.message.includes("folders.space_id")) {
          throw err;
        }
        const existing = this.db
          .prepare("SELECT id FROM folders WHERE space_id = ? AND name = ? AND deleted_at IS NULL")
          .get(spaceId, cloudFolder.name);
        if (!existing) throw err;
        this.db.transaction(() => {
          const holder = this.db
            .prepare("SELECT id FROM folders WHERE client_folder_id = ? AND id != ?")
            .get(cloudFolder.client_folder_id, existing.id);
          // A different local row already tracked this cloud folder (rename
          // collision via the DO UPDATE branch) — fork it so the winner can
          // take the cloud identity without violating the client id index.
          if (holder) this.forkFolderIdentity(holder.id);
          this.db
            .prepare(
              "UPDATE folders SET client_folder_id = ?, cloud_id = ?, sort_order = ?, sync_status = 'synced', left_team = 0, updated_at = ? WHERE id = ?"
            )
            .run(
              cloudFolder.client_folder_id,
              cloudFolder.id,
              cloudFolder.sort_order || 0,
              updatedAt,
              existing.id
            );
        })();
      }
      return this.db
        .prepare("SELECT * FROM folders WHERE client_folder_id = ?")
        .get(cloudFolder.client_folder_id);
    } catch (error) {
      debugLogger.error("Error upserting folder from cloud", { error: error.message }, "database");
      throw error;
    }
  }

  markFolderSynced(id, cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare(
          "UPDATE folders SET sync_status = 'synced', cloud_id = ?, left_team = 0 WHERE id = ?"
        )
        .run(cloudId, id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error marking folder synced", { error: error.message }, "database");
      throw error;
    }
  }

  // A folder create or pull-side name adoption may return a canonical client
  // identity different from the local one. Adopt it only while both identities
  // captured before the request still occupy this numeric row. A newer rename
  // or move adopts the cloud identity but remains pending for its follow-up
  // PATCH; an in-place revocation fork is never touched.
  acknowledgeFolderCreate(
    id,
    snapshot,
    expectedCloudId,
    responseClientFolderId,
    cloudId,
    cloudUpdatedAt = null
  ) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (
        !snapshot?.client_folder_id ||
        (expectedCloudId !== null && typeof expectedCloudId !== "string") ||
        !responseClientFolderId ||
        !cloudId
      ) {
        return { success: false, outcome: "unresolved", changes: 0 };
      }

      return this.db.transaction(() => {
        const current = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
        if (
          !current ||
          current.client_folder_id !== snapshot.client_folder_id ||
          current.cloud_id !== expectedCloudId
        ) {
          return { success: true, outcome: "identity-changed", changes: 0 };
        }
        if (expectedCloudId !== null && expectedCloudId !== cloudId) {
          return { success: true, outcome: "unresolved", changes: 0 };
        }
        const responseIdentityHolder = this.db
          .prepare("SELECT id FROM folders WHERE client_folder_id = ? AND id != ?")
          .get(responseClientFolderId, id);
        if (responseIdentityHolder) {
          return { success: true, outcome: "unresolved", changes: 0 };
        }

        const unchanged = rowMatchesSnapshot(current, snapshot, FOLDER_ACK_FIELDS);
        const leftTeam = this._leftTeamDuringPush(snapshot.space_id, current.space_id);

        if (unchanged) {
          const result = this.db
            .prepare(
              `UPDATE folders
               SET client_folder_id = ?, cloud_id = ?, sync_status = 'synced',
                   left_team = 0, updated_at = COALESCE(?, updated_at)
               WHERE id = ? AND client_folder_id = ? AND cloud_id IS ?`
            )
            .run(
              responseClientFolderId,
              cloudId,
              cloudUpdatedAt,
              id,
              snapshot.client_folder_id,
              expectedCloudId
            );
          return { success: true, outcome: "synced", changes: result.changes };
        }

        const result = this.db
          .prepare(
            `UPDATE folders
             SET client_folder_id = ?, cloud_id = ?, sync_status = 'pending',
                 left_team = CASE WHEN ? = 1 THEN 1 ELSE left_team END
             WHERE id = ? AND client_folder_id = ? AND cloud_id IS ?`
          )
          .run(
            responseClientFolderId,
            cloudId,
            leftTeam,
            id,
            snapshot.client_folder_id,
            expectedCloudId
          );
        return { success: true, outcome: "pending", changes: result.changes };
      })();
    } catch (error) {
      debugLogger.error("Error acknowledging folder create", { error: error.message }, "database");
      throw error;
    }
  }

  // Folder PATCH twin of the guarded note acknowledgement. Bind the response
  // to both client and cloud identity and compare every pushed field so a
  // same-second rename or an in-place revocation fork cannot be settled.
  markFolderSyncedIfUnchanged(id, snapshot, expectedCloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!snapshot?.client_folder_id || !expectedCloudId) {
        return { success: false, outcome: "identity-changed", changes: 0 };
      }
      return this.db.transaction(() => {
        const current = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
        if (
          !current ||
          current.client_folder_id !== snapshot.client_folder_id ||
          current.cloud_id !== expectedCloudId
        ) {
          return { success: true, outcome: "identity-changed", changes: 0 };
        }
        const unchanged = rowMatchesSnapshot(current, snapshot, FOLDER_ACK_FIELDS);
        if (!unchanged) {
          return { success: true, outcome: "pending", changes: 0 };
        }
        const result = this.db
          .prepare(
            `UPDATE folders
             SET sync_status = 'synced', left_team = 0
             WHERE id = ? AND client_folder_id = ? AND cloud_id = ?`
          )
          .run(id, snapshot.client_folder_id, expectedCloudId);
        return { success: true, outcome: "synced", changes: result.changes };
      })();
    } catch (error) {
      debugLogger.error(
        "Error marking folder synced if unchanged",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // A folder whose server row moved into a scope this user can no longer
  // write gets a fresh identity, so the next push creates it as a new
  // personal folder instead of PATCHing the inaccessible row forever.
  forkFolderIdentity(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare(
          "UPDATE folders SET client_folder_id = ?, cloud_id = NULL, sync_status = 'pending', left_team = 0 WHERE id = ?"
        )
        .run(randomUUID(), id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error("Error forking folder identity", { error: error.message }, "database");
      throw error;
    }
  }

  getFolderIdMap() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM folders WHERE deleted_at IS NULL").all();
    } catch (error) {
      debugLogger.error("Error getting folder id map", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingConversations() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // The cloud conversation contract has no space/folder scope yet.
      // Keep container chats local so another device cannot pull them as
      // global chats. Cloud-backed tombstones still use the delete queue.
      return this.db
        .prepare(
          "SELECT * FROM agent_conversations WHERE sync_status = 'pending' AND deleted_at IS NULL AND space_id IS NULL AND folder_id IS NULL"
        )
        .all();
    } catch (error) {
      debugLogger.error(
        "Error getting pending conversations",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getPendingConversationDeletes() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          `SELECT * FROM agent_conversations c
           WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL
             AND sync_status = 'pending'
             AND NOT EXISTS (
               SELECT 1 FROM optimistic_folder_delete_rows r
               WHERE r.entity_type = 'conversation' AND r.entity_id = c.id
             )`
        )
        .all();
    } catch (error) {
      debugLogger.error(
        "Error getting pending conversation deletes",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getConversationByClientId(clientId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare(
            `SELECT c.*,
               EXISTS (
                 SELECT 1 FROM optimistic_folder_delete_rows r
                 WHERE r.entity_type = 'conversation' AND r.entity_id = c.id
               ) AS folder_delete_pending
             FROM agent_conversations c
             WHERE c.client_conversation_id = ?`
          )
          .get(clientId) || null
      );
    } catch (error) {
      debugLogger.error(
        "Error getting conversation by client id",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  upsertConversationFromCloud(cloudConv, messages) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        // A local tombstone represents an unacknowledged delete. A newer live
        // cloud revision must not cancel that intent or restore message bodies
        // while the delete retries. Match by cloud id as a fallback for legacy
        // rows without a client_conversation_id.
        let existing = null;
        if (cloudConv.client_conversation_id != null) {
          existing = this.db
            .prepare("SELECT * FROM agent_conversations WHERE client_conversation_id = ?")
            .get(cloudConv.client_conversation_id);
        }
        if (!existing && cloudConv.id != null) {
          existing = this.db
            .prepare("SELECT * FROM agent_conversations WHERE cloud_id = ?")
            .get(cloudConv.id);
        }
        if (existing?.deleted_at) return existing;

        const convStmt = this.db.prepare(`
          INSERT INTO agent_conversations (client_conversation_id, cloud_id, title, note_id, sync_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'synced', ?, ?)
          ON CONFLICT(client_conversation_id) DO UPDATE SET
            cloud_id = excluded.cloud_id,
            title = excluded.title,
            note_id = excluded.note_id,
            sync_status = 'synced',
            updated_at = excluded.updated_at
        `);
        convStmt.run(
          cloudConv.client_conversation_id ?? null,
          cloudConv.id ?? null,
          cloudConv.title ?? "Untitled",
          cloudConv.note_id ?? null,
          cloudConv.created_at ?? new Date().toISOString(),
          cloudConv.updated_at ?? new Date().toISOString()
        );
        const conv = this.db
          .prepare("SELECT * FROM agent_conversations WHERE client_conversation_id = ?")
          .get(cloudConv.client_conversation_id);
        this.db.prepare("DELETE FROM agent_messages WHERE conversation_id = ?").run(conv.id);
        if (messages && messages.length > 0) {
          const msgStmt = this.db.prepare(
            "INSERT INTO agent_messages (conversation_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
          );
          for (const msg of messages) {
            msgStmt.run(
              conv.id,
              msg.role ?? "user",
              msg.content ?? "",
              msg.metadata ? JSON.stringify(msg.metadata) : null,
              msg.created_at ?? new Date().toISOString()
            );
          }
        }
        return conv;
      });
      return transaction();
    } catch (error) {
      debugLogger.error(
        "Error upserting conversation from cloud",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  markConversationSynced(id, cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare(
          `UPDATE agent_conversations
           SET cloud_id = COALESCE(cloud_id, ?),
               sync_status = CASE WHEN deleted_at IS NULL THEN 'synced' ELSE 'pending' END
           WHERE id = ?`
        )
        .run(cloudId, id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error("Error marking conversation synced", { error: error.message }, "database");
      throw error;
    }
  }

  hardDeleteConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("DELETE FROM agent_messages WHERE conversation_id = ?").run(id);
      const result = this.db.prepare("DELETE FROM agent_conversations WHERE id = ?").run(id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error("Error hard deleting conversation", { error: error.message }, "database");
      throw error;
    }
  }

  getPendingTranscriptions() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM transcriptions WHERE sync_status = 'pending' AND deleted_at IS NULL"
        )
        .all();
    } catch (error) {
      debugLogger.error(
        "Error getting pending transcriptions",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getPendingTranscriptionDeletes() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM transcriptions WHERE deleted_at IS NOT NULL AND cloud_id IS NOT NULL AND sync_status = 'pending'"
        )
        .all();
    } catch (error) {
      debugLogger.error(
        "Error getting pending transcription deletes",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  hardDeleteTranscription(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db.prepare("DELETE FROM transcriptions WHERE id = ?").run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error hard deleting transcription", { error: error.message }, "database");
      throw error;
    }
  }

  getTranscriptionByClientId(clientId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare("SELECT * FROM transcriptions WHERE client_transcription_id = ?")
          .get(clientId) || null
      );
    } catch (error) {
      debugLogger.error(
        "Error getting transcription by client id",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  upsertTranscriptionFromCloud(cloudTranscription) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(`
        INSERT INTO transcriptions (client_transcription_id, cloud_id, text, raw_text, status, sync_status, created_at)
        VALUES (?, ?, ?, ?, ?, 'synced', ?)
        ON CONFLICT(client_transcription_id) DO UPDATE SET
          cloud_id = excluded.cloud_id,
          text = excluded.text,
          raw_text = excluded.raw_text,
          status = excluded.status,
          sync_status = 'synced'
      `);
      stmt.run(
        cloudTranscription.client_transcription_id,
        cloudTranscription.id,
        cloudTranscription.text ?? "",
        cloudTranscription.raw_text || null,
        cloudTranscription.status || "completed",
        cloudTranscription.created_at
      );
      return this.db
        .prepare("SELECT * FROM transcriptions WHERE client_transcription_id = ?")
        .get(cloudTranscription.client_transcription_id);
    } catch (error) {
      debugLogger.error(
        "Error upserting transcription from cloud",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  markTranscriptionSynced(id, cloudId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("UPDATE transcriptions SET sync_status = 'synced', cloud_id = ? WHERE id = ?")
        .run(cloudId, id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error marking transcription synced", { error: error.message }, "database");
      throw error;
    }
  }

  getNotesWithUnmappedSpeakers() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          `SELECT DISTINCT nse.note_id
          FROM note_speaker_embeddings nse
          LEFT JOIN speaker_mappings sm ON nse.note_id = sm.note_id AND nse.speaker_id = sm.speaker_id
          WHERE sm.note_id IS NULL`
        )
        .all()
        .map((row) => row.note_id);
    } catch (error) {
      debugLogger.error(
        "Error getting notes with unmapped speakers",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  removeSpeakerMapping(noteId, speakerId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db
        .prepare("DELETE FROM speaker_mappings WHERE note_id = ? AND speaker_id = ?")
        .run(noteId, speakerId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error removing speaker mapping", { error: error.message }, "database");
      throw error;
    }
  }
}

module.exports = DatabaseManager;
