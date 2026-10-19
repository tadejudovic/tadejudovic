import { config } from "./config.ts";
import { store } from "./store.ts";
import { assertBudget, recordCost } from "./ai/budget.ts";
import { fetchProfilePosts, type ProfilePost } from "./ai/tiktokSearch.ts";
import { groupQueries } from "./searchDemand.ts";
import type { SearchTopic } from "./types.ts";

/**
 * Learning from the creator's own TikTok: the posts of the last N days with their numbers, and the
 * questions people ask in the comments, grouped into topics for the educational videos. Comments are
 * paid per comment fetched, so only videos with a few comments are read, at most COMMENTS_PER_POST
 * each, no reply threads, and old posts only once; then only real questions count.
 */
const COMMENTS_PER_POST = 40;
const MIN_COMMENTS = 3;
const USD_PER_COMMENT = 0.001; // on the high side, like the other Apify estimates
const MAX_POSTS = 200;

export interface Comment {
  text: string;
  likes: number;
  author?: string;
  post: string;
}

const QUESTION_START = /^(how|where|which|what|whats|what's|when|why|who|can|could|does|do|did|is|are|was|will|would|should|any|anyone)\b/i;

/** A comment worth learning from: a real question of a few words, not an emoji, a tag or the creator. */
export function isQuestion(c: Comment, creator?: string): boolean {
  const text = c.text.replace(/@\S+/g, "").replace(/\p{Extended_Pictographic}|‍|️/gu, "").replace(/\s+/g, " ").trim();
  if (creator && c.author && c.author.replace(/^@/, "").toLowerCase() === creator.replace(/^@/, "").toLowerCase()) return false;
  if (text.split(" ").filter((w) => /\p{L}/u.test(w)).length < 4) return false;
  return text.includes("?") || QUESTION_START.test(text);
}

/** Questions, the same one asked twice counted once (the most-liked copy kept). */
export function dedupeQuestions(cs: Comment[]): Comment[] {
  const key = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  const best = new Map<string, Comment>();
  for (const c of cs) {
    const k = key(c.text);
    const had = best.get(k);
    if (!had || c.likes > had.likes) best.set(k, c);
  }
  return [...best.values()].sort((a, b) => b.likes - a.likes);
}

async function fetchComments(urls: string[]): Promise<Comment[]> {
  if (!urls.length) return [];
  assertBudget();
  const res = await fetch(
    `https://api.apify.com/v2/acts/${config.apify.commentsActor}/run-sync-get-dataset-items?token=${encodeURIComponent(config.apify.token)}&timeout=280&memory=1024`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postURLs: urls, commentsPerPost: COMMENTS_PER_POST, maxRepliesPerComment: 0 }),
      signal: AbortSignal.timeout(300_000),
    },
  );
  if (!res.ok) throw new Error(`Apify couldn't read the comments (${res.status}): ${(await res.text()).slice(0, 160)}`);
  const items = ((await res.json()) as any[]).filter((x) => x && !x.error);
  recordCost(Math.max(1, items.length) * USD_PER_COMMENT);
  return items
    .map((it) => ({
      text: String(it.text ?? ""),
      likes: Number(it.diggCount ?? it.likes ?? 0) || 0,
      author: it.uniqueId ?? it.user?.uniqueId ?? it.author,
      post: String(it.videoWebUrl ?? it.postUrl ?? it.submittedVideoUrl ?? ""),
    }))
    .filter((c) => c.text.trim());
}

/**
 * Read the last `days` of the creator's TikTok: posts and their numbers, and the comments of the
 * posts that have some (new posts, and posts under two weeks old for their newest comments).
 */
export async function learnFromTikTok(days = 90): Promise<NonNullable<ReturnType<typeof store.settings>["audience"]>> {
  const handle = store.settings().handle?.trim();
  if (!handle) throw new Error("Add your TikTok handle in Settings → Profile first.");
  if (!config.apify.token) throw new Error("Connect Apify (APIFY_TOKEN on Render) to read your TikTok.");
  const since = Date.now() - days * 86400_000;
  const posts = (await fetchProfilePosts("tiktok", handle, MAX_POSTS)).filter((p) => !p.postedAt || Date.parse(p.postedAt) >= since);
  const before = store.settings().audience;
  const scanned = { ...(before?.scanned ?? {}) };
  const fresh = (p: ProfilePost) => !p.postedAt || Date.now() - Date.parse(p.postedAt) < 14 * 86400_000;
  const toRead = posts.filter((p) => (p.stats.comments ?? 0) >= MIN_COMMENTS && (!scanned[p.url] || fresh(p)));
  const comments = await fetchComments(toRead.map((p) => p.url));
  const now = new Date().toISOString();
  for (const p of toRead) scanned[p.url] = now;
  const questions = dedupeQuestions([
    ...(before?.questions ?? []).filter((q) => posts.some((p) => p.url === q.post) || !q.post),
    ...comments.filter((c) => isQuestion(c, handle)),
  ]).slice(0, 400);
  // The questions, grouped into topics for the four educational themes (most asked and liked first).
  const topics: SearchTopic[] = questions.length
    ? (await groupQueries(questions.map((q) => ({ query: q.text.slice(0, 160), clicks: 0, impressions: 1 + q.likes })), "comments")).map((t) => ({ ...t, source: "comments" as const }))
    : [];
  // The posts people saved and shared most for their views: what the audience found worth keeping.
  const topPosts = posts
    .filter((p) => p.stats.views >= 300)
    .map((p) => ({ url: p.url, text: p.text.slice(0, 200), views: p.stats.views, saves: p.stats.saves ?? 0, shares: p.stats.shares ?? 0 }))
    .sort((a, b) => (b.saves + b.shares) / b.views - (a.saves + a.shares) / a.views)
    .slice(0, 10);
  const audience = { at: now, days, posts: posts.length, commentsRead: (before?.commentsRead ?? 0) + comments.length, questions, topics, topPosts, scanned };
  store.updateSettings({ audience });
  console.log(`[audience] ${posts.length} posts, ${comments.length} comments read, ${questions.length} questions → ${topics.length} topic(s)`);
  return audience;
}
