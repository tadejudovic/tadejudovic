import { config } from "./config.ts";
import { store } from "./store.ts";
import { syncAll } from "./albums.ts";
import { plan, queueRender, isPortrait } from "./generate.ts";
import { localDate, videosLeftToday } from "./dailyLimit.ts";
import { refreshTrends, trendsStale } from "./ai/trends.ts";
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
let batchRunning = false;

export function startScheduler() {
  const tick = () => {
    runDue().catch((err) => console.error("[scheduler]", err));
  };
  setTimeout(tick, 5_000);
  setInterval(tick, 60_000);
}

async function runDue() {
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
  const due = now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm;
  // If a batch fails (e.g. no footage yet), retry every 30 minutes rather than every tick.
  if (due && auto.lastBatchDate !== today() && Date.now() - lastAttempt > 30 * 60_000) {
    lastAttempt = Date.now();
    await runDailyBatch();
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
    if (config.claude.enabled && trendsStale()) {
      await refreshTrends(store.settings().petName).catch((err) =>
        console.warn("[scheduler] trend refresh failed, using known formats:", (err as Error).message),
      );
    }
    const ready = store.clips().filter((c) => c.status === "ready" && c.kind === "video" && isPortrait(c) && !c.disliked);
    if (!ready.length) throw new Error("No analyzed vertical videos yet. Add a shared album or upload some clips.");
    // Prefer footage that hasn't been used; fall back to everything when there isn't enough new material.
    const unused = ready.filter((c) => c.uses === 0);
    const pool = unused.length >= Math.min(auto.dailyCount, 3) ? unused : ready;

    const { fontId, textStyle } = store.settings();
    const options: RenderOptions = { keepOriginalAudio: true, textStyle, fontId };
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
