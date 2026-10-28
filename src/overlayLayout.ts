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
  { x: 0.3, y: 0.4 },
  { x: 0.63, y: 0.62 },
  { x: 0.34, y: 0.7 },
  { x: 0.62, y: 0.46 },
  { x: 0.32, y: 0.56 },
  { x: 0.63, y: 0.68 },
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
 * Make the footage long enough for `seconds` without showing anything twice: the shots run on into
 * the rest of their clips (the last one first). May stay shorter than asked when the clips run out.
 */
export function lengthenFootage(segments: Segment[], seconds: number, clipDuration: (id: string) => number): Segment[] {
  const len = (xs: Segment[]) => xs.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
  const out = segments.map((s) => ({ ...s }));
  // Seconds the same footage is on screen in one go: this shot and the shots of the same clip right next to it.
  const run = (i: number) => {
    let a = i, b = i;
    while (a > 0 && out[a - 1].clipId === out[i].clipId) a--;
    while (b < out.length - 1 && out[b + 1].clipId === out[i].clipId) b++;
    return len(out.slice(a, b + 1));
  };
  // First every shot runs on a little (none past MAX_SHOT_SECONDS of one shot), the last ones first;
  // only if that isn't enough does a shot run on longer (a long same-shot stretch loses viewers).
  for (const cap of [MAX_SHOT_SECONDS, Infinity]) {
    for (let i = out.length - 1; i >= 0 && len(out) < seconds - 0.05; i--) {
      const s = out[i];
      // Up to where this clip is used next in the video (never into footage shown elsewhere).
      const nextUse = Math.min(clipDuration(s.clipId), ...out.filter((x) => x !== s && x.clipId === s.clipId && x.start >= s.end - 0.05).map((x) => x.start));
      const room = Math.max(0, nextUse - s.end);
      const headroom = Math.max(0, cap - run(i)) * (s.speed ?? 1);
      s.end += Math.min(room, headroom, (seconds - len(out)) * (s.speed ?? 1));
    }
  }
  return out;
}

/** The longest the same shot should stay on screen in one go when footage is stretched to fit. */
export const MAX_SHOT_SECONDS = 3.5;

/**
 * Footage is never replayed (the creator's rule: the same clip shows up once in a video), so this
 * returns the footage as it is; kept for the callers that used to replay a short clip.
 */
export function replayOnce(segments: Segment[], _seconds: number): Segment[] {
  return segments;
}

/**
 * Bring a video made under older rules up to the current ones, keeping its words: no footage played
 * more than twice, educational points spread over the frame and on screen long enough to read, and
 * the call to action on the last 3s. Used whenever a video is re-made (text, style, Fix the text).
 */
export function healPlan<P extends { format?: string; segments: Segment[]; overlays?: Overlay[] }>(plan: P, ctaSite?: string): P {
  const len = (xs: Segment[]) => xs.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
  // Footage: each part once (no replays).
  const key = (s: Segment) => `${s.clipId}:${s.start.toFixed(2)}`;
  const plays = new Map<string, number>();
  let segments = plan.segments.filter((s) => {
    const n = (plays.get(key(s)) ?? 0) + 1;
    plays.set(key(s), n);
    return n <= 1;
  });
  if (plan.format !== "tips" || !plan.overlays?.length) return { ...plan, segments };
  const site = ctaSite?.toLowerCase();
  const isCta = (o: Overlay) => !!site && o.text.toLowerCase().includes(site.replace(/^www\./, ""));
  const cta = plan.overlays.find(isCta);
  const rest = plan.overlays.filter((o) => !isCta(o));
  // Unique footage first; replays only as far as the text needs.
  const unique = segments.filter((s, i) => segments.findIndex((x) => key(x) === key(s)) === i);
  const ctaSeconds = cta ? 3 : 0;
  const need = rest.length > 1 ? timePoints(spreadPoints(rest), 0).need + ctaSeconds : len(unique);
  segments = len(unique) >= need ? unique : replayOnce(unique, need);
  const total = len(segments);
  const body = rest.length > 1 ? timePoints(spreadPoints(rest), Math.max(1, total - ctaSeconds)).overlays : rest;
  const overlays = body.map((o, i) => (i === 0 ? { ...o, start: 0, end: total + 1 } : o.end > total - ctaSeconds && cta ? { ...o, end: total - ctaSeconds } : o));
  if (cta) overlays.push({ ...cta, start: Math.max(0, total - ctaSeconds), end: total + 1, y: cta.y ?? 0.6 });
  return { ...plan, segments, overlays };
}
