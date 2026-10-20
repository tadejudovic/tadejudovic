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

/** Being made, waiting in Review, or (rejected) with its remake being written. */
const inFlight = (r: Render) =>
  r.status === "queued" || r.status === "rendering" || (r.status === "done" && r.review === "pending") || (r.review === "rejected" && r.remadeAs === "pending");

/** Videos of this kind being made or waiting in Review (spares on standby not counted). */
export function waitingOf(kind: PostFormat): number {
  return store.renders().filter((r) => daily(r) && r.plan.format === kind && inFlight(r) && !r.standby).length;
}

/** Spares of this kind: made (or being made) in the background, out of Review. */
export function sparesOf(kind: PostFormat): Render[] {
  return store.renders().filter((r) => daily(r) && r.plan.format === kind && r.standby && r.review === "pending" && r.status !== "error");
}

/**
 * What to make now, for a kind not kept enough today: the video for Review if nothing of the kind is
 * waiting (and no spare can step in), else one spare on standby, so a rejection is replaced at once.
 * Right after a rejection without a reason, its kind waits a minute: a reason picked just after the
 * swipe makes a remake that fixes it instead.
 */
export function toMake(now = Date.now()): { kind: PostFormat; standby: boolean }[] {
  const mix = store.settings().dailyMix;
  const out: { kind: PostFormat; standby: boolean }[] = [];
  for (const [kind, key] of DAY_KINDS) {
    if (keptToday(kind) >= (mix[key] ?? 0)) continue;
    const justRejected = store
      .renders()
      .some((r) => daily(r) && r.plan.format === kind && r.review === "rejected" && !r.rejectReason && !r.rejectedBy && now - Date.parse(r.reviewedAt ?? "") < 60_000);
    if (justRejected) continue;
    const waiting = waitingOf(kind);
    const spares = sparesOf(kind).length;
    if (!waiting && !spares) out.push({ kind, standby: false });
    else if (waiting && !spares) out.push({ kind, standby: true });
  }
  // The videos for Review first, then the spares.
  return out.sort((a, b) => Number(a.standby) - Number(b.standby));
}

/** The kinds that need a video for Review now (nothing waiting, no spare). */
export function kindsToMake(now = Date.now()): PostFormat[] {
  return toMake(now).filter((x) => !x.standby).map((x) => x.kind);
}

/**
 * A kind with nothing waiting in Review gets its spare at once (the finished one first). Called
 * after every review, so a rejected video is replaced without waiting.
 */
export function promoteSpares(): number {
  const mix = store.settings().dailyMix;
  let n = 0;
  for (const [kind, key] of DAY_KINDS) {
    if (keptToday(kind) >= (mix[key] ?? 0) || waitingOf(kind) > 0) continue;
    const spare = sparesOf(kind).sort((a, b) => Number(b.status === "done") - Number(a.status === "done") || a.createdAt.localeCompare(b.createdAt))[0];
    if (spare) {
      store.updateRender(spare.id, { standby: false });
      n++;
    }
  }
  return n;
}

/** Every kind kept for today. */
export function daySetDone(): boolean {
  const mix = store.settings().dailyMix;
  return DAY_KINDS.every(([kind, key]) => keptToday(kind) >= (mix[key] ?? 0));
}
