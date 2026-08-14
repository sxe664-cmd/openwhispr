// Map persisted provider routing to the InferenceMode its Settings tab selects on.
export function deriveReasoningMode(cloudMode, provider) {
  if (cloudMode === "byok") {
    return provider === "custom" ? "self-hosted" : "providers";
  }
  return "local";
}

// Whether a scope may borrow the fallback scope's API key along with its endpoint.
// A scope pointing somewhere of its own, or in another mode, would send that key to
// a host it was never entered for.
export function inheritsFallbackEndpoint(own, fallbackMode) {
  if (own.cloudBaseUrl || own.remoteUrl) return false;
  return !!fallbackMode && own.mode === fallbackMode;
}

// Fan a cleanup config out to all five LLM scopes; each tab selects on its mode.
export function buildReasoningScopePatches(settings, mode) {
  const dictationCleanup = { ...settings, cleanupMode: mode };
  // The four non-cleanup scopes mirror the provider routing fields that are set.
  const routing = {
    ...(settings.cleanupProvider !== undefined ? { provider: settings.cleanupProvider } : {}),
    ...(settings.cleanupModel !== undefined ? { model: settings.cleanupModel } : {}),
    ...(settings.cleanupCloudMode !== undefined ? { cloudMode: settings.cleanupCloudMode } : {}),
  };
  return {
    dictationCleanup,
    noteFormatting: { mode, ...routing },
    dictationAgent: { mode, ...routing },
    chatIntelligence: { mode, ...routing },
    dictationTranslation: { mode, ...routing },
  };
}

// Onboarding "use Corti everywhere" payloads for users who explicitly choose
// the optional BYOK provider.
// useCleanupModel is forced true either way so the routing sticks.
export function buildCortiOnboardingPayloads(
  transcriptionProvider,
  reasoningProvider,
  environment,
  hasApiKey
) {
  const transcription = {
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "corti",
    cloudTranscriptionModel: transcriptionProvider?.models?.[0]?.id,
  };
  const cortiModel = reasoningProvider?.models?.[0]?.id;
  const reasoning =
    environment === "eu" && hasApiKey && cortiModel
      ? {
          useCleanupModel: true,
          cleanupProvider: "corti",
          cleanupModel: cortiModel,
          cleanupCloudMode: "byok",
        }
      : { useCleanupModel: true, cleanupMode: "local" };
  return { transcription, reasoning };
}
