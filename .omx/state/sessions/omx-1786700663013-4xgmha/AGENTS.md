<!-- OMX:RUNTIME:START -->
<session_context>
**Session:** omx-1786700663013-4xgmha | 2026-08-14T09:44:24.118Z

**Codebase Map:**
  src/: eslint.config, i18n, updater, vite-env.d, vite.config
  src/components/: AcceptInvitationModal, AgentOverlay, ApiKeysSection, AuthenticationStep, CleanupFailureToastListener, CliIntegrationCard, CommandSearch, ControlPanel, ControlPanelSidebar, CreateTeamDialog
  src/config/: InferenceConfig, agentDetection, constants, inferenceScopes, prompts, registry, retiredPrompts, secretKeys
  src/constants/: apiKeys
  src/helpers/: abortError, activeMicRecovery, agentNameDictionary, appVersion, appleCalendarManager, assemblyAiStreaming, audioActivityDetector, audioManager, audioStorage, audioTapManager
  src/hooks/: useActionProcessing, useAudioRecording, useAuth, useBillingPortal, useClipboard, useCollapsibleSidebar, useContainerChat, useDebouncedCallback, useDelayedFlag, useDialogs
  src/lib/: auth, authAccountScope, authRequestContext, billingPortalError, conversationTitle, emojiInput, localMutationError, memberCandidates, noteConflictRegistry, noteEditorPendingSave
  src/locales/:...

**Explore Command Preference:** enabled via `USE_OMX_EXPLORE_CMD` (default-on; opt out with `0`, `false`, `no`, or `off`)
- Advisory steering only: agents SHOULD treat `omx explore` as the default first stop for direct inspection and SHOULD reserve `omx sparkshell` for qualifying read-only shell-native tasks.
- For simple file/symbol lookups, use `omx explore` FIRST before attempting full code analysis.
- When the user asks for a simple read-only exploration task (file/symbol/pattern/relationship lookup), strongly prefer `omx explore` as the default surface.
- Explore examples: `omx explore...

**Compaction Protocol:**
Before context compaction, preserve critical state:
1. Write progress checkpoint via `omx state write --input '<json>' --json`
2. Save key decisions via `omx notepad write-working --input '<json>' --json`
3. If context is >80% full, proactively checkpoint state
</session_context>
<!-- OMX:RUNTIME:END -->
