import type { InferenceMode } from "../types/electron";
import type { SettingsState } from "./settingsStore";

/** Local-first builds have no remote policy authority. */
export type PolicyStatus = "idle" | "loading" | "managed" | "unmanaged" | "error";
export type PolicyScope = "transcription" | "llm";

export interface PolicyDecisionSnapshot {
  status: PolicyStatus;
  policy: null;
  appVersion: string | null;
}

export function isPolicyActionAllowed(_state: PolicyDecisionSnapshot): boolean {
  return true;
}

export function isUpdateRequiredByOrg(_state: PolicyDecisionSnapshot): boolean {
  return false;
}

export function effectiveLocalHistoryEnabled(
  _state: PolicyDecisionSnapshot,
  personalPreference: boolean
): boolean {
  return personalPreference;
}

export function lockedLocalHistoryValue(_state: PolicyDecisionSnapshot): boolean | null {
  return null;
}

export function effectiveAudioRetentionDays(
  _state: PolicyDecisionSnapshot,
  personalPreference: number
): number {
  return personalPreference;
}

export function maxAudioRetentionDays(_state: PolicyDecisionSnapshot): number | null {
  return null;
}

export function isModeAllowedByPolicy(
  _state: PolicyDecisionSnapshot,
  _scope: PolicyScope,
  _mode: InferenceMode
): boolean {
  return true;
}

export function isProviderAllowedByPolicy(
  _state: PolicyDecisionSnapshot,
  _scope: PolicyScope,
  _providerId: string
): boolean {
  return true;
}

/** Optional BYOK provider integrations are available without managed policy. */
export function isEnterpriseProviderAllowed(
  _state: PolicyDecisionSnapshot,
  _providerId: string
): boolean {
  return true;
}

export function isAgentAllowed(_state: PolicyDecisionSnapshot): boolean {
  return true;
}

export function isWebSearchAllowed(_state: PolicyDecisionSnapshot): boolean {
  return true;
}

export function isScreenContextAllowed(_state: PolicyDecisionSnapshot): boolean {
  return true;
}

/** Cloud backup is not part of the local-first client. */
export function isCloudBackupAllowed(_state: PolicyDecisionSnapshot): boolean {
  return false;
}

export interface LlmSelection {
  mode: InferenceMode;
  provider: string;
}

export interface PolicySelectionCatalog {
  modes: readonly InferenceMode[];
  byokProviders: readonly string[];
  enterpriseProviders?: readonly string[];
}

export function resolveEffectivePolicySelection(
  _state: PolicyDecisionSnapshot,
  _scope: PolicyScope,
  selection: LlmSelection,
  _catalog: PolicySelectionCatalog
): LlmSelection {
  return selection;
}

export function isLlmSelectionAllowed(
  _state: PolicyDecisionSnapshot,
  _selection: LlmSelection
): boolean {
  return true;
}

export interface TranscriptionSelection {
  mode: InferenceMode;
  provider: string;
}

export function isTranscriptionSelectionAllowed(
  _state: PolicyDecisionSnapshot,
  _selection: TranscriptionSelection
): boolean {
  return true;
}

export type TranscriptionPolicyContext = "dictation" | "meeting" | "upload";

export function getTranscriptionSelection(
  settings: SettingsState,
  context: TranscriptionPolicyContext
): TranscriptionSelection {
  if (context === "meeting") {
    return {
      mode: settings.meetingTranscriptionMode,
      provider: settings.meetingCloudTranscriptionProvider || settings.cloudTranscriptionProvider,
    };
  }
  if (context === "upload") {
    return {
      mode: settings.uploadTranscriptionMode,
      provider: settings.uploadCloudTranscriptionProvider || settings.cloudTranscriptionProvider,
    };
  }
  return {
    mode: settings.transcriptionMode,
    provider: settings.cloudTranscriptionProvider,
  };
}

export function isTranscriptionContextAllowed(
  _state: PolicyDecisionSnapshot,
  _settings: SettingsState,
  _context: TranscriptionPolicyContext
): boolean {
  return true;
}

export function canChangeCloudBackupPreference(
  _policyAllowsBackup: boolean,
  _backupCurrentlyEnabled: boolean
): boolean {
  return false;
}

export function isControlPanelViewAllowed(
  _view: string,
  _agentAllowed: boolean,
  _policyActionsAllowed: boolean
): boolean {
  return true;
}

export function filterModeOptionsByPolicy<T>(
  options: T[],
  _scope: PolicyScope,
  _state: PolicyDecisionSnapshot,
  _providerCatalog?: {
    byokProviders: readonly string[];
    enterpriseProviders?: readonly string[];
  }
): T[] {
  return options;
}

export function reconcilePolicyModeSelection<T>(
  _options: T[],
  _scope: PolicyScope,
  _state: PolicyDecisionSnapshot,
  _selectedMode: InferenceMode,
  _providerCatalog?: {
    byokProviders: readonly string[];
    enterpriseProviders?: readonly string[];
  }
): InferenceMode | null {
  return null;
}

export function filterByokProviderOptionsByPolicy<T>(
  options: T[],
  _scope: PolicyScope,
  _state: PolicyDecisionSnapshot
): T[] {
  return options;
}

export function filterEnterpriseProviderOptionsByPolicy<T>(
  options: T[],
  _state: PolicyDecisionSnapshot
): T[] {
  return options;
}

export function shouldPersistProviderFallback(_state: PolicyDecisionSnapshot): boolean {
  return true;
}

export function reconcileProviderSelection<T extends { id: string; disabled?: boolean }>(
  selectedProvider: string,
  allowedProviders: readonly T[]
): string | null {
  if (allowedProviders.some((provider) => provider.id === selectedProvider && !provider.disabled)) {
    return null;
  }
  return allowedProviders.find((provider) => !provider.disabled)?.id ?? null;
}

interface CloudProviderOption {
  id: string;
  models?: ReadonlyArray<{ id: string }>;
}

export function reconcileCloudProviderSelection({
  selectedProvider,
  selectedModel,
  allowedProviders,
  customAllowed,
  hasCustomUrl,
}: {
  selectedProvider: string;
  selectedModel: string;
  allowedProviders: readonly CloudProviderOption[];
  customAllowed: boolean;
  hasCustomUrl: boolean;
}): { provider: string; model: string } | null {
  if (selectedProvider === "custom" && customAllowed) return null;
  const selected = allowedProviders.find((provider) => provider.id === selectedProvider);
  if (selected) {
    if (!selected.models?.length || selected.models.some((model) => model.id === selectedModel)) {
      return null;
    }
    return { provider: selected.id, model: selected.models[0].id };
  }
  if (hasCustomUrl && customAllowed) return null;
  const fallback = allowedProviders[0];
  return fallback ? { provider: fallback.id, model: fallback.models?.[0]?.id ?? "" } : null;
}
