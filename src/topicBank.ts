import { store } from "./store.ts";
import { config } from "./config.ts";
import { structured } from "./ai/director.ts";
import { aiAvailable } from "./ai/budget.ts";
import { trendingSounds } from "./sounds.ts";
import { coveredTopics, travelRoutes } from "./generate.ts";
import type { Clip, EduPillar, PostFormat, SearchTopic } from "./types.ts";

/**
 * The topic bank: what the videos talk about, researched from every source the app has, so the
 * videos go both broad and specific, reach dog owners, people thinking about a dog and people who will
 * never have one, and don't keep coming back to the same few subjects.
 *
 * Once a week (or when asked), one research pass reads:
 * - what people search: TikTok's search analytics for this account, Google Keyword Planner, and
 *   search autocomplete (Settings > What people search);
 * - what followers ask: the creator's FAQ and the questions in the comments on their TikToks;
 * - flywith.pet's priority routes and destinations (where people most need help), and the trips Lex
 *   actually made;
 * - what's trending right now: sounds being picked up fast, and the most-viewed captions found on
 *   TikTok for each situation;
 * - the footage on hand (unused clips, with what's in them), and everything already covered;
 * and turns it into about 60 concrete ideas, each tied to the clips that fit it (footage first: the
 * trend is matched to what we have). Each new video takes the next idea for its kind: high demand,
 * footage that fits, not done lately, and the audiences and themes kept in balance.
 */

export type TopicAudience = "owners" | "considering" | "everyone";

export interface TopicIdea {
  id: string;
  /** Concrete, e.g. "Taking a dog from the US to Japan: the 180-day wait". */
  title: string;
  kind: "tips" | "fun" | "inspire";
  audience: TopicAudience;
  /** Educational: Flights, Trips or Tricks. */
  pillar?: EduPillar;
  specificity: "broad" | "specific";
  /** Which sources it comes from ("tiktok search", "keyword planner", "comments", "flywith routes", "trend", …). */
  sources: string[];
  /** How much people want it, 1 (niche) to 5 (huge), from the numbers in the sources. */
  demand: number;
  /** The toothbrush test: how many people it touches (1 few … 5 nearly everyone in the audience)… */
  reach?: number;
  /** …and how often it touches them (1 once in a lifetime, 3 every trip, 5 every day or several times a day). */
  frequency?: number;
  /** The trend, format or sound it rides on, when there is one. */
  trend?: string;
  /** Clips from the library that fit it (footage first). */
  clipIds: string[];
  /** A first idea for the on-screen hook. */
  hook?: string;
  why?: string;
}

export interface TopicBank {
  at: string;
  ideas: TopicIdea[];
}

/** flywith.pet's priority routes: ranked by search volume and how hard people find them. */
export const FLYWITH_ROUTES: { route: string; why: string; tier: number }[] = [
  { route: "US → EU", why: "huge volume; one set of EU rules covers 27 countries", tier: 1 },
  { route: "US → UK", why: "post-Brexit rules confuse people constantly", tier: 1 },
  { route: "US → Australia", why: "strict biosecurity, very anxious searches", tier: 1 },
  { route: "US → Japan", why: "notorious quarantine rules, lots of expat traffic", tier: 1 },
  { route: "UK/Ireland → US", why: "return trips for expats", tier: 1 },
  { route: "within the EU", why: "common, and the EU pet passport makes it simple", tier: 1 },
  { route: "Australia → New Zealand", why: "trans-Tasman pet travel is common", tier: 2 },
  { route: "US → Canada", why: "cross-border, deceptively complex", tier: 2 },
  { route: "US → UAE", why: "expat hub, lots of pet relocation", tier: 2 },
  { route: "Singapore → anywhere", why: "an expat community that moves with pets constantly", tier: 2 },
  { route: "Southeast Asia (Thailand, Indonesia, Philippines)", why: "complex and poorly documented", tier: 3 },
  { route: "South America (Brazil, Argentina)", why: "growing demand", tier: 3 },
];

/** The share of videos each audience gets over time. */
export const AUDIENCE_SHARE: Record<TopicAudience, number> = { owners: 0.45, considering: 0.2, everyone: 0.35 };

const BANK_MAX_AGE_MS = 7 * 86400_000;
/** A topic isn't used again for this long. */
const REUSE_AFTER_MS = 45 * 86400_000;

/** The research pass running now (one at a time), and the last one's error, for the app to show. */
let running: Promise<TopicBank> | null = null;
let runningSince: string | null = null;
let lastError: { message: string; at: string } | null = null;
export const topicResearchStatus = () => ({ running: !!running, since: runningSince, error: lastError });

/** Start a research pass in the background (or join the one running); errors are kept for the app. */
export function startTopicResearch(): Promise<TopicBank> {
  if (running) return running;
  runningSince = new Date().toISOString();
  lastError = null;
  running = researchTopics()
    .catch((err) => {
      lastError = { message: (err as Error).message, at: new Date().toISOString() };
      console.warn("[topics]", (err as Error).message);
      throw err;
    })
    .finally(() => {
      running = null;
      runningSince = null;
    });
  running.catch(() => {});
  return running;
}

export function topicBank(): TopicBank | undefined {
  return store.settings().topicBank;
}

/** Whether the bank should be researched again: never done, a week old, or a source changed since. */
export function topicBankStale(): boolean {
  const s = store.settings();
  const at = Date.parse(s.topicBank?.at ?? "") || 0;
  if (Date.now() - at > BANK_MAX_AGE_MS) return true;
  const changed = [s.searchTopicsAt, s.keywordTopicsAt, s.suggestTopicsAt, s.audience?.at].some((x) => (Date.parse(x ?? "") || 0) > at);
  return changed;
}

/** The footage on hand that can still carry a video: ready, unused, upright, with a description. */
function footageOnHand(): Clip[] {
  return store
    .clips()
    .filter((c) => c.status === "ready" && c.kind === "video" && !c.uses && !c.duplicateOf && !c.disliked && !c.edited && c.height >= c.width && c.ai?.summary)
    .sort((a, b) => String(b.capturedAt ?? b.importedAt).localeCompare(String(a.capturedAt ?? a.importedAt)));
}

const listTopics = (label: string, ts: SearchTopic[] | undefined, unit: string, n = 30) =>
  ts?.length
    ? `\n${label} (most first):\n` +
      [...ts].sort((a, b) => b.impressions - a.impressions).slice(0, n).map((t) => `- ${t.topic} [${t.pillar}] ${t.impressions.toLocaleString("en")} ${unit}; e.g. ${t.queries.slice(0, 3).join(" | ")}`).join("\n")
    : `\n${label}: none loaded yet.`;

/** Everything the research pass reads, as text. */
export function sourcesText(): string {
  const s = store.settings();
  const research = store.researchAll();
  const proven = research
    .flatMap((r) => r.captions.filter((c) => (c.views ?? 0) > 0).map((c) => ({ scene: r.scene, text: c.original || c.text, views: c.views ?? 0 })))
    .sort((a, b) => b.views - a.views)
    .slice(0, 25);
  const sounds = trendingSounds(10);
  const clips = footageOnHand().slice(0, 70);
  const questions = s.audience?.questions ?? [];
  return [
    listTopics("WHAT PEOPLE SEARCH ON TIKTOK (this account's search analytics)", s.searchTopics, "impressions"),
    listTopics("WHAT PEOPLE SEARCH ON GOOGLE (Keyword Planner, everyone)", s.keywordTopics, "searches a month"),
    listTopics("WHAT PEOPLE TYPE (search autocomplete)", s.suggestTopics, "weight", 25),
    `\nFOLLOWERS' QUESTIONS (the creator's FAQ):\n` + (s.faq?.length ? s.faq.slice(0, 30).map((f) => `- ${f.q}${f.a ? ` (answer: ${f.a.slice(0, 160)})` : ""}`).join("\n") : "none"),
    `\nQUESTIONS IN THE COMMENTS on the creator's TikToks (most liked first):\n` + (questions.length ? [...questions].sort((a, b) => b.likes - a.likes).slice(0, 25).map((q) => `- ${q.text} (${q.likes} likes)`).join("\n") : "none read yet"),
    `\nFLYWITH.PET PRIORITY ROUTES (where people most need help; tier 1 first):\n` + FLYWITH_ROUTES.map((r) => `- tier ${r.tier}: ${r.route}: ${r.why}`).join("\n"),
    `\nTRIPS ${s.petName.toUpperCase()} ACTUALLY MADE (from the footage, most recent first): ${travelRoutes(10).join("; ") || "none known"}`,
    `\nTRENDING NOW: sounds being picked up fast on travel/dog TikTok:\n` + (sounds.length ? sounds.map((x) => `- "${x.name}"${x.author ? ` by ${x.author}` : ""}: ${x.recent} new posts in 3 days (${x.growth.toFixed(1)}x faster)`).join("\n") : "none read yet"),
    `\nTRENDING NOW: the most-viewed TikTok captions found for our situations:\n` + (proven.length ? proven.map((p) => `- [${p.scene}] "${p.text.slice(0, 120)}" ${p.views.toLocaleString("en")} views`).join("\n") : "none found yet"),
    `\nTHE FOOTAGE ON HAND (unused clips; use their ids in clipIds):\n` + (clips.length ? clips.map((c) => `- ${c.id} [${c.scene ?? "?"}${c.place ? `, ${c.place}` : ""}] ${c.ai!.summary!.slice(0, 160)}`).join("\n") : "none"),
    `\nALREADY COVERED (don't repeat): ${coveredTopics().slice(0, 40).join("; ") || "nothing yet"}`,
  ].join("\n");
}

export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ideas"],
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "kind", "audience", "specificity", "sources", "demand", "reach", "frequency", "clipIds"],
        properties: {
          title: { type: "string" },
          kind: { type: "string", enum: ["tips", "fun", "inspire"] },
          audience: { type: "string", enum: ["owners", "considering", "everyone"] },
          pillar: { type: "string", enum: ["airline", "destination", "prep"] },
          specificity: { type: "string", enum: ["broad", "specific"] },
          sources: { type: "array", items: { type: "string" } },
          demand: { type: "integer" },
          reach: { type: "integer" },
          frequency: { type: "integer" },
          trend: { type: "string" },
          clipIds: { type: "array", items: { type: "string" } },
          hook: { type: "string" },
          why: { type: "string" },
        },
      },
    },
  },
};

/** One research pass over every source: about 60 ideas, each tied to the footage that fits. */
export async function researchTopics(): Promise<TopicBank> {
  if (!config.claude.enabled || !aiAvailable()) throw new Error("The AI is off or out of credit, so topics can't be researched right now.");
  const { petName } = store.settings();
  const onHand = new Set(footageOnHand().map((c) => c.id));
  const r = await structured<{ ideas: Omit<TopicIdea, "id">[] }>({
    system:
      `You plan the content of a TikTok/Instagram account about traveling the world with a small dog (${petName}), ` +
      `and its site flywith.pet (planning trips with a pet). You think like a content strategist with real data in front of you.`,
    content: [
      {
        type: "text",
        text:
          `Here is everything we know about what people want, what's trending, and the footage we have.\n${sourcesText()}\n\n` +
          `Plan about 60 video ideas from it:\n` +
          `- KINDS: about 25 educational (tips: something useful, clearly answered), 18 fun (a joke or relatable moment), ` +
          `17 inspirational (a feeling or thought worth keeping).\n` +
          `- AUDIENCES, across every kind: about 45% dog OWNERS (practical, insider), 20% people CONSIDERING a dog or ` +
          `wondering if a dog fits their travelling life (honest costs, effort, which dogs suit it, what life is really like), ` +
          `and 35% EVERYONE, including people who will never have a dog (curiosity like "where do dogs pee on an 11-hour ` +
          `flight", the human side of travel, feelings anyone has).\n` +
          `- THE TOOTHBRUSH TEST comes first: favour the problems that touch the most people, most often (every day, ` +
          `several times a day), over rare ones. A walk, a meal, being left alone, the potty routine, the daily carry, ` +
          `the everyday moment anyone recognizes beat a once-a-year customs form. Rate each idea's reach (1 few … 5 nearly ` +
          `everyone in its audience) and frequency (1 once in a lifetime, 3 every trip, 5 daily or several times a day). ` +
          `Travel-specific ideas still belong, but tie them to the everyday side where you can (the daily routine on the road, ` +
          `the carrier as everyday gear) and keep the rare-but-searched ones (country rules) for the specific half.\n` +
          `- BREADTH AND DEPTH: half broad (a guide anyone in the audience needs), half specific (one airline, one route, ` +
          `one rule, one moment). Use the flywith.pet routes and the search data for the specific ones.\n` +
          `- VARIETY: no two ideas about the same thing; spread the educational ones over Flights (airline), Trips ` +
          `(destination) and Tricks (prep, incl. the airport day); never anything in ALREADY COVERED.\n` +
          `- DEMAND, REACH, FREQUENCY: whole numbers from 1 to 5. DEMAND: rate 1–5 from the numbers in the sources (search volumes, impressions, comment likes, views); say ` +
          `which sources each idea comes from (e.g. "tiktok search", "keyword planner", "autocomplete", "comments", ` +
          `"faq", "flywith routes", "lex's trips", "trend").\n` +
          `- TRENDS, FOOTAGE FIRST: go through the footage on hand and match clips to the trends, formats and sounds that ` +
          `are working now (and to the searches), so most ideas can be made from clips we already have. Put the fitting ` +
          `clip ids in clipIds (only ids from the list; empty if none fits) and name the trend, format or sound in trend.\n` +
          `- Give each a concrete title, a first hook idea, and one line on why it will work.\n` +
          `Only facts you can stand behind; for rules (airlines, countries) keep titles about the question, not a claimed answer.`,
      },
    ],
    schema: SCHEMA,
    effort: "medium",
  });
  const ideas: TopicIdea[] = r.ideas
    .filter((x) => x.title?.trim())
    .map((x, i) => ({
      ...x,
      id: `${Date.now().toString(36)}-${i}`,
      title: x.title.trim().slice(0, 160),
      pillar: x.kind === "tips" ? (x.pillar as EduPillar | undefined) : undefined,
      demand: Math.max(1, Math.min(5, Math.round(x.demand || 1))),
      reach: Math.max(1, Math.min(5, Math.round(x.reach || 1))),
      frequency: Math.max(1, Math.min(5, Math.round(x.frequency || 1))),
      clipIds: [...new Set(x.clipIds ?? [])].filter((id) => onHand.has(id)).slice(0, 4),
      sources: (x.sources ?? []).slice(0, 6),
    }));
  const bank = { at: new Date().toISOString(), ideas };
  store.updateSettings({ topicBank: bank });
  console.log(`[topics] researched ${ideas.length} ideas (${(["tips", "fun", "inspire"] as const).map((k) => `${ideas.filter((x) => x.kind === k).length} ${k}`).join(", ")})`);
  return bank;
}

/** Ideas used in videos lately (not rejected), most recent first, with when. */
function usedLately(now = Date.now()): Map<string, number> {
  const used = new Map<string, number>();
  for (const r of store.renders()) {
    const id = r.plan.topicIdea?.id;
    const at = Date.parse(r.createdAt);
    if (id && r.review !== "rejected" && now - at < REUSE_AFTER_MS) used.set(id, Math.max(used.get(id) ?? 0, at));
  }
  return used;
}

/**
 * The idea a new video of this kind should take, for this clip: footage that fits it (the clip itself
 * best), high demand, not used in the last 45 days or this round, the audience and theme furthest
 * behind their share, and broad and specific taking turns.
 */
export function pickTopic(kind: PostFormat, clip: Clip | undefined, skip = new Set<string>(), now = Date.now()): TopicIdea | undefined {
  const k = kind === "tips" || kind === "inspire" ? kind : kind === "fun" ? "fun" : undefined;
  if (!k) return undefined;
  const ideas = (topicBank()?.ideas ?? []).filter((x) => x.kind === k && !skip.has(x.id));
  if (!ideas.length) return undefined;
  const used = usedLately(now);
  const fresh = ideas.filter((x) => !used.has(x.id));
  const pool = fresh.length ? fresh : ideas;
  const recent = store
    .renders()
    .filter((r) => r.plan.format === k && r.plan.topicIdea && r.review !== "rejected")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 9);
  const share = (a: TopicAudience) => recent.filter((r) => r.plan.topicIdea!.audience === a).length / Math.max(1, recent.length);
  const lastSpec = recent[0]?.plan.topicIdea?.specificity;
  const lastPillars = recent.slice(0, 2).map((r) => r.plan.topicIdea?.pillar);
  const ready = (id: string) => store.clip(id)?.status === "ready" && !store.clip(id)?.uses;
  const score = (x: TopicIdea) =>
    toothbrush(x) * 0.25 +
    x.demand * 0.4 +
    (clip && x.clipIds.includes(clip.id) ? 3 : 0) +
    (clip?.scene && x.clipIds.some((id) => store.clip(id)?.scene === clip.scene) ? 0.8 : 0) +
    (x.clipIds.some(ready) ? 0.5 : 0) +
    (x.trend ? 0.4 : 0) +
    (AUDIENCE_SHARE[x.audience] - share(x.audience)) * 4 +
    (lastSpec && x.specificity !== lastSpec ? 0.4 : 0) +
    (x.pillar && lastPillars.includes(x.pillar) ? -0.6 : 0) +
    (used.has(x.id) ? -5 : 0);
  return [...pool].sort((a, b) => score(b) - score(a))[0];
}

/** The toothbrush score: how many people it touches times how often (1 … 25). */
export const toothbrush = (x: Pick<TopicIdea, "reach" | "frequency" | "demand">) => (x.reach ?? x.demand) * (x.frequency ?? 3);

/** How the idea reads to the director. */
export function topicText(x: TopicIdea, petName: string): string {
  const who = {
    owners: "dog OWNERS: practical and specific, the insider details they'd save",
    considering: `people CONSIDERING a dog, or wondering if a dog fits a life of travel: honest, what it's really like (the effort, the cost, the joy), never preachy`,
    everyone: `EVERYONE, including people who will never have a dog: the curiosity or the human feeling anyone shares; ${petName} is how we show it`,
  }[x.audience];
  return (
    `\n\nTOPIC FOR THIS VIDEO (from our research of what people search, ask and watch): "${x.title}".` +
    `\nWho it's for: ${who}.` +
    (x.trend ? `\nIt rides on what's trending now: ${x.trend}. Use that format or feel, in our own words.` : "") +
    (x.hook ? `\nA first hook idea (improve it, don't just copy): "${x.hook}".` : "") +
    (x.why ? `\nWhy it should work: ${x.why}` : "") +
    `\nMake the video about this topic, told through the footage. If the footage can't carry it, take the closest angle the footage can carry and keep it for the same audience.`
  );
}
