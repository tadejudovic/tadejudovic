import fs from "node:fs";
import path from "node:path";
import { cloneVoice, deleteVoice, speak } from "./voice/elevenlabs.ts";
import { config } from "./config.ts";
import { localDate, MANUAL_EXTRA, videosLeftToday } from "./dailyLimit.ts";
import { promoteSpares, sparesOf, waitingOf } from "./daySet.ts";
import { momentsOf, recentlyUsedMoments } from "./moments.ts";
import { featureOn, store, newId } from "./store.ts";
import { heuristicPlan, stretchToTarget } from "./planner.ts";
import { directClip, planVideos, proofreadText, withOpener, writeCaption, type DirectContext } from "./ai/director.ts";
import { provenCaptions, researchedHashtags, researchScene, researchStale } from "./ai/research.ts";
import { basePath, baseKey, renderVideo } from "./media/render.ts";
import { ingestQueue, renderQueue, PRIORITY } from "./queue.ts";
import type { Clip, DailyMix, EduPillar, GenerateRequest, Overlay, Partner, Platform, PostedInfo, PostFormat, Render, ReviewFeedback, StoryDraft, VideoPlan } from "./types.ts";
import { findClipFor } from "./ai/collabPick.ts";
import { detectSubject } from "./ai/subject.ts";
import { aiAvailable } from "./ai/budget.ts";
import { healPlan, lengthenFootage, spreadPoints } from "./overlayLayout.ts";
import { countryOf } from "./geo.ts";
import { buildDayVlog, planDayVlog, type VlogProposal } from "./ai/vlog.ts";
import { searchTopicsFor } from "./searchDemand.ts";
import { basicChecks } from "./checks.ts";
import { reviewVideo, type EditorVerdict } from "./ai/editor.ts";
import { previewFor, removePreview } from "./media/preview.ts";
import { parseShots, planFromDraft, planStory, planVoiceDraft } from "./ai/story.ts";
import { run, probe } from "./media/ffmpeg.ts";
import { apifyEnabled, fetchPostStats } from "./ai/tiktokSearch.ts";

function applyHashtags(p: VideoPlan, scene: string | undefined) {
  const info = researchedHashtags(scene);
  if (!info.length) return;
  p.hashtags = withResearchedTags(info.map((h) => h.tag), p.hashtags);
  p.hashtagInfo = info;
}

/** Exactly three hashtags: the researched ones (big, mid, small), topped up from the AI's if fewer were found. */
export function withResearchedTags(researched: string[], fallback: string[]): string[] {
  const out = [...researched];
  for (const t of fallback) if (out.length < 3 && !out.includes(t.toLowerCase())) out.push(t.toLowerCase());
  return out.slice(0, 3);
}

/**
 * What the creator kept and swiped away recently, so the director learns their taste:
 * overlay text, situation and (for rejections) what was wrong.
 */
export function reviewFeedback(limit = 15): ReviewFeedback {
  const reviewed = store
    .renders()
    .filter((r) => r.review !== "pending" && r.status === "done" && r.plan.hook && !r.rejectedBy)
    .sort((a, b) => Date.parse(b.reviewedAt ?? b.createdAt) - Date.parse(a.reviewedAt ?? a.createdAt));
  const item = (r: Render) => ({
    text: r.plan.overlays?.map((o) => o.text).join(" / ") || r.plan.hook,
    scene: r.plan.scene,
    basedOn: r.plan.basedOn?.text,
    format: r.plan.format,
  });
  // How posted videos actually did: the strongest signal. Best and worst, so both lessons come through.
  // One entry per post (a video on TikTok and Instagram counts twice: the platforms differ).
  const posted = store
    .renders()
    .filter((r) => r.plan.hook)
    .flatMap((r) => (r.posts ?? []).filter((p) => p.stats).map((p) => ({ r, p })))
    .sort((a, b) => b.p.stats!.views - a.p.stats!.views);
  const ranked = posted.length > 10 ? [...posted.slice(0, 6), ...posted.slice(-4)] : posted;
  // Lessons from before the fresh start come after the newer ones.
  const past = store.settings().pastFeedback;
  return {
    edits: store.edits().slice(0, 12),
    kept: [...reviewed.filter((r) => r.review === "approved").map(item), ...(past?.kept ?? [])].slice(0, limit),
    rejected: [
      ...reviewed.filter((r) => r.review === "rejected").map((r) => ({ ...item(r), reason: r.rejectReason, note: r.rejectNote })),
      ...(past?.rejected ?? []),
    ].slice(0, limit),
    performance: [...ranked.map(({ r, p }) => ({ ...item(r), platform: p.platform, ...p.stats! })), ...(past?.performance ?? [])].slice(0, 12),
  };
}

/**
 * Whether a clip may be used automatically: with "only my situations" on, it must have been
 * sorted into one of the creator's situations (airport, plane…), not "other" (beach, random).
 * Without the AI there are no situations, so everything counts.
 */
/**
 * Footage beyond the airport situations that's worth a video: not an edit, not landscape, long enough
 * to breathe, not used yet; the longest and strongest moments first.
 */
export function outsideClips(): Clip[] {
  // From the outside themes switched on (not unsorted "other" footage).
  const { outsideThemes, themesOff } = store.settings();
  const on = new Set((outsideThemes ?? []).filter((t) => !themesOff?.includes(t)));
  return store
    .clips()
    .filter(
      (c) =>
        c.status === "ready" && c.kind === "video" && c.height >= c.width && c.uses === 0 && !c.disliked &&
        !c.edited && !c.duplicateOf && c.duration >= 5 && !!c.scene && on.has(c.scene) && !placeOff(c),
    )
    .map((c) => ({ c, s: Math.min(c.duration, 20) / 20 + Math.max(0, ...(c.ai?.moments ?? c.moments ?? []).map((m) => m.score)) }))
    // Recent footage first, then the strongest.
    .sort((a, b) => filmedWeek(b.c) - filmedWeek(a.c) || b.s - a.s)
    .map((x) => x.c);
}

/** Why the last inspirational video couldn't be written by the AI (for diagnostics). */
export let inspireIssue: { at: string; message: string } | null = null;
export function noteInspireIssue(message: string | null) {
  inspireIssue = message ? { at: new Date().toISOString(), message: message.slice(0, 300) } : null;
}

/** Why each kind's last video couldn't be made (cleared when one is), so a missing kind says why. */
export const kindIssues: Partial<Record<PostFormat, { at: string; message: string }>> = {};
export function noteKindIssue(kind: PostFormat, message: string | null) {
  if (message) kindIssues[kind] = { at: new Date().toISOString(), message: message.slice(0, 300) };
  else delete kindIssues[kind];
  if (kind === "inspire") noteInspireIssue(message);
}

/**
 * Footage an educational video's points can cut to (a walk outside for a potty break): unused,
 * vertical, described clips from the situations and the outside themes, most recent first, not the
 * round's own main clips.
 */
export function brollPool(main: Clip, roundClips: Clip[] = []): Clip[] {
  // Any described vertical clip can show a point (a pee pad filmed at home, a clip used once before),
  // unused ones first, then the most recent; the points pick the most relevant (see pickBroll).
  const skip = new Set([main.id, ...roundClips.map((c) => c.id)]);
  return store
    .clips()
    .filter(
      (c) =>
        !skip.has(c.id) && c.status === "ready" && c.kind === "video" && c.height >= c.width && !c.disliked &&
        !c.edited && !c.duplicateOf && c.duration >= 2 && !!c.ai?.summary,
    )
    .sort((a, b) => Number(a.uses > 0) - Number(b.uses > 0) || Number(strongFootage(b)) - Number(strongFootage(a)) || filmedWeek(b) - filmedWeek(a));
}

/**
 * The footage that performs best (the creator's experience): Lex in the backpack walking through the
 * airport, at check-in, boarding, on the plane, getting off it. Favoured when picking clips, opening
 * shots and footage for points, never required.
 */
const STRONG_SCENES = /^(inside the airplane|under the airplane seat|boarding gate|check-in desk)$/;
const STRONG_MOMENT = /backpack|carrier|pet bag|in (a|the|his) bag|boarding|jet ?bridge|getting off|deplan|check-in/i;
export function strongFootage(c: Clip): boolean {
  return STRONG_SCENES.test(c.scene ?? "") || (/airport|gate|security|check-in/.test(c.scene ?? "") && STRONG_MOMENT.test(c.ai?.summary ?? ""));
}

/**
 * What an educational video opens on when its own clip isn't among the strongest footage: Lex in the
 * backpack at the airport, boarding, on the plane, with a strong moment; unused footage first, then
 * footage not opened on recently, the most recent first.
 */
export function openerFor(main: Clip, roundClips: Clip[] = []): Clip | undefined {
  const skip = new Set([main.id, ...roundClips.map((c) => c.id)]);
  const recentOpeners = new Set(store.renders().slice(0, 15).map((r) => r.plan.segments[0]?.clipId));
  const best = (c: Clip) => Math.max(0, ...(c.ai?.moments ?? c.moments ?? []).map((m) => m.score));
  return store
    .clips()
    .filter(
      (c) =>
        !skip.has(c.id) && !recentOpeners.has(c.id) && c.status === "ready" && c.kind === "video" && c.height >= c.width &&
        !c.disliked && !c.edited && !c.duplicateOf && c.duration >= 2 && strongFootage(c) && best(c) >= 0.5,
    )
    .sort((a, b) => Number(a.uses > 0) - Number(b.uses > 0) || filmedWeek(b) - filmedWeek(a) || best(b) - best(a))[0];
}

/** The country a clip was filmed in is switched off in Themes ("place:Portugal"). */
export function placeOff(c: Clip): boolean {
  const country = countryOf(c.place);
  return !!country && (store.settings().themesOff ?? []).includes(`place:${country}`);
}

/** Clips shorter than this are too short to build a video on (a second or two of footage). */
export const MIN_CLIP_SECONDS = 3;

export function onTopic(c: Clip): boolean {
  // Videos that are already edits (text on them) are never re-edited automatically, and a video
  // that's in two albums is only used once.
  if (c.edited || c.duplicateOf) return false;
  if (c.kind === "video" && c.duration < MIN_CLIP_SECONDS) return false;
  const { onlySituations, scenes, themesOff } = store.settings();
  if (c.scene && themesOff?.includes(c.scene)) return false;
  if (placeOff(c)) return false;
  if (!onlySituations || !config.claude.enabled) return true;
  return !!c.scene && scenes.includes(c.scene);
}

/** Portrait footage only: landscape clips are kept in the library but never used. */
export const isPortrait = (c: Clip) => c.height >= c.width;

/**
 * Choose which clips to build videos from: unused footage first, then the
 * clips with the strongest moments.
 */
/** The strongest moment the AI found in a clip (0 when none). */
const bestMoment = (c: Clip) => Math.max(0, ...(c.ai?.moments ?? c.moments ?? []).map((m) => m.score));

export function rankClips(clips: Clip[]): Clip[] {
  const best = bestMoment;
  // Recent footage first (by the week it was filmed; the strongest kind of footage counts as two weeks
  // newer), and within a week the strongest moment.
  const week = (c: Clip) => filmedWeek(c) + (strongFootage(c) ? 2 : 0);
  return [...clips].sort((a, b) => a.uses - b.uses || week(b) - week(a) || best(b) - best(a));
}

/** The week a clip was filmed (or imported, if the date is unknown), for newest-first ordering. */
export function filmedWeek(c: Clip): number {
  const t = Date.parse(c.capturedAt ?? c.importedAt) || 0;
  return Math.floor(t / (7 * 86400_000));
}

/**
 * Pick clips for a batch the way the creator does: proven situations first,
 * rotating so the feed doesn't show the same situation twice in a row, and
 * within a situation the freshest, strongest clip.
 */
export function pickBySituation(clips: Clip[], count: number): Clip[] {
  const scenes = store.settings().scenes;
  const recent = store.renders().filter((r) => Date.now() - Date.parse(r.createdAt) < 14 * 86400_000);
  // The strongest situations (check-in, boarding, on the plane) come up a little more often.
  const postedLately = (scene: string) => recent.filter((r) => r.plan.scene === scene).length - (STRONG_SCENES.test(scene) ? 1 : 0);
  const groups = new Map<string, Clip[]>();
  for (const c of rankClips(clips)) {
    const key = c.scene && scenes.includes(c.scene) ? c.scene : "other";
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  // Recent footage first: situations whose freshest clip is from the last few weeks of filming come
  // before ones that only have older clips; among those, the least posted lately (so the feed still
  // rotates), then the freshest.
  const newest = (scene: string) => Math.max(...groups.get(scene)!.map(filmedWeek));
  const latest = Math.max(...[...groups.keys()].map(newest));
  const fresh = (scene: string) => (newest(scene) >= latest - 3 ? 1 : 0);
  const order = [...groups.keys()].sort((a, b) => {
    // "other" (unclassified) last.
    if ((a === "other") !== (b === "other")) return a === "other" ? 1 : -1;
    return fresh(b) - fresh(a) || postedLately(a) - postedLately(b) || newest(b) - newest(a) || scenes.indexOf(a) - scenes.indexOf(b);
  });
  // Similar shots: at most one take per moment in a round, and none from a moment used in the last
  // few days. Within a situation the clips are ranked, so the strongest take of a moment is used.
  const moment = momentsOf(store.clips());
  const momentOf = (c: Clip) => moment.get(c.id) ?? c.id;
  const pick = (spaced: boolean) => {
    const blocked = spaced ? recentlyUsedMoments(moment) : new Set<string>();
    const taken = new Set<string>();
    const next = new Map(order.map((s) => [s, 0]));
    const picked: Clip[] = [];
    while (picked.length < count) {
      let added = false;
      for (const scene of order) {
        if (picked.length >= count) break;
        const list = groups.get(scene)!;
        let i = next.get(scene)!;
        while (i < list.length && (taken.has(momentOf(list[i])) || blocked.has(momentOf(list[i])))) i++;
        next.set(scene, i + 1);
        if (i < list.length) {
          picked.push(list[i]);
          taken.add(momentOf(list[i]));
          added = true;
        }
      }
      if (!added) break;
    }
    return picked;
  };
  const picked = pick(true);
  // Only if spacing leaves nothing at all: better a take of a recent moment than no video.
  return picked.length ? picked : pick(false);
}

/** The kind of each video in a round: fun, educational, inspirational, fun, … as far as the mix allows. */
export function mixSequence(
  mix: DailyMix,
  n: number,
  made: Partial<Record<PostFormat, number>> = {},
  lastMade: Partial<Record<PostFormat, number>> = {},
): PostFormat[] {
  const want: [PostFormat, number][] = [["fun", mix.fun ?? 0], ["tips", mix.educational ?? 0], ["inspire", mix.inspirational ?? 0]];
  const kinds = want.filter(([, w]) => w > 0);
  if (!kinds.length) return Array(n).fill("fun");
  // Each next video is the kind furthest behind its share of the day, counting what was already
  // made today: rounds are often just one or two videos, and must not all start with "fun".
  const have = new Map<PostFormat, number>(kinds.map(([k]) => [k, made[k] ?? 0]));
  const out: PostFormat[] = [];
  while (out.length < n) {
    let best = kinds[0];
    // Ties go to the kind made longest ago, so with fewer clips than kinds the same one isn't always dropped.
    for (const k of kinds) {
      const a = have.get(k[0])! / k[1];
      const b = have.get(best[0])! / best[1];
      if (a < b || (a === b && (lastMade[k[0]] ?? 0) < (lastMade[best[0]] ?? 0))) best = k;
    }
    out.push(best[0]);
    have.set(best[0], have.get(best[0])! + 1);
  }
  return out;
}

/** When each kind of video was last made (ms). */
export function lastMadeByKind(): Partial<Record<PostFormat, number>> {
  const out: Partial<Record<PostFormat, number>> = {};
  for (const r of store.renders()) {
    const f = r.plan.format;
    if (f && f !== "story") out[f] = Math.max(out[f] ?? 0, Date.parse(r.createdAt));
  }
  return out;
}

/** Videos made today by kind (rejected ones count too: they were that kind's chance). */
export function madeTodayByKind(): Partial<Record<PostFormat, number>> {
  const today = localDate(new Date());
  const out: Partial<Record<PostFormat, number>> = {};
  for (const r of store.renders()) {
    if (localDate(new Date(r.createdAt)) !== today || !r.plan.format || r.plan.format === "story" || r.plan.collab) continue;
    out[r.plan.format] = (out[r.plan.format] ?? 0) + 1;
  }
  return out;
}

/** Educational themes in rotation, and which follower questions belong to each. */
export const PILLARS: EduPillar[] = ["airline", "destination", "airport", "prep"];
const PILLAR_FAQ: Record<EduPillar, RegExp> = {
  airline: /airline|cabin|pet spot|book/i,
  destination: /where have you|where to|destination|requirement|countr|travel(ed)? to|get to|fly to|paper|document|passport|vaccin|rabies|import|dog.friendly/i,
  airport: /airport|security|check.?in|layover|transit|gate|pee|poo|potty|toilet|relief/i,
  prep: /bag|carrier|backpack|pack|gear|bring|tracker|accessor|prep|before the flight|during|calm|stress|anxious|nervous|sedat|food|water|sleep/i,
  gear: /bag|carrier|backpack|pack|gear|bring|tracker|accessor/i,
};
/** The angles within each theme, taken in turn so a theme doesn't keep coming back the same way. */
export const PILLAR_ANGLES: Record<EduPillar, string[]> = {
  airline: [
    "a specific airline: what flying it with a dog is really like (cabin or hold, weight limit, fees, how strict they are)",
    "a how-to with airlines: getting the pet spot, booking and calling to add the dog, checking in with a pet, what they ask for",
  ],
  destination: [
    "the rules and papers to bring a dog into a country: microchip, rabies, health certificate, titer test, timelines",
    "the best dog-friendly places: where dogs are welcome (cafés, trains, hotels, beaches) and what made it easy",
  ],
  airport: [
    "getting through the airport with a dog: check-in, security (carrier through the scanner, dog in your arms), boarding",
    "waiting at the airport: relief areas, layovers and transfers, the gate",
  ],
  prep: [
    "accessories we travel with: the things that make a travel day easier",
    "the bag: the carrier that fits under the seat, what makes a good one, how to get the dog used to it",
    "flight prep: the days and hours before a flight (exercise, food and water, the last walk, getting used to the carrier)",
    "during the flight: keeping the dog calm and comfortable under the seat, what to do if they get restless",
  ],
  gear: [],
};
const pillarOf = (p?: EduPillar) => (p === "gear" ? "prep" : p);

/**
 * The theme furthest behind in recent educational videos (not one already used in this round), so
 * over a week each comes up about equally: airline, destination, airport, prep.
 */
export function nextPillar(skip = new Set<EduPillar>()): EduPillar {
  const recent = store
    .renders()
    .filter((r) => r.plan.format === "tips" && r.plan.pillar && r.review !== "rejected")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, PILLARS.length * 2);
  const count = (p: EduPillar) => recent.filter((r) => pillarOf(r.plan.pillar) === p).length;
  const lastUsed = (p: EduPillar) => {
    const i = recent.findIndex((r) => pillarOf(r.plan.pillar) === p);
    return i === -1 ? Infinity : i;
  };
  const options = PILLARS.filter((p) => !skip.has(p));
  return [...(options.length ? options : PILLARS)].sort((a, b) => count(a) - count(b) || lastUsed(b) - lastUsed(a))[0];
}

/** The shapes educational videos take, and how often: lists most, the others in turn. */
export const EDU_FORMATS: [NonNullable<VideoPlan["eduFormat"]>, number][] = [
  ["list", 0.4],
  ["myth", 0.15],
  ["mistake", 0.15],
  ["qa", 0.15],
  ["dodont", 0.1],
  ["nobody", 0.05],
];

/** The format furthest behind its share over the last 10 educational videos (never twice in a row). */
export function nextEduFormat(): NonNullable<VideoPlan["eduFormat"]> {
  const recent = store
    .renders()
    .filter((r) => r.plan.format === "tips" && r.review !== "rejected")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);
  const last = recent[0]?.plan.eduFormat ?? "list";
  const count = (f: string) => recent.filter((r) => (r.plan.eduFormat ?? "list") === f).length;
  const n = Math.max(1, recent.length);
  return EDU_FORMATS.filter(([f]) => f !== last).sort((a, b) => count(a[0]) / n - a[1] - (count(b[0]) / n - b[1]))[0][0];
}

/** The angle within a theme used least recently (rejected videos don't count). */
export function nextAngle(pillar: EduPillar): string | undefined {
  const angles = PILLAR_ANGLES[pillar];
  if (!angles?.length) return undefined;
  const recent = store
    .renders()
    .filter((r) => r.plan.format === "tips" && pillarOf(r.plan.pillar) === pillar && r.plan.angle && r.review !== "rejected")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lastUsed = (a: string) => {
    const i = recent.findIndex((r) => r.plan.angle === a);
    return i === -1 ? Infinity : i;
  };
  return [...angles].sort((a, b) => lastUsed(b) - lastUsed(a))[0];
}

/** Topics of educational videos already made (and not rejected): never made again. */
export function coveredTopics(): string[] {
  const made = store
    .renders()
    .filter((r) => r.plan.format === "tips" && r.review !== "rejected")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => r.plan.topic || r.plan.hook);
  const before = (store.settings().pastFeedback?.kept ?? []).filter((k) => k.format === "tips").map((k) => k.text);
  return [...new Set([...made, ...before].filter(Boolean))].slice(0, 40);
}

/**
 * Fun and inspirational videos take turns: one for dog lovers, the next for everyone (a moment
 * anyone recognizes, the dog part of it), unless the setting says otherwise.
 */
export function nextAudience(format: PostFormat): "pets" | "everyone" {
  const { captionAudience } = store.settings();
  if (captionAudience === "everyone" || captionAudience === "pets") return captionAudience;
  // Inspirational videos are for everyone: they're how the account reaches people beyond dog owners.
  if (format === "inspire") return "everyone";
  // Mostly for everyone (two in three), now and then for dog lovers: the account grows beyond pet people.
  const lastTwo = store
    .renders()
    .filter((r) => r.plan.format === format && r.plan.audience)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 2)
    .map((r) => r.plan.audience);
  return lastTwo.length === 2 && lastTwo.every((a) => a === "everyone") ? "pets" : "everyone";
}

/** Which situations suit which kind of question (footage that shows what the answer is about). */
const QUESTION_FITS: [RegExp, RegExp][] = [
  [/bag|carrier/i, /seat|airplane|plane|gate/i],
  [/airline/i, /check-in|airplane|plane|gate/i],
  [/pee|poo|potty|toilet|relief/i, /terminal|gate|check-in/i],
  [/stress|calm|anxious|nervous/i, /security|airplane|plane|seat/i],
  [/requirement|document|paper|rule/i, /check-in/i],
];

/**
 * The follower question an educational video should answer: the one answered least in the last
 * 30 days, preferring questions that suit the clip's situation.
 */
export function nextQuestion(scene: string | undefined, skip = new Set<string>(), pillar?: EduPillar): { q: string; a?: string } | undefined {
  const faq = store.settings().faq.filter((f) => f.q && !skip.has(f.q) && (!pillar || PILLAR_FAQ[pillar].test(f.q)));
  if (!faq.length) return undefined;
  const recent = store.renders().filter((r) => r.plan.faq && Date.now() - Date.parse(r.createdAt) < 30 * 86400_000);
  const asked = (q: string) => recent.filter((r) => r.plan.faq === q).length;
  const fits = (q: string) => (scene && QUESTION_FITS.some(([qr, sr]) => qr.test(q) && sr.test(scene)) ? 1 : 0);
  return [...faq].sort((a, b) => asked(a.q) - asked(b.q) || fits(b.q) - fits(a.q))[0];
}

/**
 * `onPlan` is called as soon as each video's plan is ready (one-clip videos), so it can start
 * rendering while the AI is still writing the others.
 */
export async function plan(
  req: GenerateRequest,
  { onPlan }: { onPlan?: (p: VideoPlan) => void } = {},
): Promise<{ plans: VideoPlan[]; warning?: string }> {
  const all = store.clips().filter((c) => c.status === "ready" && isPortrait(c));
  // Footage the creator rejected is only used when they pick it themselves.
  const clips = req.clipIds?.length ? all.filter((c) => req.clipIds!.includes(c.id)) : all.filter((c) => c.uses === 0 && !c.disliked && onTopic(c));
  // Out of airport footage but there's footage from the outside themes: the inspirational video still gets made.
  if (!clips.length && !(req.pickFromPool && outsideClips().length)) throw new Error("No analyzed portrait clips available. Import some vertical footage first.");
  const { petName, handle } = store.settings();
  const aiOn = req.useAi && config.claude.enabled;
  let warning = req.useAi && !config.claude.enabled ? "ANTHROPIC_API_KEY is not set; used the heuristic planner." : undefined;

  if (req.template === "auto") {
    // Footage first: each video is built around one clip, directed from what's in it.
    const chosen = req.clipIds?.length && !req.pickFromPool ? rankClips(clips).slice(0, req.count) : pickBySituation(clips, req.count);
    // Each situation needs caption research (TikTok's most-viewed videos) before its first video.
    // Research that's merely old is still used, and refreshed later, so it never holds up a round.
    if (aiOn) {
      const scenes = [...new Set(chosen.map((c) => c.scene).filter((x): x is string => !!x && x !== "other"))];
      const never = scenes.filter((sc) => researchStale(sc) && !store.research(sc)?.captions.length);
      await mapLimit(never, 2, (scene) =>
        researchScene(scene).catch((err) => console.warn(`[research] ${scene}:`, (err as Error).message)),
      );
    }
    const recentOverlays = store
      .renders()
      .slice(0, 30)
      .map((r) => r.plan.hook)
      .filter(Boolean);
    const ctx: DirectContext = {
      petName,
      handle,
      minSeconds: Math.max(6, req.targetSeconds - 3),
      maxSeconds: req.targetSeconds + 5,
      examples: store.examples().filter((e) => e.status === "ready"),
      trends: [], // caption ideas come only from TikTok search (Apify)
      brief: req.brief,
      recentOverlays,
      proven: [],
      feedback: reviewFeedback(),
      story: store.settings().story,
    };
    const overlays: { example: string }[] = [];
    const failures: string[] = [];
    const { captionAudience } = store.settings();
    // The daily mix: fun, educational and inspirational candidates, alternating so a round always
    // has at least one of each (the creator keeps the best of each kind).
    // The round's kinds, then a clip for each: once a day the inspirational one is made from footage
    // beyond the airport situations (walks, cities, nature, the places we go); the others share the
    // airport clips. So the inspirational video isn't dropped when airport footage runs short.
    const auto = !req.clipIds?.length || req.pickFromPool;
    const roundSize = auto && !req.format ? Math.max(chosen.length, req.count) : chosen.length;
    const wanted = req.format ? Array(roundSize).fill(req.format) : mixSequence(store.settings().dailyMix, roundSize, madeTodayByKind(), lastMadeByKind());
    const outsideToday = store.renders().some((r) => r.plan.outside && localDate(new Date(r.createdAt)) === localDate(new Date()));
    const outsideAll = outsideClips();
    const airport = [...chosen];
    const kinds: PostFormat[] = [];
    chosen.length = 0;
    let outsideUsed = outsideToday;
    for (const k of wanted) {
      const out = auto && k === "inspire" && !outsideUsed ? outsideAll.find((c) => !chosen.includes(c)) : undefined;
      const clip = out ?? airport.shift();
      if (!clip) continue;
      if (out) outsideUsed = true;
      chosen.push(clip);
      kinds.push(k);
    }
    // Educational videos need time to read: they get the longest of the round's clips.
    kinds.forEach((k, i) => {
      if (k !== "tips") return;
      let best = i;
      const outsideIds = new Set(outsideAll.map((c) => c.id));
      for (let j = 0; j < chosen.length; j++)
        if (kinds[j] !== "tips" && !outsideIds.has(chosen[j].id) && chosen[j].duration > chosen[best].duration) best = j;
      [chosen[i], chosen[best]] = [chosen[best], chosen[i]];
    });
    const outsidePool = outsideAll;
    const outside = new Set(outsidePool.map((c) => c.id));
    // Extra footage for videos whose clip is too short: other unused clips, the same situation first.
    // (From all unused footage, also when the video was asked for one specific clip.)
    const spare = [
      ...all.filter((c) => !chosen.includes(c) && c.kind === "video" && c.uses === 0 && !c.disliked && onTopic(c) && c.duration >= MIN_CLIP_SECONDS),
      ...outsidePool.filter((c) => !chosen.includes(c)),
    ];
    const taken = new Set<string>();
    const best = (c: Clip) => Math.max(0, ...(c.ai?.moments ?? c.moments ?? []).map((m) => m.score));
    const extrasFor = (clip: Clip, kind?: PostFormat): Clip[] => {
      // An inspirational montage: the strongest recent moments from the journey, any place.
      if (kind === "inspire" && outside.has(clip.id)) {
        const pick = spare
          .filter((c) => !taken.has(c.id) && outside.has(c.id) && c.id !== clip.id)
          .sort((a, b) => filmedWeek(b) - filmedWeek(a) || best(b) - best(a))
          .slice(0, 16)
          .sort((a, b) => best(b) - best(a))
          .slice(0, 7);
        for (const c of pick) taken.add(c.id);
        return pick;
      }
      const pick = [...spare]
        // Outside footage is combined with outside footage; airport footage with airport footage.
        .filter((c) => !taken.has(c.id) && outside.has(c.id) === outside.has(clip.id))
        // Same situation first, then the most recently filmed (old footage only when nothing newer fits).
        .sort((a, b) => Number(b.scene === clip.scene) - Number(a.scene === clip.scene) || filmedWeek(b) - filmedWeek(a) || b.duration - a.duration)
        .slice(0, 5);
      for (const c of pick) taken.add(c.id);
      return pick;
    };
    // Fun and inspirational take turns between dog lovers and everyone, across rounds and days.
    const turn: Partial<Record<PostFormat, "pets" | "everyone">> = {};
    const audiences = kinds.map((k) => {
      const a = turn[k] ? (turn[k] === "everyone" ? "pets" : "everyone") : nextAudience(k);
      if (captionAudience === "mix") turn[k] = a;
      return a;
    });
    // Educational: a different theme for each, and nothing already covered.
    const pillarsThisRound = new Set<EduPillar>();
    const pillars = kinds.map((k) => {
      if (k !== "tips") return undefined;
      const p = req.pillar && req.pillar !== "gear" ? req.pillar : nextPillar(pillarsThisRound);
      pillarsThisRound.add(p);
      return p;
    });
    const covered = coveredTopics();
    const askedThisRound = new Set<string>();
    const searchedThisRound = new Set<string>();
    const plans = await mapLimit(chosen, 2, async (clip, i) => {
      if (aiOn) {
        try {
          const kind = kinds[i] ?? "fun";
          const pillar = pillars[i];
          // What people search for in this theme comes first; a follower question only joins in when the
          // creator wrote their answer to it (it's the source of specifics).
          const search = kind === "tips" ? searchTopicsFor(pillar).filter((t) => !searchedThisRound.has(t.topic)) : [];
          if (search[0]) searchedThisRound.add(search[0].topic);
          const question = kind === "tips" ? nextQuestion(clip.scene, askedThisRound, pillar) : undefined;
          const faq = search.length && !question?.a?.trim() ? undefined : question;
          if (faq) askedThisRound.add(faq.q);
          const direction: DirectContext = {
            ...ctx,
            proven: provenCaptions(clip.scene),
            audience: kind === "tips" ? (captionAudience === "pets" ? "pets" : "everyone") : audiences[i],
            format: kind,
            // Too short for the video? Combined with other clips of the moment instead of replayed.
            extraClips: extrasFor(clip, kind),
            ...(outside.has(clip.id)
              ? {
                  brief: [
                    ctx.brief,
                    "This footage is from the journey beyond the airport: a place, a walk, nature, a moment together. " +
                      "Make it about where we are and what it means to be here together, not about flying.",
                  ].filter(Boolean).join(" "),
                }
              : {}),
            ...(kind === "tips" ? { eduFormat: nextEduFormat(), topPosts: store.settings().audience?.topPosts, ...((opener) => ({ opener, broll: brollPool(clip, opener ? [...chosen, opener] : chosen) }))(strongFootage(clip) ? undefined : openerFor(clip, chosen)), faq, pillar, angle: pillar ? nextAngle(pillar) : undefined, search, covered, cta: store.settings().cta, minSeconds: Math.max(ctx.minSeconds, 12), maxSeconds: Math.max(ctx.maxSeconds, 18) } : {}),
          };
          let p = await directClip(clip, direction);
          // The basics first (headline, points, pacing): a draft that breaks one goes back once with
          // the exact problems, and the version with fewer problems is kept.
          const problems = basicChecks(p, clip.place);
          if (problems.length && featureOn("retries")) {
            console.log(`[checks] ${kind} on ${clip.id}: ${problems.join(" | ")}`);
            const brief = [direction.brief, `THE LAST DRAFT BROKE THESE BASIC RULES, fix every one: ${problems.join(" ")}`].filter(Boolean).join("\n\n");
            const again = await directClip(clip, { ...direction, brief }).catch(() => undefined);
            if (again && basicChecks(again, clip.place).length < problems.length) p = again;
          }
          p.checks = basicChecks(p, clip.place);
          if (outside.has(clip.id)) p.outside = true;
          applyHashtags(p, clip.scene);
          ctx.recentOverlays.unshift(p.hook);
          if (p.topic) covered.unshift(p.topic);
          onPlan?.(p);
          return p;
        } catch (err) {
          failures.push((err as Error).message);
          noteKindIssue(kinds[i] ?? "fun", (err as Error).message);
        }
      }
      // With the AI on but not answering (out of credit, the month's budget, an outage): no video,
      // rather than a trending caption pasted as is (the same one every time).
      if (aiOn) return undefined;
      // A clip without sound analysis still gets its video (from the start of the clip), rather than
      // failing the whole round: that was how the day's inspirational video kept going missing.
      const p = heuristicPlan({
        template: "auto",
        targetSeconds: req.targetSeconds,
        clips: [clip.energy?.length ? clip : { ...clip, energy: Array(Math.max(1, Math.round(clip.duration * 2))).fill(0.5) }],
        petName,
        used: new Map(),
      });
      // Without the AI director: use a proven caption for the clip's situation if there is one,
      // otherwise a generic trend example. Flagged so the creator knows, and can ask for a new caption.
      if (aiOn) p.aiNote = (failures[failures.length - 1] ?? "the AI didn't answer").slice(0, 300);
      const proven = provenCaptions(clip.scene);
      const pc = proven[i % Math.max(1, proven.length)];
      if (pc) {
        p.hook = p.title = pc.text;
        p.basedOn = { text: pc.text, views: pc.views, url: pc.url };
      } else if (overlays.length) p.hook = p.title = overlays[i % overlays.length].example.replaceAll("{pet}", petName);
      p.scene = clip.scene;
      p.postCaption = `${p.hook} 🐾`;
      p.format = kinds[i] ?? "fun";
      applyHashtags(p, clip.scene);
      onPlan?.(p);
      return p;
    });
    if (failures.length) {
      warning = `AI director failed on ${failures.length} clip(s) (${failures[0]}); used heuristics for those.`;
      console.warn(`[round] ${warning}`);
    }
    if (chosen.length < req.count) {
      warning = [warning, `Only ${chosen.length} usable clip(s), so only ${chosen.length} video(s).`].filter(Boolean).join(" ");
    }
    return { plans: plans.filter((x): x is VideoPlan => !!x), warning };
  }

  if (aiOn) {
    try {
      const plans = await planVideos({
        template: req.template,
        targetSeconds: req.targetSeconds,
        count: req.count,
        brief: req.brief,
        clips,
        petName,
        handle,
        trends: [], // caption ideas come only from TikTok search (Apify)
      });
      if (plans.length) {
        // Models are approximate with arithmetic; snap each plan to the requested length.
        const byId = new Map(clips.map((c) => [c.id, c]));
        for (const p of plans) p.segments = stretchToTarget(p.segments, byId, req.targetSeconds);
        return { plans: plans.slice(0, req.count) };
      }
      warning = "Claude returned no usable plans; used the heuristic planner instead.";
    } catch (err) {
      warning = `AI director unavailable (${(err as Error).message}); used the heuristic planner instead.`;
    }
  }

  const used = new Map<string, number>();
  const plans: VideoPlan[] = [];
  const overlays: { example: string }[] = [];
  for (let i = 0; i < req.count; i++) {
    const p = heuristicPlan({ template: req.template, targetSeconds: req.targetSeconds, clips, petName, used });
    if (req.template === "text_overlay" && overlays.length) {
      p.hook = p.title = overlays[i % overlays.length].example.replaceAll("{pet}", petName);
      p.postCaption = `${p.hook} 🐾`;
    }
    for (const s of p.segments) used.set(s.clipId, (used.get(s.clipId) ?? 0) + 1);
    plans.push(p);
  }
  return { plans, warning };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

export function queueRender(
  planned: VideoPlan,
  options: GenerateRequest["options"],
  batch?: string,
  { countUse = true, standby = false } = {},
): Render {
  const render = store.addRender({
    ...(standby ? { standby: true } : {}),
    id: newId(),
    createdAt: new Date().toISOString(),
    plan: planned,
    options,
    status: "queued",
    progress: 0,
    review: "pending",
    batch,
    countUse,
    madeWith: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "local",
  });
  enqueueRenderJob(render.id);
  return render;
}

/**
 * Each clip is used once. A rejected video hands its clips back so they can be tried again with a
 * new edit, unless the clip itself was the problem ("Bad clip"); undoing the rejection takes them again.
 */
export function syncClipUses(id: string) {
  const r = store.render(id);
  if (!r || r.status !== "done") return;
  const giveBack = r.review === "rejected" && r.rejectReason !== "clip";
  if (giveBack === !!r.usesReturned) return;
  for (const clipId of new Set(r.plan.segments.map((s) => s.clipId))) {
    const c = store.clip(clipId);
    if (c) store.updateClip(clipId, { uses: Math.max(0, c.uses + (giveBack ? -1 : 1)) });
  }
  store.updateRender(id, { usesReturned: giveBack });
}

/**
 * A brand version of a video: same clip, new text, cut and description built around the partner.
 * The original stays; the new one goes to Review.
 */
export async function makeCollabVersion(renderId: string, partnerId: string, note?: string): Promise<Render> {
  const r = store.render(renderId);
  if (!r) throw new Error("Unknown video.");
  const partner = store.partner(partnerId);
  if (!partner) throw new Error("Unknown partner.");
  if (!config.claude.enabled) throw new Error("Collab versions need the AI (ANTHROPIC_API_KEY).");
  const clip = store.clip(r.plan.segments[0]?.clipId ?? "");
  if (!clip || clip.status !== "ready") throw new Error("The clip this video was made from is no longer in the library.");
  return queueRender(await collabPlan(clip, partner, note), r.options, r.batch, { countUse: false });
}

/** Find the clip with the best angle on a partner's product or place, and make a collab video from it. */
export async function makeCollabFromLibrary(partnerId: string, note?: string): Promise<{ render: Render; reason: string }> {
  const partner = store.partner(partnerId);
  if (!partner) throw new Error("Unknown partner.");
  if (!config.claude.enabled) throw new Error("Collab videos need the AI (ANTHROPIC_API_KEY).");
  const { clip, reason } = await findClipFor(partner, note);
  const { fontId, textStyle, textSize } = store.settings();
  const render = queueRender(await collabPlan(clip, partner, note), { keepOriginalAudio: true, textStyle, textSize, fontId }, undefined, { countUse: false });
  store.updateClip(clip.id, { uses: clip.uses + 1 });
  return { render, reason };
}

/**
 * An extra educational video about a brand partner: a real lesson in the brand's area (what people
 * search for), with the brand as the practical answer in one point. Made when a partner is added,
 * or on request; it doesn't count toward the day's set.
 */
export async function makeCollabEducational(partnerId: string, note?: string): Promise<{ render: Render; reason: string }> {
  const partner = store.partner(partnerId);
  if (!partner) throw new Error("Unknown partner.");
  if (!config.claude.enabled) throw new Error("Collab videos need the AI (ANTHROPIC_API_KEY).");
  const { clip, reason } = await findClipFor(partner, note);
  const { fontId, textStyle, textSize } = store.settings();
  const render = queueRender(await collabPlan(clip, partner, note, true), { keepOriginalAudio: true, textStyle, textSize, fontId }, undefined, { countUse: false });
  store.updateClip(clip.id, { uses: clip.uses + 1 });
  return { render, reason };
}

async function collabPlan(clip: Clip, partner: Partner, note?: string, educational = false): Promise<VideoPlan> {
  const { petName, handle, story } = store.settings();
  const target = store.auto().targetSeconds;
  const edu: Partial<DirectContext> = educational
    ? {
        format: "tips",
        audience: "everyone",
        eduFormat: "list",
        topPosts: store.settings().audience?.topPosts,
        broll: brollPool(clip),
        cta: store.settings().cta,
        minSeconds: Math.max(6, target - 3, 12),
        maxSeconds: Math.max(target + 5, 18),
      }
    : {};
  const p = await directClip(clip, {
    petName,
    handle,
    minSeconds: Math.max(6, target - 3),
    maxSeconds: target + 5,
    examples: store.examples().filter((e) => e.status === "ready"),
    trends: [],
    recentOverlays: store.renders().slice(0, 30).map((x) => x.plan.hook).filter(Boolean),
    proven: provenCaptions(clip.scene),
    feedback: reviewFeedback(),
    story,
    collab: { name: partner.name, handle: partner.handle, about: partner.about, mustInclude: partner.mustInclude, note, educational },
    ...edu,
  });
  applyHashtags(p, clip.scene);
  p.collab = { partnerId: partner.id, name: partner.name, handle: partner.handle };
  // The mention, required details and disclosure go in whatever the AI wrote.
  if (partner.handle && !p.postCaption.includes(partner.handle)) p.postCaption += ` ${partner.handle}`;
  if (partner.mustInclude && !p.postCaption.includes(partner.mustInclude)) p.postCaption += `\n\n${partner.mustInclude}`;
  if (!/#ad\b|#sponsored|paid partnership/i.test(p.postCaption)) p.postCaption += "\n\n#ad";
  return p;
}

/** Write a new post description for a video (the video itself stays as it is). */
export async function regenerateCaption(renderId: string, note?: string): Promise<Render> {
  const r = store.render(renderId);
  if (!r) throw new Error("Unknown video.");
  if (!config.claude.enabled) throw new Error("New captions need the AI (ANTHROPIC_API_KEY).");
  const clip = store.clip(r.plan.segments[0]?.clipId ?? "");
  const partner = r.plan.collab ? store.partner(r.plan.collab.partnerId) : undefined;
  const { petName, handle, story, faq } = store.settings();
  const caption = await writeCaption({
    petName,
    handle,
    story,
    plan: r.plan,
    clip,
    note,
    faq: r.plan.faq ? faq.find((f) => f.q === r.plan.faq) : undefined,
    collab: partner ? { name: partner.name, handle: partner.handle, about: partner.about, mustInclude: partner.mustInclude } : undefined,
    feedback: reviewFeedback(),
  });
  let text = caption.trim();
  if (partner) {
    if (partner.handle && !text.includes(partner.handle)) text += ` ${partner.handle}`;
    if (partner.mustInclude && !text.includes(partner.mustInclude)) text += `\n\n${partner.mustInclude}`;
    if (!/#ad\b|#sponsored|paid partnership/i.test(text)) text += "\n\n#ad";
  }
  return store.updateRender(r.id, { plan: { ...r.plan, postCaption: text, aiNote: undefined } })!;
}

/** Fetch (or refresh) the stats of a video the creator posted, and keep them on the video. */
export async function refreshPostStats(renderId: string, platform: Platform): Promise<Render> {
  const r = store.render(renderId);
  const post = r?.posts?.find((p) => p.platform === platform);
  if (!r || !post) throw new Error("No post link for that platform on this video.");
  if (!apifyEnabled()) throw new Error("Reading post stats needs Apify (APIFY_TOKEN).");
  const save = (patch: Partial<PostedInfo>) =>
    store.updateRender(r.id, { posts: (store.render(r.id)!.posts ?? []).map((p) => (p.platform === platform ? { ...p, ...patch } : p)) })!;
  try {
    const { stats, postedAt } = await fetchPostStats(post.url);
    // The 3-second hold the creator entered from their insights stays with the fresh numbers.
    const held3s = post.stats?.held3s;
    return save({ stats: held3s !== undefined ? { ...stats, held3s } : stats, postedAt: postedAt ?? post.postedAt, fetchedAt: new Date().toISOString(), error: undefined });
  } catch (err) {
    save({ fetchedAt: new Date().toISOString(), error: (err as Error).message.slice(0, 200) });
    throw err;
  }
}

/** Posts whose stats are due a daily refresh (the first two weeks after posting, when views come in). */
export function postsDueForStats(now = Date.now()): { render: Render; platform: Platform }[] {
  return store.renders().flatMap((render) =>
    (render.posts ?? [])
      .filter((p) => {
        const since = Date.parse(p.postedAt ?? p.addedAt);
        const last = p.fetchedAt ? Date.parse(p.fetchedAt) : 0;
        return now - since < 14 * 86400_000 && now - last > 20 * 3600_000;
      })
      .map((p) => ({ render, platform: p.platform })),
  );
}

/** A story video from the creator's storyline: matching clips stitched in order, text per beat. */
export async function makeStoryVideo(storyline: string, targetSeconds = 20): Promise<Render> {
  if (!config.claude.enabled) throw new Error("Story videos need the AI (ANTHROPIC_API_KEY).");
  const text = storyline.trim();
  if (text.length < 10) throw new Error("Write the storyline first: what happens, in order.");
  const p = await planStory(text, targetSeconds);
  const { fontId, textStyle, textSize } = store.settings();
  return queueRender(p, { keepOriginalAudio: true, textStyle, textSize, fontId });
}

/** A day vlog from the clips filmed on one day (Settings → Day vlog; never made automatically). */
export async function makeDayVlog(day: string, targetSeconds = 30, proposal?: VlogProposal, clipIds?: string[]): Promise<Render> {
  if (!proposal && !config.claude.enabled) throw new Error("Day vlogs need the AI (ANTHROPIC_API_KEY).");
  const p = proposal ? buildDayVlog(proposal) : await planDayVlog(day, targetSeconds, clipIds);
  const { fontId, textStyle, textSize } = store.settings();
  return queueRender(p, { keepOriginalAudio: true, textStyle, textSize, fontId }, undefined, { countUse: false });
}

// ---- Voiceover stories (script / talk track → lines → recordings → video) ----------------

export async function createVoiceDraft(mode: "script" | "talk", source: string, partnerId?: string): Promise<StoryDraft> {
  if (!config.claude.enabled) throw new Error("Voiceover stories need the AI (ANTHROPIC_API_KEY).");
  const text = source.trim();
  if (text.length < 20) throw new Error(mode === "script" ? "Paste the script first." : "Write the talk track first: the points you want to make.");
  const partner = partnerId ? store.partner(partnerId) : undefined;
  rememberShots(parseShots(text).shots);
  const planned = await planVoiceDraft(mode, text, partner);
  return store.saveDraft({ id: newId(), createdAt: new Date().toISOString(), mode, source: text, partnerId: partner?.id, ...planned });
}

/** Keep the scenes used in a voiceover as reusable tags (most recent first). */
export function rememberShots(shots: string[]) {
  if (!shots.length) return;
  const old = store.settings().shotTags ?? [];
  const seen = new Set<string>();
  const tags = [...shots.reverse(), ...old].filter((t) => {
    const k = t.toLowerCase();
    return t && !seen.has(k) && seen.add(k);
  });
  store.updateSettings({ shotTags: tags.slice(0, 60) });
}

const voiceDir = () => path.join(config.dataDir, "voice");

/** Save a recorded line: converted to AAC, silence at the start and end trimmed, length measured. */
export async function saveLineRecording(draftId: string, index: number, uploaded: string, by: "me" | "clone" = "me"): Promise<StoryDraft> {
  const d = store.draft(draftId);
  if (!d?.lines[index]) throw new Error("Unknown line.");
  fs.mkdirSync(voiceDir(), { recursive: true });
  const out = path.join(voiceDir(), `${draftId}-${index}-${Date.now()}.m4a`);
  try {
    await run("ffmpeg", [
      "-y", "-v", "error", "-i", uploaded,
      "-af", "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse,loudnorm=I=-16:TP=-1.5",
      "-ac", "1", "-ar", "44100", "-c:a", "aac", "-b:a", "128k", out,
    ]);
  } finally {
    fs.rmSync(uploaded, { force: true });
  }
  const { duration } = await probe(out);
  if (!(duration > 0.3)) {
    fs.rmSync(out, { force: true });
    throw new Error("That recording was silent. Check the microphone and try again.");
  }
  const old = d.lines[index].audio;
  if (old) fs.rmSync(old, { force: true });
  d.lines[index] = { ...d.lines[index], audio: out, audioSeconds: Math.round(duration * 100) / 100, audioBy: by };
  return store.saveDraft(d);
}

/**
 * Clone the creator's voice from recorded samples (a minute or two of them talking). Replaces any
 * voice made before.
 */
export async function createVoice(uploaded: string[]): Promise<{ sampleSeconds: number }> {
  const samples: string[] = [];
  let seconds = 0;
  try {
    fs.mkdirSync(voiceDir(), { recursive: true });
    for (const [i, file] of uploaded.entries()) {
      const out = path.join(voiceDir(), `sample-${Date.now()}-${i}.m4a`);
      await run("ffmpeg", ["-y", "-v", "error", "-i", file, "-af", "loudnorm=I=-16:TP=-1.5", "-ac", "1", "-ar", "44100", "-c:a", "aac", "-b:a", "160k", out]);
      samples.push(out);
      seconds += (await probe(out)).duration || 0;
    }
    if (seconds < 30) throw new Error(`That's ${Math.round(seconds)} seconds of talking. Record at least 30 seconds (1–2 minutes sounds best).`);
    const old = store.settings().voice;
    const id = await cloneVoice(`${store.settings().handle || store.settings().petName} creator`, samples);
    store.updateSettings({ voice: { id, createdAt: new Date().toISOString(), sampleSeconds: Math.round(seconds) } });
    if (old) await deleteVoice(old.id);
    return { sampleSeconds: Math.round(seconds) };
  } finally {
    for (const f of [...uploaded, ...samples]) fs.rmSync(f, { force: true });
  }
}

export async function removeVoice() {
  const v = store.settings().voice;
  if (v) await deleteVoice(v.id);
  store.updateSettings({ voice: undefined });
}

/** Read a story's lines in the creator's cloned voice: the ones not recorded yet, or all of them. */
export async function speakDraft(draftId: string, all = false): Promise<StoryDraft> {
  const voice = store.settings().voice;
  if (!voice) throw new Error("Make your voice first (Story video → My voice).");
  let d = store.draft(draftId);
  if (!d) throw new Error("Unknown story.");
  fs.mkdirSync(config.tmpDir, { recursive: true });
  for (const [i, line] of d.lines.entries()) {
    if (line.audio && !all) continue;
    const tmp = path.join(config.tmpDir, `tts-${draftId}-${i}-${Date.now()}.mp3`);
    await speak(voice.id, line.text, tmp);
    d = await saveLineRecording(draftId, i, tmp, "clone");
  }
  return d;
}

/** Show a different clip for a line (or one for a line that had none). */
export function setLineClip(draftId: string, index: number, clipId: string): StoryDraft {
  const d = store.draft(draftId);
  const clip = store.clip(clipId);
  if (!d?.lines[index] || !clip || clip.status !== "ready") throw new Error("Unknown line or clip.");
  d.lines[index] = { ...d.lines[index], clipId, start: 0, end: clip.duration, missing: undefined };
  return store.saveDraft(d);
}

/** Make the video from a draft: with the recorded voice, or with captions only. */
export function renderDraft(draftId: string, withVoice: boolean): Render {
  const d = store.draft(draftId);
  if (!d) throw new Error("Unknown story.");
  const p = planFromDraft(d, withVoice);
  const partner = d.partnerId ? store.partner(d.partnerId) : undefined;
  if (partner) {
    p.collab = { partnerId: partner.id, name: partner.name, handle: partner.handle };
    if (partner.handle && !p.postCaption.includes(partner.handle)) p.postCaption += ` ${partner.handle}`;
    if (partner.mustInclude && !p.postCaption.includes(partner.mustInclude)) p.postCaption += `\n\n${partner.mustInclude}`;
    if (!/#ad\b|#sponsored|paid partnership/i.test(p.postCaption)) p.postCaption += "\n\n#ad";
  }
  const { fontId, textStyle, textSize } = store.settings();
  return queueRender(p, { keepOriginalAudio: true, textStyle, textSize, fontId });
}

/** Queue a failed or interrupted render again, with the same plan. */
export function retryRender(id: string, { urgent = true } = {}): Render | undefined {
  const r = store.render(id);
  if (!r) return undefined;
  store.updateRender(id, { status: "queued", progress: 0, error: undefined, review: "pending" });
  enqueueRenderJob(id, urgent);
  return store.render(id);
}

function enqueueRenderJob(id: string, urgent = true) {
  // Videos for Review first, then spares, then anything not urgent (behind imports).
  const priority = !urgent ? PRIORITY.import : store.render(id)?.standby ? PRIORITY.spare : PRIORITY.video;
  renderQueue.push(async () => {
    const render = store.render(id);
    if (!render) return; // deleted while waiting
    store.updateRender(id, { status: "rendering" });
    try {
      const clips = new Map(store.clips().map((c) => [c.id, c]));
      const result = await renderVideo(id, render.plan, clips, render.options, (p) =>
        store.updateRender(id, { progress: Math.round(p * 100) / 100 }),
      );
      // Daily videos get the editor's review before they reach Review (still "making" meanwhile).
      const review = needsEditor(render);
      store.updateRender(id, { status: review ? "rendering" : "done", progress: review ? 0.97 : 1, ...result });
      // The light copy the app plays, so even the first viewing doesn't download the full file.
      previewFor(`render-${id}`, result.file);
      if (review) void editorPass(id, result.duration);
      if (render.countUse !== false && !render.usesCounted) {
        for (const clipId of new Set(render.plan.segments.map((s) => s.clipId))) {
          const c = store.clip(clipId);
          if (c) store.updateClip(clipId, { uses: c.uses + 1 });
        }
        // Count once, even if this render is retried later.
        store.updateRender(id, { usesCounted: true });
      }
    } catch (err) {
      store.updateRender(id, { status: "error", error: (err as Error).message });
    }
  }, { kind: "render", id }, priority);
}

/** Who reviews finished videos (swappable in tests). */
export const editorReviewer = { review: reviewVideo };

/** The editor's review is for the daily videos (not stories, vlogs or collabs), when the AI is on. */
function needsEditor(r: Render): boolean {
  // Not for a video the creator already kept or edited, or one only redrawn with a new look.
  return (
    config.claude.enabled && aiAvailable() && ["tips", "fun", "inspire"].includes(r.plan.format ?? "") && !r.plan.collab &&
    r.review !== "approved" && (r.plan.editorPass ?? 0) < EDITOR_ATTEMPTS
  );
}

/** Attempts per video: the first, then up to two more made from the editor's notes. */
export const EDITOR_ATTEMPTS = 3;
/** Attempts actually made: one, unless retries are switched on (Labs); the review still scores it. */
const editorAttempts = () => (featureOn("retries") ? EDITOR_ATTEMPTS : 1);
const total = (e?: Render["editor"]) => (e ? e.scores.hook * 2 + e.scores.body + e.scores.ending : -1);

/**
 * The editor's review of a finished video: passed on to Review, or made again automatically (the
 * text fixed, or new footage or a new cut, from the editor's notes) until it passes, up to
 * EDITOR_ATTEMPTS in all. If none passes, the best-scoring attempt goes to the creator, with notes.
 */
export async function editorPass(id: string, duration: number): Promise<void> {
  const r = store.render(id);
  if (!r?.file) return;
  const finish = (patch: Partial<Render> = {}) => store.render(id) && store.updateRender(id, { status: "done", progress: 1, ...patch });
  let v: EditorVerdict;
  try {
    v = await editorReviewer.review(r, duration, new Map(store.clips().map((c) => [c.id, c])), store.settings().petName);
  } catch (err) {
    console.warn(`[editor] ${id}:`, (err as Error).message);
    return void finish();
  }
  if (!store.render(id)) return; // deleted meanwhile
  const pass = r.plan.editorPass ?? 0;
  const base = { at: new Date().toISOString(), scores: v.scores, parts: v.parts, dropOff: v.dropOff?.slice(0, 3), verdict: v.verdict, issues: v.issues.slice(0, 8), ...(v.remakeBrief ? { remakeBrief: v.remakeBrief.slice(0, 600) } : {}) };
  console.log(`[editor] ${id} (${r.plan.format}, attempt ${pass + 1}): ${v.verdict} ${JSON.stringify(v.scores)}${v.issues.length ? ` – ${v.issues.join("; ")}` : ""}`);
  if (v.verdict === "pass") return void finish({ editor: { ...base, outcome: "passed" } });
  // Set aside by the editor (not the creator's feedback); kept so the best attempt can come back.
  const setAside = (note: string, reason: Render["rejectReason"], outcome: NonNullable<Render["editor"]>["outcome"]) => {
    store.updateRender(id, {
      status: "done",
      progress: 1,
      review: "rejected",
      reviewedAt: new Date().toISOString(),
      rejectReason: reason,
      rejectNote: `Editor's review: ${note}`.slice(0, 600),
      rejectedBy: "editor",
      editor: { ...base, outcome },
    });
    syncClipUses(id);
  };
  if (pass + 1 >= editorAttempts()) return void deliverBest(id, base);
  const overlays = r.plan.overlays ?? [];
  if (v.verdict === "fix_text" && overlays.length && v.texts.length === overlays.length) {
    // Only the words change: the text is drawn again on the same footage (cached, quick).
    const fixed = overlays.map((o, i) => ({ ...o, text: v.texts[i]?.trim() || o.text }));
    const plan = healPlan({ ...r.plan, overlays: fixed, hook: fixed[0].text, editorPass: pass + 1, remakeOf: id }, store.settings().cta?.site);
    setAside(v.issues.join("; "), "text", "text_fixed");
    const fresh = queueRender(plan, r.options, r.batch, { countUse: false, standby: !!r.standby });
    store.updateRender(id, { remadeAs: fresh.id });
    console.log(`[editor] ${id}: text fixed → ${fresh.id}`);
    return;
  }
  // Footage, cut or pacing. Weak visuals (a dull opening, footage that doesn't show the points): other
  // footage; otherwise a new cut of the same footage.
  setAside(v.remakeBrief || v.issues.join("; "), v.parts.hook.visual < 7 || v.parts.body.visual < 6 ? "clip" : "edit", "remade");
  // A spare that passed steps in for the one set aside; the remake becomes the new spare.
  if (!r.standby) promoteSpares();
  const fresh = await remakeRejected(id, { force: true, editorPass: pass + 1 }).catch(() => undefined);
  if (!fresh) deliverBest(id, base); // no footage left, or the day's cap: the best so far goes on
}

/**
 * No attempt passed (or no more can be made): the best-scoring one in this video's chain goes to
 * Review with the editor's notes; the others stay set aside.
 */
function deliverBest(id: string, review: Omit<NonNullable<Render["editor"]>, "outcome">) {
  const chain: Render[] = [];
  for (let r = store.render(id); r && !chain.includes(r); r = r.plan.remakeOf ? store.render(r.plan.remakeOf) : undefined) {
    if (r.id === id || r.rejectedBy === "editor") chain.push(r);
  }
  const current = { ...store.render(id)!, editor: { ...review, outcome: "let_through" as const } };
  const best = [current, ...chain.slice(1)].reduce((a, b) => (total(b.editor) > total(a.editor) ? b : a));
  const restore = (x: Render) =>
    store.updateRender(x.id, {
      status: "done",
      progress: 1,
      review: "pending",
      reviewedAt: undefined,
      rejectReason: undefined,
      rejectNote: undefined,
      rejectedBy: undefined,
      editor: { ...(x.editor ?? review), outcome: "let_through" },
    });
  if (best.id === id) {
    restore(current);
  } else {
    restore(best);
    store.updateRender(id, { status: "done", progress: 1, review: "rejected", reviewedAt: new Date().toISOString(), rejectReason: "other", rejectNote: "Editor's review: an earlier attempt scored better.", rejectedBy: "editor", editor: { ...review, outcome: "remade" } });
    syncClipUses(id);
  }
  syncClipUses(best.id);
  console.log(`[editor] ${id}: no attempt passed; best attempt ${best.id} goes to Review`);
}

export function deleteRender(id: string) {
  const r = store.render(id);
  if (!r) return;
  for (const f of [r.file, r.thumb]) if (f) fs.rmSync(f, { force: true });
  removePreview(`render-${id}`);
  store.removeRender(id);
  // Its text-free footage goes too, unless another video (e.g. its re-made version) uses the same.
  const clips = new Map(store.clips().map((c) => [c.id, c]));
  const key = baseKey(r.plan, clips);
  if (key && !store.renders().some((x) => baseKey(x.plan, clips) === key)) fs.rmSync(basePath(key), { force: true });
}

/**
 * Re-make the videos waiting for review or posting with the current look (style, size, font and the
 * latest layout rules), keeping their text, footage and music. Videos made before the AI reported
 * where the subject is get a quick look first, so their text can stay off it.
 */
export async function refreshDesigns({ proofread = false } = {}): Promise<number> {
  const { textStyle, textSize, fontId } = store.settings();
  const todo = store
    .renders()
    .filter((r) => r.status === "done" && (r.review === "pending" || r.review === "approved") && !r.posts?.length)
    .filter((r) => r.plan.segments.every((s) => store.clip(s.clipId)?.status === "ready"));
  const clips = new Map(store.clips().map((c) => [c.id, c]));
  let n = 0;
  for (const r of todo) {
    let plan = r.plan;
    if (!plan.keepClear && config.claude.enabled && aiAvailable()) {
      const band = await detectSubject(plan, clips).catch((err) => {
        console.warn(`[design] couldn't find the subject in ${r.id}:`, (err as Error).message);
        return undefined;
      });
      if (band) plan = { ...plan, keepClear: band };
    }
    // The text gets the same read a new video gets, and is fixed where it doesn't add up.
    if (proofread && plan.overlays?.length && config.claude.enabled && aiAvailable()) {
      const old = plan.overlays;
      const fixed = await proofreadText(old.map((o) => o.text), store.settings().petName, plan.format).catch(() => null);
      if (fixed) plan = { ...plan, overlays: old.map((o, i) => ({ ...o, text: fixed[i] })), hook: fixed[0] };
    }
    if (!store.render(r.id)) continue; // deleted meanwhile
    // Only the look changes: no new editor's review (it could replace a video the creator kept).
    const fresh = queueRender(healPlan({ ...plan, editorPass: EDITOR_ATTEMPTS }, store.settings().cta?.site), { ...r.options, textStyle, textSize, fontId }, r.batch, { countUse: false });
    if (r.review === "approved") store.updateRender(fresh.id, { review: "approved", reviewedAt: r.reviewedAt });
    deleteRender(r.id);
    n++;
  }
  if (n) console.log(`[design] re-making ${n} video(s) with the current look`);
  return n;
}

/**
 * Educational videos made before the call to action: add it at the end (footage runs on 3s), keeping
 * their text and description exactly as they are.
 */
export function addCtaToExisting(): number {
  const cta = store.settings().cta;
  if (!cta?.overlay) return 0;
  const len = (p: VideoPlan) => p.segments.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
  let n = 0;
  for (const r of [...store.renders()]) {
    if (r.plan.format !== "tips" || r.status !== "done" || r.posts?.length) continue;
    if (r.review !== "pending" && r.review !== "approved") continue;
    if (!r.plan.segments.every((s) => store.clip(s.clipId)?.status === "ready")) continue;
    if (r.plan.overlays?.some((o) => o.text.toLowerCase().includes(cta.site.toLowerCase()))) continue;
    const total = len(r.plan);
    const segments = lengthenFootage(r.plan.segments, total + 3, (id) => store.clip(id)?.duration ?? 0);
    const longer = segments.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
    const overlays = spreadPoints(
      (r.plan.overlays ?? [{ text: r.plan.hook, start: 0, end: total + 1 }]).map((o, i) =>
        o.end > total ? { ...o, end: i === 0 ? longer + 1 : total } : o,
      ),
    );
    overlays.push({ text: cta.overlay, start: total, end: longer + 1, y: 0.5, cta: true });
    const fresh = queueRender({ ...r.plan, segments, overlays }, r.options, r.batch, { countUse: false });
    if (r.review === "approved") store.updateRender(fresh.id, { review: "approved", reviewedAt: r.reviewedAt });
    deleteRender(r.id);
    n++;
  }
  if (n) console.log(`[cta] added the call to action to ${n} educational video(s)`);
  return n;
}

/** Educational videos already made: their points zig-zag over the frame too (same text, re-made once). */
export function zigzagExisting(): number {
  const site = store.settings().cta?.site?.toLowerCase() ?? "";
  let n = 0;
  for (const r of [...store.renders()]) {
    if (r.plan.format !== "tips" || r.status !== "done" || r.posts?.length) continue;
    if (r.review !== "pending" && r.review !== "approved") continue;
    if (!r.plan.segments.every((s) => store.clip(s.clipId)?.status === "ready")) continue;
    const all = r.plan.overlays ?? [];
    const cta = all.filter((o) => site && o.text.toLowerCase().includes(site));
    const rest = all.filter((o) => !cta.includes(o));
    if (rest.length < 3 || rest.slice(1).every((o) => o.x !== undefined)) continue;
    const fresh = queueRender({ ...r.plan, overlays: [...spreadPoints(rest), ...cta] }, r.options, r.batch, { countUse: false });
    if (r.review === "approved") store.updateRender(fresh.id, { review: "approved", reviewedAt: r.reviewedAt });
    deleteRender(r.id);
    n++;
  }
  if (n) console.log(`[layout] points now zig-zag in ${n} educational video(s)`);
  return n;
}

/**
 * Educational videos not posted yet get the numbered-point look (number tab, one width, the hook
 * shrinking into a header). Same text and footage: only the text is drawn again.
 */
export function numberTabsExisting(): number {
  let n = 0;
  for (const r of [...store.renders()]) {
    if (r.plan.format !== "tips" || r.status !== "done" || r.posts?.length) continue;
    if (r.review !== "pending" && r.review !== "approved") continue;
    if (!r.plan.segments.every((s) => store.clip(s.clipId)?.status === "ready")) continue;
    if (!(r.plan.overlays ?? []).some((o) => o.y !== undefined && /^\s*\d{1,2}[.):]\s/.test(o.text))) continue;
    const fresh = queueRender(r.plan, r.options, r.batch, { countUse: false });
    if (r.review === "approved") store.updateRender(fresh.id, { review: "approved", reviewedAt: r.reviewedAt });
    deleteRender(r.id);
    n++;
  }
  if (n) console.log(`[layout] numbered points redrawn in ${n} educational video(s)`);
  return n;
}

/**
 * Videos waiting or kept (not posted) whose call to action was drawn like a point: drawn again with
 * it centered. The same plan, the editor's review carried over (not reviewed again).
 */
export function ctaCenterExisting(): number {
  const text = store.settings().cta?.overlay;
  const isCta = (o: Overlay) => o.y !== undefined && /link in bio|flywith\.pet/i.test(o.text);
  let n = 0;
  for (const r of [...store.renders()]) {
    if (r.status !== "done" || r.posts?.length || (r.review !== "pending" && r.review !== "approved")) continue;
    if (!r.plan.segments.every((s) => store.clip(s.clipId)?.status === "ready")) continue;
    const overlays = r.plan.overlays ?? [];
    // Not centered yet, or still the old wording ("link in bio").
    if (!overlays.some((o) => isCta(o) && (!o.cta || (!!text && o.text !== text)))) continue;
    const plan = { ...r.plan, editorPass: EDITOR_ATTEMPTS, overlays: overlays.map((o) => (isCta(o) ? { ...o, text: text || o.text, y: 0.5, x: undefined, cta: true } : o)) };
    const fresh = queueRender(plan, r.options, r.batch, { countUse: false, standby: !!r.standby });
    store.updateRender(fresh.id, { ...(r.review === "approved" ? { review: "approved", reviewedAt: r.reviewedAt } : {}), ...(r.editor ? { editor: r.editor } : {}) });
    deleteRender(r.id);
    n++;
  }
  if (n) console.log(`[layout] call to action centered in ${n} video(s)`);
  return n;
}

/**
 * Educational videos waiting in Review that open on weaker footage: the seconds under the headline
 * swapped for the strongest opening there is (same length and text). The editor's review stays.
 */
export function openerExisting(): number {
  let n = 0;
  const taken: Clip[] = [];
  for (const r of [...store.renders()]) {
    if (r.plan.format !== "tips" || r.status !== "done" || r.review !== "pending" || r.posts?.length) continue;
    if (!r.plan.segments.every((s) => store.clip(s.clipId)?.status === "ready")) continue;
    const first = store.clip(r.plan.segments[0]?.clipId ?? "");
    if (!first || strongFootage(first)) continue;
    const opener = openerFor(first, [...taken, ...r.plan.segments.map((s) => store.clip(s.clipId)).filter((c): c is Clip => !!c)]);
    if (!opener) continue;
    taken.push(opener);
    const overlays = r.plan.overlays ?? [];
    const firstPoint = overlays.find((o, i) => i > 0 && o.y !== undefined)?.start ?? 2.5;
    const plan = { ...r.plan, editorPass: EDITOR_ATTEMPTS, segments: withOpener(r.plan.segments, opener, Math.max(1.5, Math.min(3, firstPoint))) };
    const fresh = queueRender(plan, r.options, r.batch, { countUse: false, standby: !!r.standby });
    if (r.editor) store.updateRender(fresh.id, { editor: r.editor });
    deleteRender(r.id);
    console.log(`[layout] ${r.id} opens on ${opener.id} (${opener.scene}) → ${fresh.id}`);
    n++;
  }
  return n;
}

const REMAKE_BRIEF: Record<string, (text: string, note?: string) => string> = {
  text: (t, n) =>
    `REMAKE: the creator rejected a video of this clip because the TEXT was off. The rejected text was "${t}". ` +
    `Write clearly different, better on-screen text${n ? `; in their words: "${n}"` : ""}.`,
  edit: (t, n) =>
    `REMAKE: the creator rejected a video of this clip because the CUT was off (the part used, the pacing or the ` +
    `timing). Use a different, stronger part of the clip and tighter pacing${n ? `; in their words: "${n}"` : ""}. ` +
    `The text can stay close to "${t}" if it worked.`,
  clip: (t, n) =>
    `REMAKE: the creator rejected a video because the FOOTAGE wasn't good enough. Same kind of video on this new ` +
    `clip; the earlier text was "${t}"${n ? `; in their words: "${n}"` : ""}.`,
  other: (t, n) =>
    `REMAKE: the creator rejected a video of this clip. ${n ? `In their words: "${n}". Fix exactly that.` : "Something was off: make it clearly better."} ` +
    `The rejected text was "${t}".`,
};

/**
 * "Redo with this feedback": the creator agrees with the editor's review, so the video is set aside
 * and made again with the editor's notes as direction (new text, a new cut, or other footage, the
 * way the review pointed). Goes past the daily limit by a little, like any tap by the creator.
 */
export async function redoFromEditor(id: string): Promise<Render> {
  const r = store.render(id);
  if (!r) throw new Error("That video is gone.");
  const e = r.editor;
  if (!e) throw new Error("This video has no editor's review.");
  if (r.remadeAs === "pending" && Date.now() - Date.parse(r.reviewedAt ?? "") < 15 * 60_000) throw new Error("It's already being made again.");
  const p = e.parts;
  const reason: Render["rejectReason"] = e.verdict === "fix_text" ? "text" : p && (p.hook.visual < 7 || p.body.visual < 6) ? "clip" : "edit";
  const notes = [e.remakeBrief, ...e.issues, ...(p ? Object.values(p).map((x) => x.note) : [])].filter(Boolean).join(" ");
  const before = { review: r.review, reviewedAt: r.reviewedAt, rejectReason: r.rejectReason, rejectNote: r.rejectNote, rejectedBy: r.rejectedBy, remadeAs: r.remadeAs };
  store.updateRender(id, {
    review: "rejected",
    reviewedAt: new Date().toISOString(),
    rejectReason: reason,
    rejectNote: `Editor's review: ${notes}`.slice(0, 1200),
    rejectedBy: undefined,
    remadeAs: undefined,
  });
  syncClipUses(id);
  const fresh = await remakeRejected(id, { force: true, manual: true }).catch(() => undefined);
  if (!fresh) {
    store.updateRender(id, before);
    syncClipUses(id);
    throw new Error("It couldn't be made again right now (no AI credit, no fitting footage, or 3 remakes in a row already).");
  }
  return fresh;
}

/**
 * A rejected video with a reason gets a new version straight away, of the same kind: new text on the
 * same clip, a new cut, or the same idea on other footage, with the creator's words as direction.
 * Replacements don't count against the daily limit (they replace one that did); at most 3 in a row.
 */
export async function remakeRejected(id: string, { force = false, editorPass = 0, manual = false } = {}): Promise<Render | undefined> {
  const r = store.render(id);
  // Every rejected video is replaced by another of its kind (so each day ends with one of each),
  // also without a reason; videos made on request (stories, vlogs) aren't.
  if (!r || r.review !== "rejected" || r.remadeAs || !r.rejectReason || r.plan.format === "story" || r.plan.collab) return undefined;
  if (videosLeftToday() + (manual ? MANUAL_EXTRA : 0) <= 0) return undefined;
  // Its kind already has a video in Review and a spare (the reason came after they were made): the
  // reason still counts as feedback, but no third video of the kind.
  const kindOf = r.plan.format;
  if (!force && kindOf && waitingOf(kindOf) > 0 && sparesOf(kindOf).length > 0) return undefined;
  if (!config.claude.enabled || !aiAvailable()) return undefined;
  const depth = (r.plan.remakeDepth ?? 0) + 1;
  if (depth > 3) return undefined;
  const kind: PostFormat = r.plan.format ?? "fun";
  const oldText = (r.plan.overlays?.map((o) => o.text) ?? [r.plan.hook]).join(" / ");
  const used = new Set(r.plan.segments.map((s) => s.clipId));
  const main = store.clip(r.plan.segments[0]?.clipId ?? "");
  let clip: Clip | undefined = main;
  if ((r.rejectReason === "clip" || !main || main.status !== "ready") && r.plan.outside) {
    clip = outsideClips().find((c) => !used.has(c.id));
  } else if (r.rejectReason === "clip" || !main || main.status !== "ready") {
    clip = store
      .clips()
      .filter((c) => c.status === "ready" && c.kind === "video" && isPortrait(c) && c.uses === 0 && !c.disliked && onTopic(c) && !used.has(c.id))
      .sort((a, b) => Number(b.scene === main?.scene) - Number(a.scene === main?.scene) || filmedWeek(b) - filmedWeek(a) || bestMoment(b) - bestMoment(a) || b.duration - a.duration)[0];
  }
  if (!clip) return undefined;
  store.updateRender(id, { remadeAs: "pending" });
  const { fontId, textStyle, textSize } = store.settings();
  const options = { keepOriginalAudio: true, textStyle, textSize, fontId };
  try {
    const { plans } = await plan({
      template: "auto",
      targetSeconds: store.auto().targetSeconds,
      count: 1,
      clipIds: [clip.id],
      useAi: true,
      format: kind,
      pillar: pillarOf(r.plan.pillar),
      brief: REMAKE_BRIEF[r.rejectReason ?? "other"](oldText, r.rejectNote),
      options,
    });
    const p = plans[0];
    if (!p) throw new Error("no plan");
    // A spare already stepped in for the rejected one: this becomes the new spare.
    const asSpare = !!kindOf && (!!r.standby || waitingOf(kindOf) > 0);
    const fresh = queueRender({ ...p, remakeOf: r.id, remakeDepth: depth, ...(editorPass ? { editorPass } : {}) }, options, localDate(new Date()), { standby: asSpare });
    store.updateRender(id, { remadeAs: fresh.id });
    console.log(`[remake] ${r.id} (${r.rejectReason}) → ${fresh.id}`);
    return fresh;
  } catch (err) {
    store.updateRender(id, { remadeAs: undefined });
    console.warn(`[remake] couldn't remake ${id}:`, (err as Error).message);
    return undefined;
  }
}
