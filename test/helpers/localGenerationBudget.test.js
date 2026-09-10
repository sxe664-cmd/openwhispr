import assert from "node:assert/strict";
import test from "node:test";
import { guardLocalRequest, splitGenerationSource } from "../../src/helpers/localGenerationBudget.ts";

test("model-sized chunks preserve the whole source and fit with wrapper, schema, output and margin", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { electronAPI: {
    getLocalModelRuntimeProfile: async () => ({ success: true, profile: { contextTokens: 2048, maxOutputTokens: 512 } }),
    countLocalModelTokens: async (_model, text) => ({ success: true, tokenCount: text.length }),
  } };
  try {
    const source = "Named speaker: a documented observation.\n".repeat(200);
    const config = { systemPrompt: "Extract evidence.", maxTokens: 2048, responseFormat: { type: "json_object" } };
    const wrap = (value) => `SOURCE START\n${value}\nSOURCE END`;
    const chunks = await splitGenerationSource(source, "small-model", config, wrap);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.map((chunk) => chunk.text).join(""), source);
    for (const chunk of chunks) {
      const bounded = await guardLocalRequest("small-model", wrap(chunk.text), config);
      assert.equal(bounded.maxTokens, 512);
      assert.ok(wrap(chunk.text).length + `${config.systemPrompt}\n${JSON.stringify(config.responseFormat)}`.length + 512 + 64 <= Math.floor(2048 * 0.85));
    }
    await assert.rejects(guardLocalRequest("small-model", source, config), { code: "LOCAL_CONTEXT_EXCEEDED" });
  } finally { globalThis.window = previousWindow; }
});

test("an oversized prompt never receives an artificial minimum source allowance", async () => {
  await assert.rejects(
    splitGenerationSource("text", "model", { systemPrompt: "instruction ".repeat(2000), maxTokens: 2048 }),
    { code: "LOCAL_CONTEXT_TOO_SMALL" }
  );
});
