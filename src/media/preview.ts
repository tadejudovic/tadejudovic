import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { run } from "./ffmpeg.ts";
import { renderQueue } from "../queue.ts";

/**
 * Light copies for watching in the app: 720 px wide at a low bitrate (~4 MB for a 20 s video instead
 * of ~25 MB). Everything shown in the app is served from these; the full-quality file is only sent
 * to download or share. Made in the background in the heavy-work lane (never next to a render on a
 * small server), right after a render and on first request; until then the original is served.
 */
const dir = path.join(config.dataDir, "previews");
fs.mkdirSync(dir, { recursive: true });

export const previewPath = (key: string) => path.join(dir, `${key}.mp4`);

const making = new Set<string>();

/** The preview if it's ready; otherwise starts making it and returns undefined. */
export function previewFor(key: string, source: string, width = 720): string | undefined {
  const out = previewPath(key);
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(source).mtimeMs) return out;
  if (!making.has(key)) {
    making.add(key);
    renderQueue.push(() =>
      makePreview(source, out, width)
        .catch((err) => console.warn(`[preview] ${key}:`, (err as Error).message))
        .finally(() => making.delete(key)),
    );
  }
  return undefined;
}

async function makePreview(source: string, out: string, width: number) {
  const tmp = `${out}.part.mp4`;
  await run("ffmpeg", [
    "-y", "-v", "error", "-threads", "1",
    "-i", source,
    "-vf", `scale=${width}:-2`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-maxrate", "1800k", "-bufsize", "3600k", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    "-threads", "1",
    tmp,
  ]);
  fs.renameSync(tmp, out);
}

export function removePreview(key: string) {
  fs.rmSync(previewPath(key), { force: true });
}
