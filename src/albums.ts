import { store, newId } from "./store.ts";
import { fetchAlbum, isAlbumUrl, openVideo, saveResponse } from "./google/sharedAlbum.ts";
import { enqueueClip, deleteClip, SkipItem } from "./library.ts";
import type { AlbumSource } from "./types.ts";

/** New albums only import recent videos: a live album that auto-adds every video of the pet can hold years of them. */
export const DEFAULT_RECENT_DAYS = 30;
/**
 * Clips are imported only as they're needed: enough unused footage for the next round plus a
 * couple spare. Importing costs AI analysis per clip, so the rest of the album waits until
 * reviews use these up. (Items left waiting aren't marked seen, so later checks pick them up.)
 */
const SPARE_CLIPS = 2;
export function importBudget(): number {
  const unused = store.clips().filter((c) => c.status === "ready" && c.uses === 0 && !c.disliked && c.height >= c.width).length;
  const inFlight = store.clips().filter((c) => c.status === "importing" || c.status === "analyzing").length;
  return Math.max(0, store.auto().dailyCount + SPARE_CLIPS - unused - inFlight);
}

export function addAlbum(url: string, recentDays = DEFAULT_RECENT_DAYS): AlbumSource {
  url = url.trim();
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
    const unseen = page.items.filter((it) => !seen.has(it.id) && !store.hasSource(it.id));
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
