import zlib from "node:zlib";
import { config } from "./config.ts";
import { store } from "./store.ts";
import { structured } from "./ai/director.ts";
import type { EduPillar, SearchTopic } from "./types.ts";

/**
 * What people search for before landing on the creator's TikToks (TikTok Studio → Analytics →
 * Search → export: a zip with Queries.csv). Grouped into topics per educational theme, so the
 * educational videos answer what's actually being searched, in the searcher's words.
 */

export interface SearchQuery {
  query: string;
  clicks: number;
  /** TikTok: impressions; Google Keyword Planner: average monthly searches. */
  impressions: number;
}

export type SearchSource = "tiktok" | "google" | "comments";

/** The files in a zip archive (stored or deflated entries; enough for TikTok's export). */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("That isn't a zip file.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, zlib.inflateRawSync(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** Rows of a CSV (quoted fields may hold commas, quotes and line breaks). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((f) => f.trim()));
}

/**
 * The searches in an export: TikTok Studio's search analytics (the zip, or its Queries.csv), or
 * Google Ads Keyword Planner's keyword stats (UTF-16, tab-separated, two title lines on top).
 */
export function readQueries(buf: Buffer, filename = ""): SearchQuery[] {
  return readExport(buf, filename).queries;
}

export function readExport(buf: Buffer, filename = ""): { source: SearchSource; queries: SearchQuery[] } {
  let text: string;
  if (buf.readUInt32LE(0) === 0x04034b50 || /\.zip$/i.test(filename)) {
    const files = unzip(buf);
    const entry = [...files.entries()].find(([name]) => /(^|\/)queries\.csv$/i.test(name));
    if (!entry) throw new Error("No Queries.csv in that zip. Export it from TikTok Studio → Analytics → Search.");
    text = entry[1].toString("utf8");
  } else if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString("utf16le");
  else text = buf.toString("utf8");
  text = text.replace(/^\uFEFF/, "");
  // Keyword Planner: tab-separated, the header row starts with "Keyword".
  const lines = text.split(/\r?\n/);
  const kp = lines.findIndex((l) => /^Keyword\t/.test(l));
  if (kp >= 0) {
    const head = lines[kp].split("\t");
    const k = head.indexOf("Keyword");
    const v = head.findIndex((h) => /avg\. monthly searches/i.test(h));
    if (v < 0) throw new Error("That Keyword Planner file has no monthly searches column.");
    const queries = lines
      .slice(kp + 1)
      .map((l) => l.split("\t"))
      .map((r) => ({ query: r[k]?.trim() ?? "", clicks: 0, impressions: Number((r[v] ?? "").replace(/[,\s]/g, "")) || 0 }))
      .filter((r) => r.query);
    return { source: "google", queries };
  }
  const [head, ...rows] = parseCsv(text);
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const q = col(/quer/i);
  const c = col(/click/i);
  const im = col(/impression/i);
  if (q < 0 || im < 0) throw new Error("That file isn't a TikTok search export or a Google Keyword Planner export.");
  const queries = rows
    .map((r) => ({ query: r[q]?.trim() ?? "", clicks: Number(r[c]) || 0, impressions: Number(r[im]) || 0 }))
    .filter((r) => r.query && !/^site:/i.test(r.query));
  return { source: "tiktok", queries };
}

const THEMES: EduPillar[] = ["airline", "destination", "airport", "prep"];

/** Groups the queries into topics for the educational themes (off-topic searches are dropped). */
export async function groupQueries(queries: SearchQuery[], source: SearchSource = "tiktok"): Promise<SearchTopic[]> {
  // Searches only about other animals would take the places of dog ones in the 300 looked at.
  const otherAnimal = /\b(cats?|kittens?|rabbits?|bunny|bunnies|birds?|hamsters?|ferrets?|guinea pigs?)\b/i;
  const top = queries
    .filter((q) => !otherAnimal.test(q.query))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 400);
  const r = await structured<{ topics: { topic: string; key: string; theme: string; queries: number[] }[] }>({
    system: "You plan educational videos for a creator who travels the world with their dog.",
    content: [
      {
        type: "text",
        text:
          (source === "google"
            ? `What people search on Google, with average monthly searches (Google Ads Keyword Planner):\n`
            : source === "comments"
              ? `Questions people asked in the comments on the creator's own TikToks (with 1 + the comment's likes):\n`
              : `What people searched on Google before finding the creator's TikToks (with how often they saw it):\n`) +
          top.map((x, i) => `${i + 1}. ${x.query} (${x.impressions})`).join("\n") +
          `\n\nGroup the searches that ask the same thing into topics an educational video could answer, e.g. "easyJet pet ` +
          `policy" for "does easyjet allow pets in cabin", "easyjet dog policy", "can you take a dog on easyjet". Leave out ` +
          `searches that aren't about traveling with a dog: breeds, puppies for sale, unrelated travel, and searches only about ` +
          `cats, rabbits, birds or hamsters (general "pet" searches stay), and "fly" in the other senses (flies the ` +
          `insect, flyball, a dog snapping at flies). Buying-intent searches for gear ("dog carrier", ` +
          `"airline approved dog carrier") become topics a creator can answer ("What makes a carrier airline-approved"). ` +
          `Getting around by car or train with a dog (car sickness, trains) counts as prep. For each topic: ` +
          `a short name in the searchers' words, a "key" (the one or two words that identify it in a video's text, e.g. ` +
          `"easyJet", "weight limit"), the theme (airline: flights & airlines; destination: a country's rules and papers ` +
          `or dog-friendly places; airport: at the airport; prep: accessories, the bag, flight prep, during the flight), ` +
          `and the numbers of its searches.`,
      },
    ],
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["topics"],
      properties: {
        topics: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["topic", "key", "theme", "queries"],
            properties: {
              topic: { type: "string" },
              key: { type: "string" },
              theme: { type: "string", enum: THEMES },
              queries: { type: "array", items: { type: "integer" } },
            },
          },
        },
      },
    },
    effort: "low",
    model: config.claude.fastModel,
  });
  return r.topics
    .map((t) => {
      const qs = [...new Set(t.queries)].map((n) => top[n - 1]).filter((x): x is SearchQuery => !!x);
      return {
        topic: t.topic.trim(),
        key: t.key.trim(),
        pillar: t.theme as EduPillar,
        queries: qs.sort((a, b) => b.impressions - a.impressions).slice(0, 6).map((x) => x.query),
        impressions: qs.reduce((a, x) => a + x.impressions, 0),
        clicks: qs.reduce((a, x) => a + x.clicks, 0),
        source,
      };
    })
    .filter((t) => t.topic && t.queries.length)
    .sort((a, b) => b.impressions - a.impressions);
}

export async function importSearchExport(buf: Buffer, filename?: string): Promise<{ source: SearchSource; topics: SearchTopic[] }> {
  if (!config.claude.enabled) throw new Error("Sorting searches into topics needs the AI (ANTHROPIC_API_KEY).");
  const { source, queries: added } = readExport(buf, filename);
  if (!added.length) throw new Error("No searches in that file.");
  // Keyword Planner exports add up (each one is a different set of seed words); TikTok's replaces the last.
  const queries = source === "google" ? mergeQueries(store.settings().keywordQueries ?? [], added) : added;
  const topics = await groupQueries(queries, source);
  const at = new Date().toISOString();
  store.updateSettings(
    source === "google" ? { keywordTopics: topics, keywordTopicsAt: at, keywordQueries: queries } : { searchTopics: topics, searchTopicsAt: at },
  );
  console.log(`[search] ${source}: ${added.length} searches added, ${queries.length} in all → ${topics.length} topic(s)`);
  return { source, topics };
}

/** Searches of several exports together, one row per search (the newest export's numbers). */
export function mergeQueries(before: SearchQuery[], added: SearchQuery[]): SearchQuery[] {
  const byQuery = new Map(before.map((q) => [q.query.toLowerCase(), q]));
  for (const q of added) byQuery.set(q.query.toLowerCase(), q);
  return [...byQuery.values()];
}

/** Both lists: TikTok's (what brought people to this account) and Google's (what everyone searches). */
export function allSearchTopics(): SearchTopic[] {
  const { searchTopics, keywordTopics, audience } = store.settings();
  return [...(audience?.topics ?? []), ...(searchTopics ?? []).map((t) => ({ ...t, source: t.source ?? ("tiktok" as const) })), ...(keywordTopics ?? [])];
}

/** Whether an educational video in the last 45 days already answered this topic. */
export function searchTopicUsed(t: SearchTopic): boolean {
  const key = t.key.toLowerCase();
  if (!key) return false;
  return store
    .renders()
    .some(
      (r) =>
        r.plan.format === "tips" && r.review !== "rejected" && Date.now() - Date.parse(r.createdAt) < 45 * 86400_000 &&
        [r.plan.topic, r.plan.hook, r.plan.searchTopic, ...(r.plan.overlays ?? []).map((o) => o.text)].some((s) => s?.toLowerCase().includes(key)),
    );
}

/**
 * The most-searched topics of a theme not answered recently, for the next educational video. Every
 * other one: the searches are what brought people to this account's videos, not everything people
 * want to know, so they inform the mix without taking it over.
 */
export function searchTopicsFor(pillar: EduPillar | undefined, n = 3): SearchTopic[] {
  const p = pillar === "gear" ? "prep" : pillar;
  const last = store
    .renders()
    .filter((r) => r.plan.format === "tips" && r.review !== "rejected" && (r.plan.pillar === "gear" ? "prep" : r.plan.pillar) === p)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (last?.plan.searchTopic) return [];
  // The sources take turns, each in its own order (their numbers aren't comparable): what the
  // audience asked in the comments first, then what brought people to the account, then Google.
  const { searchTopics, keywordTopics, audience } = store.settings();
  const open = (list?: SearchTopic[]) => (list ?? []).filter((t) => t.pillar === p && !searchTopicUsed(t));
  const lists = [open(audience?.topics), open(searchTopics), open(keywordTopics)];
  const out: SearchTopic[] = [];
  for (let i = 0; out.length < n && lists.some((l) => i < l.length); i++)
    for (const l of lists) if (l[i] && out.length < n) out.push(l[i]);
  return out;
}
