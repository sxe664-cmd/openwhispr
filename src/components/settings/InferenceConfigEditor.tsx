import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Key, Cpu, Network } from "lucide-react";
import {
  LLM_POLICY_PROVIDER_IDS,
  useSettingsStore,
  selectPolicyEffectiveSettings,
  selectResolvedLLMConfig,
  setResolvedLLMConfig,
} from "../../stores/settingsStore";
import { usePolicyModeOptions, usePolicySnapshot } from "../../hooks/usePolicy";
import { InferenceModeSelector } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import ReasoningModelSelector from "../ReasoningModelSelector";
import OpenAICompatiblePanel from "../OpenAICompatiblePanel";
import { Toggle } from "../ui/toggle";
import type { InferenceMode } from "../../types/electron";
import type { InferenceScope } from "../../config/inferenceScopes";
import { getCloudModel, getLocalModel, isProviderValidForMode } from "../../models/ModelRegistry";

const MODE_LABEL_PREFIX: Record<InferenceScope, string> = {
  dictationCleanup: "settingsPage.aiModels.modes",
  noteFormatting: "settingsPage.aiModels.modes",
  dictationAgent: "dictationAgent.modes",
  dictationAgentVision: "dictationAgent.modes",
  chatIntelligence: "agentMode.settings.modes",
  dictationTranslation: "settingsPage.aiModels.modes",
};

interface InferenceConfigEditorProps {
  scope: InferenceScope;
  onModeChange?: (mode: InferenceMode) => void;
  allowedModes?: InferenceMode[];
}

export default function InferenceConfigEditor({
  scope,
  onModeChange,
  allowedModes,
}: InferenceConfigEditorProps) {
  const { t } = useTranslation();
  const policyState = usePolicySnapshot();
  const config = useSettingsStore(
    useShallow((settings) =>
      selectResolvedLLMConfig(selectPolicyEffectiveSettings(settings, policyState), scope)
    )
  );
  const prefix = MODE_LABEL_PREFIX[scope];
  const { modes, effectiveMode, isModeAllowed } = usePolicyModeOptions<InferenceModeOption>(
    ([
      {
        id: "providers",
        label: t(`${prefix}.providers`),
        description: t(`${prefix}.providersDesc`),
        icon: <Key className="w-4 h-4" />,
      },
      {
        id: "local",
        label: t(`${prefix}.local`),
        description: t(`${prefix}.localDesc`),
        icon: <Cpu className="w-4 h-4" />,
      },
      {
        id: "self-hosted",
        label: t(`${prefix}.selfHosted`),
        description: t(`${prefix}.selfHostedDesc`),
        icon: <Network className="w-4 h-4" />,
      },
    ] as InferenceModeOption[]).filter((mode) => !allowedModes || allowedModes.includes(mode.id)),
    "llm",
    config.mode,
    { byokProviders: LLM_POLICY_PROVIDER_IDS }
  );

  const setField = useCallback(
    <K extends keyof Omit<typeof config, "scope">>(field: K) =>
      (value: NonNullable<(typeof config)[K]>) => setResolvedLLMConfig(scope, { [field]: value }),
    [scope]
  );
  const setMode = setField("mode");
  const setProvider = setField("provider");
  const setModel = setField("model");
  const switchProvider = useCallback(
    (provider: string, fallbackModel: string) =>
      useSettingsStore.getState().switchReasoningProvider(scope, provider, fallbackModel),
    [scope]
  );

  const handleModeSelect = useCallback(
    (mode: InferenceMode) => {
      if (!isModeAllowed(mode) || mode === effectiveMode) return;
      const patch: Parameters<typeof setResolvedLLMConfig>[1] = { mode, cloudMode: "byok" };
      if (!isProviderValidForMode(config.provider, mode)) {
        patch.provider = "";
        patch.model = "";
      }
      setResolvedLLMConfig(scope, patch);
      if (mode === "self-hosted") window.electronAPI?.llamaServerStop?.();
      onModeChange?.(mode);
    },
    [config.provider, effectiveMode, isModeAllowed, onModeChange, scope]
  );

  const renderModelSelector = (mode: "cloud" | "local") => (
    <ReasoningModelSelector
      reasoningModel={config.model}
      setReasoningModel={setModel}
      localReasoningProvider={config.provider}
      setLocalReasoningProvider={setProvider}
      onCloudProviderSelect={switchProvider}
      cloudReasoningBaseUrl={config.cloudBaseUrl ?? ""}
      setCloudReasoningBaseUrl={setField("cloudBaseUrl")}
      customReasoningApiKey={config.customApiKey ?? ""}
      setCustomReasoningApiKey={setField("customApiKey")}
      setReasoningMode={setMode}
      mode={mode}
    />
  );

  const showThinkingToggle =
    effectiveMode === "self-hosted" ||
    (effectiveMode === "providers" &&
      (config.provider === "custom" ||
        config.provider === "openrouter" ||
        !!getCloudModel(config.model)?.supportsThinking)) ||
    (effectiveMode === "local" && !!getLocalModel(config.model)?.supportsThinking);

  return (
    <div className="space-y-3">
      <InferenceModeSelector modes={modes} activeMode={effectiveMode} onSelect={handleModeSelect} />
      {effectiveMode === "providers" && renderModelSelector("cloud")}
      {effectiveMode === "local" && renderModelSelector("local")}
      {effectiveMode === "self-hosted" && (
        <OpenAICompatiblePanel
          baseUrl={config.remoteUrl ?? ""}
          setBaseUrl={setField("remoteUrl")}
          apiKey={config.customApiKey ?? ""}
          setApiKey={setField("customApiKey")}
          model={config.model}
          setModel={setModel}
          baseUrlPlaceholder="http://192.168.1.126:11434/v1"
          helpExamples={<p className="text-xs text-muted-foreground">{t("reasoning.selfHosted.endpointHelp")}</p>}
        />
      )}
      {showThinkingToggle && (
        <div className="flex items-start justify-between gap-3 pt-1">
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-foreground">{t("reasoning.disableThinking.label")}</h4>
            <p className="text-xs text-muted-foreground">{t("reasoning.disableThinking.help")}</p>
          </div>
          <Toggle checked={config.disableThinking} onChange={setField("disableThinking")} />
        </div>
      )}
    </div>
  );
}
