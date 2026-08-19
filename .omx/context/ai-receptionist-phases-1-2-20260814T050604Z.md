# Autopilot Context: AIReceptionist Phases 1–2

## Task statement

Implement Phases 1 and 2 for OpenWhispr: package the existing AIReceptionist backend/runtime as a private, Dad-ready sidecar feature and make AIReceptionist the single Google Calendar/OAuth authority for the integrated build.

## Desired outcome

- OpenWhispr remains the only Electron shell.
- AIReceptionist’s Python backend and runtime can be bundled and started by OpenWhispr.
- Existing AIReceptionist `.env.local`, Google OAuth token/client, app configuration, contacts, and reminder data can be supplied through a private Dad build overlay without entering Git.
- Dad does not need to install Python/Node or configure LiveKit, Twilio, OpenAI, Google OAuth, email, or reminders.
- OpenWhispr’s duplicate Google Calendar startup/sync path is disabled or routed through the AIReceptionist authority.
- Existing local-first OpenWhispr behavior remains intact when the AIReceptionist sidecar or network services are unavailable.

## Known facts/evidence

- OpenWhispr is an Electron/Vite/React application with its own GoogleCalendarManager, OAuth implementation, sidecar lifecycle registry, local SQLite database, and substantial local-first edits already in the working tree.
- OpenWhispr currently starts `googleCalendarManager.start()` during startup and exposes direct Google Calendar OAuth/sync IPC handlers.
- AIReceptionist is an Electron desktop console with a Python backend, bundled Python runtime, Google OAuth token/client files, reminder SQLite/configuration, and a private `scripts/build-dad.js` that validates/seeds private inputs.
- AIReceptionist’s Google OAuth scopes include calendar event write/freebusy and Gmail sending; its token must not be exposed to the renderer.
- AIReceptionist’s own Electron main process owns a separate window/tray/updater/single-instance lifecycle and must not be launched as a second host application inside OpenWhispr.

## Constraints

- Preserve all existing user changes in the dirty OpenWhispr worktree.
- Do not commit or publish private credentials.
- Keep the work local; OpenWhispr has no GitHub remote.
- Use one Electron shell and one Google Calendar authority.
- Local encounters/transcription must remain usable offline.
- AIReceptionist cloud services still require valid preconfigured credentials and network access; the app must degrade gracefully if unavailable.
- Do not make destructive data migrations or delete existing local data.

## Unknowns/open questions

- Exact private source location and completeness of the AIReceptionist Dad seed for this build machine.
- Whether all required provider credentials are currently valid without reauthorization.
- Whether Phase 1–2 should use the current AIReceptionist CLI-per-command control path or a new long-lived local RPC protocol; prefer the smallest reliable adapter first.
- Exact OpenWhispr calendar UI/settings surface to retain while redirecting Google authority.

## Likely codebase touchpoints

- OpenWhispr: `main.js`, `preload.js`, `electron-builder.json`, `src/helpers/sidecarRegistry.js`, calendar manager/OAuth/IPC files, database/calendar schema, package/build scripts, tests.
- AIReceptionist source reference: `desktop/main.js`, `desktop/preload.js`, `desktop/agent_supervisor.js`, `scripts/build-dad.js`, `scripts/build-python-runtime.js`, `receptionist/`, `config/`, and `python-runtime/`.

## Phase gates

1. Sidecar packaging/startup gate: a build without private inputs fails safely; a private Dad build seeds and starts the AIReceptionist runtime without setup screens.
2. Calendar authority gate: only the AIReceptionist authority performs Google OAuth/calendar sync for the integrated build; events can be projected locally without duplicate sync loops or OAuth prompts.

