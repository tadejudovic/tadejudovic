import fs from "node:fs";
import crypto from "node:crypto";
import { config } from "./config.ts";
import type { AlbumSource, AutoSettings, Clip, Example, Render, SceneResearch, TextSize, TextStyle, Trends, CaptionAudience } from "./types.ts";

/**
 * Tiny JSON-file store. Good enough for a single creator running this locally;
 * swap for Postgres/SQLite when going multi-tenant.
 */
interface DB {
  clips: Clip[];
  renders: Render[];
  google?: GoogleTokens;
  settings: Settings;
  albums: AlbumSource[];
  examples: Example[];
  trends?: Trends;
  auto: AutoSettings;
  research: Record<string, SceneResearch>;
  /** This month's estimated spend: total, plus Claude ("ai") and Apify TikTok search ("tiktok") separately. */
  spend: { month: string; usd: number; calls: number; ai?: number; tiktok?: number };
}

export interface Settings {
  petName: string;
  handle: string;
  fontId: string;
  textStyle: TextStyle;
  textSize: TextSize;
  /** Situations that work for this account; clips are sorted into these and captions researched per situation. */
  scenes: string[];
  /** Monthly cap on estimated AI (Claude API) spend, in USD. */
  aiMonthlyBudget: number;
  /** Hard cap on new videos made per day, from any source. */
  maxVideosPerDay: number;
  /** Only clips sorted into one of `scenes` are used automatically ("other" clips only by hand). */
  onlySituations: boolean;
  /**
   * Who the on-screen text speaks to: "pets" (dog lovers), "everyone" (the shared human moment,
   * the dog as the punchline) or "mix" (alternating, so the account reaches beyond dog lovers).
   */
  captionAudience: CaptionAudience;
  /** Set once the yellow CapCut look became the default (keeps later manual choices). */
  lookV2?: boolean;
}

export const DEFAULT_SCENES = [
  "check-in desk",
  "airport terminal",
  "security check",
  "boarding gate",
  "inside the airplane",
  "under the airplane seat",
];

const DEFAULT_SETTINGS: Settings = {
  petName: "Lex",
  handle: "",
  fontId: "montserrat",
  textStyle: "yellow",
  textSize: "medium",
  captionAudience: "mix",
  scenes: DEFAULT_SCENES,
  aiMonthlyBudget: Number(process.env.AI_MONTHLY_BUDGET) || 20,
  maxVideosPerDay: 5,
  onlySituations: true,
};

const DEFAULT_AUTO: AutoSettings = {
  enabled: true,
  dailyCount: 4,
  dailyTime: "08:00",
  template: "auto",
  targetSeconds: 12,
  syncEveryHours: 3,
};

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
}

function load(): DB {
  try {
    const db = JSON.parse(fs.readFileSync(config.dbFile, "utf8")) as DB;
    db.settings = { ...DEFAULT_SETTINGS, ...db.settings };
    // One-time switch to the creator's CapCut look (yellow preset) if the old defaults were never changed.
    if (!db.settings.lookV2) {
      if (db.settings.textStyle === "classic") db.settings.textStyle = "yellow";
      if (db.settings.fontId === "tiktok-sans") db.settings.fontId = "montserrat";
      db.settings.lookV2 = true;
    }
    db.albums ??= [];
    for (const a of db.albums) a.kind ??= "google_photos_album";
    db.examples ??= [];
    db.research ??= {};
    db.spend ??= { month: "", usd: 0, calls: 0 };
    db.auto = { ...DEFAULT_AUTO, ...db.auto };
    for (const r of db.renders) r.review ??= "pending";
    return db;
  } catch {
    return { clips: [], renders: [], settings: { ...DEFAULT_SETTINGS }, albums: [], examples: [], auto: { ...DEFAULT_AUTO }, research: {}, spend: { month: "", usd: 0, calls: 0 } };
  }
}

const db: DB = load();
let saveTimer: NodeJS.Timeout | null = null;

function writeNow() {
  const tmp = `${config.dbFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, config.dbFile);
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = `${config.dbFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, config.dbFile);
  }, 50);
}

export const newId = () => crypto.randomBytes(8).toString("hex");

export const store = {
  /** Write pending changes immediately (on shutdown). */
  flush() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    writeNow();
  },
  clips: () => db.clips,
  clip: (id: string) => db.clips.find((c) => c.id === id),
  addClip(clip: Clip) {
    db.clips.unshift(clip);
    save();
    return clip;
  },
  updateClip(id: string, patch: Partial<Clip>) {
    const clip = db.clips.find((c) => c.id === id);
    if (clip) Object.assign(clip, patch);
    save();
    return clip;
  },
  removeClip(id: string) {
    db.clips = db.clips.filter((c) => c.id !== id);
    save();
  },
  hasSource(sourceId: string) {
    return db.clips.some((c) => c.sourceId === sourceId);
  },

  renders: () => db.renders,
  render: (id: string) => db.renders.find((r) => r.id === id),
  addRender(render: Render) {
    db.renders.unshift(render);
    save();
    return render;
  },
  updateRender(id: string, patch: Partial<Render>) {
    const render = db.renders.find((r) => r.id === id);
    if (render) Object.assign(render, patch);
    save();
    return render;
  },
  removeRender(id: string) {
    db.renders = db.renders.filter((r) => r.id !== id);
    save();
  },

  google: () => db.google,
  setGoogle(tokens: GoogleTokens | undefined) {
    db.google = tokens;
    save();
  },

  albums: () => db.albums,
  album: (id: string) => db.albums.find((a) => a.id === id),
  addAlbum(album: AlbumSource) {
    db.albums.push(album);
    save();
    return album;
  },
  updateAlbum(id: string, patch: Partial<AlbumSource>) {
    const album = db.albums.find((a) => a.id === id);
    if (album) Object.assign(album, patch);
    save();
    return album;
  },
  removeAlbum(id: string) {
    db.albums = db.albums.filter((a) => a.id !== id);
    save();
  },

  examples: () => db.examples,
  example: (id: string) => db.examples.find((e) => e.id === id),
  addExample(e: Example) {
    db.examples.unshift(e);
    save();
    return e;
  },
  updateExample(id: string, patch: Partial<Example>) {
    const e = db.examples.find((x) => x.id === id);
    if (e) Object.assign(e, patch);
    save();
    return e;
  },
  removeExample(id: string) {
    db.examples = db.examples.filter((e) => e.id !== id);
    save();
  },

  research: (scene: string) => db.research[scene],
  allResearch: () => db.research,
  setResearch(r: SceneResearch) {
    db.research[r.scene] = r;
    save();
    return r;
  },

  spend: () => db.spend,
  setSpend(spend: DB["spend"]) {
    db.spend = spend;
    save();
  },

  trends: () => db.trends,
  setTrends(trends: Trends) {
    db.trends = trends;
    save();
  },

  auto: () => db.auto,
  updateAuto(patch: Partial<AutoSettings>) {
    Object.assign(db.auto, patch);
    save();
    return db.auto;
  },

  settings: () => db.settings,
  updateSettings(patch: Partial<DB["settings"]>) {
    Object.assign(db.settings, patch);
    save();
    return db.settings;
  },
};
