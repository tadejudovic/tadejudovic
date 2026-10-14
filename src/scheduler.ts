import { config } from "./config.ts";
import { store } from "./store.ts";
import { importBudget, syncAll } from "./albums.ts";
import { plan, queueRender, isPortrait, onTopic } from "./generate.ts";
import { localDate, videosLeftToday } from "./dailyLimit.ts";

/**
 * Videos are made in rounds: the next batch only starts once every video of the last one
 * has been reviewed (kept or rejected), so each decision can shape the next round.
 */
export function awaitingReview(): number {
  return store.renders().filter((r) => r.status === "queued" || r.status === "rendering" || (r.status === "done" && r.review === "pending")).length;
}

/** Called after a review: if that was the last one, start the next round right away. */
export function afterReview() {
  if (awaitingReview() === 0) runDue({ afterReview: true }).catch((err) => console.error("[scheduler]", err));
}
import { ingestQueue } from "./queue.ts";
import { archiveUnusable, ARCHIVE_AFTER_DAYS, queueMissingAiLooks } from "./library.ts";
import { aiAvailable } from "./ai/budget.ts";
import { researchScene, researchStale } from "./ai/research.ts";
import type { RenderOptions, VideoPlan } from "./types.ts";

/**
 * The daily loop:
 *   - every few hours, check shared albums for new videos;
 *   - once a day at the configured time, refresh trending text formats and
 *     prepare a batch of videos for review, favoring footage not used yet.
 *
 * Runs inside the server process, so it only fires while the app is running.
 */

const today = () => localDate(new Date());
export { localDate };

let lastSync = 0;
let paused = false;
/** While paused (after repeated crashes), nothing runs on its own: no album checks, research or batches. */
export function setPaused(value: boolean) {
  paused = value;
}
let lastAttempt = 0;
let lastTopUp = 0;
let lastArchive = 0;
let researching = false;
let lastRelook = Date.now(); // startup already queues them
const TOP_UP_EVERY_MS = 2 * 60_000;
/** Why the last automatic round couldn't be made (shown in the app instead of an endless spinner). */
export let lastRoundError: { message: string; at: string } | null = null;
let batchRunning = false;

export function startScheduler() {
  const tick = () => {
    runDue().catch((err) => console.error("[scheduler]", err));
  };
  setTimeout(tick, 5_000);
  setInterval(tick, 60_000);
}

async function runDue({ afterReview = false } = {}) {
  // Once an hour: delete the files of week-old clips that will never be used (records stay).
  if (Date.now() - lastArchive > 3600_000) {
    lastArchive = Date.now();
    const n = archiveUnusable();
    if (n) console.log(`[library] deleted the files of ${n} unused clip(s) older than ${ARCHIVE_AFTER_DAYS} days`);
  }
  const auto = store.auto();
  if (!auto.enabled || paused) return;
  // Clips whose AI look failed (e.g. while the account was out of credit) get another one once
  // the import lane is free, a batch at a time.
  if (config.claude.enabled && aiAvailable() && ingestQueue.pending === 0 && Date.now() - lastRelook > 2 * 60_000) {
    lastRelook = Date.now();
    const n = queueMissingAiLooks(20);
    if (n) console.log(`[scheduler] sorting ${n} clip(s) that weren't sorted yet`);
  }
  if (store.albums().length && Date.now() - lastSync > auto.syncEveryHours * 3600_000) {
    lastSync = Date.now();
    const { newItems } = await syncAll();
    if (newItems) console.log(`[scheduler] ${newItems} new album item(s) found`);
  } else if (
    // Keep the pipeline full between the regular checks: photos and off-topic clips use up import
    // slots, so as soon as imports finish and there's room for more, take the next ones waiting.
    ingestQueue.pending === 0 &&
    Date.now() - lastTopUp > TOP_UP_EVERY_MS &&
    store.albums().some((a) => (a.waiting ?? 0) > 0) &&
    importBudget() > 0
  ) {
    lastTopUp = Date.now();
    const { newItems } = await syncAll();
    if (newItems) console.log(`[scheduler] topping up: importing ${newItems} more album item(s)`);
  }
  // Don't wait for a whole import to finish: once a few usable clips are sorted, start the round
  // (renders jump ahead of the remaining imports).
  if (ingestQueue.pending > 0 && usableClips() < enoughToStart()) return;
  const [hh, mm] = auto.dailyTime.split(":").map(Number);
  const now = new Date();
  // The first round of the day is ready by the set time; later rounds follow each finished review.
  const due = afterReview || now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm;
  // If a batch fails (e.g. no footage yet), retry every 30 minutes rather than every tick, or as
  // soon as enough clips have been sorted since.
  const retry = Date.now() - lastAttempt > 30 * 60_000 || (lastRoundError !== null && usableClips() >= enoughToStart());
  if (due && !batchRunning && awaitingReview() === 0 && videosLeftToday() > 0 && (afterReview || retry)) {
    lastAttempt = Date.now();
    try {
      const r = await runDailyBatch({ force: true });
      if (r.renders.length) lastAttempt = 0;
      lastRoundError = null;
    } catch (err) {
      lastRoundError = { message: (err as Error).message, at: new Date().toISOString() };
      throw err;
    }
  }
  // Keep caption research fresh for situations that have clips waiting, one situation per tick,
  // after the round so it never delays videos.
  if (config.claude.enabled && !batchRunning && !researching) {
    const waiting = new Set(store.clips().filter((c) => c.status === "ready" && c.uses === 0 && c.scene).map((c) => c.scene!));
    const next = store.settings().scenes.find((sc) => waiting.has(sc) && researchStale(sc) && !store.research(sc)?.error);
    if (next) {
      researching = true;
      await researchScene(next)
        .catch((err) => console.warn(`[research] ${next}:`, (err as Error).message))
        .finally(() => (researching = false));
    }
  }
}

/** Build today's batch. Safe to call manually ("make today's batch now"). */
export async function runDailyBatch(opts: { force?: boolean } = {}) {
  if (batchRunning) throw new Error("A batch is already being prepared.");
  batchRunning = true;
  const auto = store.auto();
  const date = today();
  try {
    if (!opts.force && auto.lastBatchDate === date) return { renders: [], skipped: "already done today" };
    // Every video of the last round needs a decision before more are made.
    const waiting = awaitingReview();
    if (waiting) {
      if (opts.force) throw new Error(`Review the ${waiting} video${waiting === 1 ? "" : "s"} you have first (swipe right or left). Then the next ones are made.`);
      return { renders: [], skipped: "waiting for review" };
    }
    // Checked before any AI call, so a reached limit costs nothing.
    const left = videosLeftToday();
    if (!left) {
      store.updateAuto({ lastBatchDate: date });
      return { renders: [], skipped: "daily video limit reached" };
    }
    // Pick up anything added to the albums since the last check, and let it finish analyzing.
    if (store.albums().length) {
      lastSync = Date.now();
      await syncAll();
    }
    if (usableClips() < enoughToStart()) await waitForIngest(20 * 60_000);
    const ready = store.clips().filter((c) => c.status === "ready" && c.kind === "video" && isPortrait(c) && !c.disliked && onTopic(c));
    if (!ready.length) {
      const any = store.clips().some((c) => c.status === "ready");
      throw new Error(
        any && store.settings().onlySituations
          ? `None of your clips match your situations yet (${store.settings().scenes.slice(0, 3).join(", ")}…). More are imported as needed.`
          : "No analyzed vertical videos yet. Add a shared album or upload some clips.",
      );
    }
    // Each clip is used once (a rejected video hands its clips back), so a round only draws on unused footage.
    const pool = ready.filter((c) => c.uses === 0);
    if (!pool.length) throw new Error("Every clip has been used. New footage is imported as it's needed.");

    const { fontId, textStyle, textSize } = store.settings();
    const options: RenderOptions = { keepOriginalAudio: true, textStyle, textSize, fontId };
    // Each video starts rendering as soon as its text is written, not when the whole round is.
    const renders: ReturnType<typeof queueRender>[] = [];
    const queued = new Set<VideoPlan>();
    const start = (p: VideoPlan) => {
      queued.add(p);
      renders.push(queueRender(p, options, date));
    };
    const { plans, warning } = await plan(
      {
        template: auto.template,
        targetSeconds: auto.targetSeconds,
        count: Math.min(auto.dailyCount, left),
        clipIds: pool.map((c) => c.id),
        useAi: true,
        options,
      },
      { onPlan: start },
    );
    for (const p of plans) if (!queued.has(p)) start(p);
    store.updateAuto({ lastBatchDate: date });
    console.log(`[scheduler] queued ${renders.length} video(s) for ${date}${warning ? ` (${warning})` : ""}`);
    return { renders, warning };
  } finally {
    batchRunning = false;
  }
}

/** Unused clips a round could use right now (sorted into a situation, vertical, not rejected). */
function usableClips(): number {
  return store.clips().filter((c) => c.status === "ready" && c.kind === "video" && isPortrait(c) && !c.disliked && onTopic(c) && c.uses === 0).length;
}

/** A round starts as soon as this many clips are sorted, even while more are importing: early feedback beats a full round. */
const START_WITH = 1;
const enoughToStart = () => Math.max(1, Math.min(store.auto().dailyCount, videosLeftToday(), START_WITH));

async function waitForIngest(maxMs: number) {
  const until = Date.now() + maxMs;
  while (ingestQueue.pending > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 2000));
}
