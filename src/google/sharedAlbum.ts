import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Read a public Google Photos shared-album link (photos.app.goo.gl/… or
 * photos.google.com/share/…?key=…).
 *
 * Google has no official API for reading an album by its share link, so this
 * parses the data the album page embeds for its own UI. It's the same
 * technique publicly-available album embedders use. It only sees what anyone
 * with the link can see, and it may need updating if Google changes the page.
 */

export interface AlbumItem {
  id: string;
  baseUrl: string;
  width: number;
  height: number;
  /** Capture time, ms since epoch. */
  takenAt?: number;
}

export interface AlbumPage {
  title?: string;
  items: AlbumItem[];
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

export function isAlbumUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.hostname === "photos.app.goo.gl" && u.pathname.length > 1) ||
      (u.hostname === "photos.google.com" && /^\/(u\/\d+\/)?share\//.test(u.pathname)) ||
      (u.hostname === "goo.gl" && u.pathname.startsWith("/photos/"))
    );
  } catch {
    return false;
  }
}

// Pre-accept Google's cookie-consent interstitial, which some server regions get instead of the album.
const HEADERS = { "user-agent": UA, "accept-language": "en-US,en;q=0.9", cookie: "CONSENT=YES+cb; SOCS=CAI" };

/** Undo the escaping Google uses when it embeds a URL in a script or attribute. */
function unescapeUrlText(s: string): string {
  return s
    .replace(/\\\//g, "/")
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\u003[dD]/g, "=")
    .replace(/\\u0026/g, "&")
    .replace(/\\x2[fF]/g, "/")
    .replace(/&amp;/g, "&")
    .replace(/https?%3A%2F%2F[^"'\s<>&]+/gi, (m) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m;
      }
    });
}

/** Find the full album address inside a page that redirects with a script or meta refresh. */
export function findShareUrl(html: string): string | undefined {
  return unescapeUrlText(html).match(/https:\/\/photos\.google\.com\/(?:u\/\d+\/)?share\/[A-Za-z0-9_-]+(?:\?key=[A-Za-z0-9_-]+)?/)?.[0];
}

const isShareUrl = (u: string) => /^https:\/\/photos\.google\.com\/(u\/\d+\/)?share\//.test(u);

/**
 * Turn a short link (photos.app.goo.gl/…) into the full photos.google.com/share/… address.
 * Follows HTTP redirects by hand (so every hop can be checked), and if a hop answers with a
 * page instead, looks for the address inside it. Google answers different clients
 * differently, so a few user agents are tried.
 */
async function resolveShareUrl(url: string): Promise<{ url: string; html?: string; trail: string[] }> {
  const trail: string[] = [];
  if (isShareUrl(url)) return { url, trail };
  const agents = [UA, "curl/8.5.0", "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"];
  for (const agent of agents) {
    let current = url;
    for (let hop = 0; hop < 8; hop++) {
      const res = await fetch(current, { headers: { ...HEADERS, "user-agent": agent }, redirect: "manual" });
      const location = res.headers.get("location");
      if (location && res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        current = new URL(location, current).toString();
        trail.push(`${res.status}→${new URL(current).host}${new URL(current).pathname.slice(0, 24)}`);
        if (isShareUrl(current)) return { url: current, trail };
        continue;
      }
      const html = await res.text();
      const found = findShareUrl(html);
      if (found) {
        trail.push(`page→share`);
        return { url: found, trail };
      }
      const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
      trail.push(`${res.status} page "${(title ?? "").slice(0, 40)}" (${html.length}b, ${agent.split("/")[0]})`);
      // Some hops already are the album page under another address.
      if (html.includes("AF_initDataCallback(")) return { url: current, html, trail };
      break;
    }
  }
  return { url, trail };
}

export async function fetchAlbum(url: string): Promise<AlbumPage> {
  if (!isAlbumUrl(url)) throw new Error("That doesn't look like a Google Photos shared-album link.");
  const resolved = await resolveShareUrl(url);
  let html = resolved.html;
  let finalUrl = resolved.url;
  if (!html) {
    const res = await fetch(resolved.url, { headers: HEADERS, redirect: "follow" });
    if (!res.ok) throw new Error(`Couldn't open the album (HTTP ${res.status}). Is link sharing turned on?`);
    html = await res.text();
    finalUrl = res.url;
  }
  const page = parseAlbumHtml(html);
  if (!page.items.length) {
    const blocks = html.split("AF_initDataCallback(").length - 1;
    console.warn(`[album] no items found: url=${finalUrl} bytes=${html.length} dataBlocks=${blocks} title=${page.title ?? "-"} trail=${resolved.trail.join(" | ")}`);
    const short = !isShareUrl(resolved.url);
    throw new Error(
      short
        ? "Couldn't follow this short link to the album. Open it in your browser, copy the full address " +
          "(it starts with https://photos.google.com/share/) and add that instead."
        : `Opened the album page but found no photos or videos in it (${blocks} data blocks). Check that link sharing is on.`,
    );
  }
  return page;
}

export function parseAlbumHtml(html: string): AlbumPage {
  const title = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1];
  const items = new Map<string, AlbumItem>();
  for (const data of embeddedData(html)) collectItems(data, items);
  if (!items.size && /accounts\.google\.com\/ServiceLogin/.test(html)) {
    throw new Error("Google asked for a sign-in, so this album isn't shared publicly.");
  }
  return { title: title ? decodeEntities(title) : undefined, items: [...items.values()] };
}

/** Pull the JSON `data:` payloads out of every AF_initDataCallback(...) block. */
function* embeddedData(html: string): Generator<unknown> {
  const marker = "AF_initDataCallback(";
  let at = 0;
  while ((at = html.indexOf(marker, at)) !== -1) {
    at += marker.length;
    const dataAt = html.indexOf("data:", at);
    if (dataAt === -1) break;
    const start = html.indexOf("[", dataAt);
    const end = matchBracket(html, start);
    if (start === -1 || end === -1) continue;
    try {
      yield JSON.parse(html.slice(start, end + 1));
    } catch {
      // Not JSON (or not the block we want) — keep scanning.
    }
    at = end;
  }
}

/** Index of the bracket closing the one at `start`, respecting JSON strings. */
function matchBracket(s: string, start: number): number {
  if (start < 0) return -1;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Media entries look like ["AF1Qip…", ["https://lh3.googleusercontent.com/…", width, height, …], takenAtMs, …].
 * Walk the whole tree for that shape rather than hard-coding array positions.
 */
function collectItems(node: unknown, out: Map<string, AlbumItem>) {
  if (!Array.isArray(node)) return;
  const [id, media, ts] = node;
  if (
    typeof id === "string" &&
    /^AF1Q/.test(id) &&
    Array.isArray(media) &&
    typeof media[0] === "string" &&
    /^https:\/\/lh\d\.googleusercontent\.com\//.test(media[0]) &&
    typeof media[1] === "number" &&
    typeof media[2] === "number"
  ) {
    if (!out.has(id)) {
      out.set(id, {
        id,
        baseUrl: media[0],
        width: media[1],
        height: media[2],
        takenAt: typeof ts === "number" && ts > 1e11 ? ts : undefined,
      });
    }
    return;
  }
  for (const child of node) collectItems(child, out);
}

/** Container signatures at bytes 4–8 of MP4/MOV files. */
const VIDEO_BOXES = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip"]);

export interface VideoProbe {
  res: Response | null;
  /** What Google answered, for diagnostics ("image/jpeg 200", …). */
  answer: string;
}

/**
 * Album pages don't reliably say which items are videos, so ask for the video
 * stream and check what comes back: the declared content type, and if that's
 * vague, the first bytes of the file. Tries Google's 1080p and 720p versions,
 * then the original (=dv), then 360p.
 */
export async function openVideo(item: AlbumItem, suffixes = ["=m37", "=m22", "=dv", "=m18"]): Promise<VideoProbe> {
  const answers: string[] = [];
  // Google's own 1080p/720p H.264 versions first: SDR, already rotated, far smaller than a 4K HDR
  // original, and light to decode on a small server. The original (=dv) is the fallback.
  for (const suffix of suffixes) {
    let res: Response;
    try {
      res = await fetch(`${item.baseUrl}${suffix}`, {
        headers: { ...HEADERS, referer: "https://photos.google.com/" },
        redirect: "follow",
      });
    } catch (err) {
      answers.push(`${suffix}: ${(err as Error).message}`);
      continue;
    }
    const type = (res.headers.get("content-type") ?? "?").split(";")[0];
    if (!res.ok || !res.body) {
      answers.push(`${suffix}: ${type} ${res.status}`);
      await res.body?.cancel();
      continue;
    }
    if (type.startsWith("video/")) return { res, answer: `${suffix}: ${type}` };
    if (type.startsWith("image/") || type.startsWith("text/")) {
      answers.push(`${suffix}: ${type}`);
      await res.body.cancel();
      // A photo answers the original (=dv) request with the image itself: stop there. (A video whose
      // 1080p version isn't ready may answer =m37 with a still frame, so only trust this for =dv.)
      if (suffix === "=dv" && type.startsWith("image/")) break;
      continue;
    }
    // Vague type (e.g. application/octet-stream): sniff the file header.
    const { head, body } = await peek(res.body, 12);
    const box = Buffer.from(head.subarray(4, 8)).toString("latin1");
    if (VIDEO_BOXES.has(box)) {
      return { res: new Response(body, { status: res.status, headers: res.headers }), answer: `${suffix}: ${type} (${box})` };
    }
    answers.push(`${suffix}: ${type} [${Buffer.from(head).toString("hex").slice(0, 16)}]`);
    await body.cancel();
  }
  return { res: null, answer: answers.join(", ") || "no answer" };
}

/** Read the first `n` bytes of a stream and return them plus a stream that still yields everything. */
async function peek(stream: ReadableStream<Uint8Array>, n: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < n) {
    const { value, done } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.length;
  }
  const head = Buffer.concat(chunks);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length) controller.enqueue(new Uint8Array(head));
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { head: new Uint8Array(head), body };
}

export async function saveResponse(res: Response, dest: string) {
  if (!res.body) throw new Error("Empty download");
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(dest));
}

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
