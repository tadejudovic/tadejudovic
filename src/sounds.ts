import { config } from "./config.ts";
import { store } from "./store.ts";
import { assertBudget, recordCost } from "./ai/budget.ts";
import { apifyEnabled } from "./ai/tiktokSearch.ts";
import { structured } from "./ai/director.ts";
import type { Render } from "./types.ts";

/**
 * Trending TikTok sounds, measured rather than guessed. Every few days a sample of recent posts in
 * the creator's world (travel, airports, dogs, POV) is read; each sound's posts are counted per
 * day of posting, and the history is kept. A sound is "trending" when more and more new posts pick
 * it up: the last 3 days against the 11 before them (the hockey stick), not how big it already is.
 * TikTok doesn't let an app put a library sound on a video file, so these are recommendations with
 * a link: the creator taps "Use this sound" in TikTok when posting.
 */

export const SOUND_QUERIES = ["traveltok", "travel pov", "airport pov", "flying with dog", "dog travel", "dogsoftiktok", "travel vlog", "plane pov"];
const RESULTS_PER_QUERY = 30;
/** Apify charges per result (a deliberately high estimate, like the caption research's). */
const USD_PER_RESULT = 0.005;
/** How often the sample is read. */
export const SOUNDS_EVERY_MS = 3 * 86400_000;

export interface SoundStats {
  id: string;
  name: string;
  author?: string;
  /** A creator's own audio ("original sound - …") rather than a song from the library. */
  original?: boolean;
  /** Posts seen using it, per day of posting (YYYY-MM-DD). */
  daily: Record<string, number>;
  /** Plays of the posts seen with it (most recent sample). */
  plays: number;
  /** The most-played post seen with it, as an example. */
  example?: string;
  lastSeen: string;
}

export interface TrendingSound {
  id: string;
  name: string;
  author?: string;
  original?: boolean;
  url: string;
  /** New posts with it in the last 3 days, and in the 11 days before. */
  recent: number;
  before: number;
  /** How much faster it's being picked up now than before (per day). */
  growth: number;
  plays: number;
  example?: string;
}

/** One scraper item's sound, if it has one. Field names vary between actor versions. */
export function soundOf(it: any): { id: string; name: string; author?: string; original?: boolean } | null {
  const m = it?.musicMeta ?? it?.music ?? {};
  const id = String(m.musicId ?? m.id ?? "").trim();
  const name = String(m.musicName ?? m.title ?? "").trim();
  if (!id || !name) return null;
  const author = String(m.musicAuthor ?? m.authorName ?? "").trim() || undefined;
  const original = Boolean(m.musicOriginal ?? m.original ?? /^original sound/i.test(name));
  return { id, name, author, original };
}

const day = (iso: string) => iso.slice(0, 10);

/** Add one sample's posts to the history (kept 30 days). */
export function addSample(items: unknown[], now = new Date()): number {
  const sounds = { ...(store.settings().sounds ?? {}) } as Record<string, SoundStats>;
  const seenNow = new Map<string, number>();
  let counted = 0;
  const seenPosts = new Set<string>();
  const before = new Set(store.settings().soundPostsSeen ?? []);
  const keys: string[] = [];
  for (const it of items as any[]) {
    const s = soundOf(it);
    const url = it?.webVideoUrl ?? it?.url;
    const posted = it?.createTimeISO ?? (it?.createTime ? new Date(Number(it.createTime) * 1000).toISOString() : undefined);
    if (!s || !posted || typeof url !== "string" || seenPosts.has(url)) continue;
    seenPosts.add(url);
    const plays = Number(it?.playCount ?? it?.stats?.playCount ?? 0) || 0;
    const cur: SoundStats = sounds[s.id] ?? { ...s, daily: {}, plays: 0, lastSeen: now.toISOString() };
    // Each post once: a post seen in an earlier sample isn't counted twice for its day.
    const key = `${s.id}:${url}`;
    if (!before.has(key)) {
      cur.daily[day(posted)] = (cur.daily[day(posted)] ?? 0) + 1;
      keys.push(key);
    }
    seenNow.set(s.id, (seenNow.get(s.id) ?? 0) + plays);
    if (!cur.example || plays > (cur.plays ?? 0)) cur.example = url;
    cur.lastSeen = now.toISOString();
    sounds[s.id] = { ...cur, name: s.name, author: s.author, original: s.original };
    counted++;
  }
  for (const [id, plays] of seenNow) sounds[id].plays = plays;
  // Forget days older than 30 and sounds not seen in 30 days.
  const cutoff = day(new Date(now.getTime() - 30 * 86400_000).toISOString());
  for (const [id, s] of Object.entries(sounds)) {
    s.daily = Object.fromEntries(Object.entries(s.daily).filter(([d]) => d >= cutoff));
    if (s.lastSeen < cutoff) delete sounds[id];
  }
  const remembered = [...before, ...keys].slice(-20_000);
  store.updateSettings({ sounds, soundPostsSeen: remembered, soundsAt: now.toISOString() });
  return counted;
}

/**
 * The top sounds by how fast they're being picked up: posts per day in the last 3 days against
 * the 11 days before (smoothed so one post doesn't look like a trend). Needs a few posts recently.
 */
export function trendingSounds(n = 10, now = new Date()): TrendingSound[] {
  const sounds = Object.values((store.settings().sounds ?? {}) as Record<string, SoundStats>);
  const since = (days: number) => day(new Date(now.getTime() - days * 86400_000).toISOString());
  const recentFrom = since(3);
  const beforeFrom = since(14);
  return sounds
    .map((s) => {
      let recent = 0;
      let before = 0;
      for (const [d, c] of Object.entries(s.daily)) {
        if (d >= recentFrom) recent += c;
        else if (d >= beforeFrom) before += c;
      }
      const growth = recent / 3 / ((before + 1) / 11);
      return {
        id: s.id,
        name: s.name,
        author: s.author,
        original: s.original,
        url: `https://www.tiktok.com/music/${encodeURIComponent(s.name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, ""))}-${s.id}`,
        recent,
        before,
        growth: Math.round(growth * 10) / 10,
        plays: s.plays,
        example: s.example,
      };
    })
    .filter((s) => s.recent >= 3 && s.growth >= 1.5)
    .sort((a, b) => b.growth * Math.log2(2 + b.recent) - a.growth * Math.log2(2 + a.recent) || b.plays - a.plays)
    .slice(0, n);
}

/** Read a fresh sample of recent posts from TikTok (Apify) and add it to the history. */
export async function refreshSounds(): Promise<number> {
  if (!apifyEnabled()) throw new Error("Trending sounds need Apify (APIFY_TOKEN on Render).");
  assertBudget();
  const url = `https://api.apify.com/v2/acts/${config.apify.actor}/run-sync-get-dataset-items?token=${encodeURIComponent(config.apify.token)}&timeout=280&memory=1024`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      searchQueries: SOUND_QUERIES,
      resultsPerPage: RESULTS_PER_QUERY,
      searchSection: "/video",
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSubtitles: false,
      shouldDownloadSlideshowImages: false,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Apify sound sample failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const items = (await res.json()) as unknown[];
  recordCost(Math.max(1, items.length) * USD_PER_RESULT);
  const n = addSample(Array.isArray(items) ? items : []);
  console.log(`[sounds] ${n} post(s) with a sound read; ${trendingSounds().length} trending`);
  return n;
}

/**
 * The trending sounds that fit a video (its kind, mood and concept), best first: a small AI call,
 * kept on the video. Library songs come first for fun and inspirational videos; a voiceover-style
 * original sound can fit an educational one.
 */
export async function soundsFor(r: Render): Promise<{ id: string; name: string; author?: string; url: string; why: string }[]> {
  if (r.plan.sounds?.length) return r.plan.sounds;
  const top = trendingSounds(15);
  if (!top.length) return [];
  const pick = await structured<{ picks: { n: number; why: string }[] }>({
    system: "You pick background sounds for short videos on TikTok.",
    content: [
      {
        type: "text",
        text:
          `The video (${r.plan.format === "tips" ? "educational" : r.plan.format === "inspire" ? "inspirational" : "fun"}): ${r.plan.concept ?? ""}\n` +
          `On-screen text: ${(r.plan.overlays ?? []).map((o) => o.text).join(" / ")}\n\n` +
          `Sounds being picked up fast on TikTok right now:\n` +
          top.map((s, i) => `${i + 1}. "${s.name}"${s.author ? ` by ${s.author}` : ""}${s.original ? " (a creator's original audio)" : ""}: ${s.recent} new posts in 3 days, ${s.growth}x faster than before`).join("\n") +
          `\n\nPick up to 3 that fit this video's mood and pacing (an inspirational video wants something warm or ` +
          `emotional, a fun one something playful or with a beat for the punchline, an educational one something ` +
          `light that doesn't fight the text), best first, each with a few words on why. Leave out ones that would ` +
          `clash (a sad song under a joke, lyrics that say something odd over the text).`,
      },
    ],
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["picks"],
      properties: {
        picks: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["n", "why"], properties: { n: { type: "integer" }, why: { type: "string" } } },
        },
      },
    },
    effort: "low",
    model: config.claude.fastModel,
  });
  const out = pick.picks
    .map((p) => ({ s: top[p.n - 1], why: p.why.trim() }))
    .filter((x) => x.s)
    .slice(0, 3)
    .map(({ s, why }) => ({ id: s.id, name: s.name, author: s.author, url: s.url, why }));
  store.updateRender(r.id, { plan: { ...r.plan, sounds: out } });
  return out;
}
