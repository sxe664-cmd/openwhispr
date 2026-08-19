# Slice 4 Terra Code Review — Return to Planning

## Verdict

- Recommendation: `REQUEST CHANGES`
- Architectural status: `BLOCK`
- Review cycle: 1

## Findings

### P0 — Stale generation can publish against a newer transcript

`EncounterClinicalOutputs.tsx` uses an FNV-1a renderer hash while `database.js` stores SHA-256 transcript hashes. More importantly, a generation that started for transcript revision A unconditionally persists `ready` output after revision B (including a diarization update) changes the transcript. The result can therefore be clinically stale while appearing current.

Required correction: use one canonical revision/hash contract and make final persistence conditional on the revision captured before generation. A changed revision must leave the output stale/pending and must not publish the old content as ready.

### P1 — Final transcript completion does not refresh the live note reliably

`meetingRecordingStore.stopRecording` calls the new final-completion IPC path, but that path does not reliably emit the existing note-update notification/update the active renderer note state. Short recordings and skipped/failed diarization can therefore complete in SQLite while the open note still has an old or empty transcript, preventing automatic Summary/SOAP generation until reload.

Required correction: make final encounter completion update the canonical renderer note state through the established note-update broadcast/store path, covering no-diarization and diarization-failure completion.

## Required tests

- Deferred-generation race: transcript/diarization changes during generation; old content cannot become `ready`.
- Canonical hash/revision semantics identify the exact transcript used for generation.
- Short recording with diarization skipped and failed refreshes the live note and generates outputs without reload.
- Concurrent recording IPC preserves same-encounter reuse and blocks cross-encounter attachment.
