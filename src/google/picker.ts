import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { accessToken } from "./oauth.ts";
import { canDecode4K } from "../config.ts";

/** Google Photos Picker API — https://developers.google.com/photos/picker/reference/rest */
const API = "https://photospicker.googleapis.com/v1";

export interface PickerSession {
  id: string;
  pickerUri: string;
  mediaItemsSet?: boolean;
  pollingConfig?: { pollInterval?: string; timeoutIn?: string };
  expireTime?: string;
}

export interface PickedMediaItem {
  id: string;
  createTime?: string;
  type?: "TYPE_UNSPECIFIED" | "PHOTO" | "VIDEO";
  mediaFile: {
    baseUrl: string;
    mimeType: string;
    filename: string;
    mediaFileMetadata?: {
      width?: number;
      height?: number;
      videoMetadata?: { fps?: number; processingStatus?: string };
    };
  };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Google Photos Picker ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? {} : await res.json()) as T;
}

/** Up to 500 per pick (Google allows 2,000); the disk guard stops downloads if space runs low. */
export function createSession(maxItems = 500) {
  return call<PickerSession>("/sessions", {
    method: "POST",
    body: JSON.stringify({ pickingConfig: { maxItemCount: String(maxItems) } }),
  });
}

export const getSession = (id: string) => call<PickerSession>(`/sessions/${encodeURIComponent(id)}`);

export const deleteSession = (id: string) =>
  call(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});

export async function listPicked(sessionId: string): Promise<PickedMediaItem[]> {
  const items: PickedMediaItem[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ sessionId, pageSize: "100", ...(pageToken ? { pageToken } : {}) });
    const page = await call<{ mediaItems?: PickedMediaItem[]; nextPageToken?: string }>(`/mediaItems?${q}`);
    items.push(...(page.mediaItems ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

/**
 * Download a picked item. baseUrls are valid for ~60 minutes after picking. Videos: on a small
 * server, Google's 1080p (then 720p) version first, a fraction of a 4K original's size and light to
 * decode; the original (=dv) when the server can decode 4K, or when there's no smaller version.
 */
export async function download(item: PickedMediaItem, dest: string) {
  const isVideo = item.type === "VIDEO" || item.mediaFile.mimeType.startsWith("video/");
  const suffixes = !isVideo ? ["=d"] : canDecode4K ? ["=dv", "=m37"] : ["=m37", "=m22", "=dv"];
  const answers: string[] = [];
  for (const suffix of suffixes) {
    const res = await fetch(`${item.mediaFile.baseUrl}${suffix}`, { headers: { authorization: `Bearer ${await accessToken()}` } });
    const type = (res.headers.get("content-type") ?? "").split(";")[0];
    // A smaller version Google doesn't have answers with an error or a still image: try the next.
    if (!res.ok || !res.body || (isVideo && suffix !== "=dv" && !type.startsWith("video/"))) {
      answers.push(`${suffix}: ${res.status} ${type}`);
      await res.body?.cancel();
      continue;
    }
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(dest));
    return;
  }
  throw new Error(`Download of ${item.mediaFile.filename} failed (${answers.join(", ")})`);
}
