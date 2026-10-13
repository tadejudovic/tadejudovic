import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { store, newId } from "./store.ts";
import { probe, frameAt, photoToClip } from "./media/ffmpeg.ts";
import { energyCurve, findMoments } from "./media/analyze.ts";
import { tagClip } from "./ai/director.ts";
import { download, type PickedMediaItem } from "./google/picker.ts";
import { ingestQueue } from "./queue.ts";
import type { Clip, ClipSource } from "./types.ts";

const PHOTO_SECONDS = 3;

/** Thrown from a clip's fetch to drop it quietly (e.g. a shared-album item turned out to be a photo). */
export class SkipItem extends Error {}

/** Register a clip and queue its download/analysis. */
export function enqueueClip(opts: {
  source: ClipSource;
  filename: string;
  sourceId?: string;
  capturedAt?: string;
  /** Produces the original file at `dest`. */
  fetch: (dest: string) => Promise<void>;
  onDone?: (result: "ready" | "skipped" | "error") => void;
}): Clip {
  const id = newId();
  const ext = path.extname(opts.filename) || ".bin";
  const original = path.join(config.mediaDir, `${id}.orig${ext.toLowerCase()}`);
  const clip = store.addClip({
    id,
    source: opts.source,
    sourceId: opts.sourceId,
    filename: opts.filename,
    file: original,
    kind: "video",
    capturedAt: opts.capturedAt,
    importedAt: new Date().toISOString(),
    duration: 0,
    width: 0,
    height: 0,
    hasAudio: false,
    status: "importing",
    uses: 0,
  });
  ingestQueue.push(async () => {
    try {
      await opts.fetch(original);
      await analyzeClip(id);
      opts.onDone?.("ready");
    } catch (err) {
      if (err instanceof SkipItem) {
        deleteClip(id);
        opts.onDone?.("skipped");
        return;
      }
      store.updateClip(id, { status: "error", error: (err as Error).message });
      opts.onDone?.("error");
    }
  });
  return clip;
}

export function importPicked(items: PickedMediaItem[]) {
  const fresh = items.filter((it) => !store.hasSource(it.id));
  return fresh.map((item) =>
    enqueueClip({
      source: "google_photos",
      sourceId: item.id,
      filename: item.mediaFile.filename,
      capturedAt: item.createTime,
      fetch: (dest) => download(item, dest),
    }),
  );
}

export async function analyzeClip(id: string) {
  const clip = store.clip(id);
  if (!clip) return;
  store.updateClip(id, { status: "analyzing", error: undefined });
  let info = await probe(clip.file);
  if (!info.hasVideo) throw new Error("No video stream found in this file.");

  let file = clip.file;
  let kind: Clip["kind"] = "video";
  if (info.isStill) {
    // Photos become a short slow-zoom clip so they can be cut like video.
    file = path.join(config.mediaDir, `${id}.mp4`);
    await photoToClip(clip.file, file, PHOTO_SECONDS);
    kind = "photo";
    info = await probe(file);
  }

  const thumb = path.join(config.thumbsDir, `${id}.jpg`);
  await frameAt(file, Math.min(1, info.duration / 2), thumb);
  const energy = await energyCurve(file, info.duration, info.hasAudio);
  const moments = findMoments(energy, info.duration, 3, 6);
  store.updateClip(id, {
    file,
    kind,
    thumb,
    duration: Math.round(info.duration * 100) / 100,
    width: info.width,
    height: info.height,
    hasAudio: info.hasAudio,
    capturedAt: clip.capturedAt ?? info.createdAt,
    energy,
    moments,
    status: "ready",
  });

  if (config.claude.enabled) {
    try {
      const ai = await tagClip(store.clip(id)!, store.settings().petName);
      store.updateClip(id, { ai });
    } catch (err) {
      // AI tagging is an enhancement; the heuristic moments still work.
      console.warn(`[ai] tagging ${clip.filename} failed:`, (err as Error).message);
    }
  }
}

export function deleteClip(id: string) {
  const clip = store.clip(id);
  if (!clip) return;
  for (const f of new Set([clip.file, clip.thumb, path.join(config.mediaDir, `${id}.mp4`)])) {
    if (f) fs.rmSync(f, { force: true });
  }
  for (const f of fs.readdirSync(config.mediaDir)) {
    if (f.startsWith(`${id}.`)) fs.rmSync(path.join(config.mediaDir, f), { force: true });
  }
  store.removeClip(id);
}
