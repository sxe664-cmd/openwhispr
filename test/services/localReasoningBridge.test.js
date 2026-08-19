const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const bridgeModulePath = require.resolve("../../src/services/localReasoningBridge.js");
const originalLoad = Module._load;

function loadBridge(runInference) {
  delete require.cache[bridgeModulePath];

  const modelManager = { runInference };
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "../helpers/modelManagerBridge") return { default: modelManager };
    if (request === "../helpers/debugLogger") {
      return { logReasoning() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/services/localReasoningBridge.js").default;
  } finally {
    Module._load = originalLoad;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("local reasoning queues concurrent requests FIFO with one active inference", async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const bridge = loadBridge(async (_modelId, text, config) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    calls.push({ text, config });
    await wait(5);
    active -= 1;
    return `<think>internal</think> result-${text}`;
  });

  const results = await Promise.all([
    bridge.processText("summary", "local-model", { maxTokens: 700 }),
    bridge.processText("soap", "local-model", { maxTokens: 1200 }),
    bridge.processText("focus", "local-model", { maxTokens: 80 }),
  ]);

  assert.deepEqual(results, ["result-summary", "result-soap", "result-focus"]);
  assert.deepEqual(calls.map((call) => call.text), ["summary", "soap", "focus"]);
  assert.deepEqual(calls.map((call) => call.config.maxTokens), [700, 1200, 80]);
  assert.equal(maximumActive, 1);
  assert.equal(bridge.isProcessing, false);
});

test("a failed queued request does not poison later requests", async () => {
  const calls = [];
  const bridge = loadBridge(async (_modelId, text) => {
    calls.push(text);
    await wait(1);
    if (text === "middle") throw new Error("model failed");
    return `ok-${text}`;
  });

  const results = await Promise.allSettled([
    bridge.processText("first", "local-model"),
    bridge.processText("middle", "local-model"),
    bridge.processText("last", "local-model"),
  ]);

  assert.deepEqual(calls, ["first", "middle", "last"]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[0].value, "ok-first");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.message, "model failed");
  assert.equal(results[2].status, "fulfilled");
  assert.equal(results[2].value, "ok-last");
  assert.equal(bridge.isProcessing, false);

  await assert.doesNotReject(() => bridge.processText("after-failure", "local-model"));
  assert.deepEqual(calls, ["first", "middle", "last", "after-failure"]);
});

test("queued local requests never expose the old overlap error", async () => {
  const bridge = loadBridge(async (_modelId, text) => {
    await wait(text === "slow" ? 5 : 1);
    return text;
  });

  const results = await Promise.all([
    bridge.processText("slow", "local-model"),
    bridge.processText("queued", "local-model"),
  ]);

  assert.deepEqual(results, ["slow", "queued"]);
  assert.notEqual(results[1], "Already processing a request");
});

test("local inference forwards structured response constraints and completion guards", async () => {
  let capturedConfig;
  const bridge = loadBridge(async (_modelId, _text, config) => {
    capturedConfig = config;
    return '{"fields":[]}';
  });

  await bridge.processText("clinical source", "local-model", {
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "clinical_evidence",
        strict: true,
        schema: { type: "object" },
      },
    },
    requireCompleteOutput: true,
    disableThinking: true,
  });

  assert.equal(capturedConfig.requireCompleteOutput, true);
  assert.equal(capturedConfig.disableThinking, true);
  assert.deepEqual(capturedConfig.responseFormat, {
    type: "json_schema",
    json_schema: {
      name: "clinical_evidence",
      strict: true,
      schema: { type: "object" },
    },
  });
});
