import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-budget-${process.pid}-${Date.now()}`);
process.env.AI_MONTHLY_BUDGET = "1";

const { recordUsage, assertBudget, spendThisMonth, BudgetExceeded } = await import("../src/ai/budget.ts");

test("usage is priced and the monthly cap stops further calls", () => {
  assertBudget(); // nothing spent yet
  // 100k input + 20k output tokens on Opus 5.5 = $0.40 + $0.40, plus 2 web searches = $0.02
  const usd = recordUsage({
    model: "claude-opus-5-5",
    usage: { input_tokens: 100_000, output_tokens: 20_000, server_tool_use: { web_search_requests: 2 } } as any,
  });
  assert.ok(Math.abs(usd - 0.82) < 1e-9, String(usd));
  assert.equal(spendThisMonth().calls, 1);
  assertBudget(); // $0.82 < $1
  recordUsage({ model: "claude-opus-5-5", usage: { input_tokens: 50_000, output_tokens: 0 } as any });
  assert.throws(() => assertBudget(), BudgetExceeded);
});
