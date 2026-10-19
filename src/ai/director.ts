import { lengthenFootage, spreadPoints, timePoints } from "../overlayLayout.ts";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { assertBudget, noteAiError, recordUsage } from "./budget.ts";
import { frameBuffer } from "../media/ffmpeg.ts";
import { TEMPLATES } from "../templates.ts";
import type { EduPillar, PostFormat, Clip, Example, Moment, Overlay, ProvenCaption, ReviewFeedback, Segment, TemplateId, TrendFormat, VideoPlan } from "../types.ts";

/**
 * The "AI director": Claude watches sampled frames of each clip once (cached on
 * the clip), then plans videos from that text catalog — so planning a day's
 * worth of videos is a cheap text-only call.
 */

let client: Anthropic | null = null;
// A request that hasn't answered in 5 minutes isn't coming; fail it so a round can't hang.
const anthropic = () => (client ??= new Anthropic({ timeout: 5 * 60_000, maxRetries: 2 }));

// Server-side fallback: if a request is declined, the API re-runs it on
// Anthropic's recommended fallback model instead of returning a refusal.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

export async function structured<T>(params: {
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[];
  schema: Record<string, unknown>;
  effort: "low" | "medium" | "high";
  /** Defaults to the main model. Haiku has no server-side fallback, so it's sent without one. */
  model?: string;
}): Promise<T> {
  assertBudget();
  const model = params.model ?? config.claude.model;
  const stream = anthropic().beta.messages.stream({
    ...(model.startsWith("claude-haiku") ? {} : FALLBACK),
    model,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort: params.effort, format: { type: "json_schema", schema: params.schema } },
    system: params.system,
    messages: [{ role: "user", content: params.content }],
  });
  const msg = await stream.finalMessage().catch((err) => {
    noteAiError(err);
    throw err;
  });
  recordUsage(msg);
  if (msg.stop_reason === "refusal") {
    throw new Error(`Claude declined this request (${msg.stop_details?.category ?? "unspecified"}).`);
  }
  if (msg.stop_reason === "max_tokens") throw new Error("Claude's response was cut off (max_tokens).");
  const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return JSON.parse(text) as T;
}

const MOMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["start", "end", "score", "description", "tags"],
  properties: {
    start: { type: "number" },
    end: { type: "number" },
    score: { type: "number", description: "0..1 — how likely this moment is to stop a scroll" },
    description: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
};

const TAG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "tags", "moments"],
  properties: {
    summary: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    moments: { type: "array", items: MOMENT_SCHEMA },
  },
};

/** Look at a clip: which situation it shows, and its best moments. */
export async function tagClip(
  clip: Clip,
  petName: string,
  scenes: string[],
  model = config.claude.fastModel,
): Promise<NonNullable<Clip["ai"]> & { scene: string; alreadyEdited: boolean }> {
  // Four frames on the small, fast model: enough to tell the situation and the best moments, for a tenth of a cent.
  const frames = Math.max(2, Math.min(4, Math.ceil(clip.duration / 2)));
  const times = Array.from({ length: frames }, (_, i) =>
    Math.round(((clip.duration * (i + 0.5)) / frames) * 10) / 10,
  );
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const t of times) {
    const jpg = await frameBuffer(clip.file, t);
    content.push({ type: "text", text: `Frame at t=${t}s` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
  }
  const energy = (clip.energy ?? [])
    .map((v, i) => `${(i * 0.5).toFixed(1)}s:${v.toFixed(2)}`)
    .join(" ");
  content.push({
    type: "text",
    text:
      `Clip "${clip.filename}", ${clip.duration.toFixed(1)}s long, has audio: ${clip.hasAudio}.\n` +
      `Motion+loudness energy per 0.5s (0..1): ${energy || "n/a"}\n\n` +
      (clip.note ? `The creator says about this footage: "${clip.note}"\n` : "") +
      `The pet in this footage is called ${petName}. Identify the moments (1.5–8s each, inside 0..${clip.duration.toFixed(1)}s) ` +
      `that would work in a short-form pet video, best first. Use the energy curve to place cut points on action and ` +
      `audio peaks (barks, reactions). Tags should be short and reusable across clips (e.g. zoomies, sleepy, ` +
      `side-eye, tricks, outdoors, bath, food, toy, cuddle, dramatic, puppy).\n\n` +
      `Also classify which situation the clip shows. Choose exactly one of: ${scenes.map((x) => `"${x}"`).join(", ")}, ` +
      `or "other" if none fits.\n\n` +
      `Finally, say whether this is already an edited video: text overlays, captions, titles or stickers added on top ` +
      `of the footage (e.g. a finished TikTok saved back to the phone). Text that's part of the scene itself ` +
      `(signs, screens, labels, a boarding pass) doesn't count.`,
  });
  const schema = {
    ...TAG_SCHEMA,
    required: [...TAG_SCHEMA.required, "scene", "alreadyEdited"],
    properties: {
      ...TAG_SCHEMA.properties,
      scene: { type: "string", enum: [...scenes, "other"] },
      alreadyEdited: { type: "boolean", description: "Text, captions or stickers were added on top of the footage" },
    },
  };
  const result = await structured<NonNullable<Clip["ai"]> & { scene: string; alreadyEdited: boolean }>({
    system:
      "You are a short-form video editor who specializes in viral pet content on TikTok, Reels and Shorts. " +
      "You judge footage by whether it stops the scroll in the first second: surprise, comedic timing, " +
      "expressive faces, sound, and relatable pet behavior. Be honest — static or blurry footage gets a low score.",
    content,
    schema,
    effort: "low",
    model,
  });
  result.moments = result.moments
    .map((m) => clampMoment(m, clip.duration))
    .filter((m): m is Moment => m !== null)
    .sort((a, b) => b.score - a.score);
  return result;
}

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["videos"],
  properties: {
    videos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "hook", "segments", "postCaption", "hashtags"],
        properties: {
          title: { type: "string", description: "Internal name for the video" },
          hook: { type: "string", description: "On-screen hook shown in the first ~2.5s. Max ~8 words, no emoji." },
          segments: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["clipId", "start", "end", "caption", "speed"],
              properties: {
                clipId: { type: "string" },
                start: { type: "number" },
                end: { type: "number" },
                caption: { type: "string", description: "On-screen text for this segment, or empty string. No emoji." },
                speed: { type: "number", description: "1 for normal, 0.5 for slow-mo payoff, up to 1.5" },
              },
            },
          },
          postCaption: { type: "string", description: "TikTok caption to post with, may include emoji" },
          hashtags: { type: "array", items: { type: "string" }, description: "Without the # sign" },
        },
      },
    },
  },
};

export async function planVideos(opts: {
  template: TemplateId;
  targetSeconds: number;
  count: number;
  brief?: string;
  clips: Clip[];
  petName: string;
  handle?: string;
  trends?: TrendFormat[];
}): Promise<VideoPlan[]> {
  const def = TEMPLATES[opts.template];
  const byId = new Map(opts.clips.map((c) => [c.id, c]));
  const catalog = opts.clips.map((c) => ({
    clipId: c.id,
    duration: c.duration,
    capturedAt: c.capturedAt ?? null,
    kind: c.kind,
    orientation: c.height >= c.width ? "portrait" : "landscape",
    timesAlreadyUsed: c.uses,
    summary: c.ai?.summary ?? null,
    tags: c.ai?.tags ?? [],
    moments: (c.ai?.moments ?? c.moments ?? []).slice(0, 6),
  }));
  const prompt =
    `Plan ${opts.count} distinct short-form videos of ${opts.petName}` +
    (opts.handle ? ` for the account ${opts.handle}` : "") +
    `.\n\nFormat: ${def.name}\n${def.playbook.replaceAll("{pet}", opts.petName)}\n\n` +
    `Each video must total ${opts.targetSeconds}s (±1s), computed as the sum of (end-start)/speed. ` +
    `Segments must use clipIds from the library and stay within each clip's duration; prefer the listed moments. ` +
    `Make the ${opts.count} videos clearly different from each other (different clips, angles and hooks), and favor ` +
    `clips with a low timesAlreadyUsed so the account doesn't repeat itself.` +
    (opts.trends?.length && (opts.template === "text_overlay" || opts.template === "pov_story")
      ? `\n\nText formats trending for pet accounts right now — adapt one per video so it fits what actually ` +
        `happens in the footage (don't force a format onto a clip it doesn't match, and use a different format ` +
        `for each video):\n${opts.trends.map((t) => `- ${t.pattern} (e.g. "${t.example.replaceAll("{pet}", opts.petName)}"; fits: ${t.fits})`).join("\n")}`
      : "") +
    (opts.brief ? `\n\nCreator's direction: ${opts.brief}` : "") +
    `\n\nLibrary:\n${JSON.stringify(catalog)}`;

  const result = await structured<{ videos: Omit<VideoPlan, "template" | "plannedBy">[] }>({
    system:
      "You are the head of content for a fast-growing pet creator. You know what makes short-form pet videos " +
      "perform: a hook in the first second, cut on action, captions that are relatable and funny without being " +
      "cringe, and endings that loop. Write in a natural creator voice. Hashtags: a mix of 3–6 broad and niche tags.",
    content: [{ type: "text", text: prompt }],
    schema: PLAN_SCHEMA,
    effort: "medium",
  });

  return result.videos.map((v) => ({
    ...v,
    template: opts.template,
    plannedBy: "claude" as const,
    hashtags: v.hashtags.map((h) => h.replace(/^#/, "")),
    segments: limitSlowMotion(v.segments
      .map((s) => validateSegment(s, byId))
      .filter((s): s is Segment => s !== null)),
  })).filter((v) => v.segments.length > 0);
}

function clampMoment(m: Moment, duration: number): Moment | null {
  const start = Math.max(0, Math.min(m.start, duration));
  const end = Math.max(0, Math.min(m.end, duration));
  if (end - start < 0.5) return null;
  return { ...m, start, end, score: Math.max(0, Math.min(1, m.score)) };
}

/**
 * Slow motion is an effect for one short payoff moment (a jump, a reaction), never a way to make a
 * video longer: at most one segment of up to 2.5s of footage is slowed, the rest plays at real speed.
 */
export function limitSlowMotion(segments: Segment[]): Segment[] {
  let used = false;
  return segments.map((s) => {
    if ((s.speed ?? 1) >= 1) return s;
    if (!used && s.end - s.start <= 2.5) {
      used = true;
      return { ...s, speed: Math.max(0.5, s.speed ?? 1) };
    }
    return { ...s, speed: 1 };
  });
}

/**
 * Whether an arrow points at what the text names: the AI described a visible object, and it shares a
 * real word with the text ("1. Kato backpack" / "black backpack under Lex").
 */
export function arrowTarget(text: string, pointAt: string): boolean {
  const words = (s: string) =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !["the", "and", "with", "his", "her", "dog", "lex", "our", "your"].includes(w)));
  const seen = words(pointAt ?? "");
  if (!seen.size) return false;
  const named = [...words(text)];
  return named.some((w) => [...seen].some((s) => s === w || (w.length >= 5 && s.length >= 5 && (s.startsWith(w.slice(0, 5)) || w.startsWith(s.slice(0, 5))))));
}

/** Too short for the text to be read: play the footage again (videos loop anyway) rather than slow it down. */
export function fillByRepeating(segments: Segment[], minSeconds: number): Segment[] {
  const len = (xs: Segment[]) => xs.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
  const once = len(segments);
  if (!segments.length || once <= 0) return segments;
  const out = [...segments];
  // At most one replay: footage on a loop looks like a loop.
  if (len(out) < minSeconds - 0.5) out.push(...segments.map((s) => ({ ...s, speed: 1 })));
  return out;
}

/**
 * Too short for the text: add more footage of the same kind of moment (other clips, their best
 * part), instead of replaying the same few seconds. Takes clips from `extras` as it uses them.
 */
export function fillWithClips(segments: Segment[], minSeconds: number, extras: Clip[]): Segment[] {
  const len = (xs: Segment[]) => xs.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
  const out = [...segments];
  while (len(out) < minSeconds - 0.5 && extras.length) {
    const c = extras.shift()!;
    const m = [...(c.ai?.moments ?? c.moments ?? [])].sort((a, b) => b.score - a.score)[0];
    const want = Math.min(8, Math.max(3, minSeconds - len(out)));
    const start = m ? Math.max(0, Math.min(m.start, c.duration - want)) : Math.max(0, (c.duration - want) / 2);
    const end = Math.min(c.duration, start + Math.max(want, m ? m.end - m.start : 0));
    if (end - start >= 1) out.push({ clipId: c.id, start, end, speed: 1 });
  }
  return out;
}

function validateSegment(s: Segment, clips: Map<string, Clip>): Segment | null {
  const clip = clips.get(s.clipId);
  if (!clip) return null;
  const start = Math.max(0, Math.min(s.start, clip.duration - 0.5));
  const end = Math.max(start + 0.5, Math.min(s.end, clip.duration));
  const speed = Math.max(0.5, Math.min(1.5, s.speed || 1));
  return { clipId: s.clipId, start, end, caption: s.caption || undefined, speed };
}

// ---------------------------------------------------------------------------
// Footage-first direction: one clip in, the best edit for that clip out.
// ---------------------------------------------------------------------------

const DIRECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["concept", "title", "topic", "subjectTop", "subjectBottom", "basedOn", "segments", "overlays", "postCaption", "hashtags"],
  properties: {
    basedOn: {
      type: "integer",
      description:
        "Number of the proven caption the hook is built on: its wording, or its hook pattern/structure. -1 only if " +
        "there were no proven captions or truly none of them shaped the hook.",
    },
    concept: { type: "string", description: "One sentence: what the joke/feeling is and why it works for this footage" },
    topic: { type: "string", description: "Educational videos: the specific topic in a few words. Otherwise empty." },
    subjectTop: {
      type: "number",
      description:
        "In the part of the clip used: how far down the frame the subject starts (0 = top, 1 = bottom). The subject " +
        "is the dog and any faces or main action. Text is kept out of it.",
    },
    subjectBottom: { type: "number", description: "Where the subject ends, 0..1 from the top (larger than subjectTop)." },
    title: { type: "string" },
    segments: {
      type: "array",
      description: "Parts of THIS clip to use, in order (source-clip seconds). Usually one continuous window.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "speed"],
        properties: {
          start: { type: "number" },
          end: { type: "number" },
          speed: { type: "number", description: "1 (real speed) almost always; 0.5–0.8 only for one short payoff moment; up to 1.5" },
        },
      },
    },
    overlays: {
      type: "array",
      description:
        "On-screen text on the OUTPUT timeline (seconds from the start of the finished video). Most videos need " +
        "exactly one overlay spanning the whole video. Use a second overlay only for a punchline that appears later.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "start", "end", "y", "pointAt", "pointX", "pointY"],
        properties: {
          text: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
          y: { type: "number", description: "Vertical center of the text, 0 (top) to 1 (bottom); -1 for the usual place" },
          pointAt: {
            type: "string",
            description:
              "The object the text names, as you actually see it in the frame while this text is on screen (e.g. " +
              "\"black backpack under Lex\"). Empty if it isn't clearly visible: then there's no arrow.",
          },
          pointX: { type: "number", description: "Arrow target, 0 (left) to 1 (right) in the frame; -1 for no arrow" },
          pointY: { type: "number", description: "Arrow target, 0 (top) to 1 (bottom) in the frame; -1 for no arrow" },
        },
      },
    },
    postCaption: {
      type: "string",
      description:
        "The post description under the video: 4–7 sentences (about 400–900 characters) in the creator's voice. " +
        "Hook in the first line, what happens in this clip, woven into the account's ongoing story, ending with a " +
        "question that invites comments. Emoji ok, no hashtags.",
    },
    hashtags: {
      type: "array",
      items: { type: "string" },
      description: "Exactly 3 hashtags without #: one big (1M–5M posts), one mid (50K–100K), one small (~10K)",
    },
  },
};

export interface DirectContext {
  petName: string;
  handle?: string;
  minSeconds: number;
  maxSeconds: number;
  examples: Example[];
  trends: TrendFormat[];
  brief?: string;
  /** Overlays already used recently, so the director doesn't repeat itself. */
  recentOverlays: string[];
  /** Captions that got lots of views on TikTok for this clip's situation. */
  proven: ProvenCaption[];
  /** What the creator kept and rejected recently. */
  feedback?: ReviewFeedback;
  /** Who this video's text speaks to: dog lovers, or everyone (the shared human moment). */
  audience?: "pets" | "everyone";
  /** The account's story, woven into the post description. */
  story?: string;
  /** The kind of post: "fun" (entertainment), "tips" (educational) or "inspire" (inspirational). */
  format?: PostFormat;
  /** For an educational video: the follower question it answers, with the creator's answer. */
  faq?: { q: string; a?: string };
  /** Educational: this video's theme, and the topics already covered (never repeated). */
  pillar?: EduPillar;
  covered?: string[];
  /** Other clips of the same kind of moment, to add when this one is too short (instead of replaying it). */
  extraClips?: Clip[];
  /** Educational: the call to action at the end (on screen) and in the description. */
  cta?: { site: string; overlay: string; caption: string };
  /** Make this a collab version for a brand partner. */
  collab?: { name: string; handle?: string; about: string; mustInclude?: string; note?: string };
}

const PILLAR_TEXT: Record<EduPillar, string> = {
  destination:
    "a DESTINATION: how we got Lex to a specific place (a country or city), what it took, what to know before " +
    "going, e.g. \"How I flew my dog to Brazil\", \"What it takes to bring a dog to Japan\"",
  airline:
    "an AIRLINE: flying with a specific airline or choosing one, what the pet policy is like in practice, e.g. " +
    "\"Flying LATAM with a dog\", \"The airline that let Lex sit on my lap\"",
  gear:
    "something WE TRAVEL WITH: the backpack/carrier, the health tracker, the documents, a travel essential, e.g. " +
    "\"The backpack Lex has flown 42,000km in\", \"3 things I never fly without\"",
};

/** The educational theme for this video, and what's been covered already. */
function pillarText(pillar: EduPillar | undefined, covered: string[]): string {
  return (
    (pillar
      ? `\n\nTHEME FOR THIS VIDEO: ${PILLAR_TEXT[pillar]}. Specific names (places, airlines, brands, rules) only from ` +
        `the creator's own answers or the account's story; otherwise stay with what you can see and general advice.`
      : "") +
    (covered.length
      ? `\n\nALREADY COVERED in earlier videos (never make the same topic or angle again, pick something new):\n` +
        covered.map((t) => `- ${t}`).join("\n")
      : "") +
    `\nSet "topic" to this video's specific topic in a few words (e.g. "Kato backpack", "flying Lex to Brazil").` +
    `\nThe video ends with the creator's call to action (their website), added after your text: don't write one ` +
    `yourself, on screen or in the description.`
  );
}

/** An educational video: a scroll-stopping hook, then a short teaching beat that builds up on screen. */
function tipsText(petName: string, scene?: string, faq?: { q: string; a?: string }): string {
  const question = faq
    ? `\n\nTHIS VIDEO ANSWERS A QUESTION FOLLOWERS ASK ALL THE TIME: "${faq.q}"` +
      (faq.a?.trim()
        ? `\nThe creator's own answer (the ONLY source for specifics: brand and product names, airlines, places, ` +
          `rules; never add others): ${faq.a.trim()}`
        : `\nThe creator hasn't written their answer yet: keep it general and useful (what to look for, how we ` +
          `think about it) and name no brands, airlines, places or country rules.`) +
      `\nA hook that plays on the question works well ("You always ask what bag ${petName} flies in", "The #1 ` +
      `question we get: …").`
    : "";
  return (
    `\n\nFORMAT FOR THIS VIDEO: EDUCATIONAL. Teach something real about flying or traveling with a pet` +
    `${scene ? `, tied to this situation (${scene}) where possible` : ""}, learned from traveling the world with ` +
    `${petName}.` +
    question +
    `\nPick the structure that suits this footage best, and don't use the same one as recent videos:` +
    `\n- a numbered list (2–4 points) that builds up on screen;` +
    `\n- the mistake we made, then what to do instead;` +
    `\n- myth vs. reality;` +
    `\n- do this / not this;` +
    `\n- the question everyone asks us, then the answer;` +
    `\n- what we pack / what we check before a flight;` +
    `\n- "nobody tells you…" followed by the thing nobody tells you.` +
    `\n\nTHE HOOK matters most: it's alone on screen for the first ~2.5s and must stop the scroll on its own. ` +
    `Make it specific, curious or a little high-stakes, in first person or as a direct "you": e.g. "The airline ` +
    `almost didn't let ${petName} on", "Stop doing this before a flight with your dog", "Nobody warned us about ` +
    `security", "I wish someone told me this before our first flight". Never a bland title like "Tips for flying ` +
    `with a dog".` +
    `\n\nON SCREEN, the way top creators do it:` +
    `\n- The hook is one overlay that stays at the top for the WHOLE video (start 0, end = the video's length, y -1).` +
    `\n- Then each point is its own overlay, shown alone (never repeating earlier points), one after another, each ` +
    `~2.5–3.5s, the last one staying to the end: e.g. "1. Kato backpack", "2. PetPace health tracker", "3. A ton of ` +
    `documents". Short: up to ~5 words, numbered when it's a list. A light, funny last point is great if it fits ` +
    `("4. Optional: a patient owner").` +
    `\n- Place each point in a DIFFERENT part of the frame from the one before (vary y between 0.3 and 0.7; the top ` +
    `and bottom of the frame are covered by the app), next to ` +
    `what it's about, never over ${petName}'s ` +
    `face.` +
    `\n- An arrow ONLY when the exact object the point names is clearly visible in the footage while the point is ` +
    `on screen (e.g. the backpack Lex sits in, the tracker on his collar): say what you see in pointAt and where it ` +
    `is in pointX/pointY (0..1 from the left / top), judged from the frames above at that moment. If it isn't ` +
    `clearly visible (documents that aren't shown, an idea, a tip), pointAt is empty, no arrow (-1), and the point ` +
    `just sits in a clear part of the frame.` +
    `\n- Only facts that hold for most airlines and countries; no specific rules, fees or legal requirements you ` +
    `aren't sure of.` +
    `\n- Length: whatever the lesson needs to be read comfortably, usually 15–30s: the hook alone for ~2.5s, then ` +
    `~3–4s per point. Don't pad it, and don't rush it.` +
    `\n\nIT HAS TO MAKE SENSE TO A STRANGER WITH THE SOUND OFF, reading only the text on screen:` +
    `\n- The points deliver exactly what the hook promises, and say how they connect to it. If the hook says ` +
    `"don't do X first" or "do this before X", the list is what to do first, introduced that way (e.g. the first ` +
    `list overlay starts "Check first:"). A hook that sets up a question gets its answer on screen.` +
    `\n- Every point is a complete piece of advice someone could act on, usually starting with a verb: "Book ` +
    `early: only 1–2 pets per cabin", "Measure the space under the seat", "Check the pet rules on every ` +
    `connecting flight". Never a bare noun phrase ("Same pet rules on every connection") or shorthand only you ` +
    `understand.` +
    `\n- No "POV:" hook here: POV is for a moment, not a lesson or a list.` +
    `\n- Numbers add up: a hook that says "3 checks" has exactly 3 points, all of that kind. No "bonus" unless the ` +
    `hook leaves room for it, and a bonus is still the same kind of thing.` +
    `\n- A follower question in the hook is clearly theirs: "You always ask which airline we fly with" or "\"Which ` +
    `airline do you fly with?\" Here's how we choose", never the creator asking it to themselves.` +
    `\n- Clear subjects: write "your dog" or ${petName}'s name, not "his"/"their" that could mean anyone.` +
    `\n- Before answering, read the overlays in order as someone who has never seen this account. If any line ` +
    `needs the post description to make sense, or the hook and the points don't fit together, rewrite them.` +
    `\n\nPost description: expand the lesson in a few sentences, connect it to ${petName}'s journey, and end with ` +
    `a question that invites people to share their own experience. Ignore the one-line overlay limit above; the ` +
    `proven captions are where the HOOK comes from: build the hook on the pattern or wording of one of them (adapted ` +
    `to this lesson) and set basedOn to it.`
  );
}

/** An inspirational post: the bigger journey, the feeling of traveling the world together. */
function inspireText(petName: string): string {
  return (
    `\n\nFORMAT FOR THIS VIDEO: INSPIRATIONAL. Not a joke and not a lesson: make people feel something about ` +
    `traveling the world with a dog, and make them want to do it too. Use the footage as a quiet, beautiful or ` +
    `meaningful moment of the journey.` +
    `\n- The hook still has to stop the scroll: personal, specific and a little emotional, e.g. "Six countries ` +
    `later, he still sleeps on my feet", "Everyone said we couldn't bring him", "If you're scared to fly with your ` +
    `dog, this is for you", "The moment I knew we'd made the right choice". No clichés like "living our best life".` +
    `\n- Build the hook on the pattern or wording of one of the proven captions (made personal and ` +
    `emotional) and set basedOn to it.` +
    `\n- One overlay, or a setup and a payoff line that appears a few seconds later. Calm pacing: let the moment ` +
    `breathe (at least 8s).` +
    `\n- Post description: the most story-driven of all: where we are in ${petName}'s journey, what it means to ` +
    `us, and an invitation (where would you take your dog?).`
  );
}

/** A paid collaboration: the brand becomes part of the moment, not an ad read. */
function collabText(c: NonNullable<DirectContext["collab"]>, petName: string): string {
  return (
    `\n\nTHIS IS A BRAND COLLABORATION with ${c.name}${c.handle ? ` (${c.handle})` : ""}. About the brand, in the ` +
    `creator's words: ${c.about}` +
    (c.note ? `\nThe creator's note for this video: ${c.note}` : "") +
    `\n- Pick the part of the clip where ${c.name}'s product or place is visible or most relevant.` +
    `\n- On-screen text: about the moment, with ${c.name} naturally part of it (what it makes possible for ` +
    `${petName} and us). It must still feel like a creator's post, never an ad read or a slogan.` +
    `\n- Post description: weave ${c.name} into the story, mention ${c.handle || c.name}` +
    (c.mustInclude ? `, and include exactly: ${c.mustInclude}` : "") +
    `, and end with the disclosure "#ad".` +
    `\n- Don't paste a proven caption as is here: build the hook on the pattern of one of them, made about ` +
    `${c.name}'s moment, and set basedOn to it.`
  );
}

const REASON_TEXT: Record<string, string> = {
  text: "the text was off",
  clip: "the footage wasn't good enough",
  edit: "the cut/timing was off",
  other: "no reason given",
};

const KIND: Record<string, string> = { fun: "fun", tips: "educational", inspire: "inspirational" };

export function feedbackText(f: ReviewFeedback | undefined): string {
  if (!f || (!f.kept.length && !f.rejected.length && !f.performance?.length)) return "";
  const line = (x: { text: string; scene?: string; basedOn?: string; format?: string }) =>
    `- "${x.text}"${x.format && KIND[x.format] ? ` [${KIND[x.format]}]` : ""}${x.scene ? ` (${x.scene})` : ""}` +
    `${x.basedOn ? ` [adapted from "${x.basedOn}"]` : ""}`;
  const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
  const perf = f.performance?.length
    ? `\n\nHOW POSTED VIDEOS ACTUALLY DID, best first. This is the strongest signal: lean toward what ` +
      `got views, saves and shares, away from what didn't (look at hook style, kind of post and situation):\n` +
      f.performance
        .map((p) => `${line(p)} on ${p.platform === "instagram" ? "Instagram" : "TikTok"}: ${fmt(p.views)} ${p.platform === "instagram" ? "plays" : "views"}${p.likes ? `, ${fmt(p.likes)} likes` : ""}${p.saves ? `, ${fmt(p.saves)} saves` : ""}${p.shares ? `, ${fmt(p.shares)} shares` : ""}`)
        .join("\n")
    : "";
  return (
    perf +
    `\n\nThe creator reviews every video: swipe right to keep it, left to reject it. Learn their taste from this ` +
    `and write more like what they kept and less like what they rejected (don't copy the kept lines).` +
    (f.kept.length ? `\nKept:\n${f.kept.map(line).join("\n")}` : "") +
    (f.rejected.length
      ? `\nRejected:\n${f.rejected.map((x) => `${line(x)}: ${x.note ? `in their words: "${x.note}"` : REASON_TEXT[x.reason ?? "other"]}`).join("\n")}` +
        (f.rejected.some((x) => x.note) ? `\nTheir own words are the most precise feedback you get: take them literally.` : "")
      : "")
  );
}

function provenText(proven: ProvenCaption[], scene?: string, audience: "pets" | "everyone" = "pets"): string {
  if (!proven.length) return "";
  const forEveryone = audience === "everyone";
  return (
    `\n\nPROVEN CAPTIONS for this situation${scene ? ` ("${scene}")` : ""}: the on-screen text of the most-viewed ` +
    `TikToks in the same situation, from TikTok search ("pet video" = from pet accounts, "general" = from anyone). ` +
    `The creator's method is to take the one that best matches what happens in this clip and use it as is or with ` +
    `small changes (names, details), because proven wording performs. ` +
    (forEveryone
      ? `For THIS video prefer a "general" one (or turn a pet one into the shared human moment); `
      : `For this video prefer a pet one; `) +
    `set basedOn to the one you adapt. Only if none fits the footage at all, write a line in the same style. Avoid ` +
    `ones already posted recently.\n` +
    proven
      .map(
        (c, i) =>
          `${i + 1}. "${c.text}"` +
          (c.views ? ` — ${c.views.toLocaleString("en")} views` : "") +
          ` (${c.kind === "creator" ? "found by the creator" : c.audience === "everyone" ? "general" : "pet video"})`,
      )
      .join("\n")
  );
}

/** How to aim the text: at dog lovers, or at everyone with the dog as the punchline. */
function audienceText(audience: "pets" | "everyone" = "pets", petName: string, format?: PostFormat): string {
  if (format === "inspire")
    return audience === "everyone"
      ? `\n\nAUDIENCE for this video: EVERYONE. Make it about a feeling anyone has, not about dogs: taking the leap, ` +
          `leaving the comfort zone, home being a person, saying yes to the trip, the people (and ${petName}) who come ` +
          `along. ${petName} is part of the moment, but someone without a dog should feel it too.`
      : `\n\nAUDIENCE for this video: dog lovers: what it means to see the world with your dog by your side.`;
  return audience === "everyone"
    ? `\n\nAUDIENCE for this video: EVERYONE, not just dog lovers. Write about the moment any person recognizes ` +
        `(travel stress, waiting in line, security, cramped seats, delays, the vibe of the day) so someone who doesn't ` +
        `care about dogs still laughs or nods; ${petName} is the visual punchline that makes it land. Phrase it like ` +
        `"me when…", "POV: …", "nobody: / …" about the human experience; avoid dog-owner insider terms.`
    : `\n\nAUDIENCE for this video: dog lovers. Speak to what dog owners recognize about ${petName}.`;
}

function examplesText(examples: Example[]): string {
  const usable = examples.filter((e) => e.analysis || e.overlayText || e.note);
  if (!usable.length) return "";
  return (
    "\n\nVideos that have performed well for this creator (match their tone and text style; don't copy them word for word):\n" +
    usable
      .slice(0, 12)
      .map((e) => {
        const a = e.analysis;
        return [
          `- Overlay: "${e.overlayText || a?.overlayText || "?"}"`,
          e.views ? `${e.views.toLocaleString("en")} views` : "",
          a ? `What happens: ${a.whatHappens}. Structure: ${a.structure}. Why it works: ${a.whyItWorks}. Caption style: ${a.captionStyle}.` : "",
          e.note ? `Creator's note: ${e.note}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
      })
      .join("\n")
  );
}

/** Watch one clip and write the edit that suits it best: which part to use, the overlay and the post caption. */
/** A new post description for a finished video, in the same voice; the video itself doesn't change. */
export async function writeCaption(ctx: {
  petName: string;
  handle?: string;
  story?: string;
  plan: VideoPlan;
  clip?: Clip;
  note?: string;
  faq?: { q: string; a?: string };
  collab?: { name: string; handle?: string; about: string; mustInclude?: string };
  feedback?: ReviewFeedback;
}): Promise<string> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  // Two frames so the description is about what's actually on screen.
  if (ctx.clip?.status === "ready") {
    for (const f of [0.3, 0.7]) {
      const jpg = await frameBuffer(ctx.clip.file, Math.round(ctx.clip.duration * f * 10) / 10, 400).catch(() => null);
      if (jpg) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
    }
  }
  const p = ctx.plan;
  const overlay = p.overlays?.length ? p.overlays.map((o) => o.text).join(" → ") : p.hook;
  const kind = p.format === "tips" ? "educational" : p.format === "inspire" ? "inspirational" : "fun / entertaining";
  content.push({
    type: "text",
    text:
      `Write a new post description for this ${kind} TikTok/Reels video of ${ctx.petName}` +
      `${ctx.handle ? ` (${ctx.handle})` : ""}.` +
      `\nOn-screen text: "${overlay}"` +
      (p.scene ? `\nSituation: ${p.scene}` : "") +
      (ctx.clip?.ai?.summary ? `\nWhat the clip shows: ${ctx.clip.ai.summary}` : "") +
      (ctx.faq ? `\nIt answers the follower question "${ctx.faq.q}". The creator's answer (only source for specifics): ${ctx.faq.a || "(none: stay general, name no brands, airlines or places)"}` : "") +
      (ctx.collab ? `\nIt's a paid collaboration with ${ctx.collab.name}${ctx.collab.handle ? ` (${ctx.collab.handle})` : ""}: ${ctx.collab.about}. Mention them${ctx.collab.mustInclude ? `, include exactly: ${ctx.collab.mustInclude}` : ""}, end with "#ad".` : "") +
      (ctx.story ? `\nThe account's story, to weave in (vary which part): ${ctx.story}` : "") +
      (p.postCaption ? `\nThe current description, which the creator wants replaced (don't reuse its wording): "${p.postCaption}"` : "") +
      (ctx.note ? `\nWhat the creator wants from the new one: ${ctx.note}` : "") +
      `\n\n4–7 sentences (about 400–900 characters) in the creator's voice: a hook first line, what happens in this ` +
      `moment tied into the bigger journey, and a closing question that invites comments. Emoji ok, no hashtags.` +
      feedbackText(ctx.feedback),
  });
  const r = await structured<{ postCaption: string }>({
    system: "You write post descriptions for a creator who travels the world with their dog. Warm, specific, never generic.",
    content,
    schema: { type: "object", additionalProperties: false, required: ["postCaption"], properties: { postCaption: { type: "string" } } },
    effort: "low",
  });
  return r.postCaption;
}

/**
 * A proofread of a video's on-screen text, read in order as a stranger with the sound off would: if
 * it doesn't add up (counts, pronouns, a hook the points don't answer, lines that need the caption),
 * the lines are fixed, same number and order, so their timing and places stay. Small model, text only.
 */
export async function proofreadText(lines: string[], petName: string, kind?: string): Promise<string[]> {
  if (!lines.length) return lines;
  const r = await structured<{ ok: boolean; problem: string; lines: string[] }>({
    system:
      "You proofread the on-screen text of short vertical videos for a creator who travels the world with their dog. " +
      "You are strict about whether it makes sense, and you keep the creator's voice and style.",
    content: [
      {
        type: "text",
        text:
          `The text of a ${kind ?? ""} video about ${petName}, shown one piece after another (" / " is a line break):\n` +
          lines.map((l, i) => `${i + 1}. ${l}`).join("\n") +
          `\n\nRead it as a stranger with the sound off. Does it make sense as one message? Check: the points answer ` +
          `the hook; any number in the hook matches the points; every point is the same kind of thing the hook ` +
          `promises; who "he/his/their" means is clear (use "your dog" or ${petName}); a follower question reads as ` +
          `theirs, not the creator asking themselves; an educational list or lesson doesn't start with "POV:" (POV is ` +
          `for a moment); no line needs other context. Be strict: a reader shouldn't ` +
          `have to work out what's meant. If it's fine, ok = true and return ` +
          `the lines unchanged. If not, ok = false, say the problem in a few words, and return fixed lines: exactly ` +
          `${lines.length}, same order and roles, each about as long as the original, no emoji, no hashtags.`,
      },
    ],
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "problem", "lines"],
      properties: { ok: { type: "boolean" }, problem: { type: "string" }, lines: { type: "array", items: { type: "string" } } },
    },
    // The main model: this is judgement about meaning, and only a few lines of text.
    effort: "low",
  });
  if (r.ok || r.lines.length !== lines.length || r.lines.some((l) => !l.trim())) return lines;
  console.log(`[proofread] fixed the text (${r.problem}): ${lines.join(" | ")} → ${r.lines.join(" | ")}`);
  return r.lines.map((l) => l.trim());
}

export async function directClip(clip: Clip, ctx: DirectContext): Promise<VideoPlan> {
  const frames = Math.max(4, Math.min(8, Math.ceil(clip.duration / 2)));
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (let i = 0; i < frames; i++) {
    const t = Math.round(((clip.duration * (i + 0.5)) / frames) * 10) / 10;
    const jpg = await frameBuffer(clip.file, t, 480);
    content.push({ type: "text", text: `t=${t}s` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
  }
  const energy = (clip.energy ?? []).map((v, i) => `${(i * 0.5).toFixed(1)}:${v.toFixed(2)}`).join(" ");
  content.push({
    type: "text",
    text:
      `These are frames from a ${clip.duration.toFixed(1)}s vertical clip of ${ctx.petName}` +
      (clip.capturedAt ? `, filmed ${clip.capturedAt.slice(0, 10)}` : "") +
      `. Audio: ${clip.hasAudio ? "yes" : "none"}. Motion+loudness per 0.5s: ${energy || "n/a"}.` +
      (clip.note ? `\nThe creator's note about this footage: "${clip.note}"` : "") +
      (clip.ai?.summary ? `\nEarlier read of the clip: ${clip.ai.summary}` : "") +
      (ctx.brief ? `\nCreator's direction for today: ${ctx.brief}` : "") +
      `\n\nStart from the footage: work out what is actually happening, where, and what ${ctx.petName} is feeling or ` +
      `doing that people will recognize. Then write the single on-screen line that makes it land. Formats are tools, ` +
      `not rules: use a trending structure only if it genuinely fits this footage, otherwise write something original.` +
      `\n\nThe finished video should be ${ctx.minSeconds}–${ctx.maxSeconds}s (sum of (end-start)/speed), starting right ` +
      `on the action and ending where it can loop. Text must never cover ${ctx.petName}, a face or the main action: ` +
      `report where they are (subjectTop/subjectBottom) and keep any placed text outside that band. Overlays use y -1 and no arrow (pointX/pointY -1) unless the ` +
      `format below says otherwise. Play footage at real speed (1). Slow motion only for one short ` +
      `payoff moment that's better slowed down (a jump, a head tilt, a reaction), never to make the video longer; if ` +
      `the clip is short, use all of it at speed 1 (it's replayed to give time to read). Overlay text: under ~14 words, no hashtags, no emoji; " / " starts ` +
      `a new line (e.g. "me: quick bath / ${ctx.petName}:").` +
      (ctx.trends.length
        ? `\n\nText formats currently working for pet accounts (optional inspiration):\n` +
          ctx.trends.map((t) => `- ${t.pattern.replaceAll("{pet}", ctx.petName)} (fits: ${t.fits})`).join("\n")
        : "") +
      (ctx.collab ? collabText(ctx.collab, ctx.petName) : ctx.format === "tips" ? "" : audienceText(ctx.audience, ctx.petName, ctx.format)) +
      (ctx.format === "tips" ? tipsText(ctx.petName, clip.scene, ctx.faq) + pillarText(ctx.pillar, ctx.covered ?? []) : ctx.format === "inspire" ? inspireText(ctx.petName) : "") +
      (ctx.story
        ? `\n\nTHE ACCOUNT'S STORY (weave it into the post description, not the on-screen text; connect this clip ` +
          `to the bigger journey and vary which part you bring up from post to post):\n${ctx.story}`
        : "") +
      provenText(ctx.proven, clip.scene, ctx.audience) +
      examplesText(ctx.examples) +
      feedbackText(ctx.feedback) +
      (ctx.recentOverlays.length
        ? `\n\nOverlays already posted recently (don't reuse these or their structure back-to-back):\n` +
          ctx.recentOverlays.map((o) => `- ${o}`).join("\n")
        : ""),
  });

  const r = await structured<{
    concept: string;
    title: string;
    topic: string;
    subjectTop: number;
    subjectBottom: number;
    basedOn: number;
    segments: { start: number; end: number; speed: number }[];
    overlays: { text: string; start: number; end: number; y: number; pointAt: string; pointX: number; pointY: number }[];
    postCaption: string;
    hashtags: string[];
  }>({
    system:
      "You are an editor for a creator on TikTok whose videos star their dog, made to reach a broad audience, not " +
      "only pet lovers. You start from what is on screen, never from a template. " +
      "You write on-screen text like a real creator: specific to the moment, relatable, funny or warm, never generic " +
      "or cringe, and never describing what the viewer can already see. You know the first second decides whether " +
      "people keep watching.",
    content,
    schema: DIRECT_SCHEMA,
    effort: "medium",
  });

  let segments: Segment[] = r.segments
    .map((s) => validateSegment({ clipId: clip.id, start: s.start, end: s.end, speed: s.speed }, new Map([[clip.id, clip]])))
    .filter((s): s is Segment => s !== null);
  if (!segments.length) throw new Error("The director returned no usable part of the clip.");
  const lengthOf = (xs: Segment[]) => xs.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
  const known = new Map([clip, ...(ctx.extraClips ?? [])].map((c) => [c.id, c]));
  // The text was timed for the AI's own cut: when slow motion is removed or the clip replayed, the
  // timing is stretched to the final length so every line still gets its share.
  const planned = lengthOf(segments);
  // More footage from other clips of the moment first; a single replay only if there's none.
  segments = fillByRepeating(fillWithClips(limitSlowMotion(segments), ctx.minSeconds, ctx.extraClips ?? []), ctx.minSeconds);
  let total = lengthOf(segments);
  const k = planned > 0 ? total / planned : 1;
  const frac = (v: number) => (v >= 0 && v <= 1 ? v : undefined);
  const overlays: Overlay[] = r.overlays
    .filter((o) => o.text.trim())
    .map((o) => {
      const y = frac(o.y);
      // An arrow only for an object really on screen, and the one the text names.
      const seen = arrowTarget(o.text, o.pointAt);
      const px = seen ? frac(o.pointX) : undefined;
      const py = seen ? frac(o.pointY) : undefined;
      return {
        text: o.text.trim(),
        start: Math.max(0, Math.min(o.start * k, total - 0.5)),
        end: o.end >= planned - 0.3 ? total + 1 : Math.max(o.start * k + 0.5, Math.min(o.end * k, total)),
        ...(y !== undefined ? { y: Math.max(0.1, Math.min(0.85, y)) } : {}),
        ...(px !== undefined && py !== undefined ? { pointTo: { x: px, y: py } } : {}),
      };
    });
  // A last read as a stranger would: fix text that doesn't add up (keeps timing and places).
  if (overlays.length) {
    const fixed = await proofreadText(overlays.map((o) => o.text), ctx.petName, ctx.format ? KIND[ctx.format] : undefined).catch(() => null);
    if (fixed) fixed.forEach((t, i) => (overlays[i] = { ...overlays[i], text: t }));
  }
  // Educational: the hook stays on top the whole video and the points are spread over the frame.
  if (ctx.format === "tips" && overlays.length >= 3) {
    overlays[0] = { ...overlays[0], start: 0, end: total + 1, y: undefined };
    overlays.splice(0, overlays.length, ...spreadPoints(overlays));
    // Every point stays up long enough to read; if the footage is too short for that, it gets longer
    // (more clips of the moment first), never the text faster.
    let timed = timePoints(overlays, total);
    if (timed.need > total + 0.2) {
      segments = lengthenFootage(fillWithClips(segments, timed.need, ctx.extraClips ?? []), timed.need, (id) => known.get(id)?.duration ?? 0);
      total = lengthOf(segments);
      timed = timePoints(overlays, total);
    }
    overlays.splice(0, overlays.length, ...timed.overlays);
  }
  // Educational: end on the creator's call to action (their site, link in bio) for the last 3s.
  if (ctx.format === "tips" && ctx.cta?.overlay) {
    segments = lengthenFootage(fillWithClips(segments, total + 3, ctx.extraClips ?? []), total + 3, (id) => known.get(id)?.duration ?? 0);
    const longer = lengthOf(segments);
    overlays.forEach((o, i) => {
      if (o.end > total) overlays[i] = { ...o, end: i === 0 ? longer + 1 : total };
    });
    overlays.push({ text: ctx.cta.overlay, start: total, end: longer + 1, y: 0.6 });
    total = longer;
  }
  const caption =
    ctx.format === "tips" && ctx.cta?.caption && !r.postCaption.toLowerCase().includes(ctx.cta.site.toLowerCase())
      ? `${r.postCaption.trim()}\n\n${ctx.cta.caption}`
      : r.postCaption;
  return {
    template: "auto",
    title: r.title,
    hook: overlays[0]?.text ?? "",
    overlays,
    concept: r.concept,
    scene: clip.scene,
    ...(ctx.format ? { format: ctx.format } : {}),
    ...(ctx.format === "tips" && ctx.faq ? { faq: ctx.faq.q } : {}),
    ...(ctx.format === "tips" ? { pillar: ctx.pillar, topic: r.topic?.trim() || undefined } : {}),
    ...(ctx.audience && ctx.format !== "tips" && !ctx.collab ? { audience: ctx.audience } : {}),
    ...(r.subjectBottom > r.subjectTop && r.subjectTop >= 0 && r.subjectBottom <= 1 && r.subjectBottom - r.subjectTop < 0.9
      ? { keepClear: { top: r.subjectTop, bottom: r.subjectBottom } }
      : {}),
    basedOn: (() => {
      const c = ctx.proven[r.basedOn - 1];
      return c ? { text: c.text, views: c.views, url: c.url } : undefined;
    })(),
    segments,
    postCaption: caption,
    hashtags: r.hashtags.map((h) => h.replace(/^#/, "")).slice(0, 3),
    plannedBy: "claude",
  };
}

const EXAMPLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overlayText", "whatHappens", "structure", "whyItWorks", "captionStyle"],
  properties: {
    overlayText: { type: "string", description: "The on-screen text exactly as written, or empty if none" },
    whatHappens: { type: "string" },
    structure: { type: "string", description: "Length, cuts, when text appears, where the payoff is" },
    whyItWorks: { type: "string" },
    captionStyle: { type: "string", description: "Tone, casing, length and position of the text" },
  },
};

/** Study a video that performed well so its style can guide future edits. */
export async function analyzeExample(file: string, duration: number, note?: string): Promise<NonNullable<Example["analysis"]>> {
  const frames = Math.max(4, Math.min(16, Math.ceil(duration)));
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (let i = 0; i < frames; i++) {
    const t = Math.round(((duration * (i + 0.5)) / frames) * 10) / 10;
    const jpg = await frameBuffer(file, t, 540);
    content.push({ type: "text", text: `t=${t}s` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
  }
  content.push({
    type: "text",
    text:
      `This ${duration.toFixed(1)}s short-form pet video performed well.` +
      (note ? ` The creator says: "${note}".` : "") +
      ` Read the on-screen text and break down why it works, so a new video can reuse the approach with different footage.`,
  });
  return structured({
    system: "You analyze viral short-form pet videos for a creator's style guide. Be concrete and brief.",
    content,
    schema: EXAMPLE_SCHEMA,
    effort: "low",
  });
}
