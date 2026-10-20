import { store } from "./store.ts";

/**
 * Hard cap on new videos per day, whatever starts them (the morning batch, "Make videos",
 * "Make video" on a clip). Editing a video's text or retrying a failed one doesn't count.
 */
export const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Daily videos made today, remakes included: a safety cap on how many a day of swiping can cost
 * (the day normally ends sooner, once one of each kind is kept). Stories and vlogs don't count.
 */
export function videosMadeToday(): number {
  const now = new Date();
  const today = localDate(now);
  const from = Date.parse(store.settings().countFrom ?? "");
  const start = Number.isFinite(from) && localDate(new Date(from)) === today ? from : 0;
  return store
    .renders()
    .filter((r) => r.countUse !== false && r.plan.format !== "story" && localDate(new Date(r.createdAt)) === today && Date.parse(r.createdAt) >= start).length;
}

export function dailyLimit(): number {
  return store.settings().maxVideosPerDay;
}

/** A tap by the creator ("Make new ones", "Redo with this feedback") may go this many past the limit. */
export const MANUAL_EXTRA = 3;

export function videosLeftToday(): number {
  return Math.max(0, dailyLimit() - videosMadeToday());
}

export class DailyLimitReached extends Error {
  constructor() {
    super(`Today's limit of ${dailyLimit()} new videos is reached. More tomorrow, or raise the limit in Settings.`);
  }
}
