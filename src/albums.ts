import { store, newId } from "./store.ts";
import { fetchAlbum, isAlbumUrl, openVideo, saveResponse } from "./google/sharedAlbum.ts";
import { enqueueClip, deleteClip, SkipItem } from "./library.ts";
import type { AlbumSource } from "./types.ts";

export function addAlbum(url: string): AlbumSource {
  url = url.trim();
  if (!isAlbumUrl(url)) throw new Error("Paste a Google Photos shared-album link (photos.app.goo.gl/… or photos.google.com/share/…).");
  const existing = store.albums().find((a) => a.url === url);
  if (existing) return existing;
  return store.addAlbum({ id: newId(), kind: "google_photos_album", url, addedAt: new Date().toISOString(), seen: [], videoCount: 0 });
}

const syncing = new Set<string>();

/** Bump when video detection changes, so items wrongly skipped as photos get another look. */
const DETECT_VERSION = 2;

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
      store.updateAlbum(id, { seen: album.seen.filter((s) => store.hasSource(s)), skipped: {}, detectVersion: DETECT_VERSION });
    }
    const seen = new Set(store.album(id)!.seen);
    // Retry items whose earlier download failed.
    for (const c of store.clips()) {
      if (c.status === "error" && c.sourceId && page.items.some((it) => it.id === c.sourceId)) deleteClip(c.id);
    }
    const fresh = page.items.filter((it) => !seen.has(it.id) && !store.hasSource(it.id));
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
