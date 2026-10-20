import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { allScenes, store, newId } from "./store.ts";
import { locateClip } from "./geo.ts";
import { probe, frameAt, photoToClip, needsProxy, makeProxy } from "./media/ffmpeg.ts";
import { energyCurve, findMoments } from "./media/analyze.ts";
import { tagClip } from "./ai/director.ts";
import { isOutOfCreditError, OutOfCredit } from "./ai/budget.ts";
import { download, type PickedMediaItem } from "./google/picker.ts";
import { ingestQueue } from "./queue.ts";
import { canDecode4K } from "./config.ts";
import { fetchAlbum, openVideo, saveResponse } from "./google/sharedAlbum.ts";
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
  onDone?: (result: "ready" | "skipped" | "error", reason?: string) => void;
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
        opts.onDone?.("skipped", err.message);
        return;
      }
      store.updateClip(id, { status: "error", error: (err as Error).message });
      opts.onDone?.("error");
    }
  }, { kind: "clip", id });
  return clip;
}

/** Picked items' links expire about an hour after picking: they're downloaded right away, two at a
 * time (network, not CPU), while the analysis follows in the heavy lane at its own pace. */
const DOWNLOADS_AT_ONCE = 2;
const MIN_FREE_FOR_DOWNLOAD = 1.5 * 1024 ** 3;
let downloading = 0;
const downloadsWaiting: (() => void)[] = [];
async function downloadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (downloading >= DOWNLOADS_AT_ONCE) await new Promise<void>((r) => downloadsWaiting.push(r));
  downloading++;
  try {
    return await fn();
  } finally {
    downloading--;
    downloadsWaiting.shift()?.();
  }
}
const freeDisk = () => {
  try {
    const s = fs.statfsSync(config.dataDir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
};

export function importPicked(items: PickedMediaItem[]) {
  const fresh = items.filter((it) => !store.hasSource(it.id));
  return fresh.map((item) => {
    let downloaded: Promise<void> | undefined;
    const clip = enqueueClip({
      source: "google_photos",
      sourceId: item.id,
      filename: item.mediaFile.filename,
      capturedAt: item.createTime,
      // The clip's turn can come at once (an idle lane): one tick, and the download below is set.
      fetch: async (dest) => {
        await Promise.resolve();
        return downloaded ?? download(item, dest);
      },
    });
    downloaded = downloadSlot(async () => {
      if (freeDisk() < MIN_FREE_FOR_DOWNLOAD) throw new Error("The server's disk is nearly full: pick these again after making room (or a bigger disk on Render).");
      await download(item, clip.file);
    });
    downloaded.catch(() => {}); // reported when the clip's turn comes
    return clip;
  });
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
  } else if (needsProxy(info)) {
    if (isBig(info) && !canDecode4K) throw new Error(TOO_BIG);
    // 4K / HDR / HEVC phone footage: convert once to a light 1080p copy that everything else uses,
    // then drop the heavy original (saves memory on every later step, and disk).
    const proxy = path.join(config.mediaDir, `${id}.mp4`);
    await makeProxy(clip.file, proxy, info);
    if (clip.file !== proxy) fs.rmSync(clip.file, { force: true });
    file = proxy;
    store.updateClip(id, { file });
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

  if (config.claude.enabled) await aiTag(id);
}

/** A clip whose AI look is missing (it failed, or ran before situations or edited-video checks existed). */
export const needsAiLook = (c: Clip) =>
  c.status === "ready" && c.kind === "video" && c.uses === 0 && !c.disliked &&
  (!c.ai || c.edited === undefined || (!c.scene && c.sceneSetBy !== "creator"));

/** Queue AI looks for clips that are missing one (a tenth of a cent each). Returns how many were queued. */
export function queueMissingAiLooks(limit = Infinity, skip = new Set<string>()): number {
  let n = 0;
  for (const c of store.clips()) {
    if (n >= limit) break;
    if (!needsAiLook(c) || skip.has(c.id)) continue;
    ingestQueue.push(() => aiTag(c.id), { kind: "clip", id: c.id });
    n++;
  }
  return n;
}

/** The last error from the cheap model, if it failed (shown in diagnostics). */
export let fastModelError: string | undefined;

/** Claude's look at a clip: its situation, best moments, and whether it's already an edited video. */
export async function aiTag(id: string) {
  const current = store.clip(id);
  if (!current) return;
  try {
    const { petName } = store.settings();
    const scenes = allScenes();
    // The cheap model first; if it fails, the main model, so sorting never silently stops.
    const { scene, alreadyEdited, place, ...ai } = await tagClip(current, petName, scenes).catch((err: Error) => {
      if (config.claude.fastModel === config.claude.model || isOutOfCreditError(err) || err instanceof OutOfCredit) throw err;
      console.warn(`[ai] fast model failed on ${current.filename} (${err.message}); trying ${config.claude.model}`);
      fastModelError = err.message.slice(0, 300);
      return tagClip(current, petName, scenes, config.claude.model);
    });
    // Never overwrite a situation the creator picked by hand.
    const keepScene = current.sceneSetBy === "creator";
    const keepEdited = current.editedSetBy === "creator";
    store.updateClip(id, {
      ai,
      tagError: undefined,
      ...(keepEdited ? {} : { edited: alreadyEdited }),
      ...(keepScene ? {} : { scene, sceneSetBy: "ai" as const }),
      ...(place?.trim() && !current.placeSource ? { place: place.trim(), placeSource: "ai" as const } : {}),
    });
    // The file's own GPS position, when the phone stored one, is more precise than the AI's read.
    locateClip(id).catch(() => {});
  } catch (err) {
    // The heuristic moments still work, but without a situation the clip can't be used in strict
    // mode, so keep the reason (shown in diagnostics) and try again on the next start.
    const message = (err as Error).message;
    console.warn(`[ai] tagging ${current.filename} failed:`, message);
    store.updateClip(id, { tagError: message.slice(0, 300) });
  }
}

const TOO_BIG =
  "This is a 4K video, too heavy for this server's memory. Add it through your Google Photos album instead " +
  "(the app then uses Google's 1080p version), or move to a bigger server plan.";
const isBig = (p: { width: number; height: number }) => Math.max(p.width, p.height) > 1920 || Math.min(p.width, p.height) > 1080;

/**
 * Clips imported before working copies existed may still be 4K/HDR originals. Album clips are
 * swapped for Google's own 1080p version (no 4K decoding here); others are converted if this
 * machine has the memory for it, otherwise taken out of rotation with an explanation.
 */
const albumPages = new Map<string, Promise<Awaited<ReturnType<typeof fetchAlbum>> | null>>();

export async function ensureProxy(id: string) {
  const clip = store.clip(id);
  if (!clip || clip.status !== "ready" || clip.kind !== "video" || !fs.existsSync(clip.file)) return;
  const info = await probe(clip.file);
  if (!needsProxy(info)) return;
  const proxy = path.join(config.mediaDir, `${id}.mp4`);
  const target = clip.file === proxy ? path.join(config.mediaDir, `${id}.proxy.mp4`) : proxy;

  if (clip.source === "shared_album" && clip.sourceId) {
    for (const album of store.albums()) {
      if (!albumPages.has(album.url)) albumPages.set(album.url, fetchAlbum(album.url).catch(() => null));
      const item = (await albumPages.get(album.url))?.items.find((it) => it.id === clip.sourceId);
      if (!item) continue;
      const { res } = await openVideo(item, ["=m37", "=m22"]);
      if (!res) break;
      await saveResponse(res, target);
      let light = await probe(target);
      if (needsProxy(light)) {
        // Google's version should already be light; if it's still 4K, give up on it here.
        if (isBig(light)) {
          fs.rmSync(target, { force: true });
          break;
        }
        const tmp = `${target}.tmp.mp4`;
        await makeProxy(target, tmp, light);
        fs.renameSync(tmp, target);
        light = await probe(target);
      }
      if (clip.file !== target) fs.rmSync(clip.file, { force: true });
      store.updateClip(id, { file: target, width: light.width, height: light.height });
      console.log(`[proxy] swapped ${clip.filename} for Google's 1080p version`);
      return;
    }
  }

  if (isBig(info) && !canDecode4K) {
    store.updateClip(id, { status: "error", error: TOO_BIG });
    return;
  }
  await makeProxy(clip.file, target, info);
  if (clip.file !== target) fs.rmSync(clip.file, { force: true });
  store.updateClip(id, { file: target });
  console.log(`[proxy] converted ${clip.filename} to a 1080p working copy`);
}

function removeClipFiles(clip: Clip) {
  for (const f of new Set([clip.file, clip.thumb, path.join(config.mediaDir, `${clip.id}.mp4`)])) {
    if (f) fs.rmSync(f, { force: true });
  }
  for (const f of fs.readdirSync(config.mediaDir)) {
    if (f.startsWith(`${clip.id}.`)) fs.rmSync(path.join(config.mediaDir, f), { force: true });
  }
}

export function deleteClip(id: string) {
  const clip = store.clip(id);
  if (!clip) return;
  removeClipFiles(clip);
  store.removeClip(id);
}

/** Clips that are never used automatically are kept this long (to fix a wrong situation by hand), then their files go. */
export const ARCHIVE_AFTER_DAYS = 7;

/**
 * Delete the files of clips that will never be used automatically (not from the creator's
 * situations, already edited, duplicates, landscape) once they're a week old. The record stays,
 * so the same video is never imported (or paid for) again. Clips the creator gave a situation by
 * hand, and clips used in a video, are kept.
 */
export function archiveUnusable(now = Date.now()): number {
  const usedInVideo = new Set(store.renders().flatMap((r) => r.plan.segments.map((s) => s.clipId)));
  let archived = 0;
  for (const c of store.clips()) {
    if (c.status !== "ready" || c.uses > 0 || usedInVideo.has(c.id) || c.sceneSetBy === "creator") continue;
    if (now - Date.parse(c.importedAt) < ARCHIVE_AFTER_DAYS * 86400_000) continue;
    // Footage from other situations is kept: it's for outside videos and themes switched on later.
    if (!(c.edited || c.duplicateOf || c.width > c.height)) continue;
    removeClipFiles(c);
    store.updateClip(c.id, { status: "archived", archivedAt: new Date(now).toISOString() });
    archived++;
  }
  return archived;
}
