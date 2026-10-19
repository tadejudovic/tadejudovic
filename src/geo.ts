import { store } from "./store.ts";
import { probe } from "./media/ffmpeg.ts";

/**
 * Where a clip was filmed: the GPS position phones store in the video file, turned into "City,
 * Country" with OpenStreetMap (one request a second, results cached), or the AI's read of signs and
 * landmarks when the file has no position.
 */

/** "+35.6895+139.6917+040.000/" (ISO 6709, how phones store it) → lat/lon. */
export function parseIso6709(s?: string): { lat: number; lon: number } | undefined {
  const m = s?.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  if (!m) return undefined;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat !== 0 || lon !== 0) ? { lat, lon } : undefined;
}

const cache = new Map<string, string | null>();
let last = 0;

export async function placeName(lat: number, lon: number): Promise<string | undefined> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (cache.has(key)) return cache.get(key) ?? undefined;
  const wait = last + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat}&lon=${lon}`,
      { headers: { "user-agent": "Rollcut/1.0 (pet travel video app)" }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const a = ((await res.json()) as { address?: Record<string, string> }).address ?? {};
    const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state;
    const name = [city, a.country].filter(Boolean).join(", ") || null;
    cache.set(key, name);
    return name ?? undefined;
  } catch (err) {
    console.warn("[geo] couldn't name a place:", (err as Error).message);
    return undefined;
  }
}

/** The position stored in a video file, if any. */
export async function filePosition(file: string): Promise<{ lat: number; lon: number } | undefined> {
  const info = await probe(file).catch(() => null);
  return parseIso6709(info?.location);
}

/** Give a clip its place from the file's GPS position (keeps a place the creator set). */
export async function locateClip(id: string): Promise<string | undefined> {
  const c = store.clip(id);
  if (!c || c.placeSource === "creator" || c.placeSource === "gps") return c?.place;
  const pos = await filePosition(c.file);
  if (!pos) return c.place;
  const name = await placeName(pos.lat, pos.lon);
  if (name) store.updateClip(id, { place: name, placeSource: "gps" });
  return name ?? c.place;
}

/** Once: clips already imported get their place from their files. */
export async function locateAll(): Promise<number> {
  let n = 0;
  for (const c of store.clips()) {
    if (c.status !== "ready" || c.kind !== "video" || c.placeSource) continue;
    if (await locateClip(c.id)) n++;
  }
  if (n) console.log(`[geo] found where ${n} clip(s) were filmed`);
  return n;
}

/** The country part of a place ("Lisbon, Portugal" → "Portugal"). */
export const countryOf = (place?: string) => place?.split(",").pop()?.trim() || undefined;
