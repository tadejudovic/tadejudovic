import { recentLogs } from "./logbuffer.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { config, memoryMb } from "./config.ts";
import { allScenes, store, newId, mixSize, featureOn, FEATURES, type Feature } from "./store.ts";
import { TEMPLATES } from "./templates.ts";
import { authUrl, handleCallback, disconnect, googleConfigured } from "./google/oauth.ts";
import { createSession, getSession, listPicked, deleteSession } from "./google/picker.ts";
import { enqueueClip, importPicked, analyzeClip, deleteClip, ensureProxy, fastModelError, queueMissingAiLooks } from "./library.ts";
import { clearWaitingWork, forgetRunningJobs, ingestQueue, jobsFromLastCrash, markStopping } from "./queue.ts";
import { dayClips, proposeDayVlog, vlogDays, type VlogProposal } from "./ai/vlog.ts";
import { previewFor } from "./media/preview.ts";
import { bandwidthStatus, countResponses, flushBandwidth, mediaStopped, playbackPaused, seedBandwidth } from "./bandwidth.ts";
import { allSearchTopics, importSearchExport, searchTopicUsed } from "./searchDemand.ts";
import { learnFromTikTok } from "./audience.ts";
import { DAY_KINDS, keptToday, promoteSpares, waitingOf } from "./daySet.ts";
import { linkWinningPosts, syncProfiles } from "./postMatch.ts";
import { plan, queueRender, deleteRender, pickBySituation, isPortrait, onTopic, retryRender, syncClipUses, makeCollabVersion, makeCollabFromLibrary, regenerateCaption, refreshPostStats, makeStoryVideo, makeDayVlog, createVoiceDraft, saveLineRecording, setLineClip, renderDraft, speakDraft, createVoice, removeVoice, reviewFeedback, madeTodayByKind, outsideClips, refreshDesigns, addCtaToExisting, zigzagExisting, remakeRejected, redoFromEditor, inspireIssue, kindIssues, numberTabsExisting, ctaCenterExisting, openerExisting, EDITOR_ATTEMPTS } from "./generate.ts";
import { addAlbum, forgetItem, freeDiskBytes, importPause, markDuplicates, scanSince, setRecentDays, syncAlbum } from "./albums.ts";
import { voiceCloningEnabled } from "./voice/elevenlabs.ts";
import { proofreadText } from "./ai/director.ts";
import { resortOther, suggestThemes } from "./ai/themes.ts";
import { countryOf, locateAll } from "./geo.ts";
import { healPlan, layoutPoints, lengthenFootage, readingSeconds } from "./overlayLayout.ts";
import { DailyLimitReached, dailyLimit, videosLeftToday, videosMadeToday } from "./dailyLimit.ts";
import { afterReview, awaitingReview, lastRoundError, localDate, roundStage, runDailyBatch, setPaused, startScheduler } from "./scheduler.ts";
import { apifyEnabled, platformOf } from "./ai/tiktokSearch.ts";
import { addCreatorCaption, provenCaptions, removeCaption, researchScene } from "./ai/research.ts";
import { listFonts, saveCustomFont, fontPath, FONTS } from "./fonts.ts";
import { addExample, deleteExample, reanalyzeExample } from "./examples.ts";
import { sendLanding, gateEnabled, googleCallback, googleLogin, googleStart, listenHost, lockedOut, loginPage, logout, requireAuth, signedInAs } from "./auth.ts";
import { aiOutOfCredit, monthlyLimit, spendThisMonth } from "./ai/budget.ts";
import type { Clip, GenerateRequest, RejectReason, Render, RenderOptions, StoryDraft, TemplateId, VideoPlan } from "./types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Behind a hosting proxy (Render, Railway, Fly…): trust X-Forwarded-* for HTTPS detection and client IPs.
app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.setHeader("x-robots-tag", "noindex, nofollow");
  next();
});
app.use(countResponses);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/login", loginPage);
app.get("/logout", logout);
app.get("/landing", (_req, res) => sendLanding(res)); // preview the public page while signed in
app.get("/login/google", googleStart);
app.get("/login/google/callback", (req, res, next) => { googleCallback(req, res).catch(next); });
app.use(requireAuth);
// Features behind a switch (Settings > Labs): their actions are refused while off.
const FEATURE_ROUTES: [RegExp, Feature, string][] = [
  [/^\/api\/vlog/, "vlog", "Day vlog"],
  [/^\/api\/(story|voice)/, "story", "Story video"],
  [/^\/api\/(partners(\/|$)|renders\/[^/]+\/collab$)/, "collab", "Brand partners"],
  [/^\/api\/(plan|render)$/, "manual", "Making videos by hand"],
];
app.use((req, res, next) => {
  if (req.method === "GET") return next();
  const hit = FEATURE_ROUTES.find(([re]) => re.test(req.path));
  if (hit && !featureOn(hit[1])) return void res.status(403).json({ error: `${hit[2]} is switched off. Turn it on in Settings → Labs.` });
  next();
});
// Always check for a newer version, so an update shows up on the next page load instead of an old cached copy.
app.use(express.static(path.join(here, "..", "public"), { setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") }));

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

/** Everything needed to debug a problem remotely, in one copyable blob (behind the sign-in gate). */
app.get("/api/diagnostics", (_req, res) => {
  const count = <T,>(xs: T[], key: (x: T) => string) =>
    xs.reduce<Record<string, number>>((acc, x) => ((acc[key(x)] = (acc[key(x)] ?? 0) + 1), acc), {});
  const clips = store.clips();
  const renders = store.renders();
  res.json({
    version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "local",
    aiOutOfCredit,
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
    yourCorrections: store.edits().slice(0, 10),
    bandwidth: bandwidthStatus(),
    today: { byKind: madeTodayByKind(), outsideClipsAvailable: outsideClips().length },
    // Per kind: kept today, waiting in Review, and why the last one couldn't be made (if it couldn't).
    kinds: Object.fromEntries(DAY_KINDS.map(([k]) => [k, { keptToday: keptToday(k), waiting: waitingOf(k), lastIssue: kindIssues[k] ?? null }])),
    inspirational: {
      lastMade: renders.filter((r) => r.plan.format === "inspire").map((r) => r.createdAt).sort().pop() ?? null,
      last7Days: renders.filter((r) => r.plan.format === "inspire" && Date.now() - Date.parse(r.createdAt) < 7 * 86400_000).length,
      fromOutsideFootage: renders.filter((r) => r.plan.outside).length,
      outsideThemesOn: store.settings().outsideThemes.filter((t) => !store.settings().themesOff?.includes(t)),
      outsideClipsByTheme: count(clips.filter((c) => c.status === "ready" && store.settings().outsideThemes.includes(c.scene ?? "")), (c) => `${c.scene}${c.uses ? " (used)" : ""}`),
      lastAiIssue: inspireIssue,
    },
    look: {
      setting: store.settings().textStyle,
      font: store.settings().fontId,
      videosByStyle: count(renders, (r) => r.options?.textStyle ?? "none"),
    },
    imports: { paused: importPause(), freeDiskGb: Math.round((freeDiskBytes() / 1024 ** 3) * 10) / 10 },
    clips: {
      byStatus: count(clips, (c) => c.status),
      byScene: count(clips.filter((c) => c.status === "ready"), (c) => c.scene ?? "unsorted"),
      landscape: clips.filter((c) => c.status === "ready" && c.width > c.height).length,
      errors: [...new Set(clips.filter((c) => c.error).map((c) => c.error!))].slice(0, 10),
      tagErrors: [...new Set(clips.filter((c) => c.tagError).map((c) => c.tagError!))].slice(0, 5),
      fastModelError,
      edited: clips.filter((c) => c.edited).length,
      duplicates: clips.filter((c) => c.duplicateOf).length,
      // Why clips don't make it into videos.
      notUsable: {
        landscape: clips.filter((c) => c.status === "ready" && c.width > c.height).length,
        tooShort: clips.filter((c) => c.status === "ready" && c.kind === "video" && c.duration < 3).length,
        noAiLook: clips.filter((c) => c.status === "ready" && !c.ai?.summary).length,
        filedAsOther: clips.filter((c) => c.status === "ready" && (!c.scene || c.scene === "other")).length,
        archived: clips.filter((c) => c.status === "archived").length,
        rejectedFootage: clips.filter((c) => c.disliked).length,
      },
      unusedReady: clips.filter((c) => c.status === "ready" && c.uses === 0 && c.height >= c.width && !c.edited && !c.duplicateOf).length,
      filmedSinceSep10: clips.filter((c) => (c.capturedAt ?? "") >= "2026-09-10").length,
    },
    renders: {
      byStatus: count(renders, (r) => r.status),
      // Videos the AI couldn't write (fallback captions), and why.
      withoutAi: renders.filter((r) => r.plan.aiNote).length,
      withoutAiReasons: [...new Set(renders.filter((r) => r.plan.aiNote).map((r) => r.plan.aiNote!))].slice(0, 5),
      errors: [...new Set(renders.filter((r) => r.error).map((r) => r.error!))].slice(0, 10),
    },
    albums: store.albums().map(({ seen, url, ...a }) => ({ ...a, seen: seen.length })),
    auto: store.auto(),
    logs: recentLogs(150),
  });
});

// ---- Status & settings ----------------------------------------------------

app.get("/api/status", (req, res) => {
  res.json({
    aiOutOfCredit: aiOutOfCredit ? { since: aiOutOfCredit.since } : null,
    version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "local",
    google: { configured: googleConfigured(), connected: Boolean(store.google()) },
    claude: { enabled: config.claude.enabled, model: config.claude.model },
    gate: gateEnabled,
    user: signedInAs(req),
    paused,
    spend: { ...spendThisMonth(), limit: monthlyLimit() },
    memoryMb,
    tiktokSearch: apifyEnabled(),
    videosToday: { made: videosMadeToday(), limit: dailyLimit() },
    awaitingReview: awaitingReview(),
    lastRoundError,
    kindIssues,
    roundStage,
    // The raw keyword list is only for regrouping; the app shows the topics.
    settings: { ...store.settings(), keywordQueries: undefined },
    bandwidth: bandwidthStatus(),
    templates: Object.values(TEMPLATES).map(({ id, name, description }) => ({ id, name, description })),
    music: listMusic(),
  });
});

app.put("/api/settings", (req, res) => {
  const { features, bandwidthGb, petName, handle, fontId, textStyle, textSize, aiMonthlyBudget, maxVideosPerDay, onlySituations, captionAudience, story, dailyMix, faq, instagramHandle, shotTags } = req.body ?? {};
  const fontOk = typeof fontId === "string" && listFonts().some((f) => f.id === fontId);
  const saved = store.updateSettings({
      ...(typeof petName === "string" && petName.trim() ? { petName: petName.trim().slice(0, 40) } : {}),
      ...(typeof handle === "string" ? { handle: handle.trim().slice(0, 40) } : {}),
      ...(fontOk ? { fontId } : {}),
      ...(["yellowbox", "yellow", "classic", "box", "plain"].includes(textStyle) ? { textStyle } : {}),
      ...(["small", "medium", "large"].includes(textSize) ? { textSize } : {}),
      ...(["pets", "mix", "everyone"].includes(captionAudience) ? { captionAudience } : {}),
      ...(typeof story === "string" ? { story: story.trim().slice(0, 2000) } : {}),
      ...(Array.isArray(shotTags) ? { shotTags: shotTags.filter((t): t is string => typeof t === "string" && Boolean(t.trim())).map((t) => t.trim().slice(0, 120)).slice(0, 60) } : {}),
      ...(typeof instagramHandle === "string" ? { instagramHandle: instagramHandle.trim().replace(/^@/, "").slice(0, 40) } : {}),
      ...(Array.isArray(faq)
        ? {
            faq: faq
              .map((f: any) => ({ q: String(f?.q ?? "").trim().slice(0, 200), a: String(f?.a ?? "").trim().slice(0, 1500) }))
              .filter((f: { q: string }) => f.q)
              .slice(0, 20),
          }
        : {}),
      ...(dailyMix && typeof dailyMix === "object"
        ? {
            dailyMix: {
              fun: clamp(Math.round(Number(dailyMix.fun) || 0), 0, 4),
              educational: clamp(Math.round(Number(dailyMix.educational) || 0), 0, 4),
              inspirational: clamp(Math.round(Number(dailyMix.inspirational) || 0), 0, 4),
            },
          }
        : {}),
      ...(features && typeof features === "object"
        ? { features: Object.fromEntries(FEATURES.map((f) => [f, !!(features as Record<string, unknown>)[f]])) }
        : {}),
      ...(Number.isFinite(Number(bandwidthGb)) && bandwidthGb !== "" && bandwidthGb !== undefined
        ? { bandwidthGb: clamp(Number(bandwidthGb), 1, 500) }
        : {}),
      ...(Number.isFinite(Number(aiMonthlyBudget)) && aiMonthlyBudget !== "" && aiMonthlyBudget !== undefined
        ? { aiMonthlyBudget: clamp(Number(aiMonthlyBudget), 0, 1000) }
        : {}),
      ...(typeof onlySituations === "boolean" ? { onlySituations } : {}),
      ...(Number(maxVideosPerDay) >= 1 ? { maxVideosPerDay: clamp(Math.round(Number(maxVideosPerDay)), 1, 30) } : {}),
  });
  // A round is the daily mix's candidates; the daily limit has to fit at least one round.
  if (dailyMix) {
    const size = mixSize(saved.dailyMix);
    store.updateAuto({ dailyCount: size });
    if (saved.maxVideosPerDay < size) store.updateSettings({ maxVideosPerDay: size });
  }
  res.json(store.settings());
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
  const paused = importPause();
  res.json(store.albums().map(({ seen, ...a }) => ({ ...a, seenCount: seen.length, importPaused: paused })));
});

app.post(
  "/api/albums",
  h(async (req, res) => {
    const album = addAlbum(String(req.body?.url ?? ""));
    // First check right away so videos start arriving. The album is saved already; if Google is
    // slow, answer anyway and let the check finish in the background.
    const sync = syncAlbum(album.id).catch((err: Error) => ({ error: err.message }));
    const result = await Promise.race([sync, new Promise<{ pending: true }>((r) => setTimeout(() => r({ pending: true }), 12_000))]);
    res.json({ album: store.album(album.id) ?? album, ...result });
  }),
);

app.post(
  "/api/albums/:id/sync",
  h(async (req, res) => {
    // Asked for by the creator (Check now, a new date range): read the album afresh.
    res.json(await syncAlbum(String(req.params.id), { reread: true }));
  }),
);

app.patch("/api/albums/:id", (req, res) => {
  const days = Number(req.body?.recentDays);
  if (!store.album(String(req.params.id))) return res.status(404).json({ error: "Unknown album" });
  if (Number.isFinite(days)) setRecentDays(String(req.params.id), days);
  res.json(store.album(String(req.params.id)));
});

/**
 * Start over: remove every album, clip and video (files included). Settings, situations, caption
 * research, examples and spending are kept.
 */
/**
 * Delete every made video, keep the clips (free to use again) and what reviews and post stats
 * taught the AI. The next round is made right after.
 */
function clearVideos(): number {
  const learned = reviewFeedback(30);
  const renders = [...store.renders()];
  for (const r of renders) deleteRender(r.id);
  for (const c of store.clips()) if (c.uses) store.updateClip(c.id, { uses: 0 });
  store.updateSettings({ pastFeedback: learned });
  store.updateAuto({ lastBatchDate: undefined });
  console.log(`[videos] deleted ${renders.length} video(s); clips kept and free to use again`);
  return renders.length;
}

/**
 * Everything about how one video was put together, to paste into a chat when something looks off:
 * the footage used (and how long each clip is), every piece of text with its timing and place, the
 * AI's choices, and the look. No file paths.
 */
app.get("/api/renders/:id/diagnostics", (req, res) => {
  const r = store.render(String(req.params.id));
  if (!r) return res.sendStatus(404);
  const p = r.plan;
  const round = (n: number | undefined) => (typeof n === "number" ? Math.round(n * 100) / 100 : n);
  const segments = p.segments.map((s) => {
    const c = store.clip(s.clipId);
    return {
      clip: s.clipId,
      from: round(s.start),
      to: round(s.end),
      speed: s.speed ?? 1,
      seconds: round((s.end - s.start) / (s.speed ?? 1)),
      clipLength: round(c?.duration),
      scene: c?.scene,
      filmed: c?.capturedAt?.slice(0, 10),
      clipSummary: c?.ai?.summary,
    };
  });
  const length = segments.reduce((a, s) => a + (s.seconds ?? 0), 0);
  res.json({
    app: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "local",
    madeWith: r.madeWith ?? "before versions were recorded",
    video: r.id,
    made: r.createdAt,
    status: r.status,
    error: r.error,
    review: r.review,
    rejectReason: r.rejectReason,
    rejectNote: r.rejectNote,
    kind: p.format,
    audience: p.audience,
    educational:
      p.format === "tips"
        ? {
            theme: p.pillar,
            format: p.eduFormat ?? "list",
            angle: p.angle,
            topic: p.topic,
            searchTopic: p.searchTopic ?? null,
            question: p.faq,
            // Whether search topics were available at all (Settings > What people search).
            searchTopicsLoaded: { tiktok: store.settings().searchTopics?.length ?? 0, google: store.settings().keywordTopics?.length ?? 0 },
          }
        : undefined,
    collab: p.collab?.name,
    length: round(length),
    renderedLength: round(r.duration),
    footage: segments,
    sameClipRepeated: segments.length !== new Set(segments.map((s) => `${s.clip}:${s.from}`)).size,
    text: (p.overlays ?? [{ text: p.hook, start: 0, end: length }]).map((o) => ({
      text: o.text,
      from: round(o.start),
      to: round(Math.min(o.end, length)),
      onScreen: round(Math.min(o.end, length) - o.start),
      place: o.y === undefined ? (o.at ?? "default") : { y: round(o.y), x: round(o.x) },
      arrowTo: o.pointTo,
    })),
    subjectBand: p.keepClear,
    hookBasedOn: p.basedOn,
    editorReview: r.editor ?? null,
    editorPasses: p.editorPass ?? 0,
    concept: p.concept,
    aiNote: p.aiNote,
    look: { style: r.options?.textStyle, size: r.options?.textSize, font: r.options?.fontId, music: Boolean(r.options?.musicFile) },
    description: p.postCaption,
    hashtags: p.hashtags,
  });
});

/** Proofread a video's text as a stranger would and re-make it if anything didn't add up. */
app.post(
  "/api/renders/:id/proofread",
  h(async (req, res) => {
    const r = store.render(String(req.params.id));
    if (!r) return res.sendStatus(404);
    const old = r.plan.overlays ?? [];
    if (!old.length) return res.json({ changed: false });
    const fixed = await proofreadText(old.map((o) => o.text), store.settings().petName, r.plan.format);
    if (fixed.every((t, i) => t === old[i].text)) return res.json({ changed: false });
    const overlays = old.map((o, i) => ({ ...o, text: fixed[i] }));
    // Corrected: back to Review for a fresh yes or no.
    const fresh = queueRender(healPlan({ ...r.plan, overlays, hook: overlays[0].text }, store.settings().cta?.site), r.options, r.batch, { countUse: false });
    deleteRender(r.id);
    res.json({ changed: true, render: fresh });
  }),
);

let refreshing = false;
app.post("/api/videos/refresh-design", (_req, res) => {
  if (refreshing) return res.json({ started: false });
  refreshing = true;
  refreshDesigns({ proofread: true })
    .catch((err) => console.error("[design]", err))
    .finally(() => (refreshing = false));
  res.json({ started: true });
});

app.post("/api/videos/clear", (req, res) => {
  if (req.body?.confirm !== "delete videos") return res.status(400).json({ error: "Confirmation missing." });
  const deleted = clearVideos();
  afterReview();
  res.json({ deleted });
});

app.post("/api/reset", (req, res) => {
  if (req.body?.confirm !== "start over") return res.status(400).json({ error: "Confirmation missing." });
  clearWaitingWork();
  for (const a of [...store.albums()]) store.removeAlbum(a.id);
  for (const d of [...store.drafts()]) store.removeDraft(d.id);
  for (const r of [...store.renders()]) deleteRender(r.id);
  for (const c of [...store.clips()]) deleteClip(c.id);
  // Anything left behind (half-finished downloads, old previews).
  for (const dir of [config.mediaDir, config.thumbsDir, config.rendersDir, config.tmpDir, path.join(config.dataDir, "voice")]) {
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  }
  store.updateAuto({ lastBatchDate: undefined });
  console.log("[reset] removed all albums, clips and videos");
  res.json({ ok: true });
});

app.delete("/api/albums/:id", (req, res) => {
  store.removeAlbum(String(req.params.id));
  res.json({ ok: true });
});

// ---- Daily batch -------------------------------------------------

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
    res.json(await runDailyBatch({ force: true, manual: true }));
  }),
);

// ---- Suggestions ----------------------------------------------------------

/** What the studio would make next: unused clips, rotating situations, with the caption it would likely adapt. */
app.get("/api/suggestions", (_req, res) => {
  const pending = new Set(
    store.renders().filter((r) => r.status === "queued" || r.status === "rendering").flatMap((r) => r.plan.segments.map((s) => s.clipId)),
  );
  const fresh = store.clips().filter((c) => c.status === "ready" && isPortrait(c) && c.uses === 0 && !c.disliked && onTopic(c) && !pending.has(c.id));
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

// ---- Themes: which kinds of footage go into videos ---------------------------------------

app.get("/api/themes", (_req, res) => {
  const { scenes, outsideThemes, themesOff } = store.settings();
  const clips = store.clips().filter((c) => c.status === "ready" && c.kind === "video");
  const row = (name: string) => ({
    name,
    on: !themesOff.includes(name),
    clips: clips.filter((c) => c.scene === name).length,
    unused: clips.filter((c) => c.scene === name && c.uses === 0).length,
  });
  const all = allScenes();
  // Places: the countries the footage was filmed in, from GPS or the AI's read (most clips first).
  const byCountry = new Map<string, typeof clips>();
  for (const c of clips) {
    const country = countryOf(c.place);
    if (country) byCountry.set(country, [...(byCountry.get(country) ?? []), c]);
  }
  const places = [...byCountry.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, cs]) => ({
      name,
      key: `place:${name}`,
      on: !themesOff.includes(`place:${name}`),
      clips: cs.length,
      unused: cs.filter((c) => c.uses === 0).length,
      cities: [...new Set(cs.map((c) => c.place!.split(",")[0].trim()).filter((x) => x !== name))].slice(0, 6),
    }));
  res.json({
    travel: scenes.map(row),
    outside: outsideThemes.map(row),
    places,
    located: clips.filter((c) => c.place).length,
    unsorted: clips.filter((c) => !c.scene || !all.includes(c.scene)).length,
  });
});

app.get(
  "/api/themes/suggestions",
  h(async (req, res) => {
    res.json(await suggestThemes(req.query.fresh === "1").catch(() => []));
  }),
);

let resorting = false;
const resortInBackground = () => {
  if (resorting) return;
  resorting = true;
  resortOther()
    .catch((err) => console.warn("[themes]", (err as Error).message))
    .finally(() => (resorting = false));
};

/**
 * Scan everything since a date: missing videos imported, clips without an AI look given one, and
 * clips filed as "other" sorted into the themes again.
 */
async function fullScan(since: number) {
  const { newItems } = await scanSince(since);
  const relooked = queueMissingAiLooks();
  resortInBackground();
  return { newItems, relooked };
}

app.post(
  "/api/albums/scan",
  h(async (req, res) => {
    const since = Date.parse(String(req.body?.since ?? ""));
    if (!Number.isFinite(since) || since > Date.now()) return void res.status(400).json({ error: "Pick a date in the past." });
    res.json(await fullScan(since));
  }),
);

app.put("/api/themes", (req, res) => {
  const b = req.body ?? {};
  const clean = (xs: unknown, lower = true) =>
    Array.isArray(xs)
      ? [...new Set(xs.map((x) => String(x).trim().slice(0, 60)).map((x) => (lower ? x.toLowerCase() : x)).filter((x) => x && x !== "other"))]
      : undefined;
  const outsideThemes = clean(b.outsideThemes)?.slice(0, 20);
  // (Places keep their capitals: "place:Portugal".)
  const themesOff = clean(b.themesOff, false)?.map((x) => (x.startsWith("place:") ? x : x.toLowerCase()));
  const before = store.settings().outsideThemes;
  store.updateSettings({ ...(outsideThemes ? { outsideThemes } : {}), ...(themesOff ? { themesOff } : {}) });
  // A new theme: unsorted clips get another look so it fills up.
  if (outsideThemes?.some((t) => !before.includes(t))) resortInBackground();
  res.json({ ok: true });
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
  // Most recently filmed first (import time when the filming date is unknown).
  const when = (c: Clip) => c.capturedAt ?? c.importedAt ?? "";
  res.json(
    store
      .clips()
      .filter((c) => c.status !== "archived")
      .sort((a, b) => when(b).localeCompare(when(a)))
      .map(({ energy, file, thumb, ...c }) => ({ ...c, energy })),
  );
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
  const { note, scene, edited } = req.body ?? {};
  const patch: Partial<Clip> = {};
  if (typeof edited === "boolean") Object.assign(patch, { edited, editedSetBy: "creator" as const });
  if (typeof note === "string") patch.note = note.trim().slice(0, 500) || undefined;
  if (typeof scene === "string") {
    if (scene && scene !== "other" && !allScenes().includes(scene)) return res.status(400).json({ error: "Unknown situation" });
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
  if (!fs.existsSync(clip.file)) return res.sendStatus(404);
  if (playbackPaused()) return res.status(429).json({ error: "This month's bandwidth is used up." });
  res.sendFile(previewFor(`clip-${clip.id}`, clip.file, 540) ?? clip.file);
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
    textStyle: ["yellowbox", "yellow", "classic", "box", "plain"].includes(body?.textStyle) ? body.textStyle : settings.textStyle,
    textSize: ["small", "medium", "large"].includes(body?.textSize) ? body.textSize : settings.textSize,
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
  // The creator's own corrections are kept as feedback for the next videos.
  if (planPatch.postCaption !== undefined) store.addEdit({ what: "caption", before: r.plan.postCaption ?? "", after: planPatch.postCaption, format: r.plan.format, scene: r.plan.scene });
  if (planPatch.hashtags) store.addEdit({ what: "hashtags", before: (r.plan.hashtags ?? []).join(" "), after: planPatch.hashtags.join(" "), format: r.plan.format, scene: r.plan.scene });
  const review = ["pending", "approved", "rejected"].includes(b.review) ? (b.review as Render["review"]) : undefined;
  const reason = ["text", "clip", "edit", "other"].includes(b.rejectReason) ? (b.rejectReason as RejectReason) : undefined;
  // A corrected description or hashtags on a video in Ready: back to Review for a fresh yes or no.
  const corrected = (planPatch.postCaption !== undefined && planPatch.postCaption !== r.plan.postCaption) ||
    (planPatch.hashtags !== undefined && planPatch.hashtags.join(" ") !== (r.plan.hashtags ?? []).join(" "));
  store.updateRender(r.id, {
    ...(corrected && !review && r.review === "approved" ? { review: "pending" as const } : {}),
    ...(review ? { review, reviewedAt: new Date().toISOString(), rejectReason: review === "rejected" ? reason ?? r.rejectReason : undefined } : {}),
    ...(review === undefined && reason && r.review === "rejected" ? { rejectReason: reason } : {}),
    ...(typeof b.rejectNote === "string" && (r.review === "rejected" || review === "rejected") ? { rejectNote: b.rejectNote.trim().slice(0, 500) || undefined } : {}),
    ...(b.downloaded === true ? { downloaded: true } : {}),
    plan: { ...r.plan, ...planPatch },
  });
  // "Bad clip": stop picking that footage automatically. Undoing the rejection brings it back.
  const now = store.render(r.id)!;
  const clipIds = [...new Set(r.plan.segments.map((s) => s.clipId))];
  if (now.review === "rejected" && now.rejectReason === "clip") for (const id of clipIds) store.updateClip(id, { disliked: true });
  else if (r.rejectReason === "clip") for (const id of clipIds) store.updateClip(id, { disliked: false });
  syncClipUses(r.id);
  // A reason given for a rejection: a new version that fixes it, right away. Without one, the day's
  // set makes another of its kind a minute later (see daySet.ts).
  // The kind's spare steps in at once, so the next video is already there.
  if (now.review === "rejected") promoteSpares();
  if (now.review === "rejected" && now.rejectReason && !now.remadeAs) remakeRejected(r.id).catch((err) => console.warn("[remake]", err));
  // Last video of the round reviewed: start the next round.
  if (review && review !== "pending") afterReview();
  res.json(store.render(r.id));
});

app.post(
  "/api/renders/:id/redo-editor",
  h(async (req, res) => {
    res.json(await redoFromEditor(String(req.params.id)));
  }),
);

app.post("/api/renders/:id/retry", (req, res) => {
  const r = retryRender(String(req.params.id));
  if (!r) return res.sendStatus(404);
  res.json(r);
});

// ---- Brand partners & collab versions ----------------------------------------

const handleOf = (v: unknown) => {
  const t = String(v ?? "").trim().replace(/\s+/g, "");
  return t ? (t.startsWith("@") ? t : `@${t}`).slice(0, 60) : undefined;
};

app.get("/api/partners", (_req, res) => res.json(store.partners()));

app.post("/api/partners", (req, res) => {
  const b = req.body ?? {};
  const name = String(b.name ?? "").trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: "Give the brand a name." });
  const existing = b.id ? store.partner(String(b.id)) : undefined;
  res.json(
    store.savePartner({
      id: existing?.id ?? newId(),
      name,
      handle: handleOf(b.handle),
      about: String(b.about ?? "").trim().slice(0, 1500),
      mustInclude: String(b.mustInclude ?? "").trim().slice(0, 500) || undefined,
    }),
  );
});

app.post(
  "/api/partners/:id/collab",
  h(async (req, res) => {
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) || undefined : undefined;
    res.json(await makeCollabFromLibrary(String(req.params.id), note));
  }),
);

app.delete("/api/partners/:id", (req, res) => {
  store.removePartner(String(req.params.id));
  res.json({ ok: true });
});

/** The creator posted this video: keep the link and fetch its stats (refreshed daily for two weeks). */
app.post(
  "/api/renders/:id/posted",
  h(async (req, res) => {
    const r = store.render(String(req.params.id));
    if (!r) return res.sendStatus(404);
    const url = String(req.body?.url ?? "").trim();
    const asked = req.body?.platform === "instagram" ? "instagram" : req.body?.platform === "tiktok" ? "tiktok" : undefined;
    const posts = r.posts ?? [];
    if (!url) {
      // Clearing a link.
      store.updateRender(r.id, { posts: posts.filter((p) => p.platform !== asked) });
      return res.json(store.render(r.id));
    }
    const platform = platformOf(url);
    if (!platform) return res.status(400).json({ error: "Paste the link of the post on TikTok (tiktok.com/…) or Instagram (instagram.com/reel/…)." });
    if (asked && asked !== platform) return res.status(400).json({ error: `That's ${platform === "tiktok" ? "a TikTok" : "an Instagram"} link; paste it in the ${platform === "tiktok" ? "TikTok" : "Instagram"} box.` });
    if (posts.find((p) => p.platform === platform)?.url !== url) {
      store.updateRender(r.id, { posts: [...posts.filter((p) => p.platform !== platform), { platform, url, addedAt: new Date().toISOString() }] });
    }
    try {
      res.json(await refreshPostStats(r.id, platform));
    } catch (err) {
      res.json({ ...store.render(r.id), warning: (err as Error).message });
    }
  }),
);

app.post(
  "/api/story",
  h(async (req, res) => {
    const seconds = clamp(Math.round(Number(req.body?.seconds) || 20), 10, 45);
    res.json(await makeStoryVideo(String(req.body?.storyline ?? "").slice(0, 2000), seconds));
  }),
);

// ---- What people search (TikTok search analytics) ---------------------------------------

app.get("/api/search-demand", (_req, res) => {
  const { searchTopicsAt, keywordTopicsAt, audience } = store.settings();
  res.json({
    at: searchTopicsAt ?? null,
    googleAt: keywordTopicsAt ?? null,
    audience: audience ? { at: audience.at, days: audience.days, posts: audience.posts, commentsRead: audience.commentsRead, questions: audience.questions.length, topPosts: audience.topPosts } : null,
    topics: allSearchTopics().map((t) => ({ ...t, used: searchTopicUsed(t) })),
  });
});

app.post(
  "/api/search-demand",
  upload.single("file"),
  h(async (req, res) => {
    if (!req.file) return void res.status(400).json({ error: "No file" });
    try {
      res.json(await importSearchExport(fs.readFileSync(req.file.path), req.file.originalname));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    } finally {
      fs.rmSync(req.file.path, { force: true });
    }
  }),
);

app.post(
  "/api/audience/learn",
  h(async (req, res) => {
    const days = Math.max(7, Math.min(365, Math.round(Number(req.body?.days) || 90)));
    try {
      const a = await learnFromTikTok(days);
      res.json({ posts: a.posts, questions: a.questions.length, topics: a.topics.length });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }),
);

/** Posts that worked well, by their links: linked to their videos so the AI learns from them. */
app.post(
  "/api/posts/winners",
  h(async (req, res) => {
    const urls = Array.isArray(req.body?.urls) ? req.body.urls.map(String) : String(req.body?.urls ?? "").split(/\s+/);
    try {
      res.json(await linkWinningPosts(urls.filter(Boolean).slice(0, 20)));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }),
);

// ---- Day vlogs (only on request) --------------------------------------------------------

app.get("/api/vlog/days", (_req, res) => {
  const made = [...new Set(store.renders().map((r) => r.plan.vlogDay).filter(Boolean))];
  res.json({ days: vlogDays().slice(0, 60), made });
});

/** All of a day's clips, to look at and keep or drop before the vlog is made (no AI needed). */
app.get("/api/vlog/day/:day", (req, res) => {
  const day = String(req.params.day);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return void res.status(400).json({ error: "Pick a day." });
  res.json(dayClips(day).map((c) => ({ id: c.id, duration: c.duration, filmed: c.capturedAt, place: c.place, summary: c.ai?.summary, scene: c.scene })));
});

/** The moments the AI would use for a day's vlog, to look at and change before it's made. */
app.post(
  "/api/vlog/propose",
  h(async (req, res) => {
    const day = String(req.body?.day ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return void res.status(400).json({ error: "Pick a day." });
    if (!config.claude.enabled) return void res.status(400).json({ error: "Day vlogs need the AI (ANTHROPIC_API_KEY)." });
    res.json(await proposeDayVlog(day));
  }),
);

app.post(
  "/api/vlog",
  h(async (req, res) => {
    const day = String(req.body?.day ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return void res.status(400).json({ error: "Pick a day." });
    // A proposal the creator went through: their moments (only clips of that day), their words.
    const p = req.body?.proposal;
    let proposal: VlogProposal | undefined;
    if (p && Array.isArray(p.moments)) {
      const str = (v: unknown, n: number) => String(v ?? "").slice(0, n);
      proposal = {
        day,
        title: str(p.title, 120),
        hook: str(p.hook, 120),
        postCaption: str(p.postCaption, 2200),
        hashtags: Array.isArray(p.hashtags) ? p.hashtags.map((x: unknown) => str(x, 40)).slice(0, 3) : [],
        moments: p.moments
          .filter((m: any) => store.clip(String(m?.clipId))?.capturedAt?.startsWith(day))
          .slice(0, 20)
          .map((m: any) => ({ clipId: String(m.clipId), start: Math.max(0, Number(m.start) || 0), end: Math.max(0, Number(m.end) || 0), text: str(m.text, 80), use: !!m.use })),
        others: [],
      };
    }
    const clipIds = Array.isArray(req.body?.clipIds) ? req.body.clipIds.map(String).slice(0, 40) : undefined;
    try {
      res.json(await makeDayVlog(day, 30, proposal, clipIds));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }),
);

// ---- Voiceover stories --------------------------------------------------------------

app.post(
  "/api/story/drafts",
  h(async (req, res) => {
    const mode = req.body?.mode === "talk" ? "talk" : "script";
    const partnerId = typeof req.body?.partnerId === "string" && req.body.partnerId ? req.body.partnerId : undefined;
    res.json(draftView(await createVoiceDraft(mode, String(req.body?.text ?? "").slice(0, 5000), partnerId)));
  }),
);

app.get("/api/story/drafts/:id", (req, res) => {
  const d = store.draft(String(req.params.id));
  if (!d) return res.sendStatus(404);
  res.json(draftView(d));
});

app.get("/api/story/drafts/:id/lines/:i/audio", (req, res) => {
  const line = store.draft(String(req.params.id))?.lines[Number(req.params.i)];
  if (!line?.audio || !fs.existsSync(line.audio)) return res.sendStatus(404);
  res.sendFile(line.audio);
});

const draftView = (d: StoryDraft) => ({ ...d, lines: d.lines.map(({ audio, ...l }) => ({ ...l, recorded: Boolean(audio) })) });

app.post(
  "/api/story/drafts/:id/lines/:i/audio",
  upload.single("file"),
  h(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No recording received." });
    res.json(draftView(await saveLineRecording(String(req.params.id), Number(req.params.i), req.file.path)));
  }),
);

app.post(
  "/api/story/drafts/:id/speak",
  h(async (req, res) => {
    res.json(draftView(await speakDraft(String(req.params.id), req.body?.all === true)));
  }),
);

// ---- The creator's cloned voice --------------------------------------------------------

app.get("/api/voice", (_req, res) => {
  res.json({ enabled: voiceCloningEnabled(), voice: store.settings().voice ?? null });
});

app.post(
  "/api/voice",
  upload.array("files", 5),
  h(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) return res.status(400).json({ error: "No recording received." });
    res.json(await createVoice(files.map((f) => f.path)));
  }),
);

app.delete(
  "/api/voice",
  h(async (_req, res) => {
    await removeVoice();
    res.json({ ok: true });
  }),
);

app.patch("/api/story/drafts/:id/lines/:i", (req, res) => {
  try {
    res.json(draftView(setLineClip(String(req.params.id), Number(req.params.i), String(req.body?.clipId ?? ""))));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post("/api/story/drafts/:id/render", (req, res) => {
  try {
    res.json(renderDraft(String(req.params.id), req.body?.voice !== false));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post(
  "/api/renders/:id/caption",
  h(async (req, res) => {
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) || undefined : undefined;
    res.json(await regenerateCaption(String(req.params.id), note));
  }),
);

app.post(
  "/api/renders/:id/collab",
  h(async (req, res) => {
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) || undefined : undefined;
    res.json(await makeCollabVersion(String(req.params.id), String(req.body?.partnerId ?? ""), note));
  }),
);

/** Change the on-screen text and render again; replaces the old version. */
app.post("/api/renders/:id/rerender", (req, res) => {
  const r = store.render(String(req.params.id));
  if (!r) return res.sendStatus(404);
  if (!r.plan.segments.every((s) => store.clip(s.clipId))) return res.status(400).json({ error: "A source clip was deleted." });
  const b = req.body ?? {};
  // Overlay edits arrive as the lines of text, one per piece of text on the video.
  const texts: string[] | undefined = Array.isArray(b.overlays) ? b.overlays.map((t: unknown) => String(t).trim()).filter(Boolean) : undefined;
  let segments = r.plan.segments;
  let overlays = r.plan.overlays;
  if (texts?.length) {
    const old = r.plan.overlays ?? [];
    store.addEdit({ what: "text", before: (old.length ? old.map((o) => o.text) : [r.plan.hook]).join("\n"), after: texts.join("\n"), format: r.plan.format, scene: r.plan.scene });
    const total = segments.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
    if (texts.length === old.length) {
      // Same pieces of text, reworded: same timing and places.
      overlays = old.map((o, i) => ({ ...o, text: texts[i] }));
    } else {
      // Lines added or removed: lay the text out again (hook on top, the points one after another in
      // different spots), with the footage made long enough to read it all.
      const need = texts.length > 1 ? readingSeconds(texts.length - 1) : total;
      if (need > total + 0.3) segments = lengthenFootage(segments, need, (id) => store.clip(id)?.duration ?? 0);
      const length = segments.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
      overlays = texts.length > 1 ? layoutPoints(texts, length) : [{ text: texts[0], start: 0, end: length + 1 }];
    }
  } else if (overlays?.length && typeof b.hook === "string") {
    overlays = overlays.map((o, i) => (i === 0 ? { ...o, text: b.hook } : o));
  }
  // Only the edited parts need checking; everything else (kind, voiceover, collab…) is kept as it was.
  const clean = sanitizePlan({ ...r.plan, segments, overlays });
  const next: VideoPlan = {
    ...r.plan,
    segments: clean.segments,
    overlays: clean.overlays,
    hook: overlays?.[0]?.text ?? (typeof b.hook === "string" ? b.hook : texts?.[0] ?? r.plan.hook),
    postCaption: typeof b.postCaption === "string" ? b.postCaption.slice(0, 2200) : r.plan.postCaption,
  };
  // The new version keeps the clips taken, even if the old one was rejected and had handed them back.
  if (r.usesReturned) {
    store.updateRender(r.id, { review: "pending" });
    syncClipUses(r.id);
  }
  const options = { ...r.options, ...parseOptions({ ...r.options, ...(b.options ?? {}) }) };
  // Keep the video's music unless a different track was picked.
  if (!b.options?.musicId) options.musicFile = r.options.musicFile;
  // A corrected video comes back to Review for a fresh yes or no, even if it was in Ready.
  // Re-made under today's rules (footage played at most twice, points spread and timed, call to action last).
  // The creator's own edit: no editor's review to second-guess it.
  const fresh = queueRender(healPlan({ ...next, editorPass: EDITOR_ATTEMPTS }, store.settings().cta?.site), options, r.batch, { countUse: false });
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
  // The month's bandwidth: playing stops first, downloads and shares only at the very end.
  if (mediaStopped() || (!req.query.dl && !req.query.full && playbackPaused())) return res.status(429).json({ error: "This month's bandwidth is used up." });
  if (req.query.dl) {
    const name = `${store.settings().petName}-${r.plan.title}`.replace(/[^\w\- ]/g, "").slice(0, 60).trim() || r.id;
    return res.download(r.file, `${name}.mp4`);
  }
  // Watching in the app: the light copy (?full=1 for the original, e.g. to share to TikTok).
  const file = req.query.full ? r.file : (previewFor(`render-${r.id}`, r.file) ?? r.file);
  res.sendFile(file);
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
          .map((o) => ({
            text: str(o?.text, 160),
            start: clamp(Number(o?.start) || 0, 0, 120),
            end: clamp(Number(o?.end) || 0, 0, 121),
            ...(o?.at === "caption" ? { at: "caption" as const } : {}),
            ...(Number.isFinite(o?.y) ? { y: clamp(Number(o!.y), 0.05, 0.95) } : {}),
            ...(Number.isFinite(o?.x) ? { x: clamp(Number(o!.x), 0.05, 0.95) } : {}),
            ...(o?.pointTo && Number.isFinite(o.pointTo.x) && Number.isFinite(o.pointTo.y)
              ? { pointTo: { x: clamp(o.pointTo.x, 0, 1), y: clamp(o.pointTo.y, 0, 1) } }
              : {}),
          }))
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

// ---- One-time fresh start (asked for by the creator) -------------------------
//
// Every made video is deleted and the footage is free to use again; the clips themselves stay.
// What was learned from reviews and post stats is kept for the AI. From here: 3 videos a day,
// one fun, one educational, one inspirational.
if (!store.settings().freshStartV1 && !store.renders().length && !store.clips().length) {
  store.updateSettings({ freshStartV1: true }); // a new install: nothing to clear
} else if (!store.settings().freshStartV1) {
  const learned = reviewFeedback(30);
  const n = store.renders().length;
  for (const r of store.renders()) deleteRender(r.id);
  for (const c of store.clips()) if (c.uses) store.updateClip(c.id, { uses: 0 });
  store.updateSettings({
    freshStartV1: true,
    yellowBoxRemade: true,
    pastFeedback: learned,
    dailyMix: { fun: 1, educational: 1, inspirational: 1 },
    maxVideosPerDay: 3,
  });
  store.updateAuto({ dailyCount: 3, lastBatchDate: undefined });
  console.log(`[fresh start] deleted ${n} video(s); clips kept and free to use again; 3 a day from now`);
}

// Fresh start, asked for by the creator on Oct 20: every made video goes (what was learned from
// reviews, edits and post stats is kept for the AI), the clips stay and are free to use again, the
// day's counters start over, and a new day's set follows. The one-off remakes of old videos are moot.
if (!store.settings().freshStartV4) {
  const n = store.renders().length ? clearVideos() : 0;
  store.updateSettings({ freshStartV4: true, countFrom: new Date().toISOString(), remakeLayoverV1: true, remakePottyV1: true });
  console.log(`[fresh start] ${n} video(s) deleted; starting over`);
}

// Once: spares switched off (Oct 20): the ones not started yet are dropped (finished ones can still step in).
if (!store.settings().sparesOffV1) {
  store.updateSettings({ sparesOffV1: true });
  const queued = store.renders().filter((r) => r.standby && r.status === "queued");
  for (const r of queued) deleteRender(r.id);
  if (queued.length) console.log(`[spares] dropped ${queued.length} spare(s) not started yet`);
}

// Second fresh start, asked for by the creator: all videos again, clips stay, 3 new ones follow.
if (!store.settings().freshStartV3) {
  if (store.renders().length) clearVideos();
  store.updateSettings({ freshStartV2: true, freshStartV3: true, yellowBoxRemade: true, yellowBoxRemadeV2: true, designRefreshV3: true });
}

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
      flushBandwidth();
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

// The same video imported from two albums before duplicates were caught: use it only once.
const duplicates = markDuplicates();
if (duplicates) console.log(`[albums] set aside ${duplicates} duplicate clip(s)`);

// A remake that was being written when the server stopped (a deploy) never finishes: clear it, so
// its kind isn't treated as "being made" forever and a new one of the kind is made.
for (const r of store.renders()) {
  if (r.remadeAs === "pending") {
    console.log(`[recovery] remake of ${r.id} (${r.plan.format}) was cut off by a restart; its kind is made again`);
    store.updateRender(r.id, { remadeAs: undefined });
  }
}

// Videos rejected before clips were handed back on rejection: hand them back now.
for (const r of store.renders()) syncClipUses(r.id);

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
  // Unused clips whose AI look is missing (it failed, or ran before situations or edited-video
  // checks existed): look again (a tenth of a cent each).
  if (config.claude.enabled) queueMissingAiLooks(Infinity, crashedIds);
  // Interrupted videos go ahead of all of that: they're what the creator is waiting for.
  // (A video that crashed the server is in crashedIds and isn't retried.)
  for (const r of store.renders()) {
    if (!crashedIds.has(r.id) && (r.status === "queued" || r.status === "rendering")) retryRender(r.id);
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

// The yellow box is the look for every video: ones made before it became the default, still waiting
// for review or for posting, are re-made in it once (same footage, text and music).
if (!paused && !store.settings().yellowBoxRemadeV2) {
  let n = 0;
  for (const r of store.renders()) {
    if (r.status !== "done" || r.options.textStyle === "yellowbox" || r.posts?.length || r.plan.voiceover?.length) continue;
    if (r.review !== "pending" && r.review !== "approved") continue;
    if (!r.plan.segments.every((s) => store.clip(s.clipId)?.status === "ready")) continue;
    const fresh = queueRender(r.plan, { ...r.options, textStyle: "yellowbox", fontId: "montserrat" }, r.batch, { countUse: false });
    if (r.review === "approved") store.updateRender(fresh.id, { review: "approved", reviewedAt: r.reviewedAt });
    deleteRender(r.id);
    n++;
  }
  store.updateSettings({ yellowBoxRemade: true, yellowBoxRemadeV2: true });
  if (n) console.log(`[look] re-making ${n} video(s) in the yellow box`);
}

startScheduler();

// Once: clips already imported get their place from the GPS position in their files.
if (!store.settings().geoV1) {
  store.updateSettings({ geoV1: true });
  setTimeout(() => locateAll().catch((err) => console.warn("[geo]", (err as Error).message)), 60_000);
}

// Once: clips sorted as "other" before the outside themes existed are sorted into them.
if (!store.settings().themesV1) {
  store.updateSettings({ themesV1: true });
  setTimeout(resortInBackground, 30_000);
}

// Once: educational videos already made get the call to action at the end (same text and description).
if (!paused && !store.settings().ctaAddedV1) {
  store.updateSettings({ ctaAddedV1: true, zigzagV1: true }); // the call to action pass zig-zags the points too
  addCtaToExisting();
}
// Once: and their points zig-zag over the frame.
// (Runs for videos the call to action pass already re-made; ones it re-makes now already zig-zag.)
if (!paused && !store.settings().zigzagV2) {
  store.updateSettings({ zigzagV1: true, zigzagV2: true });
  zigzagExisting();
}

// Once: spares (one per kind on standby) and the editor's attempts make more videos a day; the
// safety cap goes from 15 to 24 (left alone if the creator changed it).
if (!store.settings().sparesCapV1) {
  store.updateSettings({ sparesCapV1: true, ...(store.settings().maxVideosPerDay === 15 ? { maxVideosPerDay: 24 } : {}) });
}

// Once: videos made while the AI was out of credit are only pasted trending captions (the same one
// again and again); the ones not reviewed yet go, and the day's set makes proper ones once credit is back.
if (!store.settings().fallbackCleanupV1) {
  store.updateSettings({ fallbackCleanupV1: true });
  const junk = store.renders().filter((r) => r.plan.aiNote && r.review === "pending");
  for (const r of junk) deleteRender(r.id);
  if (junk.length) console.log(`[cleanup] removed ${junk.length} video(s) made without the AI`);
}

// Once: the creator asked for the layover potty video (90c66a3b51308243) to be fixed: points that
// answer "where", footage that shows them (their pee pad clip), a stronger opening. Back to Review.
if (!paused && !store.settings().remakeLayoverV1) {
  store.updateSettings({ remakeLayoverV1: true });
  const id = "90c66a3b51308243";
  const r = store.render(id);
  if (r && !r.remadeAs) {
    store.updateRender(id, {
      review: "rejected",
      reviewedAt: new Date().toISOString(),
      rejectReason: "clip",
      rejectNote:
        "Every point must answer the headline's question directly, with a place (where do dogs pee: a pet relief area, " +
        "outside before check-in, a pee pad in the carrier). Show each answer: use the clip with the pee pad for the pee " +
        "pad point, and any clip of Lex outside or at a relief area. Open on a bright, moving shot, not a dim static one.",
    });
    setTimeout(() => remakeRejected(id, { force: true }).catch((err) => console.warn("[remake]", err)), 30_000);
  }
}

// Once: two reels the creator said worked well (Oct 20), linked to their videos.
if (!paused && !store.settings().winnersV1 && apifyEnabled()) {
  store.updateSettings({ winnersV1: true });
  setTimeout(
    () =>
      linkWinningPosts(["https://www.instagram.com/reel/Def6HCLR_aQ/", "https://www.instagram.com/reel/DerVsbCxe6R/"]).catch((err) =>
        console.warn("[posts] winners:", (err as Error).message),
      ),
    90_000,
  );
}

// Once: the creator's Instagram reels of Oct 22 linked to their videos (views, likes, saves read by
// Apify), with the 3-second hold from their reel insights; and their TikTok read again.
if (!paused && !store.settings().insightsOct22 && apifyEnabled()) {
  store.updateSettings({ insightsOct22: true });
  const reels = ["Dexv6jHRYnW", "DexCTblNFbH", "Deu9ithxNk1", "DeubiOkt4sj", "DeqcqX8tMS8", "DepU3yStTb0", "Dekllw9thWi", "Def6HCLR_aQ", "Dec9DtVRO0X"];
  const held: [RegExp, number][] = [
    [/how do dogs get into another country/i, 0.62],
    [/what do airlines check before a dog flies/i, 0.7],
    [/pretending i belong in the priority line/i, 0.68],
    [/do these 3 things with the airline/i, 0.63],
    [/spending the night in the airport/i, 0.62],
    [/plane hits turbulence/i, 0.7],
    [/every sleeping position in economy/i, 0.8],
    [/crew wanted a photo/i, 0.71],
  ];
  setTimeout(async () => {
    await linkWinningPosts(reels.map((id) => `https://www.instagram.com/reel/${id}/`)).catch((err) => console.warn("[posts] reels:", (err as Error).message));
    for (const r of store.renders()) {
      const hold = held.find(([re]) => re.test(r.plan.hook ?? ""))?.[1];
      const ig = (r.posts ?? []).find((p) => p.platform === "instagram");
      if (hold === undefined || !ig) continue;
      store.updateRender(r.id, { posts: (r.posts ?? []).map((p) => (p === ig ? { ...p, stats: { ...(p.stats ?? { views: 0 }), held3s: hold } } : p)) });
    }
    await syncProfiles().catch((err) => console.warn("[posts] profiles:", (err as Error).message));
    console.log("[posts] Oct 22 reel insights linked");
  }, 90_000);
}

// Once: the creator asked to read their TikTok (90 days of posts and comments) right away.
if (!paused && !store.settings().audienceFirstRead && apifyEnabled() && store.settings().handle?.trim()) {
  store.updateSettings({ audienceFirstRead: true });
  setTimeout(() => learnFromTikTok(90).catch((err) => console.warn("[audience] first read:", (err as Error).message)), 120_000);
}

// Once: everything filmed since September 10 into the library (the creator asked for a full scan).
if (!paused && !store.settings().scanSinceSep10) {
  store.updateSettings({ scanSinceSep10: true });
  setTimeout(() => fullScan(Date.parse("2026-09-10T00:00:00")).catch((err) => console.warn("[albums] full scan:", (err as Error).message)), 45_000);
}

// Once: the creator wants as much footage as possible. Every album covers the last year (was 30-60
// days), and everything filmed in that year that isn't in the library is imported now, newest first,
// not held to the daily cap (the disk guard still pauses it when space runs low).
if (!paused && !store.settings().heavyImportV1) {
  store.updateSettings({ heavyImportV1: true });
  for (const a of store.albums()) if ((a.recentDays ?? 0) > 0 && (a.recentDays ?? 0) < 365) setRecentDays(a.id, 365);
  setTimeout(() => fullScan(Date.now() - 365 * 86400_000).catch((err) => console.warn("[albums] heavy import:", (err as Error).message)), 60_000);
}

// Once: the creator asked for the airport potty video (34d625ab05316488) to be made again: same first
// clip, footage that shows each point, text off Lex's face, a short hook. It goes back to Review.
if (!paused && !store.settings().remakePottyV1) {
  store.updateSettings({ remakePottyV1: true });
  const id = "34d625ab05316488";
  const r = store.render(id);
  if (r && !r.remadeAs) {
    store.updateRender(id, {
      review: "rejected",
      reviewedAt: new Date().toISOString(),
      rejectReason: "other",
      rejectNote:
        "Keep the first clip, but the points are about peeing and pooping: show footage of that (Lex walking outside the " +
        "airport, a potty break), not only the inside of the plane. Keep the text off Lex's face. The hook must be much " +
        "shorter and snappier and speak to the viewer (like \"Flying with a dog? Potty first\"), never \"people always ask\".",
    });
    setTimeout(() => remakeRejected(id, { force: true }).catch((err) => console.warn("[remake]", err)), 20_000);
  }
}

// Once: this month's bandwidth before the counter existed (Render: over 70% of 5 GB by Oct 19).
if (!store.settings().bandwidthSeedV1) {
  store.updateSettings({ bandwidthSeedV1: true });
  seedBandwidth("2026-10", 3.6e9);
}
setInterval(flushBandwidth, 60_000).unref();

// Once: the counters start over now. From here a day runs until one of each kind is kept (with a
// safety cap of 15 videos a day), starting at midnight.
if (!store.settings().countersResetV1) {
  store.updateSettings({ countersResetV1: true, countFrom: new Date().toISOString(), maxVideosPerDay: 15, dailyMix: { fun: 1, educational: 1, inspirational: 1 } });
  store.updateAuto({ lastBatchDate: undefined });
}

// Once: every day one educational, one fun and one inspirational video, and no more.
if (!store.settings().mixV2) store.updateSettings({ mixV2: true, dailyMix: { fun: 1, educational: 1, inspirational: 1 } });

// Once: the call to action (flywith.pet) centered in videos waiting or kept.
// Once: educational videos waiting in Review open on the strongest footage (asked for by the creator).
if (!paused && !store.settings().openerV1) {
  store.updateSettings({ openerV1: true });
  openerExisting();
}

// Once: the call to action reads "at www.flywith.pet" (no "link in bio"), also in videos waiting or kept.
if (!paused && !store.settings().ctaWwwV1) {
  const cta = store.settings().cta;
  if (cta && /link in bio/i.test(cta.overlay)) store.updateSettings({ cta: { ...cta, overlay: "Plan your pet's trip / at www.flywith.pet" } });
  store.updateSettings({ ctaWwwV1: true, ctaCenterV1: true });
  ctaCenterExisting();
}

// Once: educational videos waiting get the numbered-point look (number tab, one width, hook as header).
if (!paused && !store.settings().numberTabsV1) {
  store.updateSettings({ numberTabsV1: true });
  numberTabsExisting();
}

// Once: videos already made get the new look (smaller text, kept off the subject, no overlaps).
if (!paused && !store.settings().designRefreshV4) {
  store.updateSettings({ designRefreshV1: true, designRefreshV2: true, designRefreshV3: true, designRefreshV4: true });
  refreshing = true;
  refreshDesigns({ proofread: true })
    .catch((err) => console.error("[design]", err))
    .finally(() => (refreshing = false));
}

// Hosted: on all interfaces, behind Google sign-in (locked until it is set up).
const host = listenHost;
if (lockedOut) console.error("Google sign-in isn't set up (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAILS): the app is locked, nobody can sign in.");
app.listen(config.port, host, () => {
  console.log(`Rollcut running at ${config.appUrl}`);
  console.log(`  Google Photos: ${googleConfigured() ? "configured" : "not configured (set GOOGLE_CLIENT_ID/SECRET)"}`);
  console.log(`  AI director:   ${config.claude.enabled ? config.claude.model : "off (set ANTHROPIC_API_KEY)"}`);
  console.log(`  Sign-in:       ${googleLogin ? "Google (allowed accounts only)" : gateEnabled ? "locked (Google sign-in not set up)" : "off (local only)"}`);
});
