import { getCleanupSystemPrompt } from "../config/prompts";
import { getSettings } from "../stores/settingsStore";
import { resolveCleanupLanguage } from "../utils/chineseScript";
import { getDictionaryHintWords } from "../utils/snippets";
import type { InferenceScope } from "../config/inferenceScopes";
import type { ScreenContextImage } from "../types/electron";

export interface ReasoningResponseFormat {
  type: "json_object" | "json_schema";
  json_schema?: {
    name: string;
    strict?: boolean;
    schema: unknown;
  };
}

export interface ReasoningConfig {
  maxTokens?: number;
  temperature?: number;
  contextSize?: number;
  /** Local single-worker scheduling priority; higher jobs run first between requests. */
  queuePriority?: number;
  /** Opaque renderer-created key used to cancel every local request belonging to one action. */
  cancellationKey?: string;
  systemPrompt?: string;
  lanUrl?: string;
  baseUrl?: string;
  customApiKey?: string;
  provider?: string;
  disableThinking?: boolean;
  /** Screenshot attached to voice-agent requests when screen context is on. */
  screenContext?: ScreenContextImage;
  /** Suffix-free prompt used when a screenshot-carrying request is retried text-only. */
  textOnlySystemPrompt?: string;
  language?: string;
  requireCompleteOutput?: boolean;
  responseFormat?: ReasoningResponseFormat;
  requiresAgent?: boolean;
  inferenceScope?: InferenceScope;
}

export abstract class BaseReasoningService {
  protected isProcessing = false;

  protected getCustomDictionary(): string[] {
    return getDictionaryHintWords(getSettings());
  }

  // Auto must remain auto here: zh-CN/zh-TW instructions make cleanup write its
  // entire response in Chinese before the transcription language is known. The
  // final deterministic script pass handles likely-Chinese output instead. See #975.
  protected getPreferredLanguage(): string {
    return resolveCleanupLanguage(getSettings().preferredLanguage);
  }

  protected getUiLanguage(): string {
    return getSettings().uiLanguage || "en";
  }

  protected getSystemPrompt(agentName: string | null): string {
    return getCleanupSystemPrompt(
      agentName,
      this.getCustomDictionary(),
      this.getPreferredLanguage(),
      this.getUiLanguage()
    );
  }

  protected calculateMaxTokens(
    textLength: number,
    minTokens = 100,
    maxTokens = 2048,
    multiplier = 2
  ): number {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }

  abstract isAvailable(): Promise<boolean>;

  abstract processText(
    text: string,
    modelId: string,
    agentName?: string | null,
    config?: ReasoningConfig
  ): Promise<string>;
}
