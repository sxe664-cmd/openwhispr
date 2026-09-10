# Local clinical pipeline — implementation checkpoint

Date: 2026-09-10. Status: **in progress, not production-approved**.

## 2026-09-10 reliability pass

- Clinical facts now require lexical support from their exact source quotes;
  attaching an unrelated valid quote no longer authorizes a claim.
- Summary, SOAP, Focus, and structured-template prose must be supported by the
  specific evidence IDs they cite. Invalid synthesis retries once, then
  Summary/SOAP/Focus use a deterministic grounded fallback instead of failing.
- Contradictions are no longer inferred merely because manual and transcript
  facts share a category; grounded positive/negative conflicts are retained.
- Added an hour-scale beginning/middle/end retention regression.
- Local custom note actions now use persisted canonical sources and the same
  bounded map/reduce path. Custom actions are no longer misclassified as the
  built-in clinical-template action merely because a calendar event exists.
- Automatic encounter output is pinned to the configured local model.
- Clinical candidates now receive main-process evidence-revision and template-
  definition hashes. Obsolete alternate clinical generation code containing a
  silent truncation path was removed.
- Liquid 1.2B is no longer presented as a recommended general model; catalog
  copy clarifies that larger models should be used for structured clinical notes.
- Verification: 43 focused pipeline tests passed before the final additions;
  the grounding/template subset then passed 26 tests. Native Electron database
  gate passed 53 tests with zero skips. Typecheck and renderer build passed.
  Full suite remains at the same five known unrelated/runtime/translation
  failures described below (1,804 total, 1,587 passed, 212 skipped).

This worktree already contained intentional uncommitted implementation before
the resumed session. Existing changes, including unrelated vendor files, were
preserved. The aggregate Git diff is not a record of this session alone.

## Verified in the resumed session

- Completion rejects an active session without a saved checkpoint, permits a
  saved checkpoint, and permits the same guarded session to finalize afterward.
- Duplicate Stop calls share a promise; a new Start waits for prior teardown.
  Stop retains its original note/session identity. Late checkpoint callbacks
  cannot update another session's UI. Missing persistence responses are failures.
  These store-level race changes still need end-to-end recording tests.
- Preparing is owned by the global manual action job. It rereads persisted
  sources after finalization and honors cancellation, including late reads.
- Built-in Generate Notes requires the configured local route and pins its
  configured model. Custom-action routing remains separate.
- Generic conditional application guards both source hash and revision; an
  edit-and-revert cannot overwrite a newer source revision. Rejected generic
  results remain reviewable older-source drafts, with Apply guarded.
- Local inference failures retain safe error categories across IPC; schema
  rejection retries with a bounded, explicit JSON contract. Provider exception
  text is not returned or logged at this IPC boundary.
- Removed four existing generated/transcribed text preview logging fields.
- Legacy candidate content-only hashes and custom-action weak stale hashes
  remain compatible with the new canonical source hash.

## Verification results

- Focused source/evidence/budget/template/generation/store tests: 42 passed.
- `node scripts/test-pipeline-database.cjs`: 52 passed, zero skipped. Runs each
  database suite in a separate installed Electron process, matching native ABI.
- `npm run typecheck`: passed.
- `npm run build:renderer`: passed; existing bundle-size warnings remain.
- Full suite snapshot before the final preparation helper was added: 1,794
  tests, 1,578 passed, five failed, 211 skipped.
  - Three unchanged Home/settings source assertions expect the old
    `AIReceptionistView embedded`, patient `review` label, or `quickDictation`
    text. These were not rewritten simply to make the suite pass.
  - Calendar patient-resolution integration fails under shell Node ABI 137
    against the installed Electron ABI 145 addon. It passes in the new
    Electron runner; no addon rebuild was performed.
  - Translation coverage has missing non-English template-settings, patient,
    and chat deletion keys. `npm run i18n:check` also reports these.
- No live one-hour recording, weak-model, app-restart, or visual template-editor
  QA was performed. Unit tests are not a substitute for those acceptance gates.

## Remaining release gates

Do not call the approved seven-chunk plan complete. In particular:

1. Exercise global recording teardown, navigation, completion, empty recordings,
   failed persistence, and delayed diarization with behavioral integration tests.
2. Finish shared persisted evidence-job coordination. Exact in-memory chunk
   deduplication is not equivalent to one revision-owned shared job.
3. Strengthen unsupported-claim validation beyond checking citation existence.
   Correct overly broad contradiction detection (same category is not proof of
   contradiction), and preserve evidence channel provenance across chunk cuts.
4. Complete legacy-template canonical alias migration, oversized section batches,
   atomic default repair, fallback notices, and candidate template-definition
   hashes. Review stale-draft View/Regenerate UX.
5. Verify local-only automatic routing separately from compatibility helper
   routes; verify generic cancellation stops scheduling additional chunks.
6. Finish note-type-specific progress, template-editor localization and visual
   QA. Audit remaining provider/transcription logging, not just removed previews.
7. Reconcile the full-suite/translation baseline and rerun all acceptance gates
   after implementation, including actual local-model and recording QA.

## 2026-09-10 final reliability follow-up

- Empty/near-empty recordings now checkpoint and finalize their guarded session
  instead of leaving the database in `recording` while the UI reports Ready.
  Empty finalized transcripts are rejected at the generation-claim boundary and
  cannot create useless model work.
- Automatic orchestration now permits one bounded higher-priority encounter to
  preempt historical work between model requests. The local inference bridge
  remains strictly single-worker; the backlog is not fanned out concurrently.
- Queue priority is propagated through extraction, evidence reduction, and final
  synthesis. A behavioral bridge test verifies one active inference request and
  current-encounter-before-history ordering.
- Legacy SOAP and common clinical headings now migrate to canonical field IDs;
  unknown headings remain narrative. Previously persisted narrative-only
  migrations are upgraded lazily when recognized headings are present.
- Automatic local generation no longer hands a cloud/self-hosted model ID to
  llama.cpp when the note-formatting scope is not actually local.
- Latest gates: 33 focused evidence/generation/coordinator/template/source tests
  passed; the native Electron database runner passed 55 tests with zero skips;
  TypeScript passed; queue/template follow-up passed 11 tests; diff check has no
  whitespace errors. A full renderer build was re-run separately because the
  package-level build spent several minutes downloading unrelated bundled assets.

Still required before calling this production-proven: install/select the actual
Dad-machine local model and run live short/one-hour recording, malformed-output,
navigation/completion, app-reopen, and custom-template QA. There is currently no
downloaded GGUF model in the inspected user profile, so model-quality claims
cannot honestly be made from mocks alone.
