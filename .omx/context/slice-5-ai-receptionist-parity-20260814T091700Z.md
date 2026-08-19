# Slice 5: AI Receptionist UI and Calendar/Reminder Parity

## Task statement
Import the functional AIReceptionist calendar/reminder and receptionist experience into OpenWhispr, including the source UI, styles, cards, SMS/email actions, pre/post appointment templates, settings, OAuth/configuration flow, and bounded date-range behavior.

## Desired outcome
OpenWhispr should preserve its local-first encounter/transcription workflow while exposing the real AIReceptionist calendar and messaging feature in its own Calendar & Reminders and AI Receptionist surfaces. Home should show only current-day encounter context, not an unbounded historical calendar feed.

## Known facts and evidence
- Source repository: `C:\Users\santi\AIReceptionist` on branch `main`.
- Target repository: `C:\Users\santi\openwhispr` on branch `codex/ai-receptionist-phases-1-2`.
- Source has `desktop/` renderer files, Google Calendar OAuth assets, Python receptionist/reminder modules, SMS/email modules, templates/configuration, and tests.
- Target has partial integration files including `CalendarRemindersView.tsx`, `AIReceptionistView.tsx`, `EncounterHomeView.tsx`, `EncounterCard.tsx`, `receptionistCalendarBridge.js`, and `aiReceptionistRuntime.js`, but parity with source UI and messaging workflows is not established.
- Both repositories contain pre-existing user changes. Do not reset, discard, or overwrite unrelated work.
- Graphify is installed but neither repository has a graph artifact. A full semantic build was not run because the Graphify skill requires approval before first build.

## Constraints
- Do not reintroduce OpenWhispr accounts, plans, billing, workspaces, or OpenWhispr Cloud dependencies.
- Do not commit OAuth credentials, API keys, local databases, or `.env.local` secrets.
- Preserve local notes, encounters, transcripts, diarization, models, BYOK settings, and third-party integrations.
- Use one canonical calendar event model and one bounded date-range query path.
- External calendar/messaging failures must not prevent local/offline encounter use.
- Do not claim parity using placeholders or empty mock behavior where source functionality exists.

## Unknowns/open questions to resolve during planning
- Exact source-to-target mapping for the source desktop renderer versus target React/Electron renderer.
- Which source messaging/OAuth services can be reused directly and which require a thin, tested adapter.
- Whether source template persistence is file/config based or needs a local target persistence adapter.
- Current target Home query and timezone boundary behavior.
- Which environment variables are required at runtime and how the private build packages them without shipping secrets.

## Likely touchpoints
- Source: `desktop/`, `receptionist/`, `config/`, `documentation/`, `tests/`.
- Target: `src/components/CalendarRemindersView.tsx`, `src/components/AIReceptionistView.tsx`, `src/components/EncounterHomeView.tsx`, `src/components/EncounterCard.tsx`, `src/components/SettingsPage.tsx`, `src/helpers/receptionistCalendarBridge.js`, `src/helpers/aiReceptionistRuntime.js`, `src/helpers/database.js`, `src/helpers/ipcHandlers.js`, `preload.js`, `src/types/`, `src/services/`, locale files, and relevant tests.

## Acceptance evidence required
- Source parity checklist and approved plan.
- Real imported UI and functionality, with no placeholder parity claims.
- Day/Week/Month calendar behavior and SMS/email/template workflows tested.
- Home bounded to current local day/current encounter context while History/Search retain older encounters.
- `npm run typecheck`, `npm run lint`, `npm run i18n:check`, `npm run build:renderer`, and `npm test` results.
- Independent code review and architecture verdict.
