# Phase 3 Code Review 2: Required Correction

## Verdict

REQUEST CHANGES from Terra High; architectural status CLEAR.

## P1 finding

AIReceptionist sidecar failures can expose local filesystem paths or JSON-shaped credential values to the renderer. `aiReceptionistRuntime.js` currently redacts only limited `token=` patterns and forwards Python stderr; the bridge and managed-calendar UI can display that message.

## Required correction

- Establish one safe error serializer at the runtime boundary for all sidecar failures.
- Never return raw stderr, command arguments, environment values, local paths, JSON credential fields, bearer/API keys, secrets, cookies, or OAuth material to renderer-facing status/error fields.
- Preserve useful stable error codes and generic actionable messages such as runtime unavailable, command failed, timeout, or invalid response.
- Ensure bridge/UI surfaces display only the sanitized error; add focused tests with Windows paths, JSON-shaped secrets, bearer tokens, and stderr containing environment-like values.

## Release caveat

SQLite-backed encounter tests remain skipped until `better-sqlite3` is rebuilt for the active Node ABI.
