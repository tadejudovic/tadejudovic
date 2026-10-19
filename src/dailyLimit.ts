import { store } from "./store.ts";

/**
 * Hard cap on new videos per day, whatever starts them (the morning batch, "Make videos",
 * "Make video" on a clip). Editing a video's text or retrying a failed one doesn't count.
 */
export const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function videosMadeToday(): number {
  const today = localDate(new Date());
  // A remake of a rejected video replaces it, so it doesn't count again.
  return store.renders().filter((r) => r.countUse !== false && !r.plan.remakeOf && localDate(new Date(r.createdAt)) === today).length;
}

export function dailyLimit(): number {
  return store.settings().maxVideosPerDay;
}

export function videosLeftToday(): number {
  return Math.max(0, dailyLimit() - videosMadeToday());
}

export class DailyLimitReached extends Error {
  constructor() {
    super(`Today's limit of ${dailyLimit()} new videos is reached. More tomorrow, or raise the limit in Settings.`);
  }
}
