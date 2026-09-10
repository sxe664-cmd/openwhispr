import assert from "node:assert/strict";
import test from "node:test";

import {
  generateLocalGenericNotes,
  isUsableGeneratedMarkdown,
  LOCAL_NOTE_EVIDENCE_CHAR_LIMIT,
  LOCAL_NOTE_SHORT_SOURCE_CHAR_LIMIT,
} from "../../src/helpers/localNoteGeneration.ts";

test("generic validation rejects obvious refusal, prompt echo, and exact long-source copy", () => {
  const longSource = "documented detail ".repeat(80);
  assert.equal(isUsableGeneratedMarkdown("Sorry, I can't complete this request.", longSource), false);
  assert.equal(isUsableGeneratedMarkdown("SYSTEM PROMPT: summarize the source", longSource), false);
  assert.equal(isUsableGeneratedMarkdown(longSource, longSource), false);
  assert.equal(
    isUsableGeneratedMarkdown("## Key points\n\n- Documented detail was reviewed and organized.", longSource),
    true
  );
});

function fakeReasoner(calls) {
  return {
    async processText(text, modelId, agentName, config) {
      calls.push({ text, modelId, agentName, config });
      if (config.systemPrompt.includes("Synthesize the supplied bounded evidence")) {
        return "## Final note\nSynthesized evidence.";
      }
      if (config.systemPrompt.includes("Reduce the supplied note evidence")) {
        return "Reduced evidence.";
      }
      if (config.systemPrompt.includes("You are mapping one source chunk")) {
        return "- Evidence from this chunk.";
      }
      return "## Clean note\nShort source transformed.";
    },
  };
}

test("built-in local generation uses one request for a short source", async () => {
  const calls = [];
  const result = await generateLocalGenericNotes({
    sourceText: "A short personal note.",
    systemPrompt: "Base instructions",
    actionPrompt: "Clean this note.",
    modelId: "local-model",
    providerOverrides: {},
    reasoner: fakeReasoner(calls),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "A short personal note.");
  assert.equal(calls[0].config.disableThinking, true);
  assert.equal(calls[0].config.requireCompleteOutput, true);
  assert.ok(calls[0].config.maxTokens <= 2048);
  assert.match(result, /Clean note/);
});

test("built-in local generation maps long sources and synthesizes bounded evidence", async () => {
  const calls = [];
  const progress = [];
  const source = "Important meeting detail. ".repeat(
    Math.ceil((LOCAL_NOTE_SHORT_SOURCE_CHAR_LIMIT + 10_000) / 26)
  );
  const result = await generateLocalGenericNotes({
    sourceText: source,
    systemPrompt: "Meeting instructions",
    actionPrompt: "Make actionable notes.",
    modelId: "local-model",
    providerOverrides: {},
    reasoner: fakeReasoner(calls),
    onProgress: (event) => progress.push(event),
  });

  const mappingCalls = calls.filter((call) =>
    call.config.systemPrompt.includes("You are mapping one source chunk")
  );
  const synthesisCalls = calls.filter((call) =>
    call.config.systemPrompt.includes("Synthesize the supplied bounded evidence")
  );
  assert.ok(mappingCalls.length > 1);
  assert.equal(synthesisCalls.length, 1);
  assert.ok(synthesisCalls[0].text.length < LOCAL_NOTE_EVIDENCE_CHAR_LIMIT + 2_000);
  assert.ok(calls.every((call) => call.config.systemPrompt.trim().length > 0));
  assert.ok(mappingCalls.every((call) => !call.text.includes("Meeting instructions")));
  assert.ok(progress.some((event) => event.stage === "extracting"));
  assert.ok(progress.some((event) => event.stage === "synthesizing"));
  assert.match(result, /Final note/);
});
