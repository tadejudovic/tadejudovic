import type { PickedHashtag } from "../types.ts";

/**
 * Hashtags, the way the creator picks them: look at the hashtags on the
 * most-viewed videos for the situation, check how many posts each has on
 * TikTok, and use exactly three:
 *   - one big tag (1M–5M posts; not the huge ones like #dog where a video drowns),
 *   - one mid tag (50K–100K posts),
 *   - one small tag (around 10K posts).
 */
export const TIERS: { tier: PickedHashtag["tier"]; min: number; max: number; wideMin: number; wideMax: number }[] = [
  { tier: "big", min: 1_000_000, max: 5_000_000, wideMin: 700_000, wideMax: 7_000_000 },
  { tier: "mid", min: 50_000, max: 100_000, wideMin: 30_000, wideMax: 200_000 },
  { tier: "small", min: 5_000, max: 20_000, wideMin: 2_000, wideMax: 30_000 },
];

export interface TagCandidate {
  tag: string;
  /** Total views of the top videos that used it: how strongly it's tied to what works. */
  score: number;
  posts?: number;
}

/** Hashtags on a scraped video: the structured list if present, otherwise #words in the description. */
export function tagsOf(item: any, description: string): string[] {
  const list = Array.isArray(item?.hashtags) ? item.hashtags.map((h: any) => (typeof h === "string" ? h : h?.name)) : [];
  const fromText = [...description.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]);
  return [...new Set([...list, ...fromText].filter((t) => typeof t === "string" && t).map((t: string) => t.toLowerCase()))];
}

/** Rank hashtags by how much the top videos that used them were watched. */
export function candidates(videos: { views: number; tags: string[] }[]): TagCandidate[] {
  const score = new Map<string, number>();
  for (const v of videos) for (const t of v.tags) score.set(t, (score.get(t) ?? 0) + v.views);
  return [...score].map(([tag, s]) => ({ tag, score: s })).sort((a, b) => b.score - a.score);
}

/** One per tier: the best-scoring tag inside the range, else inside a slightly wider range. */
export function pickThree(cands: TagCandidate[]): PickedHashtag[] {
  const picked: PickedHashtag[] = [];
  const used = new Set<string>();
  for (const t of TIERS) {
    const within = (lo: number, hi: number) =>
      cands.find((c) => !used.has(c.tag) && c.posts !== undefined && c.posts >= lo && c.posts <= hi);
    const c = within(t.min, t.max) ?? within(t.wideMin, t.wideMax);
    if (c) {
      used.add(c.tag);
      picked.push({ tag: c.tag, posts: c.posts!, tier: t.tier });
    }
  }
  return picked;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** Read a "videoCount" (number of posts) out of TikTok's JSON or page HTML. */
export function parseVideoCount(text: string): number | undefined {
  const m = text.match(/"videoCount"\s*:\s*"?(\d+)"?/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** How many posts a hashtag has on TikTok, from TikTok's public hashtag data. */
export async function postCount(tag: string): Promise<number | undefined> {
  const urls = [
    `https://www.tiktok.com/api/challenge/detail/?challengeName=${encodeURIComponent(tag)}`,
    `https://www.tiktok.com/tag/${encodeURIComponent(tag)}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(6_000) });
      if (!res.ok) continue;
      const n = parseVideoCount(await res.text());
      if (n) return n;
    } catch {}
  }
  return undefined;
}

/** Look up post counts for the strongest candidates (sequentially, gently) and pick three. */
export async function chooseHashtags(cands: TagCandidate[], lookup = postCount, max = 20): Promise<{ picked: PickedHashtag[]; looked: number; found: number }> {
  const top = cands.slice(0, max);
  let found = 0;
  let missesInARow = 0;
  for (const c of top) {
    c.posts = await lookup(c.tag);
    if (c.posts) found++;
    // TikTok often blocks these lookups outright; don't spend minutes confirming it.
    missesInARow = c.posts ? 0 : missesInARow + 1;
    if (!found && missesInARow >= 3) break;
  }
  return { picked: pickThree(top), looked: top.length, found };
}
