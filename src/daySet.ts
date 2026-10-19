import { store } from "./store.ts";
import { localDate } from "./dailyLimit.ts";
import type { DailyMix, PostFormat, Render } from "./types.ts";

/**
 * The day's set: one educational, one fun and one inspirational video kept (as many of each as the
 * daily mix says). Until a kind is kept, there's always one of it waiting in Review: a rejected one
 * is replaced by another of its kind. Once every kind is kept, nothing more is made that day.
 */
export const DAY_KINDS: [PostFormat, keyof DailyMix][] = [
  ["tips", "educational"],
  ["fun", "fun"],
  ["inspire", "inspirational"],
];

/** When "today" started: local midnight, or the last reset of the counters if that's later. */
export function dayStart(now = new Date()): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const from = Date.parse(store.settings().countFrom ?? "");
  return Number.isFinite(from) && from > midnight && localDate(new Date(from)) === localDate(now) ? from : midnight;
}

/** Daily videos only: not stories, vlogs or brand collabs made on request. */
const daily = (r: Render) => !!r.plan.format && r.plan.format !== "story" && !r.plan.collab;

/** Videos of this kind kept today. */
export function keptToday(kind: PostFormat): number {
  const start = dayStart();
  return store.renders().filter((r) => daily(r) && r.plan.format === kind && r.review === "approved" && Date.parse(r.reviewedAt ?? "") >= start).length;
}

/** Videos of this kind being made or waiting in Review (a remake being written counts too). */
export function waitingOf(kind: PostFormat): number {
  return store
    .renders()
    .filter(
      (r) =>
        daily(r) &&
        r.plan.format === kind &&
        (r.status === "queued" || r.status === "rendering" || (r.status === "done" && r.review === "pending") || (r.review === "rejected" && r.remadeAs === "pending")),
    ).length;
}

/**
 * The kinds that need a new video now: not kept enough today and nothing of theirs waiting. Right
 * after a rejection without a reason, its kind waits a minute: a reason picked just after the swipe
 * makes a remake that fixes it instead.
 */
export function kindsToMake(now = Date.now()): PostFormat[] {
  const mix = store.settings().dailyMix;
  return DAY_KINDS.filter(([kind, key]) => {
    if (keptToday(kind) >= (mix[key] ?? 0) || waitingOf(kind) > 0) return false;
    const justRejected = store
      .renders()
      .some((r) => daily(r) && r.plan.format === kind && r.review === "rejected" && !r.rejectReason && now - Date.parse(r.reviewedAt ?? "") < 60_000);
    return !justRejected;
  }).map(([kind]) => kind);
}

/** Every kind kept for today. */
export function daySetDone(): boolean {
  const mix = store.settings().dailyMix;
  return DAY_KINDS.every(([kind, key]) => keptToday(kind) >= (mix[key] ?? 0));
}
