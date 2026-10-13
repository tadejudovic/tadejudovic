import fs from "node:fs";
import crypto from "node:crypto";
import { config } from "./config.ts";
import type { Clip, Render } from "./types.ts";

/**
 * Tiny JSON-file store. Good enough for a single creator running this locally;
 * swap for Postgres/SQLite when going multi-tenant.
 */
interface DB {
  clips: Clip[];
  renders: Render[];
  google?: GoogleTokens;
  settings: { petName: string; handle: string };
}

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
}

function load(): DB {
  try {
    const db = JSON.parse(fs.readFileSync(config.dbFile, "utf8")) as DB;
    db.settings ??= { petName: "Lex", handle: "" };
    return db;
  } catch {
    return { clips: [], renders: [], settings: { petName: "Lex", handle: "" } };
  }
}

const db: DB = load();
let saveTimer: NodeJS.Timeout | null = null;

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

  settings: () => db.settings,
  updateSettings(patch: Partial<DB["settings"]>) {
    Object.assign(db.settings, patch);
    save();
    return db.settings;
  },
};
