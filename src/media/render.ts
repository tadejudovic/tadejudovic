import crypto from "node:crypto";
import opentype from "opentype.js";
import { writeArrow } from "./arrow.ts";
import fs from "node:fs";
import path from "node:path";
import { config, canDecode4K } from "../config.ts";
import { run, frameAt, probe } from "./ffmpeg.ts";
import { fontPath } from "../fonts.ts";
import type { Clip, Overlay, RenderOptions, VideoPlan } from "../types.ts";

const { width: W, height: H, fps: FPS } = config.output;

/**
 * The part of a 1080x1920 frame that TikTok and Instagram Reels leave uncovered: their top bar, the
 * like/comment/share rail on the right and the caption and buttons at the bottom cover the rest.
 * Text always stays inside it (fractions of the frame).
 */
// Left: tall phones (20:9) crop the sides of a 9:16 video by up to ~10%, so text keeps clear of that too.
export const SAFE = { top: 0.12, bottom: 0.76, left: 0.1, right: 0.87 } as const;
const SAFE_CX = Math.round((W * (SAFE.left + SAFE.right)) / 2);
const SAFE_W = Math.round(W * (SAFE.right - SAFE.left));
const HOOK_Y = 0.17;
/**
 * On-screen text size (px on a 1080x1920 frame). TikTok-style overlays read best at roughly
 * 55-70px: big enough to read at a glance, small enough to stay 2-3 lines and leave the
 * dog visible. Medium is the default.
 */
export const TEXT_PX = { small: 42, medium: 48, large: 56 } as const;
const textPx = (o: RenderOptions) => TEXT_PX[o.textSize ?? "medium"] ?? TEXT_PX.medium;
/** Smaller text fits more words per line. */
const charsFor = (px: number, at70: number) => Math.round((at70 * 70) / px);
const CAPTION_Y = 0.64;

/** Drawtext can't render color emoji; strip them from on-screen text. */
export function screenText(s: string): string {
  return s
    .replace(/\p{Extended_Pictographic}|\u200d|\ufe0f/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Greedy word wrap. " / " forces a line break (as in "nobody: / my dog:"). */
export function wrap(text: string, maxChars: number): string[] {
  const parts = text.split(/\s+\/\s+/);
  // Lists (a hook plus tips building up) can run longer than a one-liner; the renderer shrinks them a bit.
  if (parts.length > 1) return parts.flatMap((p) => wrap(p, maxChars)).slice(0, parts.length >= 3 ? 8 : 5);
  const greedy = wrapGreedy(text, maxChars);
  // Re-wrap to even line lengths so the last line isn't a lonely word.
  for (let w = Math.ceil(text.length / greedy.length); w < maxChars; w++) {
    const even = wrapGreedy(text, w);
    if (even.length <= greedy.length) return even.slice(0, 4);
  }
  return greedy.slice(0, 4);
}

function wrapGreedy(text: string, maxChars: number): string[] {
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > maxChars) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

interface TextOpts {
  /** Vertical center of the text block, as a fraction of the frame height. */
  yFrac: number;
  /** Or: pixel position of the top of the block (wins over yFrac). */
  yTop?: number;
  /** Horizontal center as a fraction of the width (centered in the safe zone when unset). */
  xFrac?: number;
  size: number;
  maxChars: number;
  style: RenderOptions["textStyle"];
  font: string;
  enable?: string;
  tmp: string;
  key: string;
}

/**
 * One drawtext filter per line so every line is centered. Text goes through
 * files (textfile=) so quotes, colons and % never need filter escaping.
 */
export function textFilters(text: string, opts: TextOpts): { filters: string[]; height: number; top: number } {
  const clean = screenText(text);
  if (!clean) return { filters: [], height: 0, top: 0 };
  const boxed = !opts.style || opts.style === "yellowbox" || opts.style === "box";
  const padX = Math.round(opts.size * 0.55);
  const padY = Math.round(opts.size * 0.38);
  // Off-center text (points that zig-zag) keeps its center and gets the room on its narrower side.
  const cx = opts.xFrac === undefined ? SAFE_CX : Math.round(W * Math.max(SAFE.left + 0.2, Math.min(SAFE.right - 0.2, opts.xFrac)));
  const room = Math.min(SAFE_W, 2 * Math.min(cx - W * SAFE.left, W * SAFE.right - cx));
  // Lines are wrapped to fit that width (measured with the font), not just a character count.
  const maxTextW = room - (boxed ? padX * 2 : 24);
  let chars = opts.maxChars;
  let lines = wrap(clean, chars);
  while (chars > 10 && lines.some((l) => textWidth(opts.font, l, opts.size) > maxTextW)) lines = wrap(clean, --chars);
  const lineH = Math.round(opts.size * 1.24);
  let top = opts.yTop ?? Math.round(H * opts.yFrac - (lines.length * lineH) / 2);
  // Inside the safe zone, top to bottom.
  const blockH = (lines.length - 1) * lineH + opts.size * 1.08;
  const minTop = Math.round(H * SAFE.top + padY);
  const maxTop = Math.round(H * SAFE.bottom - padY - blockH);
  top = Math.max(minTop, Math.min(top, Math.max(minTop, maxTop)));
  // Box styles: one solid block behind all the lines, sized to the widest one.
  // No style given (older videos, other entry points): the yellow box, the default look.
  if (!opts.style) opts = { ...opts, style: "yellowbox" };
  const block = opts.style === "yellowbox" ? "0xF5C400" : opts.style === "box" ? "white" : null;
  if (block) {
    const widths = lines.map((l) => textWidth(opts.font, l, opts.size));
    const w = Math.min(room, Math.round(Math.max(...widths)) + padX * 2);
    const h = Math.round(blockH) + padY * 2;
    const box = [
      `drawbox=x=${Math.round(cx - w / 2)}:y=${top - padY}:w=${w}:h=${h}:color=${block}@1:t=fill`,
      opts.enable ? `enable='${opts.enable}'` : "",
    ].filter(Boolean).join(":");
    const ink = textFilters(text, { ...opts, yTop: top, maxChars: chars, style: "ink" as RenderOptions["textStyle"] });
    return { filters: [box, ...ink.filters], height: ink.height, top };
  }
  const style = {
    ink: "fontcolor=0x111111",
    yellowbox: "",
    classic: "fontcolor=white:borderw=7:bordercolor=black@0.95:shadowcolor=black@0.45:shadowx=0:shadowy=4",
    box: "fontcolor=black:box=1:boxcolor=white@0.97:boxborderw=18",
    plain: "fontcolor=white:shadowcolor=black@0.7:shadowx=0:shadowy=3",
    // CapCut's yellow preset: yellow fill, thin dark outline, drop shadow down and to the right.
    yellow: "fontcolor=0xFFE41A:borderw=4:bordercolor=0x1A1400@0.95:shadowcolor=black@0.55:shadowx=5:shadowy=5",
  }[opts.style];
  const filters = lines.map((line, i) => {
    const file = path.join(opts.tmp, `${opts.key}-${i}.txt`);
    fs.writeFileSync(file, line);
    return [
      `drawtext=fontfile='${esc(opts.font)}'`,
      `textfile='${esc(file)}'`,
      "expansion=none",
      `fontsize=${opts.size}`,
      style,
      `x=${cx}-text_w/2`,
      `y=${top + i * lineH}`,
      opts.enable ? `enable='${opts.enable}'` : "",
    ]
      .filter(Boolean)
      .join(":");
  });
  return { filters, height: lines.length * lineH, top };
}

/** "1. Call the airline" → ["1", "Call the airline"]; text that isn't a numbered point → undefined. */
export function splitNumber(text: string): [string, string] | undefined {
  const m = /^\s*(\d{1,2})[.):]\s+(\S[\s\S]*)$/.exec(text);
  return m ? [m[1], m[2]] : undefined;
}

/** The black number tab on the left of a numbered point. */
const badgeWidth = (size: number) => Math.round(size * 1.45);

/**
 * How wide a numbered point's box is when its text is wrapped to at most `maxW`: used to give all
 * the points of a video one width, so they read as one set wherever they appear.
 */
export function pointBoxWidth(text: string, size: number, font: string, maxW: number): number {
  const split = splitNumber(screenText(text));
  if (!split) return 0;
  const padX = Math.round(size * 0.5);
  const lines = fitLines(split[1], maxW - badgeWidth(size) - padX * 2, size, font, charsFor(size, 24));
  return Math.min(maxW, Math.round(Math.max(...lines.map((l) => textWidth(font, l, size)))) + badgeWidth(size) + padX * 2);
}

function fitLines(text: string, maxTextW: number, size: number, font: string, maxChars: number): string[] {
  let chars = maxChars;
  let lines = wrap(text, chars);
  while (chars > 10 && lines.some((l) => textWidth(font, l, size) > maxTextW)) lines = wrap(text, --chars);
  return lines;
}

/**
 * A numbered point in the box styles: a black tab with the number in yellow on the left, the text
 * left-aligned in the box beside it, the box `boxW` wide (the same for every point of the video).
 * Same return as textFilters: the text block's height and top, without the box padding.
 */
export function pointFilters(num: string, text: string, opts: TextOpts & { boxW: number }): { filters: string[]; height: number; top: number } {
  const size = opts.size;
  const padX = Math.round(size * 0.5);
  const padY = Math.round(size * 0.38);
  const badgeW = badgeWidth(size);
  const w = Math.min(opts.boxW, SAFE_W);
  const cx = opts.xFrac === undefined ? SAFE_CX : W * opts.xFrac;
  const left = Math.round(Math.max(W * SAFE.left, Math.min(W * SAFE.right - w, cx - w / 2)));
  const lines = fitLines(screenText(text), w - badgeW - padX * 2, size, opts.font, opts.maxChars);
  const lineH = Math.round(size * 1.24);
  const blockH = (lines.length - 1) * lineH + size * 1.08;
  let top = opts.yTop ?? Math.round(H * opts.yFrac - (lines.length * lineH) / 2);
  const minTop = Math.round(H * SAFE.top + padY);
  const maxTop = Math.round(H * SAFE.bottom - padY - blockH);
  top = Math.max(minTop, Math.min(top, Math.max(minTop, maxTop)));
  const h = Math.round(blockH) + padY * 2;
  const enable = opts.enable ? `enable='${opts.enable}'` : "";
  const body = opts.style === "box" ? "white" : "0xF5C400";
  const write = (name: string, s: string) => {
    const file = path.join(opts.tmp, `${opts.key}-${name}.txt`);
    fs.writeFileSync(file, s);
    return `textfile='${esc(file)}'`;
  };
  const numSize = Math.round(size * 1.15);
  const filters = [
    [`drawbox=x=${left + badgeW}:y=${top - padY}:w=${w - badgeW}:h=${h}:color=${body}@1:t=fill`, enable],
    [`drawbox=x=${left}:y=${top - padY}:w=${badgeW}:h=${h}:color=0x111111@1:t=fill`, enable],
    [
      `drawtext=fontfile='${esc(opts.font)}'`, write("n", num), "expansion=none", `fontsize=${numSize}`, `fontcolor=${body}`,
      `x=${left + badgeW / 2}-text_w/2`, `y=${top - padY + h / 2}-text_h/2`, enable,
    ],
    ...lines.map((line, i) => [
      `drawtext=fontfile='${esc(opts.font)}'`, write(String(i), line), "expansion=none", `fontsize=${size}`, "fontcolor=0x111111",
      `x=${left + badgeW + padX}`, `y=${top + i * lineH}`, enable,
    ]),
  ].map((parts) => parts.filter(Boolean).join(":"));
  return { filters, height: lines.length * lineH, top };
}

/**
 * Where a text box of `height` (plus padding) can go so it stays off the subject (the dog, faces):
 * its top, moved above or below the subject's band if it would cover it. Returns `top` unchanged
 * when it's already clear or there's no room either side.
 */
export function clearOfSubject(top: number, height: number, pad: number, band?: { top: number; bottom: number }): number {
  if (!band) return top;
  const kt = band.top * H;
  const kb = band.bottom * H;
  if (top + height + pad <= kt || top - pad >= kb) return top;
  const above = kt - 24 - pad - height;
  const below = kb + 24 + pad;
  const fitsAbove = above - pad >= H * SAFE.top;
  const fitsBelow = below + height + pad <= H * SAFE.bottom;
  if (fitsAbove && (!fitsBelow || top - above <= below - top)) return above;
  if (fitsBelow) return below;
  return top;
}

/** Escape a value for use inside single quotes in an ffmpeg filter graph. */
const esc = (s: string) => s.replace(/\\/g, "/").replace(/'/g, "'\\''").replace(/:/g, "\\:");

/**
 * Memory-lean encoding for small servers (Render Starter has 512 MB including the app):
 * one thread and a short look-ahead keep each ffmpeg run around 250 MB instead of 600 MB.
 */
const SINGLE_THREAD = ["-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1"];
const LEAN_X264 = ["-x264-params", "rc-lookahead=10:sync-lookahead=0"];

export interface RenderResult {
  file: string;
  thumb: string;
  duration: number;
}

/**
 * The cut footage without any text (the clips trimmed, scaled and joined) is kept per video, keyed by
 * exactly which footage it is, so changing only the text or its look redraws the text on it instead
 * of cutting every clip again.
 */
const baseDir = () => path.join(config.rendersDir, "base");
export function baseKey(plan: VideoPlan, clips: Map<string, Clip>): string | undefined {
  // Per-segment captions are drawn while cutting, so those videos can't reuse a text-free base.
  if (!plan.overlays?.length) return undefined;
  const footage = plan.segments.map((s) => [s.clipId, clips.get(s.clipId)?.file, s.start.toFixed(3), s.end.toFixed(3), s.speed ?? 1]);
  return crypto.createHash("sha1").update(JSON.stringify([footage, W, H, FPS])).digest("hex").slice(0, 20);
}
export const basePath = (key: string) => path.join(baseDir(), `${key}.mp4`);

export async function renderVideo(
  id: string,
  plan: VideoPlan,
  clips: Map<string, Clip>,
  options: RenderOptions,
  onProgress: (p: number) => void,
): Promise<RenderResult> {
  const tmp = path.join(config.tmpDir, id);
  fs.mkdirSync(tmp, { recursive: true });
  // Never decode a 4K original on a small machine: it's what runs the server out of memory.
  for (const id of new Set(plan.segments.map((s) => s.clipId))) {
    const clip = clips.get(id);
    if (!clip || canDecode4K) continue;
    const info = await probe(clip.file);
    if (Math.max(info.width, info.height) > 1920 || Math.min(info.width, info.height) > 1080) {
      throw new Error("A clip in this video is still a 4K original; it's being converted. Try again in a few minutes.");
    }
  }
  const font = await fontPath(options.fontId);
  if (!font) throw new Error("No font available for on-screen text. Pick a font or set FONT_FILE.");
  const steps = plan.segments.length + 2;
  try {
    const key = baseKey(plan, clips);
    const cached = key && fs.existsSync(basePath(key)) ? basePath(key) : undefined;
    let joined = path.join(tmp, "joined.mp4");
    if (cached) {
      // Same footage as before (only the text or its look changed): just redraw the text.
      joined = cached;
      onProgress((steps - 1) / steps);
    } else {
    const parts: string[] = [];
    for (const [i, seg] of plan.segments.entries()) {
      const clip = clips.get(seg.clipId);
      if (!clip) throw new Error(`Clip ${seg.clipId} no longer exists`);
      const out = path.join(tmp, `seg${String(i).padStart(3, "0")}.mp4`);
      // Timed overlays are drawn over the whole video in the final pass instead.
      const caption = plan.overlays?.length ? undefined : seg.caption;
      await renderSegment(clip, seg.start, seg.end, seg.speed ?? 1, caption, options, font, out, tmp, `cap${i}`);
      parts.push(out);
      onProgress((i + 1) / steps);
    }

    const list = path.join(tmp, "list.txt");
    fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
    await run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
    if (key) {
      fs.mkdirSync(baseDir(), { recursive: true });
      fs.copyFileSync(joined, basePath(key));
    }
    onProgress((steps - 1) / steps);
    }

    const { duration } = await probe(joined);
    const file = path.join(config.rendersDir, `${id}.mp4`);
    await finalize(joined, file, duration, plan, options, font, tmp);
    const thumb = path.join(config.rendersDir, `${id}.jpg`);
    await frameAt(file, Math.min(0.8, duration / 2), thumb, 540);
    onProgress(1);
    return { file, thumb, duration };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function renderSegment(
  clip: Clip,
  start: number,
  end: number,
  speed: number,
  caption: string | undefined,
  options: RenderOptions,
  font: string,
  out: string,
  tmp: string,
  key: string,
) {
  const len = Math.max(0.3, end - start);
  const outLen = len / speed;
  // Portrait only: fill the 9:16 frame.
  const base = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[v0]`;
  const text = caption
    ? textFilters(caption, { yFrac: CAPTION_Y, size: Math.round(textPx(options) * 0.95), maxChars: charsFor(textPx(options), 22), style: options.textStyle, font, tmp, key }).filters
    : [];
  const video = [`setpts=(PTS-STARTPTS)/${speed}`, `fps=${FPS}`, ...text, "format=yuv420p"].join(",");
  const useAudio = clip.hasAudio && options.keepOriginalAudio;
  const audio = useAudio
    ? `[0:a]asetpts=PTS-STARTPTS,${atempo(speed)}aresample=44100,aformat=channel_layouts=stereo,apad,atrim=0:${outLen.toFixed(3)}[aout]`
    : `[1:a]atrim=0:${outLen.toFixed(3)}[aout]`;

  await run("ffmpeg", [
    "-y", "-v", "error",
    "-ss", start.toFixed(3),
    "-t", len.toFixed(3),
    "-threads", "1",
    "-i", clip.file,
    "-f", "lavfi", "-t", outLen.toFixed(3), "-i", "anullsrc=r=44100:cl=stereo",
    "-filter_complex", `${base};[v0]${video}[vout];${audio}`,
    "-map", "[vout]", "-map", "[aout]",
    "-t", outLen.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-r", String(FPS),
    ...LEAN_X264,
    "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
    "-video_track_timescale", "15360",
    ...SINGLE_THREAD,
    out,
  ]);
}

/** atempo only accepts 0.5–2.0 per instance. */
function atempo(speed: number): string {
  if (speed === 1) return "";
  return `atempo=${Math.max(0.5, Math.min(2, speed))},`;
}

/** The overlays to draw: explicit timed overlays, or the hook (full length for text-overlay videos). */
export function overlaysFor(plan: VideoPlan, duration: number): Overlay[] {
  if (plan.overlays?.length) return plan.overlays;
  if (!plan.hook) return [];
  const full = plan.template === "text_overlay" || plan.template === "auto";
  return [{ text: plan.hook, start: 0, end: full ? duration + 1 : Math.min(2.8, duration) }];
}

async function finalize(
  input: string,
  out: string,
  duration: number,
  plan: VideoPlan,
  options: RenderOptions,
  font: string,
  tmp: string,
) {
  // Placed points (educational) show one at a time: each goes when the next one comes.
  const overlays = overlaysFor(plan, duration).map((o) => ({ ...o }));
  const points = overlays.filter((o) => o.y !== undefined).sort((a, b) => a.start - b.start);
  for (let i = 0; i < points.length - 1; i++) if (points[i].end > points[i + 1].start) points[i].end = points[i + 1].start;
  // Nothing flashes by: a line too short to read stays up at least 1.5s (within the video).
  for (const o of overlays) if (o.y === undefined && o.end - o.start < 1.5) o.end = Math.min(duration + 1, o.start + 1.5);
  // Once the points start, the hook steps back: it shrinks into a header at the top, so the point is
  // what the eye goes to.
  const boxed = !options.textStyle || options.textStyle === "yellowbox" || options.textStyle === "box";
  const headers = new Set<Overlay>();
  const numbered = boxed ? points.filter((o) => splitNumber(screenText(o.text))) : [];
  if (numbered.length) {
    const first = numbered[0].start;
    for (const o of [...overlays])
      if (o.y === undefined && o.at !== "caption" && o.start < first - 0.5 && o.end > first + 0.5) {
        const header = { ...o, start: first };
        o.end = first;
        headers.add(header);
        overlays.push(header);
      }
  }
  // Numbered points share one box width: the widest point's (wrapped to at most 64% of the frame).
  const pointPx = (o: Overlay) => (overlays.some((x) => x.text.split(/\s+\/\s+/).length >= 3 && (x.at ?? "") === (o.at ?? "")) ? Math.round(textPx(options) * 0.82) : textPx(options));
  const pointW = Math.max(0, ...numbered.map((o) => pointBoxWidth(o.text, pointPx(o), font, Math.round(W * 0.64))));
  const filters: string[] = [];
  const placed: { o: Overlay; bottom: number; top: number; end: number }[] = [];
  // One text size per position for the whole video: if any overlay there is a list of three or more
  // lines (tips), all of them are set a little smaller, so the text never changes size mid-video.
  const smaller = new Set(overlays.filter((o) => o.text.split(/\s+\/\s+/).length >= 3).map((o) => o.at ?? ""));
  const arrows: { file: string; start: number; end: number }[] = [];
  // Text in its usual place first (the hook), then text placed by the AI, which must stay clear of it.
  const order = [...overlays.keys()].sort(
    (a, b) => Number(overlays[a].y !== undefined) - Number(overlays[b].y !== undefined) || overlays[a].start - overlays[b].start,
  );
  let lastPointY: number | undefined;
  for (const i of order) {
    const o = overlays[i];
    const px = headers.has(o)
      ? Math.round(textPx(options) * 0.72)
      : smaller.has(o.at ?? "") ? Math.round(textPx(options) * 0.82) : textPx(options);
    const boxPad = Math.round(px * 0.38) + 10;
    const enable = `between(t,${o.start.toFixed(2)},${o.end.toFixed(2)})`;
    // Placed by the AI next to what it's about (educational points), maybe with an arrow pointing at it.
    if (o.y !== undefined) {
      const num = numbered.includes(o) ? splitNumber(screenText(o.text)) : undefined;
      const draw = (y: number) => {
        const opts = { yFrac: y, xFrac: o.x, size: px, maxChars: charsFor(px, 24), style: options.textStyle, font, enable, tmp, key: `ov${i}` };
        return num ? pointFilters(num[0], num[1], { ...opts, boxW: pointW }) : textFilters(o.text, opts);
      };
      let y = o.y;
      let { filters: f, height, top: drawnTop } = draw(y);
      // An arrow needs room to read as one: if the thing is right next to the text, move the text away from it.
      if (o.pointTo) {
        const ty = o.pointTo.y * H;
        const top = drawnTop;
        const bottom = top + height;
        const gap = ty > bottom ? ty - bottom : top - ty;
        if (gap >= 0 && gap < 200) {
          y = Math.max(0.1, Math.min(0.85, y + ((ty > bottom ? -1 : 1) * (200 - gap)) / H));
          ({ filters: f, height, top: drawnTop } = draw(y));
        }
      }
      // Points without an arrow: the best of several heights. Off the subject (the dog, faces) as much
      // as possible, clear of other text on screen, and never at the height of the point before, so
      // they move over the frame even when the dog fills the middle of it.
      if (!o.pointTo) {
        const others = placed.filter((p) => p.o.start < o.end && o.start < p.end);
        const prev = lastPointY;
        const score = (cy: number) => {
          const t = cy * H - height / 2 - boxPad;
          const b = cy * H + height / 2 + boxPad;
          const band = plan.keepClear ? Math.max(0, Math.min(b, plan.keepClear.bottom * H) - Math.max(t, plan.keepClear.top * H)) : 0;
          const textHit = others.some((p) => p.top < b + 20 && t - 20 < p.bottom) ? 10_000 : 0;
          const sameAsBefore = prev !== undefined && Math.abs(cy - prev) < 0.12 ? 5_000 : 0;
          const unsafe = t < H * SAFE.top || b > H * SAFE.bottom ? 20_000 : 0;
          return band + textHit + sameAsBefore + unsafe + Math.abs(cy - y) * 200;
        };
        const candidates = [y, 0.34, 0.4, 0.46, 0.52, 0.58, 0.64, 0.7];
        const best = candidates.reduce((a, c) => (score(c) < score(a) ? c : a), y);
        if (best !== y) {
          y = best;
          ({ filters: f, height, top: drawnTop } = draw(y));
        }
        lastPointY = y;
      } else if (plan.keepClear) {
        const top = clearOfSubject(drawnTop, height, boxPad, plan.keepClear);
        if (top !== drawnTop) {
          y = Math.max(0.08, Math.min(0.9, (top + height / 2) / H));
          ({ filters: f, height, top: drawnTop } = draw(y));
        }
      }
      // Never on top of other text on screen at the same time (e.g. a long hook): move below it.
      const clash = placed.filter((p) => p.o.start < o.end && o.start < p.end);
      const top0 = drawnTop - boxPad;
      const bottom0 = drawnTop + height + boxPad;
      const hit = clash.filter((p) => p.top < bottom0 && top0 < p.bottom);
      if (hit.length) {
        // Below the other text, or above it when that would leave the safe zone.
        const below = Math.max(...hit.map((p) => p.bottom)) + 30 + boxPad + height / 2;
        const above = Math.min(...hit.map((p) => p.top)) - 30 - boxPad - height / 2;
        y = below + height / 2 + boxPad <= H * SAFE.bottom || above - height / 2 - boxPad < H * SAFE.top ? below / H : above / H;
        ({ filters: f, height, top: drawnTop } = draw(y));
      }
      placed.push({ o, top: drawnTop - boxPad, bottom: drawnTop + height + boxPad, end: o.end });
      filters.push(...f);
      if (o.pointTo) {
        const top = drawnTop;
        const bottom = top + height;
        const to = { x: o.pointTo.x * W, y: o.pointTo.y * H };
        const below = to.y > bottom;
        const pad = Math.round(px * 0.38) + 14;
        const boxX = o.x === undefined ? SAFE_CX : W * o.x;
        const from = { x: boxX + Math.max(-180, Math.min(180, (to.x - boxX) * 0.5)), y: below ? bottom + pad : top - pad };
        // Stop just short of the thing, so the tip points at it instead of covering it.
        const d = Math.hypot(to.x - from.x, to.y - from.y) || 1;
        const tip = { x: to.x - ((to.x - from.x) / d) * 30, y: to.y - ((to.y - from.y) / d) * 30 };
        const file = path.join(tmp, `arrow${i}.png`);
        if (!(below ? to.y > top : to.y < top) || !writeArrow(file, W, H, from, tip)) continue;
        arrows.push({ file, start: o.start, end: o.end });
      }
      continue;
    }
    // Overlays that are on screen at the same time stack downwards (e.g. a punchline appearing under the setup).
    const above = placed.filter((p) => p.o.y === undefined && (p.o.at ?? "") === (o.at ?? "") && p.o.start < o.end && o.start < p.end);
    // The header sits at the very top of the safe zone (textFilters keeps it inside).
    let base = headers.has(o) ? 0 : Math.round(H * (o.at === "caption" ? CAPTION_Y : HOOK_Y));
    const offset = above.length ? Math.max(...above.map((p) => p.bottom)) - base + 20 + boxPad : 0;
    const yFrac = o.at === "caption" ? CAPTION_Y : HOOK_Y;
    const drawAt = (top: number) =>
      textFilters(o.text, { yFrac, yTop: top, size: px, maxChars: charsFor(px, headers.has(o) ? 26 : 24), style: options.textStyle, font, enable, tmp, key: `ov${i}` });
    let { filters: f, height, top: drawnTop } = drawAt(base + offset);
    // The first text in its place (the hook) moves above or below the subject if it would cover it.
    if (!offset && o.at !== "caption" && !headers.has(o) && plan.keepClear) {
      const top = Math.round(clearOfSubject(base, height, boxPad, plan.keepClear));
      if (top !== base) {
        base = top;
        ({ filters: f, height, top: drawnTop } = drawAt(base));
      }
    }
    filters.push(...f);
    placed.push({ o, top: drawnTop - boxPad, bottom: drawnTop + height + boxPad, end: o.end });
  }
  const music = options.musicFile && fs.existsSync(options.musicFile);
  const fadeAt = Math.max(0, duration - 1).toFixed(2);

  // Audio and video are finished in separate passes: loudness normalization alone needs ~100 MB,
  // and running it next to the video encoder pushed a render past a 512 MB server's limit.
  const audio = path.join(tmp, "audio.m4a");
  // A voiceover: the creator's lines at their places on the timeline, the clips' own sound and any
  // music turned well down underneath.
  const voice = (plan.voiceover ?? []).filter((v) => fs.existsSync(v.file));
  const voiceInputs = voice.flatMap((v) => ["-i", v.file]);
  const firstVoice = music ? 2 : 1;
  let af: string;
  if (voice.length) {
    const lines = voice.map((v, i) => {
      const ms = Math.max(0, Math.round(v.start * 1000));
      return `[${firstVoice + i}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[v${i}]`;
    });
    const voiceMix = `${voice.map((_, i) => `[v${i}]`).join("")}amix=inputs=${voice.length}:duration=longest:normalize=0[vo]`;
    const bed = music
      ? `[0:a]volume=0.18[o];[1:a]atrim=0:${duration.toFixed(3)},volume=0.12,afade=t=out:st=${fadeAt}:d=1[m];[o][m]amix=inputs=2:duration=first:normalize=0[bed]`
      : `[0:a]volume=0.18[bed]`;
    af = `${lines.join(";")};${voiceMix};${bed};[bed][vo]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;
  } else {
    af = music
      ? `[1:a]atrim=0:${duration.toFixed(3)},volume=${options.keepOriginalAudio ? 0.35 : 1},afade=t=out:st=${fadeAt}:d=1[m];` +
        `[0:a][m]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`
      : `[0:a]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;
  }
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-vn", "-threads", "1",
    "-i", input,
    ...(music ? ["-i", options.musicFile!] : []),
    ...voiceInputs,
    "-filter_complex", af,
    "-map", "[aout]",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
    "-t", duration.toFixed(3),
    ...SINGLE_THREAD,
    audio,
  ]);

  const vf = filters.length ? filters.join(",") : "null";
  // Arrows are images laid over the text-drawn frame, each only while its point is on screen.
  const graph = arrows.length
    ? `[0:v]${vf}[t0];` +
      arrows.map((a, i) => `[t${i}][${i + 2}:v]overlay=0:0:enable='between(t,${a.start.toFixed(2)},${a.end.toFixed(2)})'[t${i + 1}]`).join(";")
    : "";
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-an", "-threads", "1",
    "-i", input,
    "-i", audio,
    ...arrows.flatMap((a) => ["-i", a.file]),
    "-map", arrows.length ? `[t${arrows.length}]` : "0:v:0", "-map", "1:a:0",
    ...(arrows.length ? ["-filter_complex", graph] : ["-vf", vf]),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p",
    ...LEAN_X264,
    "-c:a", "copy",
    "-r", String(FPS), "-movflags", "+faststart",
    "-t", duration.toFixed(3),
    ...SINGLE_THREAD,
    out,
  ]);
}

const fonts = new Map<string, opentype.Font | null>();
/** How wide a line of text is drawn, in pixels (estimated if the font can't be read). */
export function textWidth(fontFile: string, text: string, size: number): number {
  if (!fonts.has(fontFile)) {
    try {
      fonts.set(fontFile, opentype.loadSync(fontFile));
    } catch {
      fonts.set(fontFile, null);
    }
  }
  const font = fonts.get(fontFile);
  return font ? font.getAdvanceWidth(text, size) : text.length * size * 0.62;
}
