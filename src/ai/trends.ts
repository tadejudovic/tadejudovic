import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { store } from "../store.ts";
import { SEED_TRENDS } from "../templates.ts";
import type { TrendFormat, Trends } from "../types.ts";

const REFRESH_EVERY_MS = 24 * 3600 * 1000;

/** Current text-overlay formats: the latest web scan, merged with the evergreen seed list. */
export function currentTrends(): Trends {
  const t = store.trends();
  if (!t?.formats.length) return { source: "seed", formats: SEED_TRENDS };
  const seen = new Set(t.formats.map((f) => f.pattern.toLowerCase()));
  return { ...t, formats: [...t.formats, ...SEED_TRENDS.filter((f) => !seen.has(f.pattern.toLowerCase()))] };
}

export function trendsStale(): boolean {
  const t = store.trends();
  return !t?.updatedAt || Date.now() - Date.parse(t.updatedAt) > REFRESH_EVERY_MS;
}

/**
 * Ask Claude to search the web for the text-overlay formats pet creators are
 * using right now, and store them as reusable patterns.
 */
export async function refreshTrends(petName: string): Promise<Trends> {
  const client = new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content:
        `Today is ${new Date().toISOString().slice(0, 10)}. Search the web for the on-screen text overlay formats that ` +
        `are performing well on TikTok and Instagram Reels for dog/pet accounts right now (this month if possible): ` +
        `"POV: …", "the energy shift when …", "me: … / my dog: …" and anything newer. Look at trend roundups, ` +
        `creator newsletters and news about viral pet videos.\n\n` +
        `Then reply with ONLY a JSON object, no prose, of the form ` +
        `{"formats":[{"pattern":"POV: the energy shift when ___","example":"POV: the energy shift when we pull into the airport","fits":"sudden change of mood; arriving somewhere"}]}. ` +
        `Give 8–15 formats, each a reusable pattern with ___ for the blank, an example filled in for a dog called ` +
        `${petName}, and the kind of footage it fits. No emoji. Skip anything that depends on a specific audio clip.`,
    },
  ];

  let text = "";
  // Server-side web search can pause long turns; continue until the model finishes.
  for (let turn = 0; turn < 4; turn++) {
    const stream = client.beta.messages.stream({
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      model: config.claude.model,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
      messages,
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("Trend research was declined.");
    messages.push({ role: "assistant", content: msg.content });
    text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (msg.stop_reason !== "pause_turn") break;
  }

  const formats = parseFormats(text);
  if (!formats.length) throw new Error("Trend research returned no usable formats.");
  const trends: Trends = { updatedAt: new Date().toISOString(), source: "claude_web_search", formats };
  store.setTrends(trends);
  return trends;
}

export function parseFormats(text: string): TrendFormat[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return (Array.isArray(parsed.formats) ? parsed.formats : [])
      .filter((f: any) => typeof f?.pattern === "string" && typeof f?.example === "string")
      .map((f: any) => ({ pattern: f.pattern.slice(0, 120), example: f.example.slice(0, 160), fits: String(f.fits ?? "").slice(0, 200) }))
      .slice(0, 20);
  } catch {
    return [];
  }
}
