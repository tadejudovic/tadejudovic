import { TEMPLATES, HOOK_BANK, POV_LINES, DEFAULT_HASHTAGS } from "./templates.ts";
import { findMoments, BIN } from "./media/analyze.ts";
import type { Clip, Moment, Segment, TemplateId, VideoPlan } from "./types.ts";

export interface Candidate extends Moment {
  clipId: string;
  clipDuration: number;
}

/** All usable moments across the library, preferring Claude's picks when available. */
export function candidates(clips: Clip[]): Candidate[] {
  const out: Candidate[] = [];
  for (const clip of clips) {
    const moments = clip.ai?.moments?.length ? clip.ai.moments : (clip.moments ?? []);
    for (const m of moments) out.push({ ...m, clipId: clip.id, clipDuration: clip.duration });
  }
  return out;
}

/** Re-cut a moment to `length` seconds, centered on the original, kept inside the clip. */
export function fitWindow(m: Candidate, length: number): { start: number; end: number } {
  const len = Math.min(length, m.clipDuration);
  const center = (m.start + m.end) / 2;
  let start = center - len / 2;
  start = Math.max(0, Math.min(start, m.clipDuration - len));
  return { start: r2(start), end: r2(start + len) };
}

/**
 * Score-based picker that avoids reusing a clip within a video, and prefers
 * clips that haven't been posted much yet (so daily output stays fresh).
 */
function pick(cands: Candidate[], clips: Map<string, Clip>, used: Map<string, number>, n: number): Candidate[] {
  const scored = cands
    .map((c) => {
      const uses = (clips.get(c.clipId)?.uses ?? 0) + (used.get(c.clipId) ?? 0) * 2;
      return { c, s: c.score / (1 + 0.35 * uses) + Math.random() * 0.08 };
    })
    .sort((a, b) => b.s - a.s);
  const chosen: Candidate[] = [];
  const clipCount = new Map<string, number>();
  const distinctClips = new Set(cands.map((c) => c.clipId)).size;
  for (const { c } of scored) {
    if (chosen.length >= n) break;
    const k = clipCount.get(c.clipId) ?? 0;
    // Allow repeats from the same clip only when the library is small.
    if (k > 0 && distinctClips >= n) continue;
    if (k > 1) continue;
    chosen.push(c);
    clipCount.set(c.clipId, k + 1);
  }
  return chosen;
}

const fill = (s: string, pet: string) => s.replaceAll("{pet}", pet);
const sample = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export function heuristicPlan(opts: {
  template: TemplateId;
  targetSeconds: number;
  clips: Clip[];
  petName: string;
  used: Map<string, number>;
}): VideoPlan {
  const { template, targetSeconds, petName, used } = opts;
  const clips = opts.clips.filter((c) => c.status === "ready");
  if (!clips.length) throw new Error("No analyzed clips yet — import some footage first.");
  const byId = new Map(clips.map((c) => [c.id, c]));
  const def = TEMPLATES[template];
  const hook = fill(sample(HOOK_BANK[template]), petName);
  let segments: Segment[] = [];

  if (template === "single_moment" || template === "text_overlay") {
    // Best continuous window of the full target length.
    const best = clips
      .filter((c) => c.energy?.length)
      .map((c) => {
        const len = Math.min(targetSeconds, c.duration);
        const [m] = findMoments(c.energy!, c.duration, len, 1);
        // Prefer clips long enough to fill the target.
        const lengthFactor = len / targetSeconds;
        const uses = c.uses + (used.get(c.id) ?? 0) * 2;
        return { c, m, s: (m.score * lengthFactor) / (1 + 0.35 * uses) + Math.random() * 0.05 };
      })
      .sort((a, b) => b.s - a.s)[0];
    if (!best) throw new Error("No clips with analysis available.");
    segments = [{ clipId: best.c.id, start: best.m.start, end: best.m.end }];
    // If the best clip is short, append the next best to reach the target.
    let total = best.m.end - best.m.start;
    if (total < targetSeconds - 1) {
      for (const c of pick(candidates(clips).filter((x) => x.clipId !== best.c.id), byId, used, 4)) {
        if (total >= targetSeconds - 0.5) break;
        const w = fitWindow(c, Math.min(targetSeconds - total, 6));
        segments.push({ clipId: c.clipId, ...w });
        total += w.end - w.start;
      }
    }
  } else if (template === "then_vs_now") {
    const dated = clips
      .filter((c) => c.capturedAt)
      .sort((a, b) => Date.parse(a.capturedAt!) - Date.parse(b.capturedAt!));
    const pool = dated.length >= 2 ? dated : clips;
    const beats = Math.max(2, Math.min(6, Math.round(targetSeconds / 3.5)));
    const half = Math.ceil(beats / 2);
    const segLen = targetSeconds / beats;
    const oldest = pool.slice(0, Math.max(half, Math.ceil(pool.length / 3)));
    const newest = pool.slice(-Math.max(beats - half, Math.ceil(pool.length / 3)));
    const year = (c: Clip) => (c.capturedAt ? String(new Date(c.capturedAt).getFullYear()) : "");
    const thenC = pick(candidates(oldest), byId, used, half);
    const nowC = pick(candidates(newest).filter((c) => !thenC.some((t) => t.clipId === c.clipId)), byId, used, beats - half);
    segments = [
      ...thenC.map((c, i) => ({
        clipId: c.clipId,
        ...fitWindow(c, segLen),
        caption: i === 0 ? `THEN ${year(byId.get(c.clipId)!)}`.trim() : undefined,
      })),
      ...nowC.map((c, i) => ({
        clipId: c.clipId,
        ...fitWindow(c, segLen),
        caption: i === 0 ? `NOW ${year(byId.get(c.clipId)!)}`.trim() : undefined,
      })),
    ];
  } else {
    const [lo, hi] = def.segmentSeconds;
    const segLen = (lo + hi) / 2;
    const n = Math.max(2, Math.round(targetSeconds / segLen));
    const chosen = pick(candidates(clips), byId, used, n);
    // Strongest moment first (the hook), the rest in a rising order to build energy.
    const [first, ...rest] = chosen;
    const ordered = first ? [first, ...rest.sort((a, b) => a.score - b.score)] : [];
    const lines = [...POV_LINES].sort(() => Math.random() - 0.5);
    const len = targetSeconds / Math.max(1, ordered.length);
    segments = ordered.map((c, i) => ({
      clipId: c.clipId,
      ...fitWindow(c, len),
      caption: template === "pov_story" ? lines[i % lines.length] : undefined,
    }));
  }

  segments = stretchToTarget(segments, byId, targetSeconds);
  return {
    template,
    title: hook,
    hook,
    segments,
    postCaption: `${hook} 🐾`,
    hashtags: DEFAULT_HASHTAGS,
    plannedBy: "heuristic",
  };
}

/**
 * Nudge segment lengths so the total lands on the target, without running past
 * clip boundaries. Short libraries just produce a shorter video.
 */
export function stretchToTarget(segments: Segment[], clips: Map<string, Clip>, target: number): Segment[] {
  const out = segments.map((s) => ({ ...s }));
  for (let pass = 0; pass < 4; pass++) {
    const total = out.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
    const diff = target - total;
    if (Math.abs(diff) < BIN / 2) break;
    const per = diff / out.length;
    for (const s of out) {
      const dur = clips.get(s.clipId)?.duration ?? s.end;
      const grow = (per * (s.speed ?? 1)) / 2;
      s.start = r2(Math.max(0, s.start - grow));
      s.end = r2(Math.min(dur, s.end + grow));
      if (s.end - s.start < 0.6) s.end = r2(Math.min(dur, s.start + 0.6));
    }
  }
  return out;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
