import { lengthenFootage, replayOnce, spreadPoints, timePoints } from "../overlayLayout.ts";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { assertBudget, noteAiError, recordUsage } from "./budget.ts";
import { frameBuffer } from "../media/ffmpeg.ts";
import { TEMPLATES } from "../templates.ts";
import type { EditRecord, EduPillar, PostFormat, Clip, Example, Moment, Overlay, ProvenCaption, ReviewFeedback, Segment, TemplateId, TrendFormat, VideoPlan, SearchTopic } from "../types.ts";

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
): Promise<NonNullable<Clip["ai"]> & { scene: string; alreadyEdited: boolean; place: string }> {
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
      `Where was it filmed? Only if signs, landmarks, a skyline or the language make it clear: "City, Country" ` +
      `(or just the country). Otherwise empty: never guess.\n\n` +
      `Finally, say whether this is already an edited video: text overlays, captions, titles or stickers added on top ` +
      `of the footage (e.g. a finished TikTok saved back to the phone). Text that's part of the scene itself ` +
      `(signs, screens, labels, a boarding pass) doesn't count.`,
  });
  const schema = {
    ...TAG_SCHEMA,
    required: [...TAG_SCHEMA.required, "scene", "alreadyEdited", "place"],
    properties: {
      ...TAG_SCHEMA.properties,
      scene: { type: "string", enum: [...scenes, "other"] },
      alreadyEdited: { type: "boolean", description: "Text, captions or stickers were added on top of the footage" },
      place: { type: "string", description: "\"City, Country\" if clearly recognizable, else empty" },
    },
  };
  const result = await structured<NonNullable<Clip["ai"]> & { scene: string; alreadyEdited: boolean; place: string }>({
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

/**
 * Of the clips offered to lengthen a video, the ones that show the same kind of place and moment as
 * its main clip and fit what the video is about. Text only (what's in each clip), small model.
 */
export async function fittingClips(concept: string, main: Clip, extras: Clip[], kind?: PostFormat): Promise<Clip[]> {
  const described = extras.filter((c) => c.ai?.summary);
  if (!described.length) return [];
  const r = await structured<{ fits: number[] }>({
    system: "You are a video editor checking whether extra footage belongs in a short video.",
    content: [
      {
        type: "text",
        text:
          `The video: ${concept}\nIts main clip: ${main.ai?.summary ?? main.scene ?? ""}${main.place ? ` (${main.place})` : ""}\n\n` +
          `Extra clips that could be added to make it longer:\n` +
          described.map((c, i) => `${i + 1}. ${c.ai!.summary}${c.place ? ` (${c.place})` : ""}`).join("\n") +
          (kind === "inspire"
            ? `\n\nThis is a journey video: footage from different places can belong together if it tells the same ` +
              `story (the trip, the feeling, being somewhere together). Which ones fit it? List their numbers.`
            : `\n\nThis video is about one specific thing, so extra footage has to show that same thing: same kind of ` +
              `place and moment, so a viewer wouldn't notice a jump. A different setting (a car instead of a plane, a ` +
              `street instead of an airport) does NOT fit. List their numbers.`),
      },
    ],
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["fits"],
      properties: { fits: { type: "array", items: { type: "integer" } } },
    },
    effort: "low",
    model: config.claude.fastModel,
  });
  return r.fits.map((n) => described[n - 1]).filter((c): c is Clip => !!c);
}

/** Too short for the text to be read: play the footage again (videos loop anyway) rather than slow it down. */
export function fillByRepeating(segments: Segment[], minSeconds: number): Segment[] {
  if (!segments.length) return segments;
  // Only what's missing, and no part played more than twice in the whole video.
  return replayOnce(segments, minSeconds);
}

/**
 * Too short for the text: add more footage of the same kind of moment (other clips, their best
 * part), instead of replaying the same few seconds. Takes clips from `extras` as it uses them.
 */
/**
 * For each point of an educational video, the clip that best shows what it's about (or none: the
 * main clip stays). Small model, from what the AI wrote about each clip; each clip used once.
 */
export async function pickBroll(points: string[], concept: string, main: Clip, pool: Clip[], setting?: string): Promise<(Clip | undefined)[]> {
  // The 40 clips most relevant to these points (their words in what's known about each clip), then
  // the order given (unused and recent first).
  const words = new Set(
    (points.join(" ") + " " + concept).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length > 3),
  );
  const relevance = (c: Clip) =>
    [c.ai?.summary, c.ai?.tags?.join(" "), c.note, c.scene].join(" ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => words.has(w)).length;
  const described = pool
    .filter((c) => c.ai?.summary && c.id !== main.id)
    .map((c, i) => ({ c, i, r: relevance(c) }))
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .slice(0, 40)
    .map((x) => x.c);
  if (!points.length || !described.length) return points.map(() => undefined);
  const r = await structured<{ points: { n: number; clip: number }[] }>({
    system: "You are a video editor picking b-roll for an educational short video.",
    content: [
      {
        type: "text",
        text:
          `The video: ${concept}\nMain clip (shown under the headline): ${main.ai?.summary ?? main.scene ?? ""}\n\n` +
          `Points, each shown on screen for a few seconds:\n${points.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\n` +
          `Clips available:\n` +
          described
            .map((c, i) => `${i + 1}. ${c.ai!.summary}${c.scene ? ` [${c.scene}]` : ""}${c.place ? ` (${c.place})` : ""}${c.capturedAt ? `, filmed ${c.capturedAt.slice(0, 10)}` : ""}`)
            .join("\n") +
          `\n\nFor each point, the clip that SHOWS what the point is about (e.g. a walk outside or on grass for a potty ` +
          `break, the carrier for a point about the carrier, the check-in desk for a check-in point), so the footage ` +
          `changes with the points instead of staying in one place. 0 when no clip clearly shows it (the main clip ` +
          `stays). Never the same clip for two points. Between clips that fit equally, the strongest footage (Lex in ` +
          `the backpack walking through the airport, at check-in, boarding, on the plane, getting off it), then the ` +
          `more recently filmed.` +
          (setting
            ? `\nThis video happens ${setting}: a clip clearly filmed there always beats one somewhere else, even ` +
              `if the other shows the action better (a dog peeing at the airport relief area beats a dog on grass in a ` +
              `park). A park, street or home clip only when nothing filmed there shows the point, and never one where ` +
              `a viewer couldn't tell it's part of the trip.`
            : ""),
      },
    ],
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["points"],
      properties: {
        points: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["n", "clip"], properties: { n: { type: "integer" }, clip: { type: "integer" } } },
        },
      },
    },
    effort: "low",
    model: config.claude.fastModel,
  });
  const used = new Set<string>();
  return points.map((_, i) => {
    const c = described[(r.points.find((p) => p.n === i + 1)?.clip ?? 0) - 1];
    if (!c || used.has(c.id)) return undefined;
    used.add(c.id);
    return c;
  });
}

/**
 * The cut with b-roll: the main footage, except while a point with its own clip is on screen, when
 * that clip's best moment plays instead. Same length as before, so the text timing still holds.
 */
export function withBroll(main: Segment[], windows: { start: number; end: number; clip?: Clip }[], total: number): Segment[] {
  const out: Segment[] = [];
  // The main footage plays on from where it left off (from the top again if it runs out).
  let mi = 0;
  let mOff = 0;
  const takeMain = (len: number) => {
    let left = len;
    for (let guard = 0; left > 0.05 && main.length && guard < 50; guard++) {
      const s = main[mi % main.length];
      const speed = s.speed ?? 1;
      const avail = (s.end - s.start) / speed - mOff;
      const take = Math.min(avail, left);
      if (take > 0.05) out.push({ ...s, start: s.start + mOff * speed, end: s.start + (mOff + take) * speed });
      left -= take;
      mOff += take;
      if (mOff >= (s.end - s.start) / speed - 0.05) {
        mi++;
        mOff = 0;
      }
    }
  };
  let t = 0;
  for (const w of windows.filter((x) => x.clip && x.end - x.start >= 1).sort((a, b) => a.start - b.start)) {
    if (w.start < t) continue;
    takeMain(w.start - t);
    const c = w.clip!;
    const len = Math.min(w.end - w.start, c.duration);
    const m = [...(c.ai?.moments ?? c.moments ?? [])].sort((a, b) => b.score - a.score)[0];
    const start = Math.max(0, Math.min(m ? m.start : (c.duration - len) / 2, c.duration - len));
    out.push({ clipId: c.id, start, end: start + len, speed: 1 });
    takeMain(w.end - w.start - len);
    t = w.end;
  }
  takeMain(total - t);
  return out;
}

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

/**
 * An inspirational video as a montage: the main clip's moment (at most 2.5s), then the best 2s of
 * each fitting clip, up to 8 shots and about 15s, so it never sits on one uncut shot.
 */
export function montage(segments: Segment[], extras: Clip[], minSeconds: number): Segment[] {
  const len = (xs: Segment[]) => xs.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
  const first = segments[0];
  if (!first) return segments;
  const out: Segment[] = [{ ...first, end: Math.min(first.end, first.start + 2.5 * (first.speed ?? 1)) }];
  for (const c of extras) {
    if (out.length >= 8 || len(out) >= Math.max(minSeconds, 15)) break;
    const m = [...(c.ai?.moments ?? c.moments ?? [])].sort((a, b) => b.score - a.score)[0];
    const want = Math.min(2, c.duration);
    const mid = m ? (m.start + m.end) / 2 : c.duration / 2;
    const start = Math.max(0, Math.min(mid - want / 2, c.duration - want));
    if (want >= 1.5) out.push({ clipId: c.id, start, end: start + want, speed: 1 });
  }
  // Not enough other footage: the rest of the main clip as the AI cut it.
  return len(out) >= minSeconds - 0.5 ? out : segments;
}

/**
 * The first `seconds` of the video replaced by the opener clip's best moment (same length, so the
 * text timing holds): what plays under the headline before the first point.
 */
export function withOpener(segments: Segment[], opener: Clip, seconds: number): Segment[] {
  if (segments.some((s) => s.clipId === opener.id)) return segments;
  const m = [...(opener.ai?.moments ?? opener.moments ?? [])].sort((a, b) => b.score - a.score)[0];
  const len = Math.min(seconds, opener.duration);
  const start = Math.max(0, Math.min(m ? m.start : (opener.duration - len) / 2, opener.duration - len));
  const out: Segment[] = [{ clipId: opener.id, start, end: start + len, speed: 1 }];
  let skip = len;
  for (const s of segments) {
    const speed = s.speed ?? 1;
    const shown = (s.end - s.start) / speed;
    if (skip >= shown - 0.05) {
      skip -= shown;
      continue;
    }
    out.push(skip > 0 ? { ...s, start: s.start + skip * speed } : s);
    skip = 0;
  }
  return out;
}

/** The longest a shot stays on screen before the video cuts (a slowed-down payoff gets up to 3s). */
export const MAX_SHOT = 2;

/**
 * Splits shots that hold too long into ~2s shots, keeping the video's length (so the text timing
 * holds): other fitting clips' best moments are cut in between when there are any, and the clip's
 * own footage jumps ahead past dead stretches when it has more than the shot uses.
 */
export function paceShots(input: Segment[], clips: Map<string, Clip>, extras: Clip[]): Segment[] {
  // Back-to-back parts of the same clip play as one shot (no visible cut), so they count as one.
  const segments: Segment[] = [];
  for (const s of input) {
    const last = segments.at(-1);
    if (last && last.clipId === s.clipId && (last.speed ?? 1) === (s.speed ?? 1) && Math.abs(last.end - s.start) < 0.15 && !last.caption && !s.caption) last.end = s.end;
    else segments.push({ ...s });
  }
  const used = new Set(segments.map((s) => s.clipId));
  const spare = extras.filter((c) => !used.has(c.id) && c.duration >= 1.5);
  const out: Segment[] = [];
  for (const s of segments) {
    const speed = s.speed ?? 1;
    const shown = (s.end - s.start) / speed;
    if (shown <= (speed < 1 ? 3 : MAX_SHOT) + 0.5) {
      out.push(s);
      continue;
    }
    const n = Math.ceil(shown / MAX_SHOT);
    const piece = shown / n;
    // Every other shot from another clip, while there are any.
    const fromOthers = Math.min(spare.length, Math.floor(n / 2));
    const own = n - fromOthers;
    // The window this shot's own footage comes from: a little past its end when the clip has more,
    // but never into footage another shot of the video already shows (no repeats).
    const clipLength = clips.get(s.clipId)?.duration ?? s.end;
    const nextUsed = Math.min(clipLength, ...segments.filter((x) => x !== s && x.clipId === s.clipId && x.start >= s.end - 0.05).map((x) => x.start));
    const windowEnd = Math.max(s.end, Math.min(nextUsed, s.start + (s.end - s.start) * 1.6));
    const step = own > 1 ? Math.max(piece * speed, (windowEnd - s.start - piece * speed) / (own - 1)) : 0;
    const ownShots = Array.from({ length: own }, (_, j) => {
      const start = s.start + j * step;
      return { ...s, start, end: Math.min(windowEnd, start + piece * speed) };
    });
    for (let i = 0, o = 0; i < n; i++) {
      const other = i % 2 === 1 && i / 2 < fromOthers + 0.5 ? spare.shift() : undefined;
      if (other) {
        const m = [...(other.ai?.moments ?? other.moments ?? [])].sort((a, b) => b.score - a.score)[0];
        const len = Math.min(piece, other.duration);
        const mid = m ? (m.start + m.end) / 2 : other.duration / 2;
        const start = Math.max(0, Math.min(mid - len / 2, other.duration - len));
        out.push({ clipId: other.id, start, end: start + len, speed: 1 });
      } else if (ownShots[o]) out.push(ownShots[o++]);
    }
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
  /** Educational: the angle within the theme (e.g. "the bag"). */
  angle?: string;
  /** Educational: the shape of the lesson (a list, myth vs. fact, …), in rotation. */
  eduFormat?: EduFormat;
  /** Educational: what people search for in this theme, most searched first. */
  search?: SearchTopic[];
  /** Educational: the creator's posts people saved and shared most (for their views). */
  topPosts?: { text: string; views: number; saves: number; shares: number }[];
  covered?: string[];
  /** Other clips of the same kind of moment, to add when this one is too short (instead of replaying it). */
  extraClips?: Clip[];
  /** Educational: footage that could show what each point is about (a walk outside for a potty break). */
  broll?: Clip[];
  /** Educational: the strongest footage to open on (Lex in the backpack at the airport, on the plane). */
  opener?: Clip;
  /** Educational: the call to action at the end (on screen) and in the description. */
  cta?: { site: string; overlay: string; caption: string };
  /** Make this a collab version for a brand partner. */
  collab?: { name: string; handle?: string; about: string; mustInclude?: string; note?: string; educational?: boolean };
}

const PILLAR_TEXT: Record<EduPillar, string> = {
  airline:
    "FLIGHTS & AIRLINES: flying with a specific airline, or how to deal with airlines as a dog owner, e.g. " +
    "\"Flying LATAM with a dog\", \"How to actually get a pet spot on your flight\"",
  destination:
    "DESTINATIONS: what it takes to bring a dog somewhere (the rules and papers), or the places that welcome dogs, " +
    "e.g. \"What it takes to bring a dog to Japan\", \"The most dog-friendly city we've been to\"",
  airport:
    "AT THE AIRPORT: getting through it with a dog, from check-in and security to the gate and layovers, e.g. " +
    "\"How security works with a dog\", \"Where your dog can pee at the airport\"",
  prep:
    "PREP & GEAR: accessories, the bag, getting ready for a flight, and the flight itself, e.g. \"The bag Lex " +
    "has flown 42,000km in\", \"What I do the morning before we fly\", \"How Lex stays calm under the seat\"",
  gear: "PREP & GEAR: accessories, the bag, getting ready for a flight, and the flight itself",
};

/** The educational theme for this video, and what's been covered already. */
function pillarText(pillar: EduPillar | undefined, covered: string[], angle?: string, search: SearchTopic[] = []): string {
  return (
    (pillar
      ? `\n\nTHEME FOR THIS VIDEO: ${PILLAR_TEXT[pillar]}.` +
        (angle && !search.length ? ` This time the angle is ${angle}.` : "") +
        (search.length
          ? `\n\nWHAT PEOPLE ASK AND SEARCH FOR in this theme (most asked first):\n` +
            search
              .map(
                (t, i) =>
                  `${i + 1}. ${t.topic} (${t.source === "google" ? `${t.impressions.toLocaleString("en")} searches a month` : t.source === "comments" ? "asked in the comments on the creator's own videos" : t.source === "suggest" ? "suggested by Google and YouTube search, so many people type it" : "searches that brought people to the creator's TikToks"}), ` +
                  `searched as: ${t.queries.map((q) => `"${q}"`).join(", ")}`,
              )
              .join("\n") +
            `\nMake this video answer the first one (another only if the first clearly can't work with this footage). ` +
            `Use the searchers' own words in the hook and in the first line of the description, so the video comes up ` +
            `for that search. You may name the airline, place or product the search is about, and state only facts you ` +
            `are sure are current (e.g. whether pets fly in the cabin at all, the weight limit with the carrier); leave ` +
            `out anything you're unsure of, and say in the description that rules change, so check before booking.` +
            ` Set "topic" to the search topic you answered.`
          : "") +
        ` Other specific names (places, airlines, brands, rules) only from ` +
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

/** Educational: what the audience found worth keeping (saves and shares for the views). */
function savedText(posts: { text: string; views: number; saves: number; shares: number }[]): string {
  if (!posts.length) return "";
  return (
    `\n\nTHE CREATOR'S POSTS PEOPLE SAVED AND SHARED MOST (for their views), what this audience finds worth ` +
    `keeping; make this lesson just as useful:\n` +
    posts
      .slice(0, 6)
      .map((p) => `- "${p.text.slice(0, 140)}" (${p.views.toLocaleString("en")} views, ${p.saves} saves, ${p.shares} shares)`)
      .join("\n")
  );
}

/**
 * Educational: the footage the points can cut to, so the lesson only promises what can be shown
 * (no "find the relief area" without a clip of one).
 */
function footageText(pool: Clip[]): string {
  const described = pool.filter((c) => c.ai?.summary).slice(0, 40);
  if (!described.length) return "";
  return (
    `\n\nOTHER FOOTAGE the points can cut to (each point plays over the clip that shows it best):\n` +
    described.map((c) => `- ${c.ai!.summary!.slice(0, 160)}${c.scene ? ` [${c.scene}]` : ""}`).join("\n") +
    `\nChoose the topic and the points so each one can be SHOWN with this clip or one of these: a point about ` +
    `something no footage shows (a relief area nobody filmed, a check-in desk that isn't there) loses viewers ` +
    `the moment it's on screen over something else. If a better topic fits the footage you have, take it.`
  );
}

/** An educational video: a scroll-stopping hook, then a short teaching beat that builds up on screen. */
function tipsText(petName: string, scene?: string, faq?: { q: string; a?: string }, eduFormat: EduFormat = "list"): string {
  const question = faq
    ? `\n\nTHIS VIDEO ANSWERS A QUESTION FOLLOWERS ASK ALL THE TIME: "${faq.q}"` +
      (faq.a?.trim()
        ? `\nThe creator's own answer (the ONLY source for specifics: brand and product names, airlines, places, ` +
          `rules; never add others): ${faq.a.trim()}`
        : `\nThe creator hasn't written their answer yet: keep it general and useful (what to look for, how we ` +
          `think about it) and name no brands, airlines, places or country rules.`) +
      `\nThe hook can BE the question, asked plainly in the viewer's own words, the way they'd type it into ` +
      `search, and for anyone curious, not only dog owners: "Where do dogs pee when they fly?", "Which airlines let ` +
      `dogs in the cabin?". Never about who asks: ` +
      `no "you always ask…", "our #1 question", "people ask me…", no quote marks, no "${petName}" in it.`
    : "";
  return (
    `\n\nFORMAT FOR THIS VIDEO: EDUCATIONAL. Teach something real about flying or traveling with a pet` +
    `${scene ? `, tied to this situation (${scene}) where possible` : ""}, learned from traveling the world with ` +
    `${petName}.` +
    question +
    EDU_FORMAT_TEXT[eduFormat] +
    `\n\nTHE HOOK matters most: it's alone on screen for the first ~2.5s, then stays on top as the header, so it ` +
    `must stop the scroll AND be read at a glance (it stays pinned at the top, at most two lines). ONE idea, 3–8 ` +
    `words, no " / " line breaks, in plain everyday words. The best: a question ANYONE is curious about, asked ` +
    `directly, e.g. "Where do dogs pee when they fly?", "Can dogs fly in the cabin?", "How much does it cost to ` +
    `fly a dog?"; or a plain promise: "3 seats a dog can't sit in". It speaks to everyone curious, not only dog ` +
    `owners: no "your dog", "dog owners", "pet parents", "if you have a dog", "flying with your dog?". Never ` +
    `label-style ("Flight day: 3 spots…", "Airport hack:"), never quote someone or say who asks ("you always ` +
    `ask", "the #1 question", "people ask me"), no "POV", and never a bland title like "Tips for flying with a ` +
    `dog". The setup, the story and the why go in the description.` +
    `\n\nON SCREEN, the way top creators do it:` +
    `\n- The hook is one overlay that stays at the top for the WHOLE video (start 0, end = the video's length, y -1).` +
    `\n- Then each point is its own overlay, shown alone (never repeating earlier points), one after another, each ` +
    `~2.5–3.5s, the last one staying to the end, each starting with its label exactly as the format above says ` +
    `("1.", "MYTH:", "FACT:", …): the label becomes a colored tab on screen. Short: up to ~5 words after the label ` +
    `(never more than 7).` +
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
    `\n- Length: short. The creator's numbers: half the viewers are gone by ~7s, and the 23s lessons lost the ` +
    `most; the ones that held best were 12–19s. So 12–17s before the call to action: the hook alone for ~2.5s, ` +
    `then ~3s per point, 3 points (never more than 4). Short points (a few words) read fast. Don't pad it.` +
    `\n\nTHE ANSWER TEST: when the headline is a question, every point is a DIRECT answer to that exact question, ` +
    `of the kind it asks for: "Where do dogs pee on a layover?" → each point is a place ("1. Pet relief areas, ` +
    `after security", "2. Outside, before check-in", "3. A pee pad in the carrier"), not general advice ("book ` +
    `long layovers", "keep the harness on"); "How much…?" → amounts; "Which…?" → names; "Can…?" → yes or no, ` +
    `then the condition. A point that's good advice but doesn't answer the question goes.` +
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
    `\n- Clear subjects: write "your dog" or ${petName}'s name, not "his"/"their" that could mean anyone.` +
    `\n- Before answering, read the overlays in order as someone who has never seen this account. If any line ` +
    `needs the post description to make sense, or the hook and the points don't fit together, rewrite them.` +
    `\n\nPost description: expand the lesson in a few sentences, connect it to ${petName}'s journey, and end with ` +
    `a question that invites people to share their own experience. Ignore the one-line overlay limit above. ` +
    `Proven captions are optional here: build on one only if its pattern really fits a lesson headline, and set ` +
    `basedOn to it then; otherwise basedOn -1. Never name one the hook doesn't use.`
  );
}

/** The shapes an educational video can take, in rotation (see generate.ts). */
export type EduFormat = "list" | "myth" | "mistake" | "qa" | "dodont" | "nobody";

const EDU_FORMAT_TEXT: Record<EduFormat, string> = {
  list:
    `\nSTRUCTURE FOR THIS VIDEO: A NUMBERED LIST. 3 points (2–4 at most) that build up on screen, each starting "1.", "2.", … ` +
    `e.g. "1. Kato backpack", "2. PetPace health tracker", "3. A ton of documents". A light, funny last point is ` +
    `great if it fits ("4. Optional: a patient owner").`,
  myth:
    `\nSTRUCTURE FOR THIS VIDEO: MYTH VS. FACT. What people believe, then what's actually true, 1–2 pairs: ` +
    `"MYTH: Dogs have to fly in cargo", then "FACT: Small dogs fly under the seat". The hook sets it up (e.g. ` +
    `"Can dogs really fly in the cabin?", "What everyone gets wrong about flying a dog"). Each MYTH is something ` +
    `people genuinely believe; each FACT states what's actually true, concretely ("FACT: Small dogs fly in the ` +
    `cabin, under the seat"), never advice like "check before booking" or "it varies". Use exactly the labels ` +
    `MYTH: and FACT:. Each FACT appears opposite its MYTH while the MYTH stays on screen.`,
  mistake:
    `\nSTRUCTURE FOR THIS VIDEO: MISTAKE → WHAT TO DO INSTEAD. A mistake people make (ideally one we made), then ` +
    `the fix, 1–2 pairs: "MISTAKE: Feeding right before the flight", then "INSTEAD: Last meal 4 hours before". The ` +
    `hook teases it (e.g. "Don't do this before your dog flies").`,
  qa:
    `\nSTRUCTURE FOR THIS VIDEO: QUESTION → ANSWER. The hook IS the question, asked plainly. The answer lands as ` +
    `the payoff after a beat: "ANSWER: …" (one clear answer, the moment the video builds to), then 1–2 short ` +
    `"TIP: …" lines that make it actionable. Keep the viewer waiting a little for the answer (it appears after ` +
    `~3s), never give it away in the hook.`,
  dodont:
    `\nSTRUCTURE FOR THIS VIDEO: DON'T / DO. Contrasting pairs, 1–2 of them: "DON'T: Sedate your dog", then "DO: ` +
    `Tire them out with a long walk". Quick to scan, each line short. The hook names the situation (e.g. "How to ` +
    `calm a dog before a flight").`,
  nobody:
    `\nSTRUCTURE FOR THIS VIDEO: "NOBODY TELLS YOU". One surprising, useful fact that most people don't know. The ` +
    `hook teases it (e.g. "Nobody tells you this about pet fees"), then ONE "FACT: …" line with it, the footage ` +
    `as proof. Short: 8–12s. No list.`,
};

/**
 * An inspirational post. For everyone (the default) it's about a feeling anyone has (the leap, the
 * place, what travel changes in you), with the dog in the picture but not the subject; for dog lovers,
 * the journey of seeing the world with your dog.
 */
function inspireText(petName: string, audience: "pets" | "everyone" = "everyone"): string {
  if (audience === "pets")
    return (
      `\n\nFORMAT FOR THIS VIDEO: INSPIRATIONAL. Not a joke and not a lesson: make people feel something about ` +
      `traveling the world with a dog, and make them want to do it too. Use the footage as a quiet, beautiful or ` +
      `meaningful moment of the journey.` +
      `\n- The hook still has to stop the scroll: personal, specific and a little emotional, e.g. "Six countries ` +
      `later, he still sleeps on my feet", "Everyone said we couldn't bring him". No clichés like "living our best life".` +
      `\n- NEVER a joke, irony or a relatable gag (if a friend would reply "lol", it's a fun video, not this one): ` +
      `it gives a feeling (pride, gratitude, wonder, calm) or a thought worth keeping.` +
      `\n- It's cut as a montage: this clip plus other beautiful moments of the journey, about 2s each. A ` +
      `setup line at the start and a payoff line appearing around the middle, staying to the end.` +
      `\n- Post description: where we are in ${petName}'s journey, what it means to us, and an invitation ` +
      `(where would you take your dog?).`
    );
  return (
    `\n\nFORMAT FOR THIS VIDEO: INSPIRATIONAL, FOR EVERYONE. Not a joke, not a lesson, and NOT a dog video: it's ` +
    `about life and travel, the kind of post someone with no pet saves and sends to a friend. Look at what the ` +
    `footage shows (the place, the light, the road, the quiet, the city waking up) and write about the feeling ` +
    `behind it: taking the leap, leaving the comfort zone, slowing down, a place that changes you, building a life ` +
    `that fits you, home being who you're with, the trip you almost didn't take.` +
    `\n- The words must make sense without the dog: don't name ${petName}, don't say "dog", "pup" or "pet" in the ` +
    `on-screen text. ${petName} can be in the footage; the text is about the human side.` +
    `\n- The hook stops the scroll by being personal and specific, e.g. "The trip I almost said no to", "Nobody ` +
    `tells you how quiet it gets when you finally go", "I used to think I'd do this someday", "Some places make you ` +
    `want to stay a little longer", "Proof you don't have to have it all figured out". No clichés like "living our ` +
    `best life" or "wanderlust".` +
    `\n- Proven captions: only borrow a structure from one if it fits; pet-specific wording doesn't belong here. ` +
    `Set basedOn only if you adapt one.` +
    `\n- NEVER a joke, irony or a relatable observation: no contrast gags ("came for X / ended up Y"), no "me ` +
    `when", no "POV", nothing that gets a laugh or an eye-roll. Test: if a friend would reply "lol", it's a fun ` +
    `video, not this one. It has to give a feeling (hope, courage, calm, gratitude, longing) or a thought worth ` +
    `keeping, e.g. "A year ago this was just a screenshot / Today I'm standing in it", "You don't need a perfect ` +
    `plan / Just a first step", "The best things I own / are the places I've been".` +
    `\n- It's cut as a montage: this clip plus other beautiful moments from the trip, about 2s each. Write ` +
    `for that: a setup line at the start, and the payoff line appearing around the middle and staying to the end.` +
    `\n- Post description: the most story-driven of all: where we are and what this chapter means, written so ` +
    `anyone relates, ending with an open question (e.g. "What's the trip you keep putting off?"). The dog can ` +
    `appear in the description as part of the story, not the point of it.`
  );
}

/** A paid collaboration: the brand becomes part of the moment, not an ad read. */
function collabText(c: NonNullable<DirectContext["collab"]>, petName: string): string {
  return (
    `\n\nTHIS IS A BRAND COLLABORATION with ${c.name}${c.handle ? ` (${c.handle})` : ""}. About the brand, in the ` +
    `creator's words: ${c.about}` +
    (c.note ? `\nThe creator's note for this video: ${c.note}` : "") +
    `\n- Pick the part of the clip where ${c.name}'s product or place is visible or most relevant.` +
    (c.educational
      ? `\n- This is an EDUCATIONAL video built around ${c.name}: a real lesson people search for, in the area ` +
        `${c.name} is about (e.g. a carrier brand → what makes a carrier work in the cabin; a pet-friendly hotel → ` +
        `what to check before booking a stay with a dog). The headline is the question, the points answer it ` +
        `honestly from our experience, and ${c.name} shows up as the practical answer in ONE point (named, ` +
        `specific: what it does for us), not in every line. It must be useful even to someone who never buys ` +
        `from ${c.name}; that's what makes the brand look good.`
      : `\n- On-screen text: about the moment, with ${c.name} naturally part of it (what it makes possible for ` +
        `${petName} and us). It must still feel like a creator's post, never an ad read or a slogan.`) +
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
  if (!f || (!f.kept.length && !f.rejected.length && !f.performance?.length && !f.edits?.length)) return "";
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
  const KIND_OF = (x: EditRecord) => (x.format && KIND[x.format] ? ` [${KIND[x.format]}]` : "");
  const short = (t: string) => (t.length > 300 ? `${t.slice(0, 300)}…` : t).replaceAll("\n", " / ");
  const edits = f.edits?.length
    ? `\n\nTHE CREATOR'S OWN CORRECTIONS, newest first: what you (or an earlier version of you) wrote, and what ` +
      `they changed it to. This is the most direct signal of their taste and voice: write the way they correct, ` +
      `avoid what they keep removing, and don't repeat the mistakes they fixed.\n` +
      f.edits
        .map((x) => `- ${x.what === "text" ? "On-screen text" : x.what === "caption" ? "Description" : "Hashtags"}${KIND_OF(x)}: "${short(x.before)}" → "${short(x.after)}"`)
        .join("\n")
    : "";
  return (
    perf +
    edits +
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
    `small changes (names, details), because proven wording performs. Its places, airlines and names are ` +
    `someone else's: replace them with this clip's own, or leave them out. ` +
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
          `along. ${petName} can be in the shot, but the words are for someone who has never had a dog.`
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
          `for a moment); no line needs other context; it reads as natural English, with the small words a person would ` +
          `say ("Call the airline", not "Call airline")` +
          (kind === "tips" || kind === "educational"
            ? `; on-screen text reads as text, not speech: the first line (the hook, which stays on screen as the ` +
              `header) is ONE idea in at most 8 words, plain words, ideally a question anyone is curious about, asked ` +
              `directly ("Where do dogs pee when they fly?"), not aimed at dog owners (no "your dog", "dog owners", "pet ` +
              `parents", "if you have a dog"); never label-style ("Flight day: …"), never quoted, never "you ` +
              `always ask", "our #1 question", "people ask me"; and a ` +
              `numbered point is at most 7 words (shorten them if not; the one case where a line may get much shorter)`
            : "") +
          `; when the first line is a question, every point answers that exact question directly (a "where" question: ` +
          `each point is a place; "how much": an amount; "which": a name) — rewrite a point that's only related advice` +
          `. Be strict: a reader shouldn't ` +
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
      (clip.place ? ` in ${clip.place}` : "") +
      `. Place names in the text: ${clip.place ? `only ${clip.place} (or none)` : "none (where it was filmed isn't known)"}; never a ` +
      `city or country from a proven caption or a guess from the frames.` +
      ` Audio: ${clip.hasAudio ? "yes" : "none"}. Motion+loudness per 0.5s: ${energy || "n/a"}.` +
      (clip.note ? `\nThe creator's note about this footage: "${clip.note}"` : "") +
      (clip.ai?.summary ? `\nEarlier read of the clip: ${clip.ai.summary}` : "") +
      (ctx.brief ? `\nCreator's direction for today: ${ctx.brief}` : "") +
      `\n\nStart from the footage: work out what is actually happening, where, and what ${ctx.petName} is feeling or ` +
      `doing that people will recognize. Then write the single on-screen line that makes it land. Formats are tools, ` +
      `not rules: use a trending structure only if it genuinely fits this footage, otherwise write something original.` +
      `\n\nThe finished video should be ${ctx.minSeconds}–${ctx.maxSeconds}s (sum of (end-start)/speed), starting right ` +
      `on the action and ending where it can loop. Text must never cover ${ctx.petName}, a face or the main action: ` +
      `report where they are (subjectTop/subjectBottom) and keep any placed text outside that band. Overlays use y -1 and no arrow (pointX/pointY -1) unless the ` +
      `format below says otherwise. Pacing: cut every 1.5–2s (several segments, jumping past dead moments); one shot holds longer only while continuous action plays out. Play footage at real speed (1). Slow motion only for one short ` +
      `payoff moment that's better slowed down (a jump, a head tilt, a reaction), never to make the video longer; if ` +
      `the clip is short, use all of it at speed 1 (it's replayed to give time to read). Overlay text: the headline at most 9 words (two short lines), any line after it at most 5 words (one line), so everything on screen at once fits in 3 lines; plain words a stranger gets in a second (no airport codes like FLL or LAX, no jargon: city names), sentence case, no hashtags, no emoji; " / " starts ` +
      `a new line (e.g. "me: quick bath / ${ctx.petName}:").` +
      (ctx.trends.length
        ? `\n\nText formats currently working for pet accounts (optional inspiration):\n` +
          ctx.trends.map((t) => `- ${t.pattern.replaceAll("{pet}", ctx.petName)} (fits: ${t.fits})`).join("\n")
        : "") +
      (ctx.collab ? collabText(ctx.collab, ctx.petName) : ctx.format === "tips" ? "" : audienceText(ctx.audience, ctx.petName, ctx.format)) +
      (ctx.format === "tips" ? tipsText(ctx.petName, clip.scene, ctx.faq, ctx.eduFormat) + pillarText(ctx.pillar, ctx.covered ?? [], ctx.angle, ctx.search) + footageText(ctx.broll ?? []) + savedText(ctx.topPosts ?? []) : ctx.format === "inspire" ? inspireText(ctx.petName, ctx.audience) : "") +
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
  // Extra footage only if it really belongs in this video (a clip's situation label can be wrong:
  // a car seat filed as "inside the airplane"), judged from what's in it against what this video is.
  if (ctx.extraClips?.length) ctx = { ...ctx, extraClips: await fittingClips(r.concept, clip, ctx.extraClips, ctx.format).catch(() => []) };
  // The text was timed for the AI's own cut: when slow motion is removed or the clip replayed, the
  // timing is stretched to the final length so every line still gets its share.
  const planned = lengthOf(segments);
  // More footage from other clips of the moment first; a single replay only if there's none.
  segments =
    ctx.format === "inspire" && ctx.extraClips?.length
      ? fillByRepeating(montage(limitSlowMotion(segments), ctx.extraClips, Math.max(ctx.minSeconds, 12)), ctx.minSeconds)
      : fillByRepeating(fillWithClips(limitSlowMotion(segments), ctx.minSeconds, ctx.extraClips ?? []), ctx.minSeconds);
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
  // The opening line is the headline, pinned at the top like in every video (a placed y would make
  // it a loose point instead).
  if (ctx.format !== "tips") {
    const opening = overlays.filter((o) => o.start <= 0.5 && !o.pointTo).sort((a, b) => a.start - b.start)[0];
    if (opening) delete (opening as Overlay).y;
  }
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
  // Educational: each point over footage that shows it, when there's a clip for it.
  if (ctx.format === "tips" && ctx.broll?.length) {
    const points = overlays.filter((o) => o.y !== undefined);
    const setting =
      ctx.pillar === "airport" ? "at the airport (terminal, check-in, security, relief area, gate)"
      : ctx.pillar === "airline" ? "on the plane or at the airport"
      : ctx.pillar === "prep" || ctx.pillar === "gear" ? "on a travel day (airport, plane, packing at home)"
      : undefined;
    const picks = await pickBroll(points.map((o) => o.text), r.concept, clip, ctx.broll, setting).catch((err) => {
      console.warn("[broll]", (err as Error).message);
      return [] as (Clip | undefined)[];
    });
    if (picks.some(Boolean)) {
      segments = withBroll(segments, points.map((o, i) => ({ start: o.start, end: Math.min(o.end, total), clip: picks[i] })), total);
      for (const c of picks) if (c) known.set(c.id, c);
      total = lengthOf(segments);
    }
  }
  // Educational: the first seconds (the headline alone, before the first point) open on the best
  // footage there is, not on whatever the video's main clip starts with.
  if (ctx.format === "tips" && ctx.opener) {
    const firstPoint = overlays.find((o, i) => i > 0 && o.y !== undefined)?.start ?? 2.5;
    segments = withOpener(segments, ctx.opener, Math.max(1.5, Math.min(3, firstPoint)));
    known.set(ctx.opener.id, ctx.opener);
  }
  // Educational: end on the creator's call to action (their site, link in bio) for the last 3s.
  if (ctx.format === "tips" && ctx.cta?.overlay) {
    segments = lengthenFootage(fillWithClips(segments, total + 3, ctx.extraClips ?? []), total + 3, (id) => known.get(id)?.duration ?? 0);
    const longer = lengthOf(segments);
    // The call to action gets the last 3s, also when there was no more footage to add.
    const ctaStart = Math.max(0, Math.min(total, longer - 3));
    overlays.forEach((o, i) => {
      if (i === 0) overlays[i] = { ...o, end: longer + 1 };
      else if (o.end > ctaStart) overlays[i] = { ...o, end: Math.max(o.start + 1.5, ctaStart) };
    });
    overlays.push({ text: ctx.cta.overlay, start: ctaStart, end: longer + 1, y: 0.5, cta: true });
    total = longer;
  }
  // Pacing: no shot holds for more than about 2s (a slowed payoff up to 3s); the length stays the same.
  segments = paceShots(segments, known, ctx.extraClips ?? []);
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
    ...(ctx.format === "tips" ? { pillar: ctx.pillar, angle: ctx.angle, eduFormat: ctx.eduFormat, searchTopic: ctx.search?.[0]?.topic, topic: r.topic?.trim() || undefined } : {}),
    ...(ctx.audience && ctx.format !== "tips" && !ctx.collab ? { audience: ctx.audience } : {}),
    ...(r.subjectBottom > r.subjectTop && r.subjectTop >= 0 && r.subjectBottom <= 1 && r.subjectBottom - r.subjectTop < 0.9
      ? { keepClear: { top: r.subjectTop, bottom: r.subjectBottom } }
      : {}),
    basedOn: (() => {
      const c = ctx.proven[r.basedOn - 1];
      // Only a reference the hook really shows: shared wording or the same opening pattern.
      return c && echoes(overlays[0]?.text ?? "", c.text) ? { text: c.text, original: c.original, views: c.views, url: c.url } : undefined;
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

const STOP = new Set("the a an and or but to of in on at for with your you my me i it is are was this that his her their our we they be so do dont not no just when what".split(" "));
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
/**
 * Whether a hook visibly builds on a caption: at least two of its words, or the same opening pattern
 * ("POV:", "nobody:", "me when", "when your…", "things I…").
 */
export function echoes(hook: string, caption: string): boolean {
  const a = new Set(words(hook));
  const shared = new Set(words(caption).filter((w) => a.has(w)));
  if (shared.size >= 2) return true;
  const opening = (s: string) => s.toLowerCase().trim().match(/^(pov|nobody|me when|me:|when (your|you)|things|how to|stop|why|if you|the \d|\d )/)?.[0];
  const o = opening(hook);
  return !!o && o === opening(caption);
}

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
