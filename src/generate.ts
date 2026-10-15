import fs from "node:fs";
import { config } from "./config.ts";
import { momentsOf, recentlyUsedMoments } from "./moments.ts";
import { store, newId } from "./store.ts";
import { heuristicPlan, stretchToTarget } from "./planner.ts";
import { directClip, planVideos, type DirectContext } from "./ai/director.ts";
import { provenCaptions, researchedHashtags, researchScene, researchStale } from "./ai/research.ts";
import { renderVideo } from "./media/render.ts";
import { ingestQueue, renderQueue } from "./queue.ts";
import type { Clip, GenerateRequest, Render, ReviewFeedback, VideoPlan } from "./types.ts";

function applyHashtags(p: VideoPlan, scene: string | undefined) {
  const info = researchedHashtags(scene);
  if (!info.length) return;
  p.hashtags = withResearchedTags(info.map((h) => h.tag), p.hashtags);
  p.hashtagInfo = info;
}

/** Exactly three hashtags: the researched ones (big, mid, small), topped up from the AI's if fewer were found. */
export function withResearchedTags(researched: string[], fallback: string[]): string[] {
  const out = [...researched];
  for (const t of fallback) if (out.length < 3 && !out.includes(t.toLowerCase())) out.push(t.toLowerCase());
  return out.slice(0, 3);
}

/**
 * What the creator kept and swiped away recently, so the director learns their taste:
 * overlay text, situation and (for rejections) what was wrong.
 */
export function reviewFeedback(limit = 15): ReviewFeedback {
  const reviewed = store
    .renders()
    .filter((r) => r.review !== "pending" && r.status === "done" && r.plan.hook)
    .sort((a, b) => Date.parse(b.reviewedAt ?? b.createdAt) - Date.parse(a.reviewedAt ?? a.createdAt));
  const item = (r: Render) => ({ text: r.plan.overlays?.map((o) => o.text).join(" / ") || r.plan.hook, scene: r.plan.scene, basedOn: r.plan.basedOn?.text });
  return {
    kept: reviewed.filter((r) => r.review === "approved").slice(0, limit).map(item),
    rejected: reviewed.filter((r) => r.review === "rejected").slice(0, limit).map((r) => ({ ...item(r), reason: r.rejectReason })),
  };
}

/**
 * Whether a clip may be used automatically: with "only my situations" on, it must have been
 * sorted into one of the creator's situations (airport, plane…), not "other" (beach, random).
 * Without the AI there are no situations, so everything counts.
 */
export function onTopic(c: Clip): boolean {
  // Videos that are already edits (text on them) are never re-edited automatically, and a video
  // that's in two albums is only used once.
  if (c.edited || c.duplicateOf) return false;
  const { onlySituations, scenes } = store.settings();
  if (!onlySituations || !config.claude.enabled) return true;
  return !!c.scene && scenes.includes(c.scene);
}

/** Portrait footage only: landscape clips are kept in the library but never used. */
export const isPortrait = (c: Clip) => c.height >= c.width;

/**
 * Choose which clips to build videos from: unused footage first, then the
 * clips with the strongest moments.
 */
export function rankClips(clips: Clip[]): Clip[] {
  const best = (c: Clip) => Math.max(0, ...(c.ai?.moments ?? c.moments ?? []).map((m) => m.score));
  return [...clips].sort((a, b) => a.uses - b.uses || best(b) - best(a));
}

/**
 * Pick clips for a batch the way the creator does: proven situations first,
 * rotating so the feed doesn't show the same situation twice in a row, and
 * within a situation the freshest, strongest clip.
 */
export function pickBySituation(clips: Clip[], count: number): Clip[] {
  const scenes = store.settings().scenes;
  const recent = store.renders().filter((r) => Date.now() - Date.parse(r.createdAt) < 14 * 86400_000);
  const postedLately = (scene: string) => recent.filter((r) => r.plan.scene === scene).length;
  const groups = new Map<string, Clip[]>();
  for (const c of rankClips(clips)) {
    const key = c.scene && scenes.includes(c.scene) ? c.scene : "other";
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const order = [...groups.keys()].sort((a, b) => {
    // "other" (unclassified) last; then least-posted situations first; then the creator's order.
    if ((a === "other") !== (b === "other")) return a === "other" ? 1 : -1;
    return postedLately(a) - postedLately(b) || scenes.indexOf(a) - scenes.indexOf(b);
  });
  // Similar shots: at most one take per moment in a round, and none from a moment used in the last
  // few days. Within a situation the clips are ranked, so the strongest take of a moment is used.
  const moment = momentsOf(store.clips());
  const momentOf = (c: Clip) => moment.get(c.id) ?? c.id;
  const pick = (spaced: boolean) => {
    const blocked = spaced ? recentlyUsedMoments(moment) : new Set<string>();
    const taken = new Set<string>();
    const next = new Map(order.map((s) => [s, 0]));
    const picked: Clip[] = [];
    while (picked.length < count) {
      let added = false;
      for (const scene of order) {
        if (picked.length >= count) break;
        const list = groups.get(scene)!;
        let i = next.get(scene)!;
        while (i < list.length && (taken.has(momentOf(list[i])) || blocked.has(momentOf(list[i])))) i++;
        next.set(scene, i + 1);
        if (i < list.length) {
          picked.push(list[i]);
          taken.add(momentOf(list[i]));
          added = true;
        }
      }
      if (!added) break;
    }
    return picked;
  };
  const picked = pick(true);
  // Only if spacing leaves nothing at all: better a take of a recent moment than no video.
  return picked.length ? picked : pick(false);
}

/**
 * `onPlan` is called as soon as each video's plan is ready (one-clip videos), so it can start
 * rendering while the AI is still writing the others.
 */
export async function plan(
  req: GenerateRequest,
  { onPlan }: { onPlan?: (p: VideoPlan) => void } = {},
): Promise<{ plans: VideoPlan[]; warning?: string }> {
  const all = store.clips().filter((c) => c.status === "ready" && isPortrait(c));
  // Footage the creator rejected is only used when they pick it themselves.
  const clips = req.clipIds?.length ? all.filter((c) => req.clipIds!.includes(c.id)) : all.filter((c) => c.uses === 0 && !c.disliked && onTopic(c));
  if (!clips.length) throw new Error("No analyzed portrait clips available. Import some vertical footage first.");
  const { petName, handle } = store.settings();
  const aiOn = req.useAi && config.claude.enabled;
  let warning = req.useAi && !config.claude.enabled ? "ANTHROPIC_API_KEY is not set; used the heuristic planner." : undefined;

  if (req.template === "auto") {
    // Footage first: each video is built around one clip, directed from what's in it.
    const chosen = req.clipIds?.length ? rankClips(clips).slice(0, req.count) : pickBySituation(clips, req.count);
    // Each situation needs caption research (TikTok's most-viewed videos) before its first video.
    // Research that's merely old is still used, and refreshed later, so it never holds up a round.
    if (aiOn) {
      const scenes = [...new Set(chosen.map((c) => c.scene).filter((x): x is string => !!x && x !== "other"))];
      const never = scenes.filter((sc) => researchStale(sc) && !store.research(sc)?.captions.length);
      await mapLimit(never, 2, (scene) =>
        researchScene(scene).catch((err) => console.warn(`[research] ${scene}:`, (err as Error).message)),
      );
    }
    const recentOverlays = store
      .renders()
      .slice(0, 30)
      .map((r) => r.plan.hook)
      .filter(Boolean);
    const ctx: DirectContext = {
      petName,
      handle,
      minSeconds: Math.max(6, req.targetSeconds - 3),
      maxSeconds: req.targetSeconds + 5,
      examples: store.examples().filter((e) => e.status === "ready"),
      trends: [], // caption ideas come only from TikTok search (Apify)
      brief: req.brief,
      recentOverlays,
      proven: [],
      feedback: reviewFeedback(),
      story: store.settings().story,
    };
    const overlays: { example: string }[] = [];
    const failures: string[] = [];
    // "mix": every other video speaks to everyone, starting with the first.
    const { captionAudience } = store.settings();
    const audienceFor = (i: number): "pets" | "everyone" =>
      captionAudience === "everyone" ? "everyone" : captionAudience === "pets" ? "pets" : i % 2 === 0 ? "everyone" : "pets";
    const plans = await mapLimit(chosen, 2, async (clip, i) => {
      if (aiOn) {
        try {
          const p = await directClip(clip, { ...ctx, proven: provenCaptions(clip.scene), audience: audienceFor(i) });
          applyHashtags(p, clip.scene);
          ctx.recentOverlays.unshift(p.hook);
          onPlan?.(p);
          return p;
        } catch (err) {
          failures.push((err as Error).message);
        }
      }
      const p = heuristicPlan({ template: "auto", targetSeconds: req.targetSeconds, clips: [clip], petName, used: new Map() });
      // Without the AI director: use a proven caption for the clip's situation if there is one,
      // otherwise a generic trend example. Review and edit before posting.
      const proven = provenCaptions(clip.scene);
      const pc = proven[i % Math.max(1, proven.length)];
      if (pc) {
        p.hook = p.title = pc.text;
        p.basedOn = { text: pc.text, views: pc.views, url: pc.url };
      } else if (overlays.length) p.hook = p.title = overlays[i % overlays.length].example.replaceAll("{pet}", petName);
      p.scene = clip.scene;
      p.postCaption = `${p.hook} 🐾`;
      applyHashtags(p, clip.scene);
      onPlan?.(p);
      return p;
    });
    if (failures.length) warning = `AI director failed on ${failures.length} clip(s) (${failures[0]}); used heuristics for those.`;
    if (chosen.length < req.count) {
      warning = [warning, `Only ${chosen.length} usable clip(s), so only ${chosen.length} video(s).`].filter(Boolean).join(" ");
    }
    return { plans, warning };
  }

  if (aiOn) {
    try {
      const plans = await planVideos({
        template: req.template,
        targetSeconds: req.targetSeconds,
        count: req.count,
        brief: req.brief,
        clips,
        petName,
        handle,
        trends: [], // caption ideas come only from TikTok search (Apify)
      });
      if (plans.length) {
        // Models are approximate with arithmetic; snap each plan to the requested length.
        const byId = new Map(clips.map((c) => [c.id, c]));
        for (const p of plans) p.segments = stretchToTarget(p.segments, byId, req.targetSeconds);
        return { plans: plans.slice(0, req.count) };
      }
      warning = "Claude returned no usable plans; used the heuristic planner instead.";
    } catch (err) {
      warning = `AI director unavailable (${(err as Error).message}); used the heuristic planner instead.`;
    }
  }

  const used = new Map<string, number>();
  const plans: VideoPlan[] = [];
  const overlays: { example: string }[] = [];
  for (let i = 0; i < req.count; i++) {
    const p = heuristicPlan({ template: req.template, targetSeconds: req.targetSeconds, clips, petName, used });
    if (req.template === "text_overlay" && overlays.length) {
      p.hook = p.title = overlays[i % overlays.length].example.replaceAll("{pet}", petName);
      p.postCaption = `${p.hook} 🐾`;
    }
    for (const s of p.segments) used.set(s.clipId, (used.get(s.clipId) ?? 0) + 1);
    plans.push(p);
  }
  return { plans, warning };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

export function queueRender(
  planned: VideoPlan,
  options: GenerateRequest["options"],
  batch?: string,
  { countUse = true } = {},
): Render {
  const render = store.addRender({
    id: newId(),
    createdAt: new Date().toISOString(),
    plan: planned,
    options,
    status: "queued",
    progress: 0,
    review: "pending",
    batch,
    countUse,
  });
  enqueueRenderJob(render.id);
  return render;
}

/**
 * Each clip is used once. A rejected video hands its clips back so they can be tried again with a
 * new edit, unless the clip itself was the problem ("Bad clip"); undoing the rejection takes them again.
 */
export function syncClipUses(id: string) {
  const r = store.render(id);
  if (!r || r.status !== "done") return;
  const giveBack = r.review === "rejected" && r.rejectReason !== "clip";
  if (giveBack === !!r.usesReturned) return;
  for (const clipId of new Set(r.plan.segments.map((s) => s.clipId))) {
    const c = store.clip(clipId);
    if (c) store.updateClip(clipId, { uses: Math.max(0, c.uses + (giveBack ? -1 : 1)) });
  }
  store.updateRender(id, { usesReturned: giveBack });
}

/** Queue a failed or interrupted render again, with the same plan. */
export function retryRender(id: string, { urgent = true } = {}): Render | undefined {
  const r = store.render(id);
  if (!r) return undefined;
  store.updateRender(id, { status: "queued", progress: 0, error: undefined, review: "pending" });
  enqueueRenderJob(id, urgent);
  return store.render(id);
}

function enqueueRenderJob(id: string, urgent = true) {
  (urgent ? renderQueue : ingestQueue).push(async () => {
    const render = store.render(id);
    if (!render) return; // deleted while waiting
    store.updateRender(id, { status: "rendering" });
    try {
      const clips = new Map(store.clips().map((c) => [c.id, c]));
      const result = await renderVideo(id, render.plan, clips, render.options, (p) =>
        store.updateRender(id, { progress: Math.round(p * 100) / 100 }),
      );
      store.updateRender(id, { status: "done", progress: 1, ...result });
      if (render.countUse !== false && !render.usesCounted) {
        for (const clipId of new Set(render.plan.segments.map((s) => s.clipId))) {
          const c = store.clip(clipId);
          if (c) store.updateClip(clipId, { uses: c.uses + 1 });
        }
        // Count once, even if this render is retried later.
        store.updateRender(id, { usesCounted: true });
      }
    } catch (err) {
      store.updateRender(id, { status: "error", error: (err as Error).message });
    }
  }, { kind: "render", id });
}

export function deleteRender(id: string) {
  const r = store.render(id);
  if (!r) return;
  for (const f of [r.file, r.thumb]) if (f) fs.rmSync(f, { force: true });
  store.removeRender(id);
}
