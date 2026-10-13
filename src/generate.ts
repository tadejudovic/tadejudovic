import fs from "node:fs";
import { config } from "./config.ts";
import { store, newId } from "./store.ts";
import { heuristicPlan, stretchToTarget } from "./planner.ts";
import { directClip, planVideos, type DirectContext } from "./ai/director.ts";
import { currentTrends } from "./ai/trends.ts";
import { renderVideo } from "./media/render.ts";
import { renderQueue } from "./queue.ts";
import type { Clip, GenerateRequest, Render, VideoPlan } from "./types.ts";

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

export async function plan(req: GenerateRequest): Promise<{ plans: VideoPlan[]; warning?: string }> {
  const all = store.clips().filter((c) => c.status === "ready" && isPortrait(c));
  const clips = req.clipIds?.length ? all.filter((c) => req.clipIds!.includes(c.id)) : all;
  if (!clips.length) throw new Error("No analyzed portrait clips available. Import some vertical footage first.");
  const { petName, handle } = store.settings();
  const aiOn = req.useAi && config.claude.enabled;
  let warning = req.useAi && !config.claude.enabled ? "ANTHROPIC_API_KEY is not set; used the heuristic planner." : undefined;

  if (req.template === "auto") {
    // Footage first: each video is built around one clip, directed from what's in it.
    const chosen = rankClips(clips).slice(0, req.count);
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
      trends: currentTrends().formats,
      brief: req.brief,
      recentOverlays,
    };
    const overlays = [...currentTrends().formats].sort(() => Math.random() - 0.5);
    const failures: string[] = [];
    const plans = await mapLimit(chosen, 2, async (clip, i) => {
      if (aiOn) {
        try {
          const p = await directClip(clip, ctx);
          ctx.recentOverlays.unshift(p.hook);
          return p;
        } catch (err) {
          failures.push((err as Error).message);
        }
      }
      const p = heuristicPlan({ template: "auto", targetSeconds: req.targetSeconds, clips: [clip], petName, used: new Map() });
      // Without the AI director, overlays are generic trend examples; review and edit them before posting.
      if (overlays.length) p.hook = p.title = overlays[i % overlays.length].example.replaceAll("{pet}", petName);
      p.postCaption = `${p.hook} 🐾`;
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
        trends: currentTrends().formats,
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
  const overlays = [...currentTrends().formats].sort(() => Math.random() - 0.5);
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
  });
  renderQueue.push(async () => {
    store.updateRender(render.id, { status: "rendering" });
    try {
      const clips = new Map(store.clips().map((c) => [c.id, c]));
      const result = await renderVideo(render.id, planned, clips, options, (p) =>
        store.updateRender(render.id, { progress: Math.round(p * 100) / 100 }),
      );
      store.updateRender(render.id, { status: "done", progress: 1, ...result });
      for (const id of countUse ? new Set(planned.segments.map((s) => s.clipId)) : []) {
        const c = store.clip(id);
        if (c) store.updateClip(id, { uses: c.uses + 1 });
      }
    } catch (err) {
      store.updateRender(render.id, { status: "error", error: (err as Error).message });
    }
  });
  return render;
}

export function deleteRender(id: string) {
  const r = store.render(id);
  if (!r) return;
  for (const f of [r.file, r.thumb]) if (f) fs.rmSync(f, { force: true });
  store.removeRender(id);
}
