import { store, newId } from "./store.ts";
import { albumUrlFrom, fetchAlbum, isAlbumUrl, openVideo, saveResponse } from "./google/sharedAlbum.ts";
import { enqueueClip, deleteClip, SkipItem } from "./library.ts";
import { onTopic } from "./generate.ts";
import type { AlbumSource, Clip } from "./types.ts";

/** New albums only import recent videos: a live album that auto-adds every video of the pet can hold years of them. */
export const DEFAULT_RECENT_DAYS = 30;
/**
 * Clips are imported only as they're needed: enough unused footage for the next round plus a
 * couple spare. Importing costs AI analysis per clip, so the rest of the album waits until
 * reviews use these up. (Items left waiting aren't marked seen, so later checks pick them up.)
 */
const SPARE_CLIPS = 2;
/** At most this many album clips are imported (and analyzed by the AI) per day. */
export const MAX_IMPORTS_PER_DAY = 30;
export function importBudget(): number {
  // Only footage that can actually be used counts: off-topic clips (beach, random) don't stop the
  // importer from looking further through the album for airport/plane clips.
  const unused = store.clips().filter((c) => c.status === "ready" && c.uses === 0 && !c.disliked && c.height >= c.width && onTopic(c)).length;
  const inFlight = store.clips().filter((c) => c.status === "importing" || c.status === "analyzing").length;
  const today = new Date().toDateString();
  const importedToday = store.clips().filter((c) => c.source === "shared_album" && new Date(c.importedAt).toDateString() === today).length;
  return Math.max(0, Math.min(store.auto().dailyCount + SPARE_CLIPS - unused - inFlight, MAX_IMPORTS_PER_DAY - importedToday));
}

export function addAlbum(pasted: string, recentDays = DEFAULT_RECENT_DAYS): AlbumSource {
  const url = albumUrlFrom(pasted);
  if (!isAlbumUrl(url)) throw new Error("Paste a Google Photos shared-album link (photos.app.goo.gl/… or photos.google.com/share/…).");
  const existing = store.albums().find((a) => a.url === url);
  if (existing) return existing;
  return store.addAlbum({ id: newId(), kind: "google_photos_album", url, addedAt: new Date().toISOString(), seen: [], videoCount: 0, recentDays });
}

const syncing = new Set<string>();

/** Bump when video detection changes, so items wrongly skipped as photos get another look. */
const DETECT_VERSION = 3;

/** Forget an album item so the next check imports it again (e.g. its clip failed and was removed). */
export function forgetItem(sourceId: string) {
  for (const a of store.albums()) {
    if (a.seen.includes(sourceId)) store.updateAlbum(a.id, { seen: a.seen.filter((s) => s !== sourceId) });
  }
}

/** Capture times (ms) of album videos already in the library or being imported. */
function capturedKeys(): Set<number> {
  return new Set(
    store.clips().flatMap((c) => (c.source === "shared_album" && c.capturedAt && c.status !== "error" ? [Date.parse(c.capturedAt)] : [])),
  );
}

/**
 * Clips imported twice before duplicates were caught (one video in two albums): keep the one
 * already used (or imported first) and set the others aside.
 */
export function markDuplicates(): number {
  const groups = new Map<string, Clip[]>();
  for (const c of store.clips()) {
    if (c.source !== "shared_album" || !c.capturedAt || c.status !== "ready" || c.duplicateOf) continue;
    const key = `${Date.parse(c.capturedAt)}:${Math.round(c.duration)}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  let marked = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = group.sort((a, b) => b.uses - a.uses || a.importedAt.localeCompare(b.importedAt));
    for (const c of rest) {
      store.updateClip(c.id, { duplicateOf: keep.id });
      marked++;
    }
  }
  return marked;
}

/**
 * Check a shared album for items we haven't seen and import the videos.
 * Photos in the album are remembered and skipped.
 */
export async function syncAlbum(id: string): Promise<{ newItems: number }> {
  const album = store.album(id);
  if (!album) throw new Error("Unknown album");
  if (syncing.has(id)) return { newItems: 0 };
  syncing.add(id);
  try {
    const page = await fetchAlbum(album.url);
    if (album.detectVersion !== DETECT_VERSION) {
      // Keep only items that were actually imported; everything skipped gets re-checked.
      // Also repairs albums where a video's clip was removed but the item stayed marked as handled.
      const kept = album.seen.filter((s) => store.hasSource(s));
      store.updateAlbum(id, { seen: kept, videoCount: kept.length, skipped: {}, detectVersion: DETECT_VERSION });
    }
    // Retry items whose earlier download failed.
    for (const c of store.clips()) {
      if (c.status === "error" && c.sourceId && page.items.some((it) => it.id === c.sourceId)) {
        const failures = { ...store.album(id)!.failures };
        failures[c.sourceId] = (failures[c.sourceId] ?? 0) + 1;
        store.updateAlbum(id, { failures });
        // Give up after 3 failed attempts; the clip stays in the library with its error.
        if (failures[c.sourceId] > 3) continue;
        deleteClip(c.id);
        forgetItem(c.sourceId);
      }
    }
    const seen = new Set(store.album(id)!.seen);
    // Videos already in the library (from an earlier copy of this album, or another album) count
    // as this album's, so it doesn't read "0 videos" when everything in it is already here.
    const alreadyHere = page.items.filter((it) => !seen.has(it.id) && store.hasSource(it.id)).map((it) => it.id);
    if (alreadyHere.length) {
      const a = store.album(id)!;
      store.updateAlbum(id, { seen: [...new Set([...a.seen, ...alreadyHere])], videoCount: a.videoCount + alreadyHere.length });
      for (const s of alreadyHere) seen.add(s);
    }
    // The same video in two albums has a different id in each, but the same capture time to the millisecond.
    const have = capturedKeys();
    const unseen = page.items.filter((it) => {
      if (seen.has(it.id) || store.hasSource(it.id)) return false;
      if (!it.takenAt) return true;
      if (have.has(it.takenAt)) return false;
      have.add(it.takenAt); // also catches the same video twice in one album
      return true;
    });
    // Too-old items aren't marked as seen, so widening the window later picks them up.
    const days = store.album(id)!.recentDays ?? 0;
    const cutoff = days > 0 ? Date.now() - days * 86400_000 : 0;
    const recent = unseen.filter((it) => !it.takenAt || it.takenAt >= cutoff);
    const newestFirst = recent.sort((a, b) => (b.takenAt ?? 0) - (a.takenAt ?? 0));
    const fresh = newestFirst.slice(0, importBudget());
    store.updateAlbum(id, { tooOld: unseen.length - recent.length, waiting: recent.length - fresh.length });
    for (const item of fresh) {
      enqueueClip({
        source: "shared_album",
        sourceId: item.id,
        filename: `${page.title ?? "album"}-${item.id.slice(-8)}.mp4`,
        capturedAt: item.takenAt ? new Date(item.takenAt).toISOString() : undefined,
        fetch: async (dest) => {
          const { res, answer } = await openVideo(item);
          if (!res) throw new SkipItem(answer);
          await saveResponse(res, dest);
        },
        onDone: (result, reason) => {
          const a = store.album(id);
          if (!a) return;
          if (result === "skipped" && reason) {
            const key = reason.slice(0, 120);
            store.updateAlbum(id, { skipped: { ...a.skipped, [key]: (a.skipped?.[key] ?? 0) + 1 } });
          }
          // Errors aren't marked as seen, so a failed download is retried on the next sync.
          if (result !== "error") store.updateAlbum(id, { seen: [...new Set([...a.seen, item.id])] });
          if (result === "ready") store.updateAlbum(id, { videoCount: a.videoCount + 1 });
        },
      });
    }
    store.updateAlbum(id, { title: page.title ?? album.title, lastSyncAt: new Date().toISOString(), lastError: undefined });
    return { newItems: fresh.length };
  } catch (err) {
    store.updateAlbum(id, { lastSyncAt: new Date().toISOString(), lastError: (err as Error).message });
    throw err;
  } finally {
    syncing.delete(id);
  }
}

export function setRecentDays(id: string, days: number) {
  return store.updateAlbum(id, { recentDays: Math.max(0, Math.min(3650, Math.round(days))) });
}

export async function syncAll() {
  let newItems = 0;
  for (const a of store.albums()) {
    try {
      newItems += (await syncAlbum(a.id)).newItems;
    } catch (err) {
      console.warn(`[albums] sync of ${a.url} failed:`, (err as Error).message);
    }
  }
  return { newItems };
}
