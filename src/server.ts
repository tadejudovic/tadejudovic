import { recentLogs } from "./logbuffer.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { config, memoryMb } from "./config.ts";
import { store, newId } from "./store.ts";
import { TEMPLATES } from "./templates.ts";
import { authUrl, handleCallback, disconnect, googleConfigured } from "./google/oauth.ts";
import { createSession, getSession, listPicked, deleteSession } from "./google/picker.ts";
import { enqueueClip, importPicked, analyzeClip, deleteClip, ensureProxy } from "./library.ts";
import { forgetRunningJobs, ingestQueue, jobsFromLastCrash, markStopping } from "./queue.ts";
import { plan, queueRender, deleteRender, pickBySituation, isPortrait, retryRender } from "./generate.ts";
import { addAlbum, forgetItem, setRecentDays, syncAlbum } from "./albums.ts";
import { DailyLimitReached, dailyLimit, videosLeftToday, videosMadeToday } from "./dailyLimit.ts";
import { afterReview, awaitingReview, lastRoundError, localDate, runDailyBatch, setPaused, startScheduler } from "./scheduler.ts";
import { currentTrends, refreshTrends } from "./ai/trends.ts";
import { apifyEnabled } from "./ai/tiktokSearch.ts";
import { addCreatorCaption, provenCaptions, removeCaption, researchScene } from "./ai/research.ts";
import { listFonts, saveCustomFont, fontPath, FONTS } from "./fonts.ts";
import { addExample, deleteExample, reanalyzeExample } from "./examples.ts";
import { gateEnabled, login, loginPage, logout, requireAuth } from "./auth.ts";
import { monthlyLimit, spendThisMonth } from "./ai/budget.ts";
import type { Clip, GenerateRequest, RejectReason, Render, RenderOptions, TemplateId, VideoPlan } from "./types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Behind a hosting proxy (Render, Railway, Fly…): trust X-Forwarded-* for HTTPS detection and client IPs.
app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.setHeader("x-robots-tag", "noindex, nofollow");
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/login", loginPage);
app.post("/login", login);
app.get("/logout", logout);
app.use(requireAuth);
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

// ---- Diagnostics ----------------------------------------------------------

/** Everything needed to debug a problem remotely, in one copyable blob (behind the password gate). */
app.get("/api/diagnostics", (_req, res) => {
  const count = <T,>(xs: T[], key: (x: T) => string) =>
    xs.reduce<Record<string, number>>((acc, x) => ((acc[key(x)] = (acc[key(x)] ?? 0) + 1), acc), {});
  const clips = store.clips();
  const renders = store.renders();
  res.json({
    version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "local",
    now: new Date().toISOString(),
    uptimeMin: Math.round(process.uptime() / 60),
    memoryMb,
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    paused,
    aiEnabled: config.claude.enabled,
    tiktokSearch: apifyEnabled(),
    research: store.settings().scenes.map((scene) => {
      const r = store.research(scene);
      return r && { scene, source: r.source, updatedAt: r.updatedAt, error: r.error, captions: r.captions.length, hashtags: r.hashtags, hashtagNote: r.hashtagNote };
    }).filter(Boolean),
    spend: { ...spendThisMonth(), limit: monthlyLimit() },
    queuePending: ingestQueue.pending,
    clips: {
      byStatus: count(clips, (c) => c.status),
      byScene: count(clips.filter((c) => c.status === "ready"), (c) => c.scene ?? "unsorted"),
      landscape: clips.filter((c) => c.status === "ready" && c.width > c.height).length,
      errors: [...new Set(clips.filter((c) => c.error).map((c) => c.error!))].slice(0, 10),
    },
    renders: {
      byStatus: count(renders, (r) => r.status),
      errors: [...new Set(renders.filter((r) => r.error).map((r) => r.error!))].slice(0, 10),
    },
    albums: store.albums().map(({ seen, url, ...a }) => ({ ...a, seen: seen.length })),
    auto: store.auto(),
    logs: recentLogs(150),
  });
});

// ---- Status & settings ----------------------------------------------------

app.get("/api/status", (_req, res) => {
  res.json({
    google: { configured: googleConfigured(), connected: Boolean(store.google()) },
    claude: { enabled: config.claude.enabled, model: config.claude.model },
    gate: gateEnabled,
    paused,
    spend: { ...spendThisMonth(), limit: monthlyLimit() },
    memoryMb,
    tiktokSearch: apifyEnabled(),
    videosToday: { made: videosMadeToday(), limit: dailyLimit() },
    awaitingReview: awaitingReview(),
    lastRoundError,
    settings: store.settings(),
    templates: Object.values(TEMPLATES).map(({ id, name, description }) => ({ id, name, description })),
    music: listMusic(),
  });
});

app.put("/api/settings", (req, res) => {
  const { petName, handle, fontId, textStyle, aiMonthlyBudget, maxVideosPerDay } = req.body ?? {};
  const fontOk = typeof fontId === "string" && listFonts().some((f) => f.id === fontId);
  res.json(
    store.updateSettings({
      ...(typeof petName === "string" && petName.trim() ? { petName: petName.trim().slice(0, 40) } : {}),
      ...(typeof handle === "string" ? { handle: handle.trim().slice(0, 40) } : {}),
      ...(fontOk ? { fontId } : {}),
      ...(["yellow", "classic", "box", "plain"].includes(textStyle) ? { textStyle } : {}),
      ...(Number.isFinite(Number(aiMonthlyBudget)) && aiMonthlyBudget !== "" && aiMonthlyBudget !== undefined
        ? { aiMonthlyBudget: clamp(Number(aiMonthlyBudget), 0, 1000) }
        : {}),
      ...(Number(maxVideosPerDay) >= 1 ? { maxVideosPerDay: clamp(Math.round(Number(maxVideosPerDay)), 1, 30) } : {}),
    }),
  );
});

// ---- Fonts ----------------------------------------------------------------

app.get("/api/fonts", (_req, res) => res.json(listFonts()));

app.post("/api/fonts", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  try {
    const id = saveCustomFont(req.file.path, req.file.originalname);
    store.updateSettings({ fontId: id });
    res.json({ id });
  } catch (err) {
    fs.rmSync(req.file.path, { force: true });
    res.status(400).json({ error: (err as Error).message });
  }
});

/** Serve a font file so the UI can preview it (downloads built-in fonts on first request). */
app.get(
  "/media/font/:id",
  h(async (req, res) => {
    const id = String(req.params.id);
    if (!listFonts().some((f) => f.id === id)) return res.sendStatus(404);
    const file = await fontPath(id);
    if (!file) return res.sendStatus(404);
    res.setHeader("cache-control", "public, max-age=86400");
    res.sendFile(file);
  }),
);

// ---- Examples that worked -------------------------------------------------

app.get("/api/examples", (_req, res) => res.json(store.examples().map(({ file, thumb, ...e }) => e)));

app.post("/api/examples", upload.single("file"), (req, res) => {
  const b = req.body ?? {};
  const views = Number(String(b.views ?? "").replace(/[^\d]/g, "")) || undefined;
  if (!req.file && !b.overlayText && !b.note) return res.status(400).json({ error: "Add a video, its overlay text, or a note." });
  const { file, thumb, ...created } = addExample({
      tmpFile: req.file?.path,
      filename: req.file?.originalname,
      note: typeof b.note === "string" ? b.note.slice(0, 1000) : undefined,
      overlayText: typeof b.overlayText === "string" ? b.overlayText.slice(0, 200) : undefined,
      views,
  });
  res.json(created);
});

app.patch("/api/examples/:id", (req, res) => {
  const b = req.body ?? {};
  const e = store.updateExample(String(req.params.id), {
    ...(typeof b.note === "string" ? { note: b.note.slice(0, 1000) } : {}),
    ...(typeof b.overlayText === "string" ? { overlayText: b.overlayText.slice(0, 200) } : {}),
  });
  if (!e) return res.sendStatus(404);
  res.json(e);
});

app.post("/api/examples/:id/reanalyze", (req, res) => {
  reanalyzeExample(String(req.params.id));
  res.json({ ok: true });
});

app.delete("/api/examples/:id", (req, res) => {
  deleteExample(String(req.params.id));
  res.json({ ok: true });
});

app.get("/media/example/:id.jpg", (req, res) => {
  const e = store.example(String(req.params.id));
  if (!e?.thumb || !fs.existsSync(e.thumb)) return res.sendStatus(404);
  res.sendFile(e.thumb);
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

// ---- Shared albums --------------------------------------------------------

app.get("/api/albums", (_req, res) => {
  res.json(store.albums().map(({ seen, ...a }) => ({ ...a, seenCount: seen.length })));
});

app.post(
  "/api/albums",
  h(async (req, res) => {
    const album = addAlbum(String(req.body?.url ?? ""));
    // First sync right away so the creator sees videos arriving.
    const result = await syncAlbum(album.id).catch((err: Error) => ({ error: err.message }));
    res.json({ album, ...result });
  }),
);

app.post(
  "/api/albums/:id/sync",
  h(async (req, res) => {
    res.json(await syncAlbum(String(req.params.id)));
  }),
);

app.patch("/api/albums/:id", (req, res) => {
  const days = Number(req.body?.recentDays);
  if (!store.album(String(req.params.id))) return res.status(404).json({ error: "Unknown album" });
  if (Number.isFinite(days)) setRecentDays(String(req.params.id), days);
  res.json(store.album(String(req.params.id)));
});

app.delete("/api/albums/:id", (req, res) => {
  store.removeAlbum(String(req.params.id));
  res.json({ ok: true });
});

// ---- Daily batch & trends -------------------------------------------------

app.get("/api/auto", (_req, res) => res.json(store.auto()));

app.put("/api/auto", (req, res) => {
  const b = req.body ?? {};
  const patch: Partial<ReturnType<typeof store.auto>> = {};
  if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
  if (b.dailyCount !== undefined) patch.dailyCount = clamp(Math.round(Number(b.dailyCount) || 4), 1, 10);
  if (typeof b.dailyTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.dailyTime)) patch.dailyTime = b.dailyTime;
  if (b.template in TEMPLATES) patch.template = b.template;
  if (b.targetSeconds !== undefined) patch.targetSeconds = clamp(Number(b.targetSeconds) || 12, 6, 60);
  if (b.syncEveryHours !== undefined) patch.syncEveryHours = clamp(Number(b.syncEveryHours) || 3, 0.25, 48);
  res.json(store.updateAuto(patch));
});

app.post(
  "/api/batch/run",
  h(async (_req, res) => {
    res.json(await runDailyBatch({ force: true }));
  }),
);

app.get("/api/trends", (_req, res) => res.json(currentTrends()));

app.post(
  "/api/trends/refresh",
  h(async (_req, res) => {
    if (!config.claude.enabled) return res.status(400).json({ error: "Set ANTHROPIC_API_KEY to research trends." });
    res.json(await refreshTrends(store.settings().petName));
  }),
);

// ---- Suggestions ----------------------------------------------------------

/** What the studio would make next: unused clips, rotating situations, with the caption it would likely adapt. */
app.get("/api/suggestions", (_req, res) => {
  const pending = new Set(
    store.renders().filter((r) => r.status === "queued" || r.status === "rendering").flatMap((r) => r.plan.segments.map((s) => s.clipId)),
  );
  const fresh = store.clips().filter((c) => c.status === "ready" && isPortrait(c) && c.uses === 0 && !c.disliked && !pending.has(c.id));
  res.json(
    pickBySituation(fresh, 6).map((c) => {
      const top = provenCaptions(c.scene, 1)[0];
      return {
        clipId: c.id,
        scene: c.scene,
        duration: c.duration,
        note: c.note,
        summary: c.ai?.summary,
        caption: top ? { text: top.text, views: top.views } : undefined,
      };
    }),
  );
});

// ---- Situations & proven captions -----------------------------------------

app.get("/api/scenes", (_req, res) => {
  const clips = store.clips().filter((c) => c.status === "ready");
  const scenes = store.settings().scenes;
  res.json(
    [...scenes, "other"].map((scene) => ({
      scene,
      clips: clips.filter((c) => (scene === "other" ? !c.scene || !scenes.includes(c.scene) : c.scene === scene)).length,
      unused: clips.filter((c) => c.uses === 0 && (scene === "other" ? !c.scene || !scenes.includes(c.scene) : c.scene === scene)).length,
      research: scene === "other" ? null : store.research(scene) ?? null,
    })),
  );
});

app.put("/api/scenes", (req, res) => {
  const list = Array.isArray(req.body?.scenes) ? req.body.scenes : [];
  const scenes = [...new Set(list.map((x: unknown) => String(x).trim().toLowerCase().slice(0, 60)).filter((x: string) => x && x !== "other"))].slice(0, 20) as string[];
  if (!scenes.length) return res.status(400).json({ error: "Keep at least one situation." });
  res.json(store.updateSettings({ scenes }));
});

app.post(
  "/api/scenes/:scene/research",
  h(async (req, res) => {
    if (!config.claude.enabled) return res.status(400).json({ error: "Set ANTHROPIC_API_KEY to research captions." });
    res.json(await researchScene(String(req.params.scene)));
  }),
);

app.post("/api/scenes/:scene/captions", (req, res) => {
  const b = req.body ?? {};
  if (typeof b.text !== "string" || !b.text.trim()) return res.status(400).json({ error: "Caption text required" });
  const views = Number(String(b.views ?? "").replace(/[^\d]/g, "")) || undefined;
  res.json(addCreatorCaption(String(req.params.scene), { text: b.text, views, url: b.url, note: b.note }));
});

app.delete("/api/scenes/:scene/captions/:id", (req, res) => {
  removeCaption(String(req.params.scene), String(req.params.id));
  res.json({ ok: true });
});

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

/** The creator's own note about what's on the footage. */
app.patch("/api/clips/:id", (req, res) => {
  const { note, scene } = req.body ?? {};
  const patch: Partial<Clip> = {};
  if (typeof note === "string") patch.note = note.trim().slice(0, 500) || undefined;
  if (typeof scene === "string") {
    if (scene && scene !== "other" && !store.settings().scenes.includes(scene)) return res.status(400).json({ error: "Unknown situation" });
    patch.scene = scene || undefined;
    patch.sceneSetBy = "creator";
  }
  const clip = store.updateClip(String(req.params.id), patch);
  if (!clip) return res.sendStatus(404);
  res.json({ ok: true });
});

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
  const settings = store.settings();
  const fontId = typeof body?.fontId === "string" && listFonts().some((f) => f.id === body.fontId) ? body.fontId : settings.fontId;
  return {
    keepOriginalAudio: body?.keepOriginalAudio !== false,
    textStyle: ["yellow", "classic", "box", "plain"].includes(body?.textStyle) ? body.textStyle : settings.textStyle,
    fontId,
    musicFile,
  };
}

function parseRequest(body: any): GenerateRequest {
  const template = (body?.template in TEMPLATES ? body.template : "auto") as TemplateId;
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
    const r = parseRequest(req.body);
    r.count = Math.max(1, Math.min(r.count, videosLeftToday()));
    res.json(await plan(r));
  }),
);

/** Render already-reviewed plans. */
app.post("/api/render", (req, res) => {
  const plans: VideoPlan[] = Array.isArray(req.body?.plans) ? req.body.plans : [];
  const options = parseOptions(req.body?.options);
  const valid = plans.filter((p) => Array.isArray(p?.segments) && p.segments.every((s) => store.clip(String(s.clipId))));
  if (!valid.length) return res.status(400).json({ error: "No valid plans to render." });
  const left = videosLeftToday();
  if (!left) return res.status(429).json({ error: new DailyLimitReached().message });
  res.json({ renders: valid.slice(0, left).map((p) => queueRender(sanitizePlan(p), options)) });
});

/** One click: plan and render. */
app.post(
  "/api/generate",
  h(async (req, res) => {
    const r = parseRequest(req.body);
    const left = videosLeftToday();
    if (!left) return res.status(429).json({ error: new DailyLimitReached().message });
    r.count = Math.min(r.count, left);
    const { plans, warning } = await plan(r);
    // "Make video" on a clip adds it to today's review batch.
    const batch = req.body?.batch === "today" ? localDate(new Date()) : undefined;
    res.json({ renders: plans.map((p) => queueRender(p, r.options, batch)), warning });
  }),
);

app.get("/api/renders", (_req, res) => {
  res.json(store.renders().map(({ file, thumb, ...r }) => r));
});

/** Review: approve/reject, and edit the post caption (no re-render needed). */
app.patch("/api/renders/:id", (req, res) => {
  const r = store.render(String(req.params.id));
  if (!r) return res.sendStatus(404);
  const b = req.body ?? {};
  const planPatch: Partial<VideoPlan> = {};
  if (typeof b.postCaption === "string") planPatch.postCaption = b.postCaption.slice(0, 2200);
  if (Array.isArray(b.hashtags)) planPatch.hashtags = b.hashtags.map((t: unknown) => String(t).replace(/^#/, "").slice(0, 40)).filter(Boolean).slice(0, 15);
  const review = ["pending", "approved", "rejected"].includes(b.review) ? (b.review as Render["review"]) : undefined;
  const reason = ["text", "clip", "edit", "other"].includes(b.rejectReason) ? (b.rejectReason as RejectReason) : undefined;
  store.updateRender(r.id, {
    ...(review ? { review, reviewedAt: new Date().toISOString(), rejectReason: review === "rejected" ? reason ?? r.rejectReason : undefined } : {}),
    ...(review === undefined && reason && r.review === "rejected" ? { rejectReason: reason } : {}),
    ...(b.downloaded === true ? { downloaded: true } : {}),
    plan: { ...r.plan, ...planPatch },
  });
  // "Bad clip": stop picking that footage automatically. Undoing the rejection brings it back.
  const now = store.render(r.id)!;
  const clipIds = [...new Set(r.plan.segments.map((s) => s.clipId))];
  if (now.review === "rejected" && now.rejectReason === "clip") for (const id of clipIds) store.updateClip(id, { disliked: true });
  else if (r.rejectReason === "clip") for (const id of clipIds) store.updateClip(id, { disliked: false });
  // Last video of the round reviewed: start the next round.
  if (review && review !== "pending") afterReview();
  res.json(store.render(r.id));
});

app.post("/api/renders/:id/retry", (req, res) => {
  const r = retryRender(String(req.params.id));
  if (!r) return res.sendStatus(404);
  res.json(r);
});

/** Change the on-screen text and render again; replaces the old version. */
app.post("/api/renders/:id/rerender", (req, res) => {
  const r = store.render(String(req.params.id));
  if (!r) return res.sendStatus(404);
  if (!r.plan.segments.every((s) => store.clip(s.clipId))) return res.status(400).json({ error: "A source clip was deleted." });
  const b = req.body ?? {};
  // Overlay edits arrive as a list of texts matching the existing overlays (or a single hook).
  const texts: string[] | undefined = Array.isArray(b.overlays) ? b.overlays.map(String) : undefined;
  const overlays = r.plan.overlays?.length
    ? r.plan.overlays.map((o, i) => ({ ...o, text: texts?.[i] ?? (i === 0 && typeof b.hook === "string" ? b.hook : o.text) }))
    : undefined;
  const next = sanitizePlan({
    ...r.plan,
    overlays,
    hook: overlays?.[0]?.text ?? (typeof b.hook === "string" ? b.hook : texts?.[0] ?? r.plan.hook),
    postCaption: typeof b.postCaption === "string" ? b.postCaption : r.plan.postCaption,
  });
  const fresh = queueRender(next, { ...r.options, ...parseOptions({ ...r.options, ...(b.options ?? {}) }) }, r.batch, { countUse: false });
  deleteRender(r.id);
  res.json(fresh);
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
    template: (p.template in TEMPLATES ? p.template : "auto") as TemplateId,
    title: str(p.title, 120) || "Untitled",
    concept: str(p.concept, 300) || undefined,
    scene: str(p.scene, 60) || undefined,
    basedOn:
      p.basedOn && typeof p.basedOn.text === "string"
        ? {
            text: str(p.basedOn.text, 200),
            views: Number(p.basedOn.views) > 0 ? Math.round(Number(p.basedOn.views)) : undefined,
            url: typeof p.basedOn.url === "string" && /^https?:\/\//.test(p.basedOn.url) ? str(p.basedOn.url, 500) : undefined,
          }
        : undefined,
    overlays: Array.isArray(p.overlays)
      ? p.overlays
          .slice(0, 6)
          .map((o) => ({ text: str(o?.text, 160), start: clamp(Number(o?.start) || 0, 0, 120), end: clamp(Number(o?.end) || 0, 0, 121) }))
          .filter((o) => o.text && o.end > o.start)
      : undefined,
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

// ---- Startup recovery -----------------------------------------------------
//
// Work queues live in memory. After a restart: skip whatever crashed the server last time,
// pause everything if it keeps crashing, and otherwise pick up interrupted work.

const CRASHED = "This crashed the server (it ran out of memory), so it won't be retried automatically.";
const crashed = jobsFromLastCrash();
for (const j of crashed) {
  console.warn(`[recovery] ${j.kind} ${j.id} was running when the server died; not retrying it`);
  if (j.kind === "render") store.updateRender(j.id, { status: "error", error: CRASHED });
  if (j.kind === "clip") store.updateClip(j.id, { status: "error", error: CRASHED });
  if (j.kind === "example") store.updateExample(j.id, { status: "error", error: CRASHED });
}
const crashedIds = new Set(crashed.map((j) => j.id));

/** Unclean starts (no graceful shutdown before them) in the last 20 minutes. */
function recordBoot(): number {
  const file = path.join(config.dataDir, ".boots.json");
  const cleanMarker = path.join(config.dataDir, ".clean-exit");
  const clean = fs.existsSync(cleanMarker);
  fs.rmSync(cleanMarker, { force: true });
  let boots: number[] = [];
  try {
    boots = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  if (!clean) boots.push(Date.now());
  boots = boots.filter((t) => Date.now() - t < 20 * 60_000);
  fs.writeFileSync(file, JSON.stringify(boots));
  return boots.length;
}
// Deploys stop the server with SIGTERM; mark those so they don't count as crashes.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    try {
      // A deploy interrupted whatever was running; it didn't crash anything, so let the next start retry it.
      markStopping();
      forgetRunningJobs();
      store.flush();
      fs.writeFileSync(path.join(config.dataDir, ".clean-exit"), String(Date.now()));
    } catch {}
    process.exit(0);
  });
}

const uncleanBoots = recordBoot();
let paused = uncleanBoots >= 3;
if (paused) console.warn(`[recovery] ${uncleanBoots} crashes in 20 minutes: automatic work is paused until resumed in Settings`);

// Failed videos whose clips no longer exist can't be retried; remove them so they don't clutter the page.
for (const r of store.renders()) {
  if (r.status === "error" && r.plan.segments.some((s) => !store.clip(s.clipId))) deleteRender(r.id);
}

function recoverWork() {
  for (const c of store.clips()) {
    if (crashedIds.has(c.id) || (c.status !== "importing" && c.status !== "analyzing")) continue;
    const downloaded = c.status === "analyzing" || (c.source === "upload" && fs.existsSync(c.file));
    if (downloaded && fs.existsSync(c.file)) {
      ingestQueue.push(() => analyzeClip(c.id).catch((err) => void store.updateClip(c.id, { status: "error", error: err.message })), { kind: "clip", id: c.id });
    } else if (c.source === "shared_album") {
      // Possibly a partial download: drop it; the next album check imports it again.
      deleteClip(c.id);
      if (c.sourceId) forgetItem(c.sourceId);
    } else {
      store.updateClip(c.id, { status: "error", error: "Interrupted by a restart. Upload it again." });
    }
  }
  // Clips imported before 1080p working copies existed: swap/convert them first...
  for (const c of store.clips()) {
    if (c.status === "ready" && c.kind === "video" && !crashedIds.has(c.id)) {
      ingestQueue.push(() => ensureProxy(c.id).catch((err) => console.warn(`[proxy] ${c.filename}:`, err.message)), { kind: "clip", id: c.id });
    }
  }
  // ...then finish interrupted videos.
  for (const r of store.renders()) {
    if (!crashedIds.has(r.id) && (r.status === "queued" || r.status === "rendering")) retryRender(r.id, { urgent: false });
  }
}

if (!paused) recoverWork();
setPaused(paused);

app.post("/api/resume", (_req, res) => {
  fs.rmSync(path.join(config.dataDir, ".boots.json"), { force: true });
  if (paused) {
    paused = false;
    setPaused(false);
    recoverWork();
  }
  res.json({ ok: true });
});

startScheduler();

// Public by default only when the password gate is on.
const host = process.env.HOST ?? (gateEnabled ? "0.0.0.0" : "127.0.0.1");
if (!gateEnabled && !["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error("Refusing to listen on a public address without APP_PASSWORD. Set APP_PASSWORD (or HOST=127.0.0.1).");
  process.exit(1);
}
app.listen(config.port, host, () => {
  console.log(`Lex Studio running at ${config.appUrl}`);
  console.log(`  Google Photos: ${googleConfigured() ? "configured" : "not configured (set GOOGLE_CLIENT_ID/SECRET)"}`);
  console.log(`  AI director:   ${config.claude.enabled ? config.claude.model : "off (set ANTHROPIC_API_KEY)"}`);
  console.log(`  Password gate: ${gateEnabled ? "on" : "off (local only)"}`);
});
