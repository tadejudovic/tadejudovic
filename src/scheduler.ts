import { config } from "./config.ts";
import { store } from "./store.ts";
import { syncAll } from "./albums.ts";
import { plan, queueRender, isPortrait } from "./generate.ts";
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
import { researchScene, researchStale } from "./ai/research.ts";
import type { RenderOptions } from "./types.ts";

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
  const auto = store.auto();
  if (!auto.enabled || paused) return;
  if (store.albums().length && Date.now() - lastSync > auto.syncEveryHours * 3600_000) {
    lastSync = Date.now();
    const { newItems } = await syncAll();
    if (newItems) console.log(`[scheduler] ${newItems} new album item(s) found`);
  }
  // Let imports (download, analysis, situation sorting) finish before picking clips.
  if (ingestQueue.pending > 0) return;
  // Keep caption research fresh for situations that have clips waiting, one situation per tick,
  // so suggestions can show the caption they'd use before anything is made.
  if (config.claude.enabled) {
    const waiting = new Set(store.clips().filter((c) => c.status === "ready" && c.uses === 0 && c.scene).map((c) => c.scene!));
    const next = store.settings().scenes.find((sc) => waiting.has(sc) && researchStale(sc) && !store.research(sc)?.error);
    if (next) await researchScene(next).catch((err) => console.warn(`[research] ${next}:`, (err as Error).message));
  }
  const [hh, mm] = auto.dailyTime.split(":").map(Number);
  const now = new Date();
  // The first round of the day is ready by the set time; later rounds follow each finished review.
  const due = afterReview || now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm;
  // If a batch fails (e.g. no footage yet), retry every 30 minutes rather than every tick.
  if (due && !batchRunning && awaitingReview() === 0 && videosLeftToday() > 0 && (afterReview || Date.now() - lastAttempt > 30 * 60_000)) {
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
    await waitForIngest(20 * 60_000);
    const ready = store.clips().filter((c) => c.status === "ready" && c.kind === "video" && isPortrait(c) && !c.disliked);
    if (!ready.length) throw new Error("No analyzed vertical videos yet. Add a shared album or upload some clips.");
    // Prefer footage that hasn't been used; fall back to everything when there isn't enough new material.
    const unused = ready.filter((c) => c.uses === 0);
    const pool = unused.length >= Math.min(auto.dailyCount, 3) ? unused : ready;

    const { fontId, textStyle, textSize } = store.settings();
    const options: RenderOptions = { keepOriginalAudio: true, textStyle, textSize, fontId };
    const { plans, warning } = await plan({
      template: auto.template,
      targetSeconds: auto.targetSeconds,
      count: Math.min(auto.dailyCount, left),
      clipIds: pool.map((c) => c.id),
      useAi: true,
      options,
    });
    const renders = plans.map((p) => queueRender(p, options, date));
    store.updateAuto({ lastBatchDate: date });
    console.log(`[scheduler] queued ${renders.length} video(s) for ${date}${warning ? ` (${warning})` : ""}`);
    return { renders, warning };
  } finally {
    batchRunning = false;
  }
}

async function waitForIngest(maxMs: number) {
  const until = Date.now() + maxMs;
  while (ingestQueue.pending > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 2000));
}
