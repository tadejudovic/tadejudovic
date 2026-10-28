import fs from "node:fs";
import { config } from "./config.ts";
import { store } from "./store.ts";
import { structured } from "./ai/director.ts";
import { aiAvailable } from "./ai/budget.ts";
import type { Clip, GenerateRequest, TextStyle } from "./types.ts";
import { bestMoment, hasLex, plan, queueRender, strongFootage, together } from "./generate.ts";

export type Topic = { title: string; why: string; audience: "niche" | "everyone"; clipId?: string };

/** What onboarding needs to show: where the creator is, and what's been set up so far. */
export function onboardingState() {
  const s = store.settings();
  const clips = store.clips().filter((c) => c.kind === "video");
  const first = latestVersion(s.firstVideoId);
  // The creator's own footage, newest first, so every screen shows their videos, not stock images.
  const recent = [...clips].sort((a, b) => b.importedAt.localeCompare(a.importedAt)).slice(0, 12);
  return {
    done: !!s.onboardedAt,
    footage: recent.map((c) => ({ id: c.id, status: c.status, scene: c.scene, looked: looked(c), thumb: Boolean(c.thumb) })),
    firstVideo: first
      ? { id: first.id, status: first.status, progress: first.progress, hook: first.plan.hook, review: first.review, remaking: first.remadeAs === "pending" }
      : null,
    google: { connected: Boolean(store.google()) },
    clips: { total: clips.length, ready: clips.filter((c) => c.status === "ready").length, looked: clips.filter(looked).length },
    topics: s.topics ?? [],
    textStyle: s.textStyle,
    billing: s.billing ?? null,
  };
}

const looked = (c: Clip) => c.status === "ready" && Boolean(c.ai?.summary);

/** Topics suggested when the AI can't look (or there's no footage yet): broad ones that fit most rolls. */
const FALLBACK: Topic[] = [
  { title: "Everyday moments", why: "The small, real moments people relate to.", audience: "everyone" },
  { title: "Travel", why: "Trips, airports and places you've been.", audience: "everyone" },
  { title: "Behind the scenes", why: "How you do what you do.", audience: "niche" },
  { title: "Tips from experience", why: "What you've learned, shown with your footage.", audience: "niche" },
];

/**
 * Topics for the creator's videos, from what's in their footage: the small model looks at a few
 * frames and what the AI saw in each clip, and names 5 topics their camera roll can SHOW, each
 * for their niche or for everyone.
 */
export async function suggestTopics(): Promise<Topic[]> {
  const clips = store
    .clips()
    .filter(looked)
    .sort((a, b) => (b.capturedAt ?? b.importedAt).localeCompare(a.capturedAt ?? a.importedAt))
    .slice(0, 24);
  if (!clips.length || !config.claude.enabled || !aiAvailable()) return FALLBACK.map((t, i) => ({ ...t, clipId: clips[i % Math.max(1, clips.length)]?.id }));
  const content: Parameters<typeof structured>[0]["content"] = [];
  for (const c of clips.slice(0, 6)) {
    const jpg = c.thumb && fs.existsSync(c.thumb) ? fs.readFileSync(c.thumb) : null;
    if (jpg) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
  }
  content.push({
    type: "text",
    text:
      `A creator's camera roll: a few frames above, and what's in ${clips.length} of their videos:\n` +
      clips.map((c, i) => `${i + 1}. ${c.scene ? `[${c.scene}] ` : ""}${c.ai!.summary}`).join("\n") +
      "\n\nSuggest 5 topics for short TikTok / Reels videos this footage can actually SHOW, most promising first. " +
      "Each: a 1–4 word title (\"Flying with a dog\", \"Home cooking\", \"Van life\"), one short line on why it fits " +
      "this footage, and who it speaks to: \"niche\" (people already into this, e.g. dog lovers) or \"everyone\" " +
      "(a moment anyone recognizes). Also give the number of the video above that shows it best.",
  });
  try {
    const r = await structured<{ topics: (Topic & { clip?: number })[] }>({
      system: "You help new creators find what their videos should be about, from the footage they already have.",
      content,
      model: config.claude.fastModel,
      effort: "low",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["topics"],
        properties: {
          topics: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "why", "audience", "clip"],
              properties: { title: { type: "string" }, why: { type: "string" }, audience: { type: "string", enum: ["niche", "everyone"] }, clip: { type: "integer" } },
            },
          },
        },
      },
    });
    const topics = r.topics.filter((t) => t.title?.trim()).slice(0, 6);
    return topics.length
      ? topics.map(({ clip, ...t }, i) => ({ ...t, title: t.title.trim().slice(0, 40), why: t.why.trim().slice(0, 140), clipId: clips[(clip ?? i + 1) - 1]?.id ?? clips[i % clips.length].id }))
      : FALLBACK;
  } catch (e) {
    console.warn("[onboarding] topic suggestions failed:", (e as Error).message);
    return FALLBACK;
  }
}

/**
 * The chosen topics steer every video, and who the text speaks to follows from them: all for the
 * niche → written for that niche, all for everyone → for everyone, both → alternating.
 */
export function saveTopics(topics: { title: string; audience: "niche" | "everyone" }[]) {
  const clean = topics
    .filter((t) => typeof t?.title === "string" && t.title.trim())
    .map((t) => ({ title: t.title.trim().slice(0, 40), audience: t.audience === "everyone" ? ("everyone" as const) : ("niche" as const) }))
    .slice(0, 5);
  const niche = clean.filter((t) => t.audience === "niche").length;
  const captionAudience = !clean.length ? store.settings().captionAudience : niche === clean.length ? "pets" : niche === 0 ? "everyone" : "mix";
  return store.updateSettings({ topics: clean, captionAudience });
}

/** Luhn check: a card number that could be real (test mode still checks it was typed right). */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return digits.length >= 12 && sum % 10 === 0;
}

const TRIAL_DAYS = 7;

/**
 * Starts the free trial. TEST MODE: there's no payment provider yet, nothing is charged and the card
 * number is never stored; only its brand and last four digits are kept, to show on the plan.
 */
export function startTrial(card: { number?: unknown; exp?: unknown; cvc?: unknown }, save = true) {
  const digits = String(card.number ?? "").replace(/\D/g, "");
  if (!luhn(digits)) throw new Error("That card number doesn't look right. In test mode, use 4242 4242 4242 4242.");
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(String(card.exp ?? "").trim());
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) throw new Error("Expiry as MM/YY, e.g. 12/29.");
  const expEnd = new Date(Date.UTC(2000 + Number(m[2]), Number(m[1]), 1));
  if (expEnd.getTime() < Date.now()) throw new Error("That card has expired.");
  if (!/^\d{3,4}$/.test(String(card.cvc ?? "").trim())) throw new Error("The 3 or 4 digits on the back.");
  const brand = /^4/.test(digits) ? "Visa" : /^(5[1-5]|2[2-7])/.test(digits) ? "Mastercard" : /^3[47]/.test(digits) ? "Amex" : "Card";
  const now = new Date();
  const billing = {
    plan: "trial" as const,
    startedAt: now.toISOString(),
    trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 86400_000).toISOString(),
    card: { brand, last4: digits.slice(-4) },
    test: true as const,
  };
  if (save) store.updateSettings({ billing });
  return billing;
}

/**
 * The newest version of a video: the editor's check or the creator's ✗ can make it again, and the
 * first video on screen follows along to the remade one.
 */
function latestVersion(id?: string) {
  let r = id ? store.render(id) : undefined;
  for (let i = 0; i < 10 && r?.remadeAs && r.remadeAs !== "pending"; i++) {
    const next = store.render(r.remadeAs);
    if (!next) break;
    r = next;
  }
  return r;
}

/** Finishing without topics: the ones the footage suggests most strongly steer the videos. */
export async function topicsIfNone() {
  if (store.settings().topics?.length) return;
  const topics = await suggestTopics();
  if (!store.settings().topics?.length) saveTopics(topics.slice(0, 3));
}

/** The first video, made while onboarding explains how it's made (one video, from the best clips). */
export async function makeFirstVideo(look: { textStyle?: TextStyle } = {}): Promise<string> {
  const s = store.settings();
  const existing = latestVersion(s.firstVideoId);
  if (existing && existing.status !== "error") return existing.id;
  // Built around the single best clip they picked (the strongest footage and moment, not the next
  // one in the daily rotation); the rest of their picks can fill in around it.
  const best = store
    .clips()
    .filter((c) => c.status === "ready" && c.kind === "video" && c.height >= c.width && c.ai?.summary && hasLex(c) && !c.disliked)
    .sort((a, b) => Number(strongFootage(b)) + Number(together(b)) - Number(strongFootage(a)) - Number(together(a)) || bestMoment(b) - bestMoment(a))[0];
  const req: GenerateRequest = {
    template: "auto",
    targetSeconds: 15,
    count: 1,
    useAi: true,
    pickFromPool: true,
    clipIds: best ? [best.id] : undefined,
    options: { keepOriginalAudio: true, textStyle: look.textStyle ?? s.textStyle, textSize: s.textSize, fontId: s.fontId, ...(look.textStyle ? { lookPicked: true } : {}) },
  };
  const { plans } = await plan(req);
  if (!plans.length) throw new Error("No clips are ready yet.");
  const r = queueRender(plans[0], req.options);
  store.updateSettings({ firstVideoId: r.id });
  return r.id;
}
