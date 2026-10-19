import fs from "node:fs";
import crypto from "node:crypto";
import { config } from "./config.ts";
import type { AlbumSource, AutoSettings, Clip, Example, Render, SceneResearch, TextSize, TextStyle, Trends, CaptionAudience, Partner, FaqItem, DailyMix, StoryDraft, ReviewFeedback, EditRecord, SearchTopic } from "./types.ts";

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
  partners: Partner[];
  drafts: StoryDraft[];
  edits: EditRecord[];
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
  /** The creator's cloned voice (ElevenLabs), for voiceovers they don't record themselves. */
  voice?: { id: string; createdAt: string; sampleSeconds: number };
  /** Themes beyond the airport (outside footage), and themes and situations switched off for videos. */
  outsideThemes: string[];
  themesOff: string[];
  /** Scenes the creator has asked for in voiceovers ("/ Lex inside airplane"), most recent first, to reuse. */
  shotTags?: string[];
  /** The call to action at the end of educational videos (on screen) and in their description. */
  cta: { site: string; overlay: string; caption: string };
  /**
   * What followers ask most, with the creator's own answers. Educational videos each answer one of
   * these; the answers are the only source for specifics (brands, airlines, places, rules).
   */
  faq: FaqItem[];
  /** Superseded by dailyMix. */
  tipsPerRound?: number;
  /** Candidates per kind of post in each round: one fun, one educational and one inspirational post a day, picked from these. */
  dailyMix: DailyMix;
  /** Set once rounds switched to the daily mix (round size and daily limit raised to fit it). */
  mixV1?: boolean;
  /** Instagram username, so posted videos can be found on the profile automatically. */
  instagramHandle?: string;
  /** The account's story, woven into every post description (who Lex is, the trip, where we are). */
  story: string;
  /** Set once the yellow CapCut look became the default (keeps later manual choices). */
  lookV2?: boolean;
  /** Set once the yellow box became the default. */
  lookV3?: boolean;
  lookV4?: boolean;
  /** Set once videos waiting for review or posting were re-made in the yellow box. */
  yellowBoxRemade?: boolean;
  yellowBoxRemadeV2?: boolean;
  /** Set once all videos were deleted for a fresh start. */
  freshStartV1?: boolean;
  freshStartV2?: boolean;
  freshStartV3?: boolean;
  designRefreshV1?: boolean;
  designRefreshV2?: boolean;
  designRefreshV3?: boolean;
  designRefreshV4?: boolean;
  ctaAddedV1?: boolean;
  zigzagV1?: boolean;
  zigzagV2?: boolean;
  numberTabsV1?: boolean;
  mixV2?: boolean;
  /** What people search for before finding the account (TikTok search analytics), grouped into topics. */
  searchTopics?: SearchTopic[];
  searchTopicsAt?: string;
  /** What people search on Google (Keyword Planner export), grouped into topics the same way. */
  keywordTopics?: SearchTopic[];
  keywordTopicsAt?: string;
  themesV1?: boolean;
  geoV1?: boolean;
  /** What reviews and post stats taught before the videos were deleted (still fed to the AI). */
  pastFeedback?: ReviewFeedback;
}

/** Videos in a round made from the daily mix. */
export const mixSize = (m: DailyMix) => Math.max(1, (m.fun ?? 0) + (m.educational ?? 0) + (m.inspirational ?? 0));

export const DEFAULT_SCENES = [
  "check-in desk",
  "airport terminal",
  "security check",
  "boarding gate",
  "inside the airplane",
  "under the airplane seat",
];

/** Themes beyond the airport that clips are also sorted into (the journey: places, walks, nature). */
export const DEFAULT_OUTSIDE_THEMES = ["city walk", "nature & hiking", "beach", "café & restaurant", "hotel & home", "road trip", "park"];

const DEFAULT_SETTINGS: Settings = {
  petName: "Lex",
  handle: "",
  fontId: "montserrat",
  textStyle: "yellowbox",
  textSize: "medium",
  captionAudience: "mix",
  cta: {
    site: "flywith.pet",
    overlay: "Plan your pet's trip / at flywith.pet (link in bio)",
    caption: "Planning a trip with your pet? Everything we've learned is on flywith.pet (link in bio).",
  },
  dailyMix: { fun: 2, educational: 2, inspirational: 2 },
  faq: [
    { q: "What bag / carrier do you fly with?", a: "" },
    { q: "Which airline do you fly with?", a: "" },
    { q: "Where have you traveled with Lex?", a: "" },
    { q: "What are the requirements for different destinations?", a: "" },
    { q: "Where does Lex pee and poo when traveling?", a: "" },
    { q: "How do you keep Lex stress-free when flying?", a: "" },
  ],
  story:
    "Lex (@lex.poodle) is a poodle on a trip around the world with us: new countries, airports, planes and cities, " +
    "one adventure at a time. We share the real side of traveling the world with a dog, so more pets get to come " +
    "along instead of staying home.",
  scenes: DEFAULT_SCENES,
  outsideThemes: DEFAULT_OUTSIDE_THEMES,
  themesOff: [],
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
    // One-time switch to the yellow box (black Montserrat on a yellow block), the creator's chosen default.
    if (!db.settings.lookV4) {
      db.settings.textStyle = "yellowbox";
      db.settings.fontId = "montserrat";
      db.settings.lookV3 = true;
      db.settings.lookV4 = true;
    }
    db.albums ??= [];
    db.partners ??= [];
    db.drafts ??= [];
    db.edits ??= [];
    for (const r of db.renders ?? []) {
      if (r.posted && !r.posts) r.posts = [{ ...r.posted, platform: "tiktok" }];
      delete r.posted;
    }
    // One-time switch to the daily mix: a round holds the mix's candidates, and the daily limit fits a round.
    if (!db.settings.mixV1) {
      const size = mixSize(db.settings.dailyMix);
      if (db.auto) db.auto.dailyCount = size;
      db.settings.maxVideosPerDay = Math.max(db.settings.maxVideosPerDay ?? 0, size);
      db.settings.mixV1 = true;
    }
    for (const a of db.albums) a.kind ??= "google_photos_album";
    db.examples ??= [];
    db.research ??= {};
    db.spend ??= { month: "", usd: 0, calls: 0 };
    db.auto = { ...DEFAULT_AUTO, ...db.auto };
    for (const r of db.renders) r.review ??= "pending";
    return db;
  } catch {
    return { clips: [], renders: [], settings: { ...DEFAULT_SETTINGS }, albums: [], examples: [], partners: [], drafts: [], edits: [], auto: { ...DEFAULT_AUTO }, research: {}, spend: { month: "", usd: 0, calls: 0 } };
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

  /** The creator's corrections to text, descriptions and hashtags, newest first (the last 150). */
  edits: () => db.edits,
  addEdit(e: Omit<EditRecord, "at">) {
    if (e.before.trim() === e.after.trim()) return;
    db.edits = [{ ...e, at: new Date().toISOString() }, ...db.edits].slice(0, 150);
    save();
  },

  drafts: () => db.drafts,
  draft: (id: string) => db.drafts.find((d) => d.id === id),
  saveDraft(d: StoryDraft) {
    const i = db.drafts.findIndex((x) => x.id === d.id);
    if (i >= 0) db.drafts[i] = d;
    else db.drafts.unshift(d);
    db.drafts = db.drafts.slice(0, 20);
    save();
    return d;
  },
  removeDraft(id: string) {
    db.drafts = db.drafts.filter((d) => d.id !== id);
    save();
  },

  partners: () => db.partners,
  partner: (id: string) => db.partners.find((p) => p.id === id),
  savePartner(p: Partner) {
    const i = db.partners.findIndex((x) => x.id === p.id);
    if (i >= 0) db.partners[i] = p;
    else db.partners.push(p);
    save();
    return p;
  },
  removePartner(id: string) {
    db.partners = db.partners.filter((p) => p.id !== id);
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

/** Every situation and theme clips are sorted into: the airport ones, then the outside ones. */
export function allScenes(): string[] {
  const { scenes, outsideThemes } = store.settings();
  return [...new Set([...scenes, ...(outsideThemes ?? [])])];
}
