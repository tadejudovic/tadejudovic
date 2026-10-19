import type { Overlay, Segment } from "./types.ts";

/**
 * Text laid out like a creator's list video: the first line (the hook) stays at the top the whole
 * time, the rest appear one after another, each on its own and each in a different part of the
 * frame, the last staying to the end.
 */

/**
 * Where points sit, in turn: each in a clearly different part of the frame from the one before
 * (center of the text; x 0 left … 1 right, y 0 top … 1 bottom), all below the headline and inside
 * the apps' safe zone.
 */
export const POINT_SPOTS: { x: number; y: number }[] = [
  { x: 0.35, y: 0.4 },
  { x: 0.6, y: 0.62 },
  { x: 0.38, y: 0.7 },
  { x: 0.58, y: 0.45 },
  { x: 0.4, y: 0.56 },
  { x: 0.6, y: 0.68 },
];
export const POINT_Y = POINT_SPOTS.map((p) => p.y);
export const POINT_X = POINT_SPOTS.map((p) => p.x);

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
  // Not enough footage for the full reading time: share what there is in proportion (the caller adds
  // footage first when it can).
  const scale = total < need - 0.2 ? Math.max(0, total - hookAlone) / (need - hookAlone) : 1;
  const spare = scale < 1 ? 0 : (total - need) / points.length;
  let t = Math.min(hookAlone, total * 0.2);
  const timed = points.map((p, i) => {
    const start = t;
    t += reads[i] * scale + spare;
    return { ...p, start, end: i === points.length - 1 ? total + 1 : t };
  });
  return { overlays: [{ ...hook, start: 0, end: total + 1 }, ...timed], need: scale < 1 ? need : 0 };
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
  if (!points.length) return overlays;
  return [
    overlays[0],
    ...points.map((o, i) =>
      // A point with an arrow stays by the thing it points at; the others take turns over the frame.
      o.pointTo
        ? { ...o, x: o.x ?? Math.max(0.36, Math.min(0.58, o.pointTo.x)) }
        : { ...o, ...POINT_SPOTS[i % POINT_SPOTS.length] },
    ),
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
  return replayOnce(out, seconds);
}

/**
 * Replay footage to reach `seconds`, but only as much as is missing, and never any part more than
 * twice in the whole video: footage on a loop looks like a loop. May stay shorter than asked.
 */
export function replayOnce(segments: Segment[], seconds: number): Segment[] {
  const len = (xs: Segment[]) => xs.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
  const key = (s: Segment) => `${s.clipId}:${s.start.toFixed(2)}`;
  const plays = new Map<string, number>();
  for (const s of segments) plays.set(key(s), (plays.get(key(s)) ?? 0) + 1);
  const out = [...segments];
  for (const s of segments) {
    const missing = seconds - len(out);
    if (missing < 0.3) break;
    if ((plays.get(key(s)) ?? 0) >= 2) continue;
    const take = Math.min(s.end - s.start, missing);
    if (take < 1) continue;
    out.push({ ...s, end: s.start + take, speed: 1 });
    plays.set(key(s), (plays.get(key(s)) ?? 0) + 1);
  }
  return out;
}
