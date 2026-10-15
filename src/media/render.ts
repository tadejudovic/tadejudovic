import fs from "node:fs";
import path from "node:path";
import { config, canDecode4K } from "../config.ts";
import { run, frameAt, probe } from "./ffmpeg.ts";
import { fontPath } from "../fonts.ts";
import type { Clip, Overlay, RenderOptions, VideoPlan } from "../types.ts";

const { width: W, height: H, fps: FPS } = config.output;

// TikTok's UI covers the top bar, the right-hand action rail and the bottom
// caption area. Keep text inside the safe zone.
const HOOK_Y = 0.17;
/**
 * On-screen text size (px on a 1080x1920 frame). TikTok-style overlays read best at roughly
 * 55-70px: big enough to read at a glance, small enough to stay 2-3 lines and leave the
 * dog visible. Medium is the default.
 */
export const TEXT_PX = { small: 54, medium: 62, large: 70 } as const;
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
export function textFilters(text: string, opts: TextOpts): { filters: string[]; height: number } {
  const clean = screenText(text);
  if (!clean) return { filters: [], height: 0 };
  const lines = wrap(clean, opts.maxChars);
  const lineH = Math.round(opts.size * 1.24);
  const top = opts.yTop ?? Math.round(H * opts.yFrac - (lines.length * lineH) / 2);
  const style = {
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
      "x=(w-text_w)/2",
      `y=${top + i * lineH}`,
      opts.enable ? `enable='${opts.enable}'` : "",
    ]
      .filter(Boolean)
      .join(":");
  });
  return { filters, height: lines.length * lineH };
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
    const joined = path.join(tmp, "joined.mp4");
    await run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
    onProgress((steps - 1) / steps);

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
  const overlays = overlaysFor(plan, duration);
  const filters: string[] = [];
  const placed: { o: Overlay; bottom: number }[] = [];
  for (const [i, o] of overlays.entries()) {
    // Overlays that are on screen at the same time stack downwards (e.g. a punchline appearing under the setup).
    const above = placed.filter((p) => p.o.start < o.end && o.start < p.o.end);
    const offset = above.length ? Math.max(...above.map((p) => p.bottom)) + 24 : 0;
    // A list of three or more lines (tips) is set a little smaller so every point fits.
    const px = o.text.split(/\s+\/\s+/).length >= 3 ? Math.round(textPx(options) * 0.82) : textPx(options);
    const { filters: f, height } = textFilters(o.text, {
      yFrac: HOOK_Y,
      yTop: Math.round(H * HOOK_Y) + offset,
      size: px,
      maxChars: charsFor(px, 24),
      style: options.textStyle,
      font,
      enable: `between(t,${o.start.toFixed(2)},${o.end.toFixed(2)})`,
      tmp,
      key: `ov${i}`,
    });
    filters.push(...f);
    placed.push({ o, bottom: offset + height });
  }
  const music = options.musicFile && fs.existsSync(options.musicFile);
  const fadeAt = Math.max(0, duration - 1).toFixed(2);

  // Audio and video are finished in separate passes: loudness normalization alone needs ~100 MB,
  // and running it next to the video encoder pushed a render past a 512 MB server's limit.
  const audio = path.join(tmp, "audio.m4a");
  const af = music
    ? `[1:a]atrim=0:${duration.toFixed(3)},volume=${options.keepOriginalAudio ? 0.35 : 1},afade=t=out:st=${fadeAt}:d=1[m];` +
      `[0:a][m]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`
    : `[0:a]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-vn", "-threads", "1",
    "-i", input,
    ...(music ? ["-i", options.musicFile!] : []),
    "-filter_complex", af,
    "-map", "[aout]",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
    "-t", duration.toFixed(3),
    ...SINGLE_THREAD,
    audio,
  ]);

  const vf = filters.length ? filters.join(",") : "null";
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-an", "-threads", "1",
    "-i", input,
    "-i", audio,
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p",
    ...LEAN_X264,
    "-c:a", "copy",
    "-r", String(FPS), "-movflags", "+faststart",
    "-t", duration.toFixed(3),
    ...SINGLE_THREAD,
    out,
  ]);
}
