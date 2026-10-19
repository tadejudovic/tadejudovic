import type { Overlay, Segment } from "./types.ts";

/**
 * Text laid out like a creator's list video: the first line (the hook) stays at the top the whole
 * time, the rest appear one after another, each on its own and each in a different part of the
 * frame, the last staying to the end.
 */

/** Where points sit, in turn (center of the text, 0 top … 1 bottom): never twice in the same spot. */
export const POINT_Y = [0.62, 0.42, 0.72, 0.5, 0.66, 0.46];
/** And across: left, right, middle… so the points move over the screen one after another. */
export const POINT_X = [0.34, 0.6, 0.46, 0.36, 0.58, 0.44];

/** Seconds a line needs on screen to be read comfortably (about 3 words a second, at least 2s). */
export function readSeconds(text: string): number {
  const words = text.split(/\s+/).filter((w) => w && w !== "/").length;
  return Math.max(2, words / 3 + 0.8);
}

/**
 * Points shown one after another, each on screen at least as long as it takes to read: the hook
 * alone first, then the points back to back, sharing any spare time. Returns the seconds needed
 * when the video is too short for that (the caller lengthens the footage and calls again).
 */
export function timePoints(overlays: Overlay[], total: number): { overlays: Overlay[]; need: number } {
  const [hook, ...points] = overlays;
  if (!points.length) return { overlays, need: 0 };
  const hookAlone = 2.5;
  const reads = points.map((p) => readSeconds(p.text));
  const need = hookAlone + reads.reduce((a, b) => a + b, 0);
  if (total < need - 0.2) return { overlays, need };
  const spare = (total - need) / points.length;
  let t = hookAlone;
  const timed = points.map((p, i) => {
    const start = t;
    t += reads[i] + spare;
    return { ...p, start, end: i === points.length - 1 ? total + 1 : t };
  });
  return { overlays: [{ ...hook, start: 0, end: total + 1 }, ...timed], need };
}

/** Seconds needed to read a hook and `points` points one after another. */
export function readingSeconds(points: number): number {
  return points <= 0 ? 4 : 2.5 + 3.2 * points;
}

export function layoutPoints(texts: string[], total: number): Overlay[] {
  const [hook, ...points] = texts;
  const out: Overlay[] = [{ text: hook, start: 0, end: total + 1 }];
  if (!points.length) return out;
  const first = Math.min(2.5, total * 0.2);
  const per = (total - first) / points.length;
  points.forEach((text, i) =>
    out.push({
      text,
      start: first + i * per,
      end: i === points.length - 1 ? total + 1 : first + (i + 1) * per,
      y: POINT_Y[i % POINT_Y.length],
      x: POINT_X[i % POINT_X.length],
    }),
  );
  return out;
}

/** Points the AI placed all in one spot (or not at all) get spread over the frame instead. */
export function spreadPoints(overlays: Overlay[]): Overlay[] {
  const points = overlays.slice(1);
  if (points.length < 2) return overlays;
  const spots = new Set(points.map((o) => (o.y === undefined ? "none" : o.y.toFixed(2))));
  const spread = spots.size >= Math.min(points.length, 2) && !spots.has("none");
  return [
    overlays[0],
    ...points.map((o, i) => ({
      ...o,
      ...(spread || o.pointTo ? {} : { y: POINT_Y[i % POINT_Y.length] }),
      // Across the frame too: toward the thing an arrow points at, otherwise left, right, middle in turn.
      x: o.x ?? (o.pointTo ? Math.max(0.36, Math.min(0.58, o.pointTo.x)) : POINT_X[i % POINT_X.length]),
    })),
  ];
}

/**
 * Make the footage long enough for `seconds`: first let the last part run on into the rest of its
 * clip, then replay the footage at real speed.
 */
export function lengthenFootage(segments: Segment[], seconds: number, clipDuration: (id: string) => number): Segment[] {
  const len = (xs: Segment[]) => xs.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
  let out = segments.map((s) => ({ ...s }));
  const lastSeg = out[out.length - 1];
  if (lastSeg && len(out) < seconds) {
    const room = clipDuration(lastSeg.clipId) - lastSeg.end;
    lastSeg.end += Math.max(0, Math.min(room, (seconds - len(out)) * (lastSeg.speed ?? 1)));
  }
  const once = out.map((s) => ({ ...s, speed: 1 }));
  // One replay at most: footage on a loop looks like a loop.
  if (len(out) < seconds - 0.3) out = [...out, ...once];
  return out;
}
