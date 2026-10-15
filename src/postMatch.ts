import { store } from "./store.ts";
import { apifyEnabled, fetchProfilePosts, type ProfilePost } from "./ai/tiktokSearch.ts";
import type { Platform, PostedInfo, Render } from "./types.ts";

/**
 * Finding posted videos on the creator's own profiles, so they don't have to paste links: the
 * latest posts are read once, matched to Rollcut videos by their description (the creator pastes
 * the one Rollcut wrote, maybe with small edits), and every recent post's stats are refreshed
 * from the same read.
 */

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/#[\p{L}\p{N}_]+/gu, " ")
      .replace(/@[\w.]+/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );

/** How alike two descriptions are, 0..1: shared words over the shorter one. */
export function captionSimilarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (A.size < 3 || B.size < 3) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/** Videos that may have been posted on this platform and aren't linked to a post there yet. */
export function unmatched(platform: Platform, now = Date.now()): Render[] {
  return store
    .renders()
    .filter(
      (r) =>
        r.review === "approved" &&
        r.status === "done" &&
        now - Date.parse(r.reviewedAt ?? r.createdAt) < 21 * 86400_000 &&
        !(r.posts ?? []).some((p) => p.platform === platform),
    );
}

const MIN_SIMILARITY = 0.5;

/** Link profile posts to videos (best caption match first, each once) and refresh known posts' stats. */
export function applyProfilePosts(platform: Platform, posts: ProfilePost[], now = new Date()): { matched: number; refreshed: number } {
  const fetchedAt = now.toISOString();
  let refreshed = 0;
  // Posts already linked (by URL): refresh their numbers.
  const known = new Map<string, { r: Render; p: PostedInfo }>();
  for (const r of store.renders()) for (const p of r.posts ?? []) if (p.platform === platform) known.set(p.url, { r, p });
  const fresh: ProfilePost[] = [];
  for (const post of posts) {
    const k = known.get(post.url);
    if (!k) {
      fresh.push(post);
      continue;
    }
    update(k.r.id, platform, { stats: post.stats, postedAt: post.postedAt ?? k.p.postedAt, fetchedAt, error: undefined });
    refreshed++;
  }
  // New posts: match to unlinked videos by description, posted after the video was approved.
  const pairs: { post: ProfilePost; r: Render; score: number }[] = [];
  for (const post of fresh) {
    for (const r of unmatched(platform, now.getTime())) {
      if (post.postedAt && Date.parse(post.postedAt) < Date.parse(r.createdAt) - 3600_000) continue;
      const score = Math.max(captionSimilarity(post.text, r.plan.postCaption ?? ""), captionSimilarity(post.text, r.plan.hook ?? "") * 0.9);
      if (score >= MIN_SIMILARITY) pairs.push({ post, r, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedPosts = new Set<string>();
  const usedRenders = new Set<string>();
  let matched = 0;
  for (const { post, r } of pairs) {
    if (usedPosts.has(post.url) || usedRenders.has(r.id)) continue;
    usedPosts.add(post.url);
    usedRenders.add(r.id);
    const current = store.render(r.id)!;
    store.updateRender(r.id, {
      posts: [...(current.posts ?? []), { platform, url: post.url, addedAt: fetchedAt, postedAt: post.postedAt, stats: post.stats, fetchedAt }],
    });
    matched++;
  }
  return { matched, refreshed };
}

function update(renderId: string, platform: Platform, patch: Partial<PostedInfo>) {
  const r = store.render(renderId);
  if (!r) return;
  store.updateRender(r.id, { posts: (r.posts ?? []).map((p) => (p.platform === platform ? { ...p, ...patch } : p)) });
}

/** The creator's handles that can be checked. */
export function profileHandles(): { platform: Platform; handle: string }[] {
  const { handle, instagramHandle } = store.settings();
  const out: { platform: Platform; handle: string }[] = [];
  if (handle?.trim()) out.push({ platform: "tiktok", handle: handle.trim() });
  if (instagramHandle?.trim()) out.push({ platform: "instagram", handle: instagramHandle.trim() });
  return out;
}

const lastCheck = new Map<Platform, number>();

/**
 * Check the profiles: every 6 hours while there are videos waiting to be found, otherwise once a
 * day while recent posts need fresh numbers.
 */
let syncing = false;

export async function syncProfiles(now = Date.now()): Promise<void> {
  if (!apifyEnabled() || syncing) return;
  syncing = true;
  try {
    await checkProfiles(now);
  } finally {
    syncing = false;
  }
}

async function checkProfiles(now: number): Promise<void> {
  for (const { platform, handle } of profileHandles()) {
    const waiting = unmatched(platform, now).length > 0;
    const recentPosts = store.renders().some((r) => (r.posts ?? []).some((p) => p.platform === platform && now - Date.parse(p.postedAt ?? p.addedAt) < 14 * 86400_000));
    if (!waiting && !recentPosts) continue;
    const every = waiting ? 6 * 3600_000 : 22 * 3600_000;
    if (now - (lastCheck.get(platform) ?? 0) < every) continue;
    lastCheck.set(platform, now);
    try {
      const posts = await fetchProfilePosts(platform, handle);
      const { matched, refreshed } = applyProfilePosts(platform, posts);
      if (matched || refreshed) console.log(`[profiles] ${platform}: found ${matched} new post(s), refreshed ${refreshed}`);
    } catch (err) {
      console.warn(`[profiles] ${platform} @${handle}: ${(err as Error).message}`);
    }
  }
}
