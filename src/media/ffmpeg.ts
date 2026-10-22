import fs from "node:fs";
import { spawn } from "node:child_process";

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/**
 * Cap ffmpeg's threads. Left alone, ffmpeg starts a worker (and frame buffers)
 * per CPU it can see, which in a container is often the whole host, enough to
 * run a small instance out of memory on 4K phone footage.
 */
const THREADS = String(Math.max(1, Number(process.env.FFMPEG_THREADS) || 2));

export function withThreadLimit(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    // Before each input: limits the decoder (unless the caller already chose a thread count for it).
    if (args[i] === "-i" && args[i - 2] !== "-threads") out.push("-threads", THREADS);
    // Before the output (last arg): limits the encoder and filters.
    if (i === args.length - 1 && !args.slice(args.lastIndexOf("-i")).includes("-threads")) {
      out.push("-threads", THREADS, "-filter_threads", THREADS, "-filter_complex_threads", THREADS);
    }
    out.push(args[i]);
  }
  return out;
}

const RUN_LIMIT_MS = Number(process.env.FFMPEG_TIME_LIMIT_MS) || 30 * 60_000;

/** Run ffmpeg/ffprobe and collect output. Rejects with the tail of stderr on failure. */
export function run(
  bin: "ffmpeg" | "ffprobe",
  args: string[],
  onStderr?: (line: string) => void,
): Promise<RunResult> {
  if (bin === "ffmpeg") args = withThreadLimit(args);
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    // A hung ffmpeg would block the single heavy-work lane forever: stop it after 30 minutes.
    const killer = setTimeout(() => proc.kill("SIGKILL"), RUN_LIMIT_MS);
    proc.on("close", () => clearTimeout(killer));
    const out: Buffer[] = [];
    let err = "";
    proc.stdout.on("data", (d: Buffer) => out.push(d));
    proc.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      err += s;
      if (err.length > 200_000) err = err.slice(-100_000);
      onStderr?.(s);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`${bin} exited with ${code}: ${err.trim().split("\n").slice(-6).join("\n")}`));
    });
  });
}

export interface ProbeInfo {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  hasVideo: boolean;
  isStill: boolean;
  createdAt?: string;
  videoCodec?: string;
  pixFmt?: string;
  /** e.g. "arib-std-b67" (HLG, iPhone HDR) or "smpte2084" (PQ / HDR10). */
  colorTransfer?: string;
  /** Where it was filmed (ISO 6709, e.g. "+38.7223-009.1393/"), if the phone stored it. */
  location?: string;
  /** Clockwise rotation (0/90/180/270) needed to display the video upright. */
  rotation: number;
}

export async function probe(file: string): Promise<ProbeInfo> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  const info = JSON.parse(stdout.toString());
  const streams: any[] = info.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  let width = Number(video?.width ?? 0);
  let height = Number(video?.height ?? 0);
  // Phones store portrait video as landscape + rotation metadata.
  const rawRotation = Number(video?.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0);
  // Clockwise degrees needed to display the frame upright (what ffmpeg's autorotate applies).
  const rotation = ((Math.round(-rawRotation / 90) * 90) % 360 + 360) % 360;
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  const stillCodecs = ["mjpeg", "png", "webp", "bmp", "tiff", "gif", "heic", "hevc_image"];
  const formatName: string = info.format?.format_name ?? "";
  const isStill =
    !!video &&
    (formatName.includes("image2") || formatName.includes("_pipe") || stillCodecs.includes(video.codec_name)) &&
    !audio &&
    Number(info.format?.duration ?? 0) < 0.5;
  return {
    duration: Number(info.format?.duration ?? video?.duration ?? 0),
    width,
    height,
    hasAudio: !!audio,
    hasVideo: !!video,
    isStill,
    createdAt: info.format?.tags?.creation_time ?? video?.tags?.creation_time,
    videoCodec: video?.codec_name,
    pixFmt: video?.pix_fmt,
    colorTransfer: video?.color_transfer,
    rotation,
    location: info.format?.tags?.location ?? info.format?.tags?.["com.apple.quicktime.location.ISO6709"] ?? info.format?.tags?.["location-eng"],
  };
}

export const isHdr = (p: ProbeInfo) => p.colorTransfer === "arib-std-b67" || p.colorTransfer === "smpte2084";

/**
 * Whether a clip should be converted to a light 1080p proxy on import: anything
 * bigger than 1080p, HDR, 10-bit, or not H.264. Everything after import then
 * decodes the proxy, which keeps memory use low.
 */
export function needsProxy(p: ProbeInfo): boolean {
  const longSide = Math.max(p.width, p.height);
  const shortSide = Math.min(p.width, p.height);
  return longSide > 1920 || shortSide > 1080 || isHdr(p) || /10|12/.test(p.pixFmt ?? "") || p.videoCodec !== "h264";
}

/**
 * Convert a clip to a 1080p H.264 SDR proxy (rotation applied). The decoder runs
 * single-threaded so a 4K HEVC original only ever holds a few frames in memory.
 * HDR (HLG/PQ) is tone-mapped to SDR so colors don't look washed out.
 */
export async function makeProxy(input: string, out: string, p: ProbeInfo) {
  const big = Math.max(p.width, p.height) > 1920 || Math.min(p.width, p.height) > 1080;
  let source = input;
  let tmp: string | null = null;
  if (big) {
    // Step 1: decode the heavy original and only downscale it (stored orientation, original color),
    // into a near-lossless 10-bit intermediate. Doing this in its own process keeps the 4K decoder
    // and the final encoder from being in memory at the same time (~320 MB peak instead of ~470 MB).
    const storedPortrait = p.rotation === 90 || p.rotation === 270 ? p.width > p.height : p.height >= p.width;
    const scale = storedPortrait ? "scale='min(iw,1080)':-2:flags=lanczos" : "scale=-2:'min(ih,1080)':flags=lanczos";
    tmp = `${out}.step1.mkv`;
    await run("ffmpeg", [
      "-y", "-v", "error",
      "-noautorotate", "-threads", "1",
      "-i", input,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", scale,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p10le",
      "-x264-params", "rc-lookahead=0:sync-lookahead=0",
      "-c:a", "copy",
      "-threads", "1", "-filter_threads", "1",
      tmp,
    ]);
    source = tmp;
  }
  // Step 2 (or the only step for smaller files): HDR → SDR, rotate upright, final H.264 encode.
  const downscale = big ? "" : `scale='if(gte(iw,ih),-2,min(iw,1080))':'if(gte(iw,ih),min(ih,1080),-2)':flags=lanczos,`;
  const rotate = { 90: "transpose=clock,", 180: "hflip,vflip,", 270: "transpose=cclock," }[p.rotation] ?? "";
  const toneMap =
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,";
  const encode = (vf: string) =>
    run("ffmpeg", [
      "-y", "-v", "error",
      "-noautorotate", "-threads", "1",
      "-i", source,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", vf,
      // The working copy every video is cut from: near-transparent quality.
      "-c:v", "libx264", "-preset", "fast", "-crf", "14", "-pix_fmt", "yuv420p",
      "-x264-params", "rc-lookahead=8:sync-lookahead=0",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      "-threads", "1", "-filter_threads", "1",
      out,
    ]);
  try {
    let done = false;
    if (isHdr(p)) {
      try {
        // HDR (HLG/PQ) → SDR so colors don't look washed out.
        await encode(`${downscale}${toneMap}${rotate}format=yuv420p`);
        done = true;
      } catch (err) {
        console.warn("[proxy] HDR tone-mapping failed, converting without it:", (err as Error).message);
      }
    }
    if (!done) await encode(`${downscale}${rotate}format=yuv420p`);
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true });
  }
  // The frames are upright now; clear any rotation flag carried over so players don't rotate them again.
  if ((await probe(out)).rotation) {
    const fixed = `${out}.norot.mp4`;
    await run("ffmpeg", ["-y", "-v", "error", "-display_rotation:v:0", "0", "-i", out, "-map", "0", "-c", "copy", "-movflags", "+faststart", fixed]);
    fs.renameSync(fixed, out);
  }
}

/** Extract a single JPEG frame. */
export async function frameAt(file: string, t: number, out: string, width = 360) {
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-ss", String(Math.max(0, t)),
    "-i", file,
    "-frames:v", "1",
    "-vf", `scale=${width}:-2`,
    "-q:v", "4",
    out,
  ]);
}

/** Extract a single JPEG frame into memory (for sending to Claude). */
export async function frameBuffer(file: string, t: number, width = 512): Promise<Buffer> {
  const { stdout } = await run("ffmpeg", [
    "-v", "error",
    "-ss", String(Math.max(0, t)),
    "-i", file,
    "-frames:v", "1",
    "-vf", `scale=${width}:-2`,
    "-q:v", "5",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "pipe:1",
  ]);
  return stdout;
}

/** Turn a still photo into a short slow-zoom clip so it can be cut like video. */
export async function photoToClip(input: string, out: string, seconds = 3) {
  const { width, height, fps } = { width: 1080, height: 1920, fps: 30 };
  const frames = seconds * fps;
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-loop", "1",
    "-i", input,
    "-vf",
    [
      `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase`,
      `crop=${width * 2}:${height * 2}`,
      `zoompan=z='min(zoom+0.0015,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`,
      "format=yuv420p",
    ].join(","),
    "-t", String(seconds),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    out,
  ]);
}

/**
 * How blurry a stretch of a clip is (ffmpeg's blurdetect: lower is sharper), sampled at 3 frames a
 * second: the first frame on its own (what viewers see first) and the stretch's average. Undefined
 * when this ffmpeg has no blurdetect (added in 5.1).
 */
export async function blurOf(file: string, start: number, seconds: number): Promise<{ first: number; mean: number } | undefined> {
  try {
    const { stdout } = await run("ffmpeg", [
      "-v", "error", "-ss", start.toFixed(2), "-t", seconds.toFixed(2), "-i", file,
      "-vf", "fps=3,scale=360:-2,blurdetect,metadata=print:file=-", "-an", "-f", "null", "-",
    ]);
    const values = [...stdout.toString().matchAll(/lavfi\.blur=([\d.]+)/g)].map((m) => Number(m[1]));
    if (!values.length) return undefined;
    return { first: values[0], mean: values.reduce((a, b) => a + b, 0) / values.length };
  } catch {
    return undefined;
  }
}
