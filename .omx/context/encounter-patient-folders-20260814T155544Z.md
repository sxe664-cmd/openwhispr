# Autopilot Context: Encounter Patient Folders

## Task statement

Implement `.omx/plans/encounter-patient-folders.md` in `C:\Users\santi\openwhispr`.

## Desired outcome

Starting a one-on-one encounter should deterministically resolve a patient by normalized email, create or reuse a private patient folder, place the encounter note there, and produce a concise date-first note format without overwriting user edits. Ambiguous/group/missing-email encounters must remain unassigned and reviewable.

## Known facts and evidence

- `src/helpers/database.js:3795-3909` starts encounters idempotently and creates a meeting note from the calendar summary when needed.
- `src/helpers/database.js:2066-2117` saves notes into folders and defaults meeting notes to the Meetings folder.
- `src/helpers/database.js:2352-2385` creates uniquely named folders in a selected space.
- `src/helpers/database.js:4282-4344` writes the canonical transcript and completes the encounter.
- `src/helpers/database.js:666-730` defines encounters and separate encounter clinical outputs.
- Calendar attendee JSON is persisted by `src/helpers/database.js:3517-3545` and normalized in `src/helpers/calendarContract.js:69-151`.
- `src/helpers/receptionistCalendarBridge.js:48-101` currently exposes attendee emails but not raw descriptions; the managed path may not preserve display names.
- `vendor/ai-receptionist/receptionist/reminders/calendar_google.py:226-244` reads Google descriptions internally, while `vendor/ai-receptionist/receptionist/reminders/identity.py:30-44` supports exact structured email parsing.
- Existing one-on-one participant resolution is in `src/helpers/ipcHandlers.js:484-517`.
- Existing folder-to-Markdown mirroring is in `src/helpers/markdownMirror.js:1-230`.

## Constraints

- Preserve all existing work in the dirty worktree; do not reset, checkout, or broadly reformat unrelated files.
- Source changes are authorized only for this patient-folder feature and its tests.
- Do not make patient identity decisions with fuzzy names or an LLM.
- Keep patient folders in the private space by default.
- Do not expose raw calendar descriptions or full PHI through the renderer bridge.
- Autopilot loop must be `ralplan -> ralph -> code-review`; a non-clean review returns to planning.
- Terra High owns planning, architecture, course corrections, review, and final validation.

## Unknowns/open questions to resolve during planning

- Whether to add a dedicated patient profile table, folder metadata, or both without conflicting with existing folder sync.
- Safest source for display name when managed Google projection only provides attendee email.
- Whether focus/title generation should extend encounter outputs or use a conservative deterministic fallback.
- How to protect manually edited note titles/content during completion-time formatting.
- Which existing test harness can exercise DatabaseManager migrations without touching user data.

## Likely touchpoints

- `src/helpers/database.js`
- `src/helpers/ipcHandlers.js`
- `src/helpers/receptionistCalendarBridge.js`
- `src/helpers/calendarContract.js`
- `vendor/ai-receptionist/receptionist/reminders/calendar_google.py`
- `vendor/ai-receptionist/receptionist/reminders/identity.py`
- `src/components/EncounterHomeView.tsx`
- `src/components/EncounterCard.tsx`
- `src/components/notes/NoteEditor.tsx`
- `src/components/notes/EncounterClinicalOutputs.tsx`
- `src/helpers/clinicalOutputGeneration.ts`
- `src/config/prompts/clinicalOutputs.ts`
- `src/types/electron.ts`
- `preload.js`
- `test/helpers/*`
- `test/components/*`
