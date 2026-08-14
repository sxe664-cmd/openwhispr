# Network behavior

OpenWhispr is local-first. The desktop client does not require an account,
hosted API, subscription, workspace, or cloud sync service to start or use
local transcription, diarization, notes, model downloads, or local search.

Optional network access occurs only when the user explicitly configures it:

- BYOK transcription or reasoning providers, using the endpoint configured by the user.
- Google, Microsoft, or Apple calendar authorization and calendar APIs.
- Model download hosts selected by the local model manager.

No OpenWhispr Cloud or authentication domain should be added to an offline
allowlist. See `docs/server-removal-checklist.md` for hosted infrastructure
that must be disabled or removed in any separate server repository.
