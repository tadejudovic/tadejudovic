import fs from "node:fs";
import { config } from "./config.ts";
import { store, newId } from "./store.ts";
import { heuristicPlan, stretchToTarget } from "./planner.ts";
import { planVideos } from "./ai/director.ts";
import { renderVideo } from "./media/render.ts";
import { renderQueue } from "./queue.ts";
import type { GenerateRequest, Render, VideoPlan } from "./types.ts";

export async function plan(req: GenerateRequest): Promise<{ plans: VideoPlan[]; warning?: string }> {
  const all = store.clips().filter((c) => c.status === "ready");
  const clips = req.clipIds?.length ? all.filter((c) => req.clipIds!.includes(c.id)) : all;
  if (!clips.length) throw new Error("No analyzed clips available. Import some footage first.");
  const { petName, handle } = store.settings();
  let warning: string | undefined;

  if (req.useAi && config.claude.enabled) {
    try {
      const plans = await planVideos({
        template: req.template,
        targetSeconds: req.targetSeconds,
        count: req.count,
        brief: req.brief,
        clips,
        petName,
        handle,
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
  } else if (req.useAi) {
    warning = "ANTHROPIC_API_KEY is not set; used the heuristic planner.";
  }

  const used = new Map<string, number>();
  const plans: VideoPlan[] = [];
  for (let i = 0; i < req.count; i++) {
    const p = heuristicPlan({ template: req.template, targetSeconds: req.targetSeconds, clips, petName, used });
    for (const s of p.segments) used.set(s.clipId, (used.get(s.clipId) ?? 0) + 1);
    plans.push(p);
  }
  return { plans, warning };
}

export function queueRender(planned: VideoPlan, options: GenerateRequest["options"]): Render {
  const render = store.addRender({
    id: newId(),
    createdAt: new Date().toISOString(),
    plan: planned,
    options,
    status: "queued",
    progress: 0,
  });
  renderQueue.push(async () => {
    store.updateRender(render.id, { status: "rendering" });
    try {
      const clips = new Map(store.clips().map((c) => [c.id, c]));
      const result = await renderVideo(render.id, planned, clips, options, store.settings().handle, (p) =>
        store.updateRender(render.id, { progress: Math.round(p * 100) / 100 }),
      );
      store.updateRender(render.id, { status: "done", progress: 1, ...result });
      for (const id of new Set(planned.segments.map((s) => s.clipId))) {
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
