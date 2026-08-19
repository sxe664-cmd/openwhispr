const modelManager = require("../helpers/modelManagerBridge").default;
const debugLogger = require("../helpers/debugLogger");

class LocalReasoningService {
  constructor() {
    this.isProcessing = false;
    this.pendingRequests = [];
    this.nextRequestId = 0;
    this.drainPromise = null;
  }

  async isAvailable() {
    try {
      await modelManager.ensureLlamaCpp();
      const models = await modelManager.getAllModels();
      return models.some((model) => model.isDownloaded);
    } catch {
      return false;
    }
  }

  processText(text, modelId, config = {}) {
    const normalizedConfig = config && typeof config === "object" ? config : {};
    const requestId = ++this.nextRequestId;
    const textLength = typeof text === "string" ? text.length : 0;
    const queuePosition = this.pendingRequests.length + (this.isProcessing ? 1 : 0) + 1;

    debugLogger.logReasoning("LOCAL_BRIDGE_QUEUED", {
      requestId,
      modelId,
      textLength,
      queuePosition,
      queueDepth: queuePosition,
      hasConfig: Object.keys(normalizedConfig).length > 0,
    });

    return new Promise((resolve, reject) => {
      this.pendingRequests.push({
        requestId,
        text,
        modelId,
        config: normalizedConfig,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      });
      void this._drainQueue();
    });
  }

  async _drainQueue() {
    if (this.drainPromise) return this.drainPromise;

    this.drainPromise = (async () => {
      try {
        while (this.pendingRequests.length > 0) {
          const request = this.pendingRequests.shift();
          if (request) await this._runQueuedRequest(request);
        }
      } finally {
        this.drainPromise = null;
        // A request can be queued at the exact moment the final loop check
        // runs. Schedule another drain rather than leaving its promise open.
        if (this.pendingRequests.length > 0) void this._drainQueue();
      }
    })();

    return this.drainPromise;
  }

  async _runQueuedRequest(request) {
    const startedAt = Date.now();
    const queueWaitMs = startedAt - request.enqueuedAt;
    this.isProcessing = true;

    debugLogger.logReasoning("LOCAL_BRIDGE_START", {
      requestId: request.requestId,
      modelId: request.modelId,
      textLength: typeof request.text === "string" ? request.text.length : 0,
      queueWaitMs,
      remainingQueueDepth: this.pendingRequests.length,
      hasConfig: Object.keys(request.config).length > 0,
    });

    try {
      const result = await this._processText(request.text, request.modelId, request.config);
      request.resolve(result);
    } catch (error) {
      request.reject(error);
    } finally {
      this.isProcessing = false;
      debugLogger.logReasoning("LOCAL_BRIDGE_COMPLETE", {
        requestId: request.requestId,
        modelId: request.modelId,
        queueWaitMs,
        processingTimeMs: Date.now() - startedAt,
        remainingQueueDepth: this.pendingRequests.length,
      });
    }
  }

  async _processText(text, modelId, config) {
    const startTime = Date.now();

    try {
      const inferenceConfig = {
        maxTokens: config.maxTokens || this.calculateMaxTokens(text.length),
        temperature: config.temperature || 0.7,
        topK: config.topK || 40,
        topP: config.topP || 0.9,
        repeatPenalty: config.repeatPenalty || 1.1,
        systemPrompt: config.systemPrompt || "",
        disableThinking: config.disableThinking !== false,
        requireCompleteOutput: config.requireCompleteOutput === true,
        responseFormat: config.responseFormat,
      };

      debugLogger.logReasoning("LOCAL_BRIDGE_INFERENCE", {
        modelId,
        config: inferenceConfig,
      });

      const result = await modelManager.runInference(modelId, text, inferenceConfig);
      const stripThinking = config.disableThinking !== false;
      const cleanResult = stripThinking
        ? result
            .replace(/<think>[\s\S]*?<\/think>/g, "")
            .replace(/<think>[\s\S]*$/, "")
            .trim()
        : result.trim();

      debugLogger.logReasoning("LOCAL_BRIDGE_SUCCESS", {
        modelId,
        processingTimeMs: Date.now() - startTime,
        resultLength: cleanResult.length,
        resultPreview: cleanResult.substring(0, 100) + (cleanResult.length > 100 ? "..." : ""),
      });

      return cleanResult;
    } catch (error) {
      debugLogger.logReasoning("LOCAL_BRIDGE_ERROR", {
        modelId,
        processingTimeMs: Date.now() - startTime,
        error: error.message,
        stack: error.stack,
      });

      throw error;
    }
  }

  calculateMaxTokens(textLength, minTokens = 512, maxTokens = 2048, multiplier = 2) {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }
}

module.exports = {
  default: new LocalReasoningService(),
};
