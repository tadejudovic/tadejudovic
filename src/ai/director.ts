import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { assertBudget, noteAiError, recordUsage } from "./budget.ts";
import { frameBuffer } from "../media/ffmpeg.ts";
import { TEMPLATES } from "../templates.ts";
import type { PostFormat, Clip, Example, Moment, Overlay, ProvenCaption, ReviewFeedback, Segment, TemplateId, TrendFormat, VideoPlan } from "../types.ts";

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
    segments: v.segments
      .map((s) => validateSegment(s, byId))
      .filter((s): s is Segment => s !== null),
  })).filter((v) => v.segments.length > 0);
}

function clampMoment(m: Moment, duration: number): Moment | null {
  const start = Math.max(0, Math.min(m.start, duration));
  const end = Math.max(0, Math.min(m.end, duration));
  if (end - start < 0.5) return null;
  return { ...m, start, end, score: Math.max(0, Math.min(1, m.score)) };
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
  required: ["concept", "title", "basedOn", "segments", "overlays", "postCaption", "hashtags"],
  properties: {
    basedOn: {
      type: "integer",
      description: "Number of the proven caption the overlay is adapted from, or -1 if it is original",
    },
    concept: { type: "string", description: "One sentence: what the joke/feeling is and why it works for this footage" },
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
          speed: { type: "number", description: "1 normal; 0.5 slow-mo for a payoff; up to 1.5" },
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
        required: ["text", "start", "end"],
        properties: { text: { type: "string" }, start: { type: "number" }, end: { type: "number" } },
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
  /** Make this a collab version for a brand partner. */
  collab?: { name: string; handle?: string; about: string; mustInclude?: string; note?: string };
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
    `\n\nOn screen: overlays back to back on the output timeline. The hook first, then the teaching beats, each ` +
    `shown ~3s; for a list, each overlay repeats the earlier points and adds the next (" / " between them) so it ` +
    `builds up; the last overlay stays to the end. Each line under ~8 words, concrete and useful. Only facts that ` +
    `hold for most airlines and countries; no specific rules, fees or legal requirements you aren't sure of. ` +
    `The video must be long enough to read everything: at least 12s.` +
    `\n\nPost description: expand the lesson in a few sentences, connect it to ${petName}'s journey, and end with ` +
    `a question that invites people to share their own experience. Ignore the one-line overlay limit above; the ` +
    `proven captions are only inspiration for the hook's tone.`
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
    `\n- Ignore the proven-caption instruction to adapt one as is: use them only for tone and structure.`
  );
}

const REASON_TEXT: Record<string, string> = {
  text: "the text was off",
  clip: "the footage wasn't good enough",
  edit: "the cut/timing was off",
  other: "no reason given",
};

export function feedbackText(f: ReviewFeedback | undefined): string {
  if (!f || (!f.kept.length && !f.rejected.length)) return "";
  const line = (x: { text: string; scene?: string; basedOn?: string }) =>
    `- "${x.text}"${x.scene ? ` (${x.scene})` : ""}${x.basedOn ? ` [adapted from "${x.basedOn}"]` : ""}`;
  return (
    `\n\nThe creator reviews every video: swipe right to keep it, left to reject it. Learn their taste from this ` +
    `and write more like what they kept and less like what they rejected (don't copy the kept lines).` +
    (f.kept.length ? `\nKept:\n${f.kept.map(line).join("\n")}` : "") +
    (f.rejected.length
      ? `\nRejected:\n${f.rejected.map((x) => `${line(x)}: ${REASON_TEXT[x.reason ?? "other"]}`).join("\n")}`
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
function audienceText(audience: "pets" | "everyone" = "pets", petName: string): string {
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
      `on the action and ending where it can loop. Overlay text: under ~14 words, no hashtags, no emoji; " / " starts ` +
      `a new line (e.g. "me: quick bath / ${ctx.petName}:").` +
      (ctx.trends.length
        ? `\n\nText formats currently working for pet accounts (optional inspiration):\n` +
          ctx.trends.map((t) => `- ${t.pattern.replaceAll("{pet}", ctx.petName)} (fits: ${t.fits})`).join("\n")
        : "") +
      (ctx.collab ? collabText(ctx.collab, ctx.petName) : audienceText(ctx.audience, ctx.petName)) +
      (ctx.format === "tips" ? tipsText(ctx.petName, clip.scene, ctx.faq) : ctx.format === "inspire" ? inspireText(ctx.petName) : "") +
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
    basedOn: number;
    segments: { start: number; end: number; speed: number }[];
    overlays: Overlay[];
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

  const segments: Segment[] = r.segments
    .map((s) => validateSegment({ clipId: clip.id, start: s.start, end: s.end, speed: s.speed }, new Map([[clip.id, clip]])))
    .filter((s): s is Segment => s !== null);
  if (!segments.length) throw new Error("The director returned no usable part of the clip.");
  const total = segments.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
  const overlays = r.overlays
    .filter((o) => o.text.trim())
    .map((o) => ({
      text: o.text.trim(),
      start: Math.max(0, Math.min(o.start, total - 0.5)),
      end: o.end >= total - 0.3 ? total + 1 : Math.max(o.start + 0.5, Math.min(o.end, total)),
    }));
  return {
    template: "auto",
    title: r.title,
    hook: overlays[0]?.text ?? "",
    overlays,
    concept: r.concept,
    scene: clip.scene,
    ...(ctx.format ? { format: ctx.format } : {}),
    ...(ctx.format === "tips" && ctx.faq ? { faq: ctx.faq.q } : {}),
    basedOn: (() => {
      const c = ctx.proven[r.basedOn - 1];
      return c ? { text: c.text, views: c.views, url: c.url } : undefined;
    })(),
    segments,
    postCaption: r.postCaption,
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
