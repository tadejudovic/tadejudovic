import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { assertBudget, recordCost } from "./budget.ts";
import { structured } from "./director.ts";
import { frameBuffer } from "../media/ffmpeg.ts";
import { newId } from "../store.ts";
import { candidates, chooseHashtags, postCount, tagsOf } from "./hashtags.ts";
import type { PickedHashtag, Platform, PostStats, ProvenCaption } from "../types.ts";

/**
 * Caption research through TikTok's own search, the way the creator does it by
 * hand: search "dog at the boarding gate", look at the videos with the most
 * views, read the text on them.
 *
 * Apify's TikTok scraper returns real search results with view counts. The text
 * shown ON a video isn't in that data (it's part of the picture), so Claude reads
 * it off each video's cover frame, where TikTok overlays almost always appear.
 */

export const apifyEnabled = () => Boolean(config.apify.token);

/** Apify charges per result; this is a deliberately high estimate so the budget errs on the safe side. */
const USD_PER_RESULT = 0.005;
const RESULTS_PER_QUERY = 20;
/** How many of the most-viewed videos get their cover read by Claude. */
const COVERS_TO_READ = 14;
/** How many of those are general (non-pet) videos of the same situation. */
const GENERAL_COVERS = 6;
/** Ignore small videos: the point is wording that's proven to travel. */
const MIN_VIEWS = 20_000;

export interface TikTokVideo {
  url: string;
  description: string;
  views: number;
  likes?: number;
  author?: string;
  cover?: string;
  postedAt?: string;
  tags: string[];
}

/** The same situation without the pet: wording from these works for any audience. */
export function generalQueries(scene: string): string[] {
  const s = scene.toLowerCase();
  return [`${s} pov`, `${s} relatable`];
}

export function searchQueries(scene: string): string[] {
  const s = scene.toLowerCase();
  const travel = /airport|airplane|plane|flight|boarding|check-in|security|gate|terminal|seat/.test(s);
  return [`dog ${s}`, `pov dog ${s}`, travel ? `flying with dog ${s}` : `dog ${s} funny`];
}

/** Map one item of the scraper's output to what we need. Field names vary a little between actor versions. */
export function normalizeItem(it: any): TikTokVideo | null {
  const url = it?.webVideoUrl ?? it?.url ?? it?.videoUrl;
  const views = Number(it?.playCount ?? it?.stats?.playCount ?? it?.views ?? 0);
  if (typeof url !== "string" || !/^https?:\/\//.test(url) || !(views > 0)) return null;
  const author = it?.authorMeta?.name ?? it?.author?.uniqueId ?? it?.authorMeta?.nickName;
  const cover = it?.videoMeta?.coverUrl ?? it?.videoMeta?.originalCoverUrl ?? it?.covers?.default ?? it?.coverUrl;
  const description = String(it?.text ?? it?.desc ?? it?.description ?? "").trim();
  return {
    url,
    description,
    tags: tagsOf(it, description),
    views,
    likes: Number(it?.diggCount ?? it?.stats?.diggCount) || undefined,
    author: typeof author === "string" ? author : undefined,
    cover: typeof cover === "string" && /^https?:\/\//.test(cover) ? cover : undefined,
    postedAt: it?.createTimeISO ?? undefined,
  };
}

export async function searchTikTok(queries: string[]): Promise<TikTokVideo[]> {
  assertBudget();
  const url =
    `https://api.apify.com/v2/acts/${config.apify.actor}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(config.apify.token)}&timeout=240&memory=1024`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      searchQueries: queries,
      resultsPerPage: RESULTS_PER_QUERY,
      searchSection: "/video",
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSubtitles: false,
      shouldDownloadSlideshowImages: false,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (res.status === 401) throw new Error("Apify rejected the token. Check APIFY_TOKEN on Render.");
    if (res.status === 402) throw new Error("Apify account is out of credit.");
    throw new Error(`Apify TikTok search failed (${res.status}): ${body}`);
  }
  const items = (await res.json()) as unknown[];
  recordCost(Math.max(1, items.length) * USD_PER_RESULT);
  const byUrl = new Map<string, TikTokVideo>();
  for (const it of Array.isArray(items) ? items : []) {
    const v = normalizeItem(it);
    if (v && !byUrl.has(v.url)) byUrl.set(v.url, v);
  }
  return [...byUrl.values()].sort((a, b) => b.views - a.views);
}

/** Estimated Apify cost per hashtag looked up (deliberately high, like USD_PER_RESULT). */
const USD_PER_HASHTAG = 0.01;

const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** One item of the hashtag actor's output → [tag, number of posts]. Field names vary between actors/versions. */
export function parseHashtagItem(it: any): [string, number] | null {
  const name = it?.name ?? it?.hashtag ?? it?.hashtagName ?? it?.challengeName ?? it?.title ?? it?.challenge?.title ?? it?.tag;
  const posts =
    num(it?.videoCount) ?? num(it?.stats?.videoCount) ?? num(it?.challengeStats?.videoCount) ??
    num(it?.statsV2?.videoCount) ?? num(it?.postCount) ?? num(it?.posts) ?? num(it?.publishCnt) ?? num(it?.videos);
  if (typeof name !== "string" || !posts) return null;
  return [name.replace(/^#/, "").toLowerCase(), posts];
}

/** How many posts each hashtag has on TikTok, through Apify (one run for all of them). */
export async function hashtagPostCounts(tags: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!tags.length) return counts;
  assertBudget();
  const url =
    `https://api.apify.com/v2/acts/${config.apify.hashtagActor}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(config.apify.token)}&timeout=180&memory=1024`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Only the hashtags' totals ("metadata"), not their videos.
    body: JSON.stringify({ hashtags: tags, mode: "metadata", maxItems: tags.length, resultsPerPage: 1 }),
    signal: AbortSignal.timeout(200_000),
  });
  if (!res.ok) throw new Error(`Apify hashtag lookup failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const items = (await res.json()) as unknown[];
  recordCost(Math.max(1, tags.length) * USD_PER_HASHTAG);
  for (const it of Array.isArray(items) ? items : []) {
    const parsed = parseHashtagItem(it);
    if (parsed && tags.includes(parsed[0]) && !counts.has(parsed[0])) counts.set(...parsed);
  }
  return counts;
}

export const isTikTokPostUrl = (url: string) => /^https:\/\/(www\.|vm\.|vt\.|m\.)?tiktok\.com\//i.test(url.trim());
export const isInstagramPostUrl = (url: string) => /^https:\/\/(www\.)?instagram\.com\/(reel|reels|p|tv)\/[\w-]+/i.test(url.trim());
export const platformOf = (url: string): Platform | undefined =>
  isTikTokPostUrl(url) ? "tiktok" : isInstagramPostUrl(url) ? "instagram" : undefined;

/** A post's public numbers, through Apify. */
export function fetchPostStats(url: string): Promise<{ stats: PostStats; postedAt?: string }> {
  return platformOf(url) === "instagram" ? fetchInstagramStats(url) : fetchTikTokStats(url);
}

/** Instagram shows plays, likes and comments publicly (shares and saves only to the owner). */
async function fetchInstagramStats(url: string): Promise<{ stats: PostStats; postedAt?: string }> {
  assertBudget();
  const api =
    `https://api.apify.com/v2/acts/${config.apify.instagramActor}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(config.apify.token)}&timeout=120&memory=1024`;
  const res = await fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ directUrls: [url.trim()], resultsType: "posts", resultsLimit: 1, addParentData: false }),
    signal: AbortSignal.timeout(150_000),
  });
  if (!res.ok) throw new Error(`Apify couldn't read the Instagram post (${res.status}): ${(await res.text()).slice(0, 160)}`);
  const items = (await res.json()) as any[];
  recordCost(USD_PER_RESULT);
  const it = Array.isArray(items) ? items.find((x) => !x?.error) : undefined;
  if (!it) throw new Error("Instagram didn't return this post. Is the link right and the account public?");
  const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
  // Reels report plays; likes are -1 when the owner hides like counts.
  const views = n(it.videoPlayCount ?? it.igPlayCount ?? it.videoViewCount ?? it.playCount);
  if (views === undefined) throw new Error("Couldn't read the play count (only Reels and videos have one).");
  return {
    stats: { views, likes: n(it.likesCount), comments: n(it.commentsCount) },
    postedAt: typeof it.timestamp === "string" ? it.timestamp : undefined,
  };
}

export interface ProfilePost {
  url: string;
  text: string;
  postedAt?: string;
  stats: PostStats;
}

/** The latest posts on the creator's own profile, with their public numbers (one Apify run). */
export async function fetchProfilePosts(platform: Platform, handle: string, limit = 20): Promise<ProfilePost[]> {
  assertBudget();
  const name = handle.trim().replace(/^@/, "");
  const actor = platform === "instagram" ? config.apify.instagramActor : config.apify.actor;
  const input =
    platform === "instagram"
      ? { directUrls: [`https://www.instagram.com/${name}/`], resultsType: "posts", resultsLimit: limit, addParentData: false }
      : { profiles: [name], resultsPerPage: limit, profileScrapeSections: ["videos"], profileSorting: "latest", shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSubtitles: false, shouldDownloadSlideshowImages: false };
  const res = await fetch(
    `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(config.apify.token)}&timeout=240&memory=1024`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(280_000) },
  );
  if (!res.ok) throw new Error(`Apify couldn't read the ${platform} profile (${res.status}): ${(await res.text()).slice(0, 160)}`);
  const items = ((await res.json()) as any[]).filter((x) => x && !x.error);
  recordCost(Math.max(1, items.length) * USD_PER_RESULT);
  const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
  return items.flatMap((it): ProfilePost[] => {
    if (platform === "instagram") {
      const views = n(it.videoPlayCount ?? it.igPlayCount ?? it.videoViewCount);
      if (typeof it.url !== "string" || views === undefined) return []; // only videos
      return [{ url: it.url, text: String(it.caption ?? ""), postedAt: it.timestamp, stats: { views, likes: n(it.likesCount), comments: n(it.commentsCount) } }];
    }
    const url = it.webVideoUrl ?? it.url;
    const views = n(it.playCount ?? it.stats?.playCount);
    if (typeof url !== "string" || views === undefined) return [];
    return [{
      url,
      text: String(it.text ?? it.desc ?? ""),
      postedAt: it.createTimeISO,
      stats: { views, likes: n(it.diggCount), comments: n(it.commentCount), shares: n(it.shareCount), saves: n(it.collectCount) },
    }];
  });
}

async function fetchTikTokStats(url: string): Promise<{ stats: PostStats; postedAt?: string }> {
  assertBudget();
  const api =
    `https://api.apify.com/v2/acts/${config.apify.actor}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(config.apify.token)}&timeout=120&memory=1024`;
  const res = await fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      postURLs: [url.trim()],
      resultsPerPage: 1,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSubtitles: false,
      shouldDownloadSlideshowImages: false,
    }),
    signal: AbortSignal.timeout(150_000),
  });
  if (!res.ok) throw new Error(`Apify couldn't read the post (${res.status}): ${(await res.text()).slice(0, 160)}`);
  const items = (await res.json()) as any[];
  recordCost(USD_PER_RESULT);
  const it = Array.isArray(items) ? items[0] : undefined;
  if (!it) throw new Error("TikTok didn't return this post. Is the link right and the post public?");
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  const views = n(it.playCount ?? it.stats?.playCount ?? it.views);
  if (views === undefined) throw new Error("Couldn't read the view count for this post.");
  return {
    stats: {
      views,
      likes: n(it.diggCount ?? it.stats?.diggCount),
      comments: n(it.commentCount ?? it.stats?.commentCount),
      shares: n(it.shareCount ?? it.stats?.shareCount),
      saves: n(it.collectCount ?? it.stats?.collectCount),
    },
    postedAt: typeof it.createTimeISO === "string" ? it.createTimeISO : undefined,
  };
}

const READ_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["videos"],
  properties: {
    videos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "relevant", "onScreenText", "reusableCaption"],
        properties: {
          n: { type: "integer", description: "The video's number" },
          relevant: { type: "boolean", description: "Pet video: a pet in the situation. General video: about the situation and relatable to anyone" },
          onScreenText: { type: "string", description: "The text overlaid on the cover frame, exactly as written, or empty" },
          reusableCaption: {
            type: "string",
            description: "The overlay (or, if none, the post caption's hook) cleaned of hashtags/emoji, or empty if nothing reusable",
          },
        },
      },
    },
  },
};

async function coverImage(url: string, tmp: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    // Re-encode to a small JPEG (covers can be webp/heic; keeps the request small too).
    return (await frameBuffer(tmp, 0, 480)).toString("base64");
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export interface TikTokResearch {
  captions: ProvenCaption[];
  hashtags: PickedHashtag[];
  hashtagNote?: string;
}

/** Search TikTok for a situation: captions of the most-viewed relevant videos, and three hashtags from them. */
export async function researchSceneOnTikTok(scene: string, petName: string): Promise<TikTokResearch> {
  // Pet videos in the situation, and general videos of the same situation (for text that speaks to
  // everyone, not only dog lovers). A failed general search doesn't sink the research.
  const [petResults, generalResults] = await Promise.all([
    searchTikTok(searchQueries(scene)),
    searchTikTok(generalQueries(scene)).catch((err: Error) => {
      console.warn(`[research] general search for ${scene}: ${err.message}`);
      return [] as TikTokVideo[];
    }),
  ]);
  const popular = petResults.filter((v) => v.views >= MIN_VIEWS);
  const petUrls = new Set(popular.map((v) => v.url));
  const general = generalResults.filter((v) => v.views >= MIN_VIEWS && !petUrls.has(v.url));
  if (!popular.length && !general.length) return { captions: [], hashtags: [], hashtagNote: "No videos with 20K+ views found for this search." };
  // Most-viewed of each kind, so both kinds of caption come back.
  const videos: (TikTokVideo & { audience: "pets" | "everyone" })[] = [
    ...popular.slice(0, COVERS_TO_READ - GENERAL_COVERS).map((v) => ({ ...v, audience: "pets" as const })),
    ...general.slice(0, GENERAL_COVERS).map((v) => ({ ...v, audience: "everyone" as const })),
  ];

  // Post counts come from Apify; TikTok's own page is only a fallback (it usually blocks us).
  const cands = candidates([...popular, ...general]).slice(0, 20);
  let apifyError: string | undefined;
  const counts = await hashtagPostCounts(cands.map((c) => c.tag)).catch((err: Error) => {
    apifyError = err.message;
    console.warn(`[hashtags] ${scene}: ${err.message}`);
    return new Map<string, number>();
  });
  const { picked, looked, found } = await chooseHashtags(cands, async (tag) => counts.get(tag) ?? (counts.size ? undefined : postCount(tag)));
  const hashtagNote =
    picked.length === 3 ? undefined
    : !looked ? "The top videos had no hashtags."
    : !found ? `Couldn't read hashtag post counts${apifyError ? ` (${apifyError.slice(0, 120)})` : ""}, so the AI picks hashtags for now.`
    : `Only found ${picked.length} of 3 hashtags in the right size ranges.`;

  const content: any[] = [];
  for (const [i, v] of videos.entries()) {
    const img = v.cover ? await coverImage(v.cover, path.join(config.tmpDir, `cover-${newId()}`)) : null;
    content.push({
      type: "text",
      text: `Video ${i + 1} (${v.audience === "pets" ? "pet video" : "general video"}): ${v.views.toLocaleString("en")} views. Post caption: "${v.description}"`,
    });
    if (img) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img } });
  }
  content.push({
    type: "text",
    text:
      `These are TikTok search results for "${scene}": pet videos, and general videos of the same situation. For each ` +
      `video, read the text overlaid on its cover frame and say whether it's relevant: a pet video is relevant if it ` +
      `shows a pet in (or is clearly about) that situation; a general video is relevant if it's about that situation ` +
      `and its text is relatable to anyone who has been there. reusableCaption should be wording another creator could ` +
      `put on a video of their own dog (${petName}) in the same situation; for general videos keep it about the shared ` +
      `human moment so it still speaks to people who aren't into dogs.`,
  });

  const out = await structured<{ videos: { n: number; relevant: boolean; onScreenText: string; reusableCaption: string }[] }>({
    system: "You read TikTok video covers and extract their on-screen text precisely. Never invent text that isn't there.",
    content,
    schema: READ_SCHEMA,
    effort: "low",
    model: config.claude.fastModel,
  });

  const now = new Date().toISOString();
  const captions: ProvenCaption[] = [];
  for (const r of out.videos) {
    const v = videos[r.n - 1];
    const text = r.reusableCaption.trim();
    if (!v || !r.relevant || !text) continue;
    captions.push({
      id: newId(),
      text: text.slice(0, 200),
      // The source as it really is, so a reference can be checked against the video.
      original: (r.onScreenText.trim() || `(post caption) ${v.description}`).slice(0, 200),
      views: v.views,
      url: v.url,
      kind: r.onScreenText.trim() ? "overlay" : "description",
      audience: v.audience,
      note: [v.author && `@${v.author}`, v.postedAt?.slice(0, 10), v.likes && `${v.likes.toLocaleString("en")} likes`]
        .filter(Boolean)
        .join(", "),
      foundAt: now,
    });
  }
  return { captions: captions.sort((a, b) => (b.views ?? 0) - (a.views ?? 0)), hashtags: picked, hashtagNote };
}
