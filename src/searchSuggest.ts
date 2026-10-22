import { config } from "./config.ts";
import { store } from "./store.ts";
import { groupQueries, type SearchQuery } from "./searchDemand.ts";

/**
 * What people type into Google and YouTube search about traveling with a dog: the autocomplete
 * suggestions for a set of seed questions, refreshed weekly. Free (no API key), and unlike the
 * creator's exports it updates itself. Its numbers are ranks, not volumes: a suggestion offered
 * first, for many seeds, counts most.
 */
export const SEEDS = [
  "flying with a dog",
  "dog on a plane",
  "dog in cabin",
  "small dog flight",
  "airline pet policy",
  "dog carrier airline approved",
  "dog passport",
  "travel to europe with a dog",
  "bring dog to another country",
  "dog health certificate travel",
  "rabies titer test dog",
  "cdc dog import",
  "dog at the airport",
  "pet relief area airport",
  "dog layover",
  "dog security airport",
  "calm dog on flight",
  "traveling with a dog",
];
const PREFIXES = ["", "how to ", "can ", "what ", "best "];

async function suggest(q: string, ds?: "yt"): Promise<string[]> {
  const params = new URLSearchParams({ client: "firefox", hl: "en", q, ...(ds ? { ds } : {}) });
  const res = await fetch(`https://suggestqueries.google.com/complete/search?${params}`, {
    headers: { "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`suggest ${res.status}`);
  const body = (await res.json()) as [string, string[]];
  return Array.isArray(body?.[1]) ? body[1].filter((s) => typeof s === "string") : [];
}

/** Every suggestion, scored by how high it was offered (10 for first … 1), summed over seeds. */
export async function collectSuggestions(seeds = SEEDS): Promise<SearchQuery[]> {
  const score = new Map<string, number>();
  for (const seed of seeds)
    for (const prefix of PREFIXES)
      for (const ds of [undefined, "yt"] as const) {
        const list = await suggest(`${prefix}${seed}`, ds).catch(() => [] as string[]);
        list.slice(0, 10).forEach((s, i) => {
          const key = s.trim().toLowerCase();
          if (key) score.set(key, (score.get(key) ?? 0) + (10 - i));
        });
        await new Promise((r) => setTimeout(r, 250)); // gentle on Google
      }
  return [...score.entries()].map(([query, impressions]) => ({ query, impressions, clicks: 0 }));
}

/** Refresh the autocomplete topics (weekly, from the scheduler; once on deploy). */
export async function refreshSuggestTopics(): Promise<number> {
  if (!config.claude.enabled) return 0;
  const queries = await collectSuggestions();
  if (queries.length < 10) throw new Error(`only ${queries.length} suggestions came back`);
  const topics = await groupQueries(queries, "suggest");
  store.updateSettings({ suggestTopics: topics, suggestTopicsAt: new Date().toISOString() });
  console.log(`[search] autocomplete: ${queries.length} searches → ${topics.length} topic(s)`);
  return topics.length;
}
