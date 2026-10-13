import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { run, frameAt, probe } from "./ffmpeg.ts";
import type { Clip, RenderOptions, VideoPlan } from "../types.ts";

const { width: W, height: H, fps: FPS } = config.output;

// TikTok's UI covers the top bar, the right-hand action rail and the bottom
// caption area. Keep text inside the safe zone.
const HOOK_Y = 0.17;
const CAPTION_Y = 0.64;

/** Drawtext can't render color emoji; strip them from on-screen text. */
export function screenText(s: string): string {
  return s
    .replace(/\p{Extended_Pictographic}|\u200d|\ufe0f/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Greedy word wrap. */
export function wrap(text: string, maxChars: number): string[] {
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
  return lines.slice(0, 4);
}

/**
 * One drawtext filter per line so every line is centered. Text goes through
 * files (textfile=) so quotes, colons and % never need filter escaping.
 */
function textFilters(
  text: string,
  opts: { yFrac: number; size: number; maxChars: number; style: RenderOptions["textStyle"]; enable?: string; tmp: string; key: string },
): string[] {
  const clean = screenText(text);
  if (!clean || !config.fontFile) return [];
  const lines = wrap(clean, opts.maxChars);
  const lineH = Math.round(opts.size * 1.22);
  const top = Math.round(H * opts.yFrac - (lines.length * lineH) / 2);
  return lines.map((line, i) => {
    const file = path.join(opts.tmp, `${opts.key}-${i}.txt`);
    fs.writeFileSync(file, line);
    const style =
      opts.style === "box"
        ? "fontcolor=black:box=1:boxcolor=white@0.95:boxborderw=16"
        : "fontcolor=white:borderw=7:bordercolor=black@0.9:shadowcolor=black@0.5:shadowx=0:shadowy=4";
    return [
      `drawtext=fontfile='${esc(config.fontFile!)}'`,
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
}

/** Escape a value for use inside single quotes in an ffmpeg filter graph. */
const esc = (s: string) => s.replace(/\\/g, "/").replace(/'/g, "'\\''").replace(/:/g, "\\:");

function framingFor(clip: Clip, mode: RenderOptions["framing"]): "fill" | "blur" {
  if (mode !== "auto") return mode;
  // Portrait and near-portrait footage fills the frame; landscape gets a blurred backdrop.
  return clip.width / clip.height <= 0.8 ? "fill" : "blur";
}

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
  handle: string,
  onProgress: (p: number) => void,
): Promise<RenderResult> {
  const tmp = path.join(config.tmpDir, id);
  fs.mkdirSync(tmp, { recursive: true });
  const steps = plan.segments.length + 2;
  try {
    const parts: string[] = [];
    for (const [i, seg] of plan.segments.entries()) {
      const clip = clips.get(seg.clipId);
      if (!clip) throw new Error(`Clip ${seg.clipId} no longer exists`);
      const out = path.join(tmp, `seg${String(i).padStart(3, "0")}.mp4`);
      await renderSegment(clip, seg.start, seg.end, seg.speed ?? 1, seg.caption, options, out, tmp, `cap${i}`);
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
    await finalize(joined, file, duration, plan, options, handle, tmp);
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
  out: string,
  tmp: string,
  key: string,
) {
  const len = Math.max(0.3, end - start);
  const outLen = len / speed;
  const framing = framingFor(clip, options.framing);
  const base =
    framing === "fill"
      ? `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[v0]`
      : `[0:v]split[a][b];` +
        `[a]scale=${W / 4}:${H / 4}:force_original_aspect_ratio=increase,crop=${W / 4}:${H / 4},boxblur=12:3,scale=${W}:${H},eq=brightness=-0.08[bg];` +
        `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v0]`;
  const text = caption
    ? textFilters(caption, { yFrac: CAPTION_Y, size: 66, maxChars: 22, style: options.textStyle, tmp, key })
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
    "-i", clip.file,
    "-f", "lavfi", "-t", outLen.toFixed(3), "-i", "anullsrc=r=44100:cl=stereo",
    "-filter_complex", `${base};[v0]${video}[vout];${audio}`,
    "-map", "[vout]", "-map", "[aout]",
    "-t", outLen.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
    "-video_track_timescale", "15360",
    out,
  ]);
}

/** atempo only accepts 0.5–2.0 per instance. */
function atempo(speed: number): string {
  if (speed === 1) return "";
  return `atempo=${Math.max(0.5, Math.min(2, speed))},`;
}

async function finalize(
  input: string,
  out: string,
  duration: number,
  plan: VideoPlan,
  options: RenderOptions,
  handle: string,
  tmp: string,
) {
  const hookUntil = Math.min(2.8, duration);
  const filters = [
    ...textFilters(plan.hook, {
      yFrac: HOOK_Y,
      size: 78,
      maxChars: 20,
      style: options.textStyle,
      enable: `lt(t,${hookUntil.toFixed(2)})`,
      tmp,
      key: "hook",
    }),
    ...(handle
      ? textFilters(handle, { yFrac: 0.93, size: 34, maxChars: 40, style: "classic", tmp, key: "handle" })
      : []),
  ];
  const vf = filters.length ? `[0:v]${filters.join(",")}[vout]` : `[0:v]null[vout]`;
  const music = options.musicFile && fs.existsSync(options.musicFile);
  const fadeAt = Math.max(0, duration - 1).toFixed(2);
  const af = music
    ? `[1:a]atrim=0:${duration.toFixed(3)},volume=${options.keepOriginalAudio ? 0.35 : 1},afade=t=out:st=${fadeAt}:d=1[m];` +
      `[0:a][m]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`
    : `[0:a]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;

  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", input,
    ...(music ? ["-i", options.musicFile!] : []),
    "-filter_complex", `${vf};${af}`,
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
    "-r", String(FPS), "-movflags", "+faststart",
    "-t", duration.toFixed(3),
    out,
  ]);
}
