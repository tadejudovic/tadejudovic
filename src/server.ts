import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { config } from "./config.ts";
import { store, newId } from "./store.ts";
import { TEMPLATES } from "./templates.ts";
import { authUrl, handleCallback, disconnect, googleConfigured } from "./google/oauth.ts";
import { createSession, getSession, listPicked, deleteSession } from "./google/picker.ts";
import { enqueueClip, importPicked, analyzeClip, deleteClip } from "./library.ts";
import { plan, queueRender, deleteRender } from "./generate.ts";
import type { GenerateRequest, RenderOptions, TemplateId, VideoPlan } from "./types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(here, "..", "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: config.tmpDir,
    filename: (_req, file, cb) => cb(null, `${newId()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 4 * 1024 ** 3 },
});

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

// ---- Status & settings ----------------------------------------------------

app.get("/api/status", (_req, res) => {
  res.json({
    google: { configured: googleConfigured(), connected: Boolean(store.google()) },
    claude: { enabled: config.claude.enabled, model: config.claude.model },
    fontAvailable: Boolean(config.fontFile),
    settings: store.settings(),
    templates: Object.values(TEMPLATES).map(({ id, name, description }) => ({ id, name, description })),
    music: listMusic(),
  });
});

app.put("/api/settings", (req, res) => {
  const { petName, handle } = req.body ?? {};
  res.json(
    store.updateSettings({
      ...(typeof petName === "string" && petName.trim() ? { petName: petName.trim().slice(0, 40) } : {}),
      ...(typeof handle === "string" ? { handle: handle.trim().slice(0, 40) } : {}),
    }),
  );
});

// ---- Google Photos --------------------------------------------------------

app.get("/auth/google", (_req, res) => {
  if (!googleConfigured()) return res.status(400).send("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.");
  res.redirect(authUrl());
});

app.get(
  "/auth/google/callback",
  h(async (req, res) => {
    if (req.query.error) return res.redirect(`/?google_error=${encodeURIComponent(String(req.query.error))}`);
    await handleCallback(String(req.query.code ?? ""), String(req.query.state ?? ""));
    res.redirect("/?google=connected");
  }),
);

app.post("/api/google/disconnect", (_req, res) => {
  disconnect();
  res.json({ ok: true });
});

app.post(
  "/api/google/picker",
  h(async (_req, res) => {
    const s = await createSession();
    res.json({ id: s.id, pickerUri: s.pickerUri, pollInterval: s.pollingConfig?.pollInterval });
  }),
);

app.get(
  "/api/google/picker/:id",
  h(async (req, res) => {
    const id = String(req.params.id);
    const s = await getSession(id);
    if (!s.mediaItemsSet) return res.json({ done: false });
    const items = await listPicked(id);
    const clips = importPicked(items);
    await deleteSession(id);
    res.json({ done: true, picked: items.length, imported: clips.length });
  }),
);

// ---- Library --------------------------------------------------------------

app.get("/api/clips", (_req, res) => {
  res.json(store.clips().map(({ energy, file, thumb, ...c }) => ({ ...c, energy })));
});

app.post(
  "/api/clips/upload",
  upload.array("files", 100),
  h(async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    const lastModified = parseDates(req.body?.lastModified);
    const clips = files.map((f, i) =>
      enqueueClip({
        source: "upload",
        filename: f.originalname,
        capturedAt: lastModified[i],
        fetch: async (dest) => fs.renameSync(f.path, dest),
      }),
    );
    res.json({ imported: clips.length });
  }),
);

app.post(
  "/api/clips/:id/reanalyze",
  h(async (req, res) => {
    const id = String(req.params.id);
    if (!store.clip(id)) return res.sendStatus(404);
    analyzeClip(id).catch((err) => store.updateClip(id, { status: "error", error: err.message }));
    res.json({ ok: true });
  }),
);

app.delete("/api/clips/:id", (req, res) => {
  deleteClip(String(req.params.id));
  res.json({ ok: true });
});

app.get("/media/thumb/:id", (req, res) => {
  const clip = store.clip(String(req.params.id));
  if (!clip?.thumb || !fs.existsSync(clip.thumb)) return res.sendStatus(404);
  res.sendFile(clip.thumb);
});

app.get("/media/clip/:id", (req, res) => {
  const clip = store.clip(String(req.params.id));
  if (!clip || clip.status !== "ready") return res.sendStatus(404);
  res.sendFile(clip.file);
});

// ---- Music ----------------------------------------------------------------

const musicDir = path.join(config.mediaDir, "music");
fs.mkdirSync(musicDir, { recursive: true });

function listMusic() {
  return fs
    .readdirSync(musicDir)
    .filter((f) => /\.(mp3|m4a|aac|wav|ogg)$/i.test(f))
    .map((f) => ({ id: f, name: f.replace(/^[0-9a-f]{16}-/, "") }));
}

app.post("/api/music", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const safe = path.basename(req.file.originalname).replace(/[^\w.\- ]/g, "_");
  const name = `${newId()}-${safe}`;
  fs.renameSync(req.file.path, path.join(musicDir, name));
  res.json({ id: name });
});

// ---- Generate -------------------------------------------------------------

function parseOptions(body: any): RenderOptions {
  const musicId = typeof body?.musicId === "string" ? path.basename(body.musicId) : "";
  const musicFile = musicId && fs.existsSync(path.join(musicDir, musicId)) ? path.join(musicDir, musicId) : undefined;
  return {
    framing: ["auto", "fill", "blur"].includes(body?.framing) ? body.framing : "auto",
    keepOriginalAudio: body?.keepOriginalAudio !== false,
    textStyle: body?.textStyle === "box" ? "box" : "classic",
    musicFile,
  };
}

function parseRequest(body: any): GenerateRequest {
  const template = (body?.template in TEMPLATES ? body.template : "quick_cuts") as TemplateId;
  return {
    template,
    targetSeconds: clamp(Number(body?.targetSeconds) || 15, 6, 60),
    count: clamp(Math.round(Number(body?.count) || 1), 1, 10),
    brief: typeof body?.brief === "string" ? body.brief.slice(0, 500) : undefined,
    clipIds: Array.isArray(body?.clipIds) ? body.clipIds.map(String) : undefined,
    useAi: body?.useAi !== false,
    options: parseOptions(body?.options),
  };
}

/** Preview plans without rendering (lets the creator edit hooks/captions first). */
app.post(
  "/api/plan",
  h(async (req, res) => {
    res.json(await plan(parseRequest(req.body)));
  }),
);

/** Render already-reviewed plans. */
app.post("/api/render", (req, res) => {
  const plans: VideoPlan[] = Array.isArray(req.body?.plans) ? req.body.plans : [];
  const options = parseOptions(req.body?.options);
  const valid = plans.filter((p) => Array.isArray(p?.segments) && p.segments.every((s) => store.clip(String(s.clipId))));
  if (!valid.length) return res.status(400).json({ error: "No valid plans to render." });
  res.json({ renders: valid.map((p) => queueRender(sanitizePlan(p), options)) });
});

/** One click: plan and render. */
app.post(
  "/api/generate",
  h(async (req, res) => {
    const r = parseRequest(req.body);
    const { plans, warning } = await plan(r);
    res.json({ renders: plans.map((p) => queueRender(p, r.options)), warning });
  }),
);

app.get("/api/renders", (_req, res) => {
  res.json(store.renders().map(({ file, thumb, ...r }) => r));
});

app.delete("/api/renders/:id", (req, res) => {
  deleteRender(String(req.params.id));
  res.json({ ok: true });
});

app.get("/media/render/:id.mp4", (req, res) => {
  const r = store.render(String(req.params.id));
  if (!r?.file || !fs.existsSync(r.file)) return res.sendStatus(404);
  if (req.query.dl) {
    const name = `${store.settings().petName}-${r.plan.title}`.replace(/[^\w\- ]/g, "").slice(0, 60).trim() || r.id;
    return res.download(r.file, `${name}.mp4`);
  }
  res.sendFile(r.file);
});

app.get("/media/render/:id.jpg", (req, res) => {
  const r = store.render(String(req.params.id));
  if (!r?.thumb || !fs.existsSync(r.thumb)) return res.sendStatus(404);
  res.sendFile(r.thumb);
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// ---- helpers --------------------------------------------------------------

function sanitizePlan(p: VideoPlan): VideoPlan {
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  return {
    template: (p.template in TEMPLATES ? p.template : "quick_cuts") as TemplateId,
    title: str(p.title, 120) || "Untitled",
    hook: str(p.hook, 120),
    postCaption: str(p.postCaption, 2200),
    hashtags: Array.isArray(p.hashtags) ? p.hashtags.map((t) => str(t, 40)).filter(Boolean).slice(0, 15) : [],
    plannedBy: p.plannedBy === "claude" ? "claude" : "heuristic",
    segments: p.segments.slice(0, 40).map((s) => {
      const clip = store.clip(String(s.clipId))!;
      const start = clamp(Number(s.start) || 0, 0, Math.max(0, clip.duration - 0.3));
      return {
        clipId: clip.id,
        start,
        end: clamp(Number(s.end) || start + 1, start + 0.3, clip.duration),
        caption: str(s.caption, 120) || undefined,
        speed: clamp(Number(s.speed) || 1, 0.5, 2),
      };
    }),
  };
}

function parseDates(v: unknown): (string | undefined)[] {
  const arr = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return arr.map((x) => {
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : undefined;
  });
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// Work queues live in memory; anything in flight when the server stopped is lost.
for (const c of store.clips()) {
  if (c.status === "importing" || c.status === "analyzing") {
    store.updateClip(c.id, { status: "error", error: "Interrupted by a restart — re-import or re-analyze." });
  }
}
for (const r of store.renders()) {
  if (r.status === "queued" || r.status === "rendering") {
    store.updateRender(r.id, { status: "error", error: "Interrupted by a restart." });
  }
}

const host = process.env.HOST ?? "127.0.0.1";
app.listen(config.port, host, () => {
  console.log(`PawCut running at ${config.appUrl}`);
  console.log(`  Google Photos: ${googleConfigured() ? "configured" : "not configured (set GOOGLE_CLIENT_ID/SECRET)"}`);
  console.log(`  AI director:   ${config.claude.enabled ? config.claude.model : "off (set ANTHROPIC_API_KEY)"}`);
  console.log(`  Text font:     ${config.fontFile ?? "none found — set FONT_FILE to enable on-screen text"}`);
});
