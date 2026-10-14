import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-credit-${process.pid}`);
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";
const budget = await import("../src/ai/budget.ts");
const { importBudget } = await import("../src/albums.ts");

test("an out-of-credit answer pauses AI calls and imports until a call goes through again", () => {
  assert.equal(budget.aiAvailable(), true);
  assert.ok(importBudget() > 0);
  budget.noteAiError(new Error('400 {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}'));
  assert.equal(budget.aiAvailable(), false);
  assert.throws(() => budget.assertBudget(), budget.OutOfCredit);
  assert.equal(importBudget(), 0);
  budget.recordUsage({ model: "claude-haiku-5-5", usage: { input_tokens: 10, output_tokens: 10 } } as any);
  assert.equal(budget.aiAvailable(), true);
});

test("other errors don't pause anything", () => {
  budget.noteAiError(new Error("overloaded"));
  assert.equal(budget.aiAvailable(), true);
});
