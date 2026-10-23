import { config } from "./config.ts";
import { store } from "./store.ts";
import { footageNeeded, importBudget, syncAll } from "./albums.ts";
import { plan, queueRender, isPortrait, onTopic, outsideClips, noteKindIssue, postsDueForStats, refreshPostStats } from "./generate.ts";
import { apifyEnabled } from "./ai/tiktokSearch.ts";
import { syncProfiles } from "./postMatch.ts";
import { localDate, MANUAL_EXTRA, videosLeftToday } from "./dailyLimit.ts";
import { DAY_KINDS, daySetDone, promoteSpares, toMake, waitingOf } from "./daySet.ts";
import { learnFromTikTok } from "./audience.ts";
import { refreshSuggestTopics } from "./searchSuggest.ts";

/**
 * The day runs until one video of each kind (educational, fun, inspirational) is kept: each kind not
 * kept yet has one waiting in Review, and a rejected one is replaced by another of its kind.
 */
export function awaitingReview(): number {
  // Videos made on request (stories, day vlogs) don't count here.
  return store
    .renders()
    .filter((r) => r.plan.format !== "story" && !r.standby && (r.status === "queued" || r.status === "rendering" || (r.status === "done" && r.review === "pending"))).length;
}

/**
 * Called after a review: make what the day's set needs now, and once more a minute later (a kind
 * rejected without a reason waits that long for one).
 */
export function afterReview() {
  const go = () => runDue({ afterReview: true }).catch((err) => console.error("[scheduler]", err));
  go();
  setTimeout(go, 65_000).unref();
}
import { ingestQueue } from "./queue.ts";
import { archiveUnusable, ARCHIVE_AFTER_DAYS, freeDiskSpace, queueMissingAiLooks } from "./library.ts";
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
let lastStats = 0;
let lastSuggest = 0;
let lastAudience = 0;
let researching = false;
let lastRelook = Date.now(); // startup already queues them
const TOP_UP_EVERY_MS = 2 * 60_000;
/** Why the last automatic round couldn't be made (shown in the app instead of an endless spinner). */
export let lastRoundError: { message: string; at: string } | null = null;
let batchRunning = false;
/** What the round being made is doing right now (shown in the app), or null when none is. */
export let roundStage: string | null = null;

export function startScheduler() {
  const tick = () => {
    runDue().catch((err) => console.error("[scheduler]", err));
  };
  setTimeout(tick, 5_000);
  setInterval(tick, 60_000);
}

async function runDue({ afterReview = false } = {}) {
  // Find posted videos on the creator's profiles and refresh recent posts' numbers in one read.
  // In the background: a profile read can take a few minutes and mustn't hold up rounds.
  void syncProfiles().catch((err) => console.warn("[profiles]", (err as Error).message));
  // Posts the profile read didn't cover (links pasted by hand): refresh them one by one.
  if (apifyEnabled() && Date.now() - lastStats > 10 * 60_000) {
    lastStats = Date.now();
    for (const { render, platform } of postsDueForStats().slice(0, 3)) {
      await refreshPostStats(render.id, platform).catch((err) => console.warn(`[stats] ${platform} ${render.id}: ${(err as Error).message}`));
    }
  }
  // Once an hour: delete the files of week-old clips that will never be used (records stay).
  if (Date.now() - lastArchive > 3600_000) {
    lastArchive = Date.now();
    const n = archiveUnusable();
    if (n) console.log(`[library] deleted the files of ${n} unused clip(s) older than ${ARCHIVE_AFTER_DAYS} days`);
    const freed = freeDiskSpace();
    if (freed > 50 * 1024 ** 2) console.log(`[library] freed ${(freed / 1024 ** 3).toFixed(2)} GB of files nothing needs`);
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
    store.albums().some((a) => (a.waiting ?? 0) > 0 || ((a.tooOld ?? 0) > 0 && footageNeeded() > 0)) &&
    importBudget() > 0
  ) {
    lastTopUp = Date.now();
    const { newItems } = await syncAll();
    if (newItems) console.log(`[scheduler] topping up: importing ${newItems} more album item(s)`);
  }
  // Once a week: what the audience asks on the creator's TikTok (new posts' comments only; cents).
  const aud = store.settings().audience;
  if (aud && apifyEnabled() && Date.now() - Date.parse(aud.at) > 7 * 86400_000 && Date.now() - lastAudience > 3600_000) {
    lastAudience = Date.now();
    void learnFromTikTok(aud.days).catch((err) => console.warn("[audience]", (err as Error).message));
  }
  // Once a week: what people type into Google and YouTube search (free; one small AI call to sort it).
  const sAt = Date.parse(store.settings().suggestTopicsAt ?? "") || 0;
  if (config.claude.enabled && Date.now() - sAt > 7 * 86400_000 && Date.now() - lastSuggest > 6 * 3600_000) {
    lastSuggest = Date.now();
    void refreshSuggestTopics().catch((err) => console.warn("[search] autocomplete:", (err as Error).message));
  }
  // The day's set: a video of each kind not kept yet waits in Review, from midnight on, so they're
  // ready in the morning. Failures retry every 10 minutes (or as soon as more clips are sorted).
  const retry = Date.now() - lastAttempt > 10 * 60_000 || (lastRoundError !== null && usableClips() > 0);
  // A kind with nothing waiting gets its spare at once; then what's still missing is made.
  promoteSpares();
  if (!batchRunning && toMake().length && videosLeftToday() > 0 && (afterReview || retry)) {
    lastAttempt = Date.now();
    try {
      const r = await runDailyBatch({ force: true });
      if (r.renders.length) lastAttempt = 0;
      lastRoundError = null;
    } catch (err) {
      lastRoundError = { message: (err as Error).message, at: new Date().toISOString() };
      // The whole round failed (out of credit, no footage): every kind that was due says why.
      for (const { kind } of toMake()) noteKindIssue(kind, (err as Error).message);
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

/**
 * Make what the day's set still needs: one video of each kind that isn't kept yet and has nothing
 * waiting in Review. Safe to call by hand ("make the next ones").
 */
/**
 * Today's set, or, when the creator taps "Make new ones" (manual), more of it even when the set is
 * done or one of each is waiting: the kinds with nothing waiting (all three when every kind has one),
 * up to MANUAL_EXTRA past the daily limit.
 */
export async function runDailyBatch({ manual = false }: { force?: boolean; manual?: boolean } = {}) {
  if (batchRunning) throw new Error(`The next videos are already being made${roundStage ? `: ${roundStage.toLowerCase()}` : ""}`);
  batchRunning = true;
  roundStage = "Starting…";
  const date = today();
  try {
    promoteSpares();
    // No AI, no videos: a video without it would only be a pasted caption.
    if (config.claude.enabled && !aiAvailable()) throw new Error("The Anthropic account is out of credit. Add credit at console.anthropic.com → Plans & Billing; videos are made again as soon as it's back.");
    const left = () => videosLeftToday() + (manual ? MANUAL_EXTRA : 0);
    let kinds = toMake();
    if (!kinds.length && manual) {
      const free = DAY_KINDS.map(([k]) => k).filter((k) => !waitingOf(k));
      kinds = (free.length ? free : DAY_KINDS.map(([k]) => k)).map((kind) => ({ kind, standby: false }));
    }
    if (!kinds.length) return { renders: [], skipped: daySetDone() ? "today's set is done" : "one of each is waiting for review, with a spare" };
    if (!left()) return { renders: [], skipped: "daily video limit reached" };
    // Pick up anything added to the albums since the last check, and let it finish analyzing.
    // Listing a big album takes a while: only wait for it when there's nothing to make videos from yet.
    if (store.albums().length) {
      lastSync = Date.now();
      if (usableClips() > 0) syncAll().catch((err) => console.warn("[scheduler] album check failed:", (err as Error).message));
      else {
        roundStage = "Bringing in more footage from your albums…";
        await syncAll();
        roundStage = "Waiting for clips to be sorted into your situations…";
        await waitForIngest(5 * 60_000);
      }
    }
    const pool = store.clips().filter((c) => c.status === "ready" && c.kind === "video" && isPortrait(c) && !c.disliked && onTopic(c) && c.uses === 0);
    if (!pool.length && !outsideClips().length) {
      const any = store.clips().some((c) => c.status === "ready");
      throw new Error(
        any
          ? "Every clip has been used. Older footage from your albums is being imported now; the next video starts as soon as it's sorted."
          : "No clips yet. Pick videos in Settings → Google Photos (or upload some).",
      );
    }
    const auto = store.auto();
    const { fontId, textStyle, textSize } = store.settings();
    const options: RenderOptions = { keepOriginalAudio: true, textStyle, textSize, fontId };
    const renders: ReturnType<typeof queueRender>[] = [];
    const failures: string[] = [];
    // One at a time, each starting to render as soon as its text is written: the videos for Review
    // first, then the spares (quietly, in the background).
    for (const { kind, standby } of kinds) {
      if (!left()) break;
      roundStage = standby ? null : `Writing the ${kind === "tips" ? "educational" : kind === "inspire" ? "inspirational" : "fun"} video…`;
      try {
        const { plans } = await plan({
          template: auto.template,
          targetSeconds: auto.targetSeconds,
          count: 1,
          clipIds: store.clips().filter((c) => pool.includes(c) && c.uses === 0).map((c) => c.id),
          pickFromPool: true,
          useAi: true,
          format: kind,
          options,
        });
        const p = plans.find((x) => x.format === kind);
        if (!p) throw new Error(`the ${kind} video couldn't be planned`);
        const made = queueRender(p, options, date, { standby });
        renders.push(made);
        noteKindIssue(kind, null);
      } catch (err) {
        failures.push(`${kind}: ${(err as Error).message}`);
        noteKindIssue(kind, (err as Error).message);
      }
    }
    store.updateAuto({ lastBatchDate: date });
    console.log(`[scheduler] made ${renders.length} video(s) for today's set (${kinds.map((k) => `${k.kind}${k.standby ? " spare" : ""}`).join(", ")})${failures.length ? `; failed: ${failures.join("; ")}` : ""}`);
    if (!renders.length && failures.length) throw new Error(failures.join("; "));
    return { renders, warning: failures.length ? failures.join("; ") : undefined };
  } finally {
    batchRunning = false;
    roundStage = null;
  }
}

/** Unused clips a round could use right now (sorted into a situation, vertical, not rejected). */
function usableClips(): number {
  return store.clips().filter((c) => c.status === "ready" && c.kind === "video" && isPortrait(c) && !c.disliked && onTopic(c) && c.uses === 0).length;
}

async function waitForIngest(maxMs: number) {
  const until = Date.now() + maxMs;
  while (ingestQueue.pending > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 2000));
}
