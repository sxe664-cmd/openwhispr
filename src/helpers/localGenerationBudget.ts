import type { ReasoningConfig } from "../services/BaseReasoningService";

export async function countGenerationTokens(modelId: string, text: string): Promise<number> {
  try {
    const result = await window.electronAPI?.countLocalModelTokens?.(modelId, text);
    if (result?.success && Number.isFinite(result.tokenCount)) {
      return Math.max(1, Number(result.tokenCount));
    }
  } catch {
    // Older bridges and unloaded tokenizers use the conservative fallback.
  }
  return Math.max(1, Math.ceil(Array.from(text).length / 2.5));
}

export async function localRequestBudget(modelId: string, config: ReasoningConfig) {
  let contextTokens = 4096;
  let outputLimit = 1024;
  try {
    const result = await window.electronAPI?.getLocalModelRuntimeProfile?.(modelId);
    if (result?.success && result.profile && result.profile.contextTokens > 0) {
      contextTokens = result.profile.contextTokens;
      outputLimit = result.profile.maxOutputTokens;
    }
  } catch {
    // Defaults apply only when no effective runtime profile is available.
  }
  const maxTokens = Math.max(1, Math.min(config.maxTokens ?? 1024, outputLimit));
  const instructions = `${config.systemPrompt ?? ""}\n${JSON.stringify(config.responseFormat ?? {})}`;
  const instructionTokens = await countGenerationTokens(modelId, instructions);
  // Reserve chat framing as well as the 15% context safety margin.
  const inputTokens = Math.floor(contextTokens * 0.85) - instructionTokens - maxTokens - 64;
  if (inputTokens <= 0) {
    throw Object.assign(new Error("The local model context cannot fit this note request."), {
      code: "LOCAL_CONTEXT_TOO_SMALL",
    });
  }
  return { inputTokens, maxTokens, contextTokens };
}

export async function guardLocalRequest(
  modelId: string,
  text: string,
  config: ReasoningConfig
): Promise<ReasoningConfig> {
  const budget = await localRequestBudget(modelId, config);
  if (await countGenerationTokens(modelId, text) > budget.inputTokens) {
    throw Object.assign(new Error("The local note request exceeds the model context."), {
      code: "LOCAL_CONTEXT_EXCEEDED",
    });
  }
  return { ...config, maxTokens: budget.maxTokens };
}

/** Every emitted portion is counted with its actual request wrapper. */
export async function splitGenerationSource(
  source: string,
  modelId: string,
  config: ReasoningConfig,
  wrap: (portion: string) => string = (portion) => portion
): Promise<Array<{ text: string; start: number; end: number }>> {
  const { inputTokens } = await localRequestBudget(modelId, config);
  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  while (start < source.length) {
    let low = 1;
    let high = source.length - start;
    let fit = 0;
    while (low <= high) {
      const length = Math.floor((low + high) / 2);
      if (await countGenerationTokens(modelId, wrap(source.slice(start, start + length))) <= inputTokens) {
        fit = length;
        low = length + 1;
      } else {
        high = length - 1;
      }
    }
    if (!fit) throw Object.assign(new Error("The local model context is too small."), { code: "LOCAL_CONTEXT_TOO_SMALL" });
    let end = start + fit;
    if (end < source.length) {
      const searchStart = start + Math.floor(fit / 2);
      const candidates = [...source.slice(searchStart, end).matchAll(/[.!?\n](?=\s|$)/g)];
      const boundary = candidates.at(-1);
      if (boundary?.index != null) end = searchStart + boundary.index + 1;
      // Do not divide a surrogate pair across requests.
      if (/[\uD800-\uDBFF]/.test(source[end - 1]) && end > start + 1) end -= 1;
    }
    const text = source.slice(start, end);
    chunks.push({ text, start, end });
    start = end;
  }
  return chunks;
}
