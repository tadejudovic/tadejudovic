import { store } from "./store.ts";
import type { Clip } from "./types.ts";

/**
 * "Takes" of one moment: clips of the same situation filmed within half an hour of each other
 * (e.g. three angles of Lex in the plane seat on the same flight). A round uses at most one take
 * per moment, and another take of a moment waits a few days, so the feed doesn't repeat itself.
 */
export const TAKE_GAP_MS = 30 * 60_000;
export const TAKE_SPACING_DAYS = 3;

/** clip id → moment id. Clips without a capture time are each their own moment. */
export function momentsOf(clips: Clip[]): Map<string, string> {
  const moment = new Map<string, string>();
  const byScene = new Map<string, Clip[]>();
  for (const c of clips) {
    if (!c.capturedAt || !Number.isFinite(Date.parse(c.capturedAt))) {
      moment.set(c.id, c.id);
      continue;
    }
    const key = c.scene ?? "";
    byScene.set(key, [...(byScene.get(key) ?? []), c]);
  }
  for (const list of byScene.values()) {
    list.sort((a, b) => Date.parse(a.capturedAt!) - Date.parse(b.capturedAt!));
    let id = "";
    let last = -Infinity;
    for (const c of list) {
      const t = Date.parse(c.capturedAt!);
      if (t - last > TAKE_GAP_MS) id = c.id; // a new moment starts
      moment.set(c.id, id);
      last = t;
    }
  }
  return moment;
}

/** Moments a take was used from in the last few days (in a video that wasn't rejected). */
export function recentlyUsedMoments(moment: Map<string, string>, now = Date.now()): Set<string> {
  const used = new Set<string>();
  for (const r of store.renders()) {
    if (r.review === "rejected" || r.status === "error") continue;
    if (now - Date.parse(r.createdAt) > TAKE_SPACING_DAYS * 86400_000) continue;
    for (const s of r.plan.segments) {
      const m = moment.get(s.clipId);
      if (m) used.add(m);
    }
  }
  return used;
}
