import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { assertBudget, BudgetExceeded, recordUsage } from "./budget.ts";
import { store, newId } from "../store.ts";
import { apifyEnabled, researchSceneOnTikTok } from "./tiktokSearch.ts";
import type { PickedHashtag, ProvenCaption, SceneResearch } from "../types.ts";

/**
 * Caption research, the automated version of what the creator does by hand:
 * search TikTok for videos of a dog in the same situation (e.g. "security
 * check"), find the ones with lots of views, and note the text they used.
 *
 * With an Apify token this searches TikTok itself (real results, real view
 * counts; see tiktokSearch.ts). Without one, Claude uses server-side web search
 * and web fetch, which only sees what's publicly indexed (post descriptions,
 * TikTok "discover" pages, articles), so view counts are reported only when a
 * source shows them. The creator's own captions are always kept.
 */

export const RESEARCH_MAX_AGE_MS = 7 * 86400_000;

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
  const caps = store.research(scene)?.captions ?? [];
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
        // Keep last week's hashtags if this time the post counts couldn't be read.
        hashtags: found.hashtags.length ? found.hashtags : previous?.hashtags,
        hashtagNote: found.hashtagNote,
      });
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err;
      store.setResearch({ scene, source: previous?.source, hashtags: previous?.hashtags, updatedAt: previous?.updatedAt, error: (err as Error).message, captions: previous?.captions ?? [] });
      throw err;
    }
  }
  const client = new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content:
        `I post TikToks of my dog ${petName} traveling. Next video is a clip of ${petName} at: "${scene}".\n\n` +
        `Do what I'd do by hand: search for TikTok videos of dogs (or other pets) in this exact situation ` +
        `("${scene}", at an airport or on a plane) that got a lot of views, and collect the on-screen text or captions they ` +
        `used. Try several phrasings (e.g. "dog ${scene} tiktok", "POV dog ${scene}", "flying with dog ${scene}") and ` +
        `look at TikTok video pages, TikTok discover/search pages, and articles about viral pet travel videos.\n\n` +
        `Rules:\n` +
        `- Only report a view count if a source you saw shows it (e.g. "2.1M views", or likes as a fallback in "note"). Never estimate.\n` +
        `- Include the URL where you saw it.\n` +
        `- kind = "overlay" if it's the text shown on the video, "description" if it's the post caption.\n` +
        `- Prefer text that could be reused for a different dog in the same situation.\n\n` +
        `Reply with ONLY a JSON object, no prose: {"captions":[{"text":"...","views":1200000,"url":"https://...","kind":"overlay","note":"@account, date"}]}. ` +
        `Use null for views if unknown. Up to 15 captions, most-viewed first.`,
    },
  ];

  let text = "";
  try {
    for (let turn = 0; turn < 5; turn++) {
      assertBudget();
      const stream = client.beta.messages.stream({
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        model: config.claude.model,
        max_tokens: 32000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        tools: [
          { type: "web_search_20260209", name: "web_search", max_uses: 8 },
          { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6 },
        ],
        messages,
      });
      const msg = await stream.finalMessage();
      recordUsage(msg);
      if (msg.stop_reason === "refusal") throw new Error("Research was declined.");
      messages.push({ role: "assistant", content: msg.content });
      text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      if (msg.stop_reason !== "pause_turn") break;
    }
    const found = parseCaptions(text);
    const result: SceneResearch = {
      scene,
      source: "web",
      updatedAt: new Date().toISOString(),
      captions: [...creatorCaptions, ...found],
    };
    return store.setResearch(result);
  } catch (err) {
    // Budget stops aren't failures of the research itself; let it run again once there's budget.
    if (err instanceof BudgetExceeded) throw err;
    const failed: SceneResearch = {
      scene,
      hashtags: previous?.hashtags,
      source: previous?.source,
      updatedAt: previous?.updatedAt,
      error: (err as Error).message,
      captions: previous?.captions ?? [],
    };
    store.setResearch(failed);
    throw err;
  }
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
