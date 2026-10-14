import { BudgetExceeded } from "./budget.ts";
import { store, newId } from "../store.ts";
import { apifyEnabled, researchSceneOnTikTok } from "./tiktokSearch.ts";
import type { PickedHashtag, ProvenCaption, SceneResearch } from "../types.ts";

/**
 * Caption research, the automated version of what the creator does by hand:
 * search TikTok for videos of a dog in the same situation (e.g. "security
 * check"), find the ones with lots of views, and note the text they used.
 *
 * Searches TikTok itself through Apify (real results, real view counts; see
 * tiktokSearch.ts). That is the only source of caption ideas; the creator's own
 * captions are always kept alongside.
 */

export const RESEARCH_MAX_AGE_MS = 14 * 86400_000;

export function researchStale(scene: string): boolean {
  const r = store.research(scene);
  if (!r?.updatedAt) return true;
  // Once TikTok search is connected, older web-search results are redone right away.
  if (apifyEnabled() && r.source !== "tiktok") return true;
  return Date.now() - Date.parse(r.updatedAt) > RESEARCH_MAX_AGE_MS;
}

/** Proven captions for a situation, most-viewed first; creator-added ones always included. */
export function provenCaptions(scene: string | undefined, limit = 12): ProvenCaption[] {
  if (!scene) return [];
  const r = store.research(scene);
  // Only TikTok-search results (and the creator's own); older web-search finds are ignored.
  const caps = (r?.captions ?? []).filter((c) => c.kind === "creator" || r?.source === "tiktok");
  return [...caps].sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, limit);
}

const running = new Map<string, Promise<SceneResearch>>();

export function researchScene(scene: string): Promise<SceneResearch> {
  if (!running.has(scene)) {
    running.set(
      scene,
      doResearch(scene).finally(() => running.delete(scene)),
    );
  }
  return running.get(scene)!;
}

async function doResearch(scene: string): Promise<SceneResearch> {
  const { petName } = store.settings();
  const previous = store.research(scene);
  const creatorCaptions = (previous?.captions ?? []).filter((c) => c.kind === "creator");
  if (apifyEnabled()) {
    try {
      const found = await researchSceneOnTikTok(scene, petName);
      return store.setResearch({
        scene,
        source: "tiktok",
        updatedAt: new Date().toISOString(),
        captions: [...creatorCaptions, ...found.captions],
        // Keep the previous hashtags if this time the post counts couldn't be read.
        hashtags: found.hashtags.length ? found.hashtags : previous?.hashtags,
        hashtagNote: found.hashtagNote,
      });
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err;
      store.setResearch({ scene, source: previous?.source, hashtags: previous?.hashtags, updatedAt: previous?.updatedAt, error: (err as Error).message, captions: previous?.captions ?? [] });
      throw err;
    }
  }
  // Caption ideas come only from TikTok itself (via Apify), never from general web pages.
  const error = "Connect Apify (APIFY_TOKEN on Render) to find captions on TikTok.";
  store.setResearch({ scene, source: previous?.source, hashtags: previous?.hashtags, updatedAt: previous?.updatedAt, error, captions: previous?.captions ?? [] });
  throw new Error(error);
}

export function parseCaptions(text: string): ProvenCaption[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    const now = new Date().toISOString();
    return (Array.isArray(parsed.captions) ? parsed.captions : [])
      .filter((c: any) => typeof c?.text === "string" && c.text.trim())
      .map((c: any) => ({
        id: newId(),
        text: c.text.trim().slice(0, 200),
        views: typeof c.views === "number" && c.views > 0 ? Math.round(c.views) : undefined,
        url: typeof c.url === "string" && /^https?:\/\//.test(c.url) ? c.url.slice(0, 500) : undefined,
        kind: c.kind === "description" ? "description" : "overlay",
        note: typeof c.note === "string" ? c.note.slice(0, 200) : undefined,
        foundAt: now,
      }))
      .slice(0, 15);
  } catch {
    return [];
  }
}

export function addCreatorCaption(scene: string, c: { text: string; views?: number; url?: string; note?: string }) {
  const r = store.research(scene) ?? { scene, captions: [] };
  const caption: ProvenCaption = {
    id: newId(),
    text: c.text.trim().slice(0, 200),
    views: c.views,
    url: c.url && /^https?:\/\//.test(c.url) ? c.url.slice(0, 500) : undefined,
    note: c.note?.slice(0, 200),
    kind: "creator",
    foundAt: new Date().toISOString(),
  };
  store.setResearch({ ...r, captions: [caption, ...r.captions] });
  return caption;
}

export function removeCaption(scene: string, id: string) {
  const r = store.research(scene);
  if (r) store.setResearch({ ...r, captions: r.captions.filter((c) => c.id !== id) });
}

/** The three researched hashtags for a situation (with post counts), if there are any. */
export function researchedHashtags(scene: string | undefined): PickedHashtag[] {
  return scene ? store.research(scene)?.hashtags ?? [] : [];
}
