import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { assertBudget, recordCost } from "./budget.ts";
import { structured } from "./director.ts";
import { frameBuffer } from "../media/ffmpeg.ts";
import { newId } from "../store.ts";
import { candidates, chooseHashtags, tagsOf } from "./hashtags.ts";
import type { PickedHashtag, ProvenCaption } from "../types.ts";

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
const COVERS_TO_READ = 12;
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
          relevant: { type: "boolean", description: "A pet in (or clearly about) the searched situation" },
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
  const popular = (await searchTikTok(searchQueries(scene))).filter((v) => v.views >= MIN_VIEWS);
  if (!popular.length) return { captions: [], hashtags: [], hashtagNote: "No videos with 20K+ views found for this search." };
  const videos = popular.slice(0, COVERS_TO_READ);

  const { picked, looked, found } = await chooseHashtags(candidates(popular));
  const hashtagNote =
    picked.length === 3 ? undefined
    : !looked ? "The top videos had no hashtags."
    : !found ? "Couldn't read hashtag post counts from TikTok, so the AI picks hashtags for now."
    : `Only found ${picked.length} of 3 hashtags in the right size ranges.`;

  const content: any[] = [];
  for (const [i, v] of videos.entries()) {
    const img = v.cover ? await coverImage(v.cover, path.join(config.tmpDir, `cover-${newId()}`)) : null;
    content.push({ type: "text", text: `Video ${i + 1}: ${v.views.toLocaleString("en")} views. Post caption: "${v.description}"` });
    if (img) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img } });
  }
  content.push({
    type: "text",
    text:
      `These are TikTok search results for pets at "${scene}". For each video, read the text overlaid on its cover ` +
      `frame and say whether it's relevant. reusableCaption should be wording another creator could put on a video of ` +
      `their own dog (${petName}) in the same situation.`,
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
      views: v.views,
      url: v.url,
      kind: r.onScreenText.trim() ? "overlay" : "description",
      note: [v.author && `@${v.author}`, v.postedAt?.slice(0, 10), v.likes && `${v.likes.toLocaleString("en")} likes`]
        .filter(Boolean)
        .join(", "),
      foundAt: now,
    });
  }
  return { captions: captions.sort((a, b) => (b.views ?? 0) - (a.views ?? 0)), hashtags: picked, hashtagNote };
}
