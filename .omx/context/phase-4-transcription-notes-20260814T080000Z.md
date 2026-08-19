# Autopilot Context: Slice 4 Encounter Transcription and Notes

## Task statement

Implement Slice 4 for the local-first OpenWhispr build: connect local encounters to recording, transcription, diarization, and clinical note generation without introducing cloud dependencies or a second UI shell.

## Desired outcome

- Starting an encounter creates or reuses its local note and enters the existing meeting recording/transcription flow.
- The encounter preserves transcript text and speaker labels locally, including in-person and telehealth recordings.
- Completed encounters can generate and save both a readable summary and a SOAP-format note using the configured offline/local or explicitly retained BYOK intelligence provider.
- The encounter card and note view expose clear recording, processing, ready, and failure states with retry-safe behavior.
- Existing quick dictation, notes, local models, diarization, and offline operation remain intact.

## Scope boundaries

In scope: encounter-to-recording lifecycle wiring, transcript/note association, local summary/SOAP generation orchestration, encounter detail/status UI, persistence and retry behavior, focused tests, and safe local/BYOK provider routing.

Out of scope: new model training, replacing the existing transcription or diarization engines, direct Google OAuth/calendar changes, cloud OpenWhispr APIs, installer signing, and production credentials.

## Known facts/evidence

- Phase 1-2 established the AIReceptionist sidecar and managed calendar authority.
- Phase 3 added local encounters, deterministic calendar projection, idempotent encounter starts, encounter-first Home cards, and Calendar & Reminders/AI Receptionist surfaces.
- Existing local recording/transcription paths include `MeetingRecordingMount`, `meetingRecordingStore`, `meetingTranscriptionRouting`, `transcriptionRoute`, local Whisper/Parakeet IPC, diarization IPC, and note persistence in `database.js`/note stores.
- Existing note editing and transcript display components can be extended rather than replaced.
- The worktree contains substantial preexisting local-first edits; preserve unrelated changes and do not commit private credentials.

## Constraints

- The local SQLite database remains the source of truth.
- Encounter start must be idempotent and retries must not create duplicate notes or transcripts.
- Renderer-facing errors must use fixed safe messages; do not expose sidecar output, filesystem paths, prompts, credentials, or raw provider exceptions.
- Default generation must work offline with an installed local intelligence model; BYOK remains opt-in and explicit.
- A partial transcript or failed generation must remain recoverable.
- Preserve quick dictation behavior and existing note data.

## Likely codebase touchpoints

- Encounter bridge: `src/helpers/database.js`, `src/helpers/ipcHandlers.js`, `preload.js`, `src/types/electron.ts`.
- Recording/transcription: `src/components/MeetingRecordingMount.tsx`, `src/stores/meetingRecordingStore.ts`, `src/helpers/meetingTranscriptionRouting.js`, `src/helpers/transcriptionRoute.ts`, `src/helpers/meetingDetectionEngine.js`, and existing meeting IPC handlers.
- Notes/intelligence: `src/components/notes/NoteEditor.tsx`, `src/components/notes/MeetingTranscriptChat.tsx`, `src/helpers/noteFormattingOverrides.js`, `src/config/prompts*`, local intelligence/model helpers, and note stores.
- UI/tests: `src/components/EncounterCard.tsx`, `src/components/EncounterHomeView.tsx`, locale files, and `test/` encounter/transcription/note tests.

## Phase gates

1. Lifecycle gate: one encounter start leads to one local note/recording session, and stop/retry/reopen behavior is deterministic.
2. Clinical output gate: transcript, summary, and SOAP output are persisted locally and remain available after restart without cloud calls.
3. Regression gate: quick dictation, existing meeting recording, diarization, notes, and offline startup remain functional; focused tests plus standard lint/typecheck/build pass.
