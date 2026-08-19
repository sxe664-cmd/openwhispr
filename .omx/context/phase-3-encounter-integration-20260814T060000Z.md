# Autopilot Context: Phase 3 Encounter Integration

## Task statement

Implement Phase 3 for the local-first OpenWhispr build: integrate the AIReceptionist-owned calendar experience into OpenWhispr and establish the local encounter foundation without starting Phase 4 note-generation work.

## Desired outcome

- OpenWhispr remains the only Electron shell.
- Calendar & Reminders and AI Receptionist become first-class integrated product surfaces.
- AIReceptionist remains the only Google Calendar/OAuth authority.
- Calendar events project into stable local encounters and appear on Home as encounter cards.
- Encounter records can be opened and connected to the existing local meeting/transcription flow without changing the Phase 1-2 sidecar boundary.
- Existing local notes, calendar data, diarization, and offline behavior remain intact.

## Scope boundaries

In scope: local encounter schema/projection, calendar-to-encounter mapping, Home encounter list/cards, integrated Calendar & Reminders and AI Receptionist UI/settings surfaces, managed sidecar status/error states, deep-link/navigation behavior, tests.

Out of scope for Phase 3: full SOAP/summary generation, new transcription models, cloud APIs, live production credentials, installer signing, or replacing the existing transcription/diarization engine. Those belong to Phase 4.

## Known facts/evidence

- Phase 1-2 already add `AIReceptionistRuntime` and `ReceptionistCalendarBridge`.
- The bridge projects calendar rows into the local `calendar_events` table with provider `ai_receptionist`, stable occurrence IDs, tombstone handling, complete-window reconciliation, reminder execution, and cached offline behavior.
- Existing OpenWhispr has local SQLite notes, meeting recording/transcription/diarization workflows, upcoming-meeting UI, settings navigation, and calendar IPC/preload APIs.
- The worktree contains substantial preexisting local-first edits; unrelated edits must be preserved.

## Constraints

- Do not reintroduce direct Google OAuth or duplicate calendar sync.
- Do not add a second Electron host or expose AIReceptionist secrets to the renderer.
- Preserve existing local note/calendar rows and note-linked event retention.
- Prefer additive/migratable changes over destructive schema changes.
- Keep the phase independently testable and offline-safe when the sidecar/network is unavailable.

## Likely codebase touchpoints

- OpenWhispr: `src/helpers/database.js`, `src/helpers/receptionistCalendarBridge.js`, `src/components/UpcomingMeetings.tsx`, `src/components/SettingsPage.tsx`, `src/components/SettingsModal.tsx`, `src/AppRouter.jsx`, Home/notes components, preload/electron types, locale files, and focused tests.
- AIReceptionist reference: existing calendar/reminders and receptionist settings views/components, but reuse behavior through the sidecar boundary rather than launching its Electron UI.

## Phase gates

1. Encounter foundation gate: a calendar event maps deterministically to one local encounter without duplicate rows, and Home can render/open it while offline from cached data.
2. Product surface gate: Calendar & Reminders and AI Receptionist surfaces are reachable in-app with clear managed/offline/error status and no auth/setup prompt.
3. Regression gate: existing meeting recording/transcription/diarization and local notes remain functional; focused tests plus standard lint/typecheck/build pass.
