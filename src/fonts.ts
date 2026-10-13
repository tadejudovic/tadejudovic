import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

/**
 * Fonts creators commonly use for TikTok/CapCut text. CapCut doesn't publish its
 * font list (it varies by app version, region and platform), and its built-in
 * fonts can't be redistributed, so these are the free (SIL Open Font License)
 * originals or closest free matches, downloaded from Google Fonts on first use.
 * Any other font, including one exported from CapCut desktop, can be uploaded.
 */
export interface FontDef {
  id: string;
  name: string;
  /** Google Fonts css2 `family=` value, including the weight. */
  query: string;
  /** CSS family name (for previews). */
  family: string;
  weight: number;
  vibe: string;
}

export const FONTS: FontDef[] = [
  { id: "tiktok-sans", name: "TikTok Sans", query: "TikTok+Sans:wght@800", family: "TikTok Sans", weight: 800, vibe: "TikTok's own font: the native in-app look" },
  { id: "montserrat", name: "Montserrat", query: "Montserrat:wght@800", family: "Montserrat", weight: 800, vibe: "Closest free match to CapCut's “Classic” (Proxima Nova)" },
  { id: "poppins", name: "Poppins", query: "Poppins:wght@700", family: "Poppins", weight: 700, vibe: "Clean, round, friendly" },
  { id: "figtree", name: "Figtree", query: "Figtree:wght@800", family: "Figtree", weight: 800, vibe: "Modern geometric sans" },
  { id: "nunito-sans", name: "Nunito Sans", query: "Nunito+Sans:wght@800", family: "Nunito Sans", weight: 800, vibe: "Soft and warm" },
  { id: "inter", name: "Inter", query: "Inter:wght@800", family: "Inter", weight: 800, vibe: "Neutral, very legible" },
  { id: "roboto", name: "Roboto Black", query: "Roboto:wght@900", family: "Roboto", weight: 900, vibe: "Android/YouTube default look" },
  { id: "sora", name: "Sora", query: "Sora:wght@800", family: "Sora", weight: 800, vibe: "Wide, techy" },
  { id: "rubik", name: "Rubik", query: "Rubik:wght@800", family: "Rubik", weight: 800, vibe: "Chunky with rounded corners" },
  { id: "fredoka", name: "Fredoka", query: "Fredoka:wght@700", family: "Fredoka", weight: 700, vibe: "Bubbly, cute — good for pets" },
  { id: "lilita-one", name: "Lilita One", query: "Lilita+One", family: "Lilita One", weight: 400, vibe: "Bold rounded display" },
  { id: "luckiest-guy", name: "Luckiest Guy", query: "Luckiest+Guy", family: "Luckiest Guy", weight: 400, vibe: "Cartoon / meme energy" },
  { id: "bangers", name: "Bangers", query: "Bangers", family: "Bangers", weight: 400, vibe: "Comic-book" },
  { id: "kanit", name: "Kanit", query: "Kanit:wght@700", family: "Kanit", weight: 700, vibe: "Sporty, slightly condensed" },
  { id: "bebas-neue", name: "Bebas Neue", query: "Bebas+Neue", family: "Bebas Neue", weight: 400, vibe: "Tall all-caps headline" },
  { id: "anton", name: "Anton", query: "Anton", family: "Anton", weight: 400, vibe: "Heavy condensed impact" },
  { id: "oswald", name: "Oswald", query: "Oswald:wght@700", family: "Oswald", weight: 700, vibe: "Condensed news-style" },
  { id: "archivo-black", name: "Archivo Black", query: "Archivo+Black", family: "Archivo Black", weight: 400, vibe: "Very heavy grotesque" },
  { id: "archivo-narrow", name: "Archivo Narrow", query: "Archivo+Narrow:wght@700", family: "Archivo Narrow", weight: 700, vibe: "The “brat” Arial Narrow look" },
  { id: "righteous", name: "Righteous", query: "Righteous", family: "Righteous", weight: 400, vibe: "Retro rounded" },
  { id: "permanent-marker", name: "Permanent Marker", query: "Permanent+Marker", family: "Permanent Marker", weight: 400, vibe: "Handwritten marker" },
  { id: "caveat", name: "Caveat", query: "Caveat:wght@700", family: "Caveat", weight: 700, vibe: "Casual handwriting" },
  { id: "dancing-script", name: "Dancing Script", query: "Dancing+Script:wght@700", family: "Dancing Script", weight: 700, vibe: "Script, soft and pretty" },
  { id: "pacifico", name: "Pacifico", query: "Pacifico", family: "Pacifico", weight: 400, vibe: "Surf-style script" },
  { id: "lobster", name: "Lobster", query: "Lobster", family: "Lobster", weight: 400, vibe: "Bold retro script" },
  { id: "playfair-display", name: "Playfair Display", query: "Playfair+Display:wght@800", family: "Playfair Display", weight: 800, vibe: "Elegant serif, editorial" },
  { id: "dm-serif-display", name: "DM Serif Display", query: "DM+Serif+Display", family: "DM Serif Display", weight: 400, vibe: "Classy high-contrast serif" },
];

export const DEFAULT_FONT_ID = "montserrat";
const fontsDir = path.join(config.dataDir, "fonts");
const customDir = path.join(fontsDir, "custom");
fs.mkdirSync(customDir, { recursive: true });

export function listFonts() {
  const builtIn = FONTS.map((f) => ({ ...f, custom: false, downloaded: fs.existsSync(path.join(fontsDir, `${f.id}.ttf`)) }));
  const custom = fs
    .readdirSync(customDir)
    .filter((f) => /\.(ttf|otf)$/i.test(f))
    .map((f) => ({
      id: `custom:${f}`,
      name: f.replace(/^[0-9a-f]{16}-/, "").replace(/\.(ttf|otf)$/i, ""),
      query: "",
      family: "",
      weight: 400,
      vibe: "Your uploaded font",
      custom: true,
      downloaded: true,
    }));
  return [...custom, ...builtIn];
}

export function saveCustomFont(tmpPath: string, originalName: string): string {
  const safe = path.basename(originalName).replace(/[^\w.\- ]/g, "_");
  if (!/\.(ttf|otf)$/i.test(safe)) throw new Error("Upload a .ttf or .otf font file.");
  const name = `${crypto.randomBytes(8).toString("hex")}-${safe}`;
  fs.renameSync(tmpPath, path.join(customDir, name));
  return `custom:${name}`;
}

/** Local path of a font, downloading it from Google Fonts the first time. */
export async function fontPath(id: string | undefined): Promise<string | null> {
  if (id?.startsWith("custom:")) {
    const file = path.join(customDir, path.basename(id.slice(7)));
    if (fs.existsSync(file)) return file;
  }
  const def = FONTS.find((f) => f.id === id) ?? FONTS.find((f) => f.id === DEFAULT_FONT_ID)!;
  const file = path.join(fontsDir, `${def.id}.ttf`);
  if (fs.existsSync(file)) return file;
  try {
    // Without a browser user-agent, Google Fonts serves plain TrueType URLs.
    const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${def.query}`)).text();
    const url = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/)?.[1];
    if (!url) throw new Error("no TTF in Google Fonts response");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  } catch (err) {
    console.warn(`[fonts] couldn't download ${def.name}, falling back to a system font:`, (err as Error).message);
    return config.fontFile;
  }
}
