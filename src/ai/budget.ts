import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { store } from "../store.ts";

/**
 * Monthly AI spending cap. Every Claude call is priced from the usage the API
 * reports and added to this month's total; once the cap is reached, AI calls are
 * refused and the app falls back to its free heuristics until next month.
 * (Set a hard limit in the Anthropic Console too; this is the app-side guard.)
 */

// USD per million tokens [input, output]. Unknown models are priced like Opus.
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-opus-4-8": [5, 25],
  "claude-fable-5-1": [10, 50],
};
const WEB_SEARCH_USD = 10 / 1000;

export class BudgetExceeded extends Error {
  constructor(limit: number) {
    super(`This month's AI budget ($${limit.toFixed(2)}) is used up; using the free method until next month.`);
  }
}

const month = () => new Date().toISOString().slice(0, 7);

export function spendThisMonth() {
  const s = store.spend();
  return s.month === month() ? s : { month: month(), usd: 0, calls: 0 };
}

export function monthlyLimit(): number {
  return store.settings().aiMonthlyBudget;
}

/** Throw before an AI call if the month's budget is used up. */
export function assertBudget() {
  const limit = monthlyLimit();
  if (spendThisMonth().usd >= limit) throw new BudgetExceeded(limit);
}

/** Add a finished call's cost to this month's total. */
export function recordUsage(msg: Pick<Anthropic.Beta.BetaMessage, "usage" | "model">) {
  const [inPrice, outPrice] = PRICES[msg.model] ?? PRICES[config.claude.model] ?? PRICES["claude-opus-5-5"];
  const u = msg.usage;
  const input =
    (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1;
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  const usd = (input * inPrice + (u.output_tokens ?? 0) * outPrice) / 1e6 + searches * WEB_SEARCH_USD;
  const current = spendThisMonth();
  store.setSpend({ month: current.month, usd: current.usd + usd, calls: current.calls + 1 });
  return usd;
}
