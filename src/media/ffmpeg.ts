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
    // Before each input: limits the decoder.
    if (args[i] === "-i") out.push("-threads", THREADS);
    // Before the output (last arg): limits the encoder and filters.
    if (i === args.length - 1) out.push("-threads", THREADS, "-filter_threads", THREADS, "-filter_complex_threads", THREADS);
    out.push(args[i]);
  }
  return out;
}

/** Run ffmpeg/ffprobe and collect output. Rejects with the tail of stderr on failure. */
export function run(
  bin: "ffmpeg" | "ffprobe",
  args: string[],
  onStderr?: (line: string) => void,
): Promise<RunResult> {
  if (bin === "ffmpeg") args = withThreadLimit(args);
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
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
  const rotation = Math.abs(
    Number(video?.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0),
  );
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
  };
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
