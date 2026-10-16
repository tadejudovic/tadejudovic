import type Anthropic from "@anthropic-ai/sdk";
import { store } from "../store.ts";
import { frameBuffer } from "../media/ffmpeg.ts";
import { structured } from "./director.ts";
import { provenCaptions } from "./research.ts";
import type { Clip, DraftLine, Overlay, Segment, StoryDraft, VideoPlan } from "../types.ts";

/**
 * Story videos: the creator writes a storyline, the AI finds a clip (and the best part of it) for
 * each beat, and the parts are stitched in order with a line of text per beat.
 */

/** How many clips the AI looks through (one frame each + their best moments). */
const CANDIDATES = 40;

/**
 * Shot directions inside the creator's text: "[lying at the gate]" or "/security". They say which
 * footage to show for the words that follow, and are never spoken or shown as text.
 */
const SHOT_RE = /\[([^\[\]\n]{1,80})\]|(^|\s)\/([a-z][\w-]{1,40})/gi;

export function parseShots(source: string): { marked: string; shots: string[] } {
  const shots: string[] = [];
  const marked = source.replace(SHOT_RE, (_m, bracket: string | undefined, lead: string | undefined, slash: string | undefined) => {
    const shot = (bracket ?? slash ?? "").replace(/[-_]+/g, " ").trim();
    if (!shot) return _m;
    shots.push(shot);
    return `${lead ?? ""}{SHOT: ${shot}}`;
  });
  return { marked, shots };
}

/** The spoken words without any shot directions left in them. */
export function stripShots(text: string): string {
  return text.replace(/\{SHOT:[^}]*\}/gi, " ").replace(SHOT_RE, (_m, _b, lead: string | undefined) => lead ?? " ").replace(/\s+/g, " ").trim();
}

const STOP = new Set("the and for with that this from have has was were are his her him she they them you your our out into over just like about what when then than there here very really more most some lex dog dogs".split(" "));
const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
const clipText = (c: Clip) =>
  [c.scene, c.ai?.summary, ...(c.ai?.tags ?? []), c.note, ...(c.ai?.moments ?? []).map((m) => m.description)].filter(Boolean).join(" ");
function relevance(c: Clip, query: Set<string>): number {
  let n = 0;
  for (const w of words(clipText(c))) if (query.has(w) || [...query].some((q) => q.length >= 5 && (w.startsWith(q) || q.startsWith(w)))) n++;
  return n;
}

/**
 * The clips the AI chooses from, shown as one frame each plus their best moments: for every shot
 * the creator asked for, the clips that match it best; then the clips that fit the text; then
 * unused and recent footage.
 */
async function clipCandidates(text = "", shots: string[] = []): Promise<{ shown: Clip[]; content: Anthropic.Beta.BetaContentBlockParam[] }> {
  const time = (c: Clip) => Date.parse(c.capturedAt ?? c.importedAt) || 0;
  const all = store
    .clips()
    .filter((c) => c.status === "ready" && c.kind === "video" && c.height >= c.width && !c.disliked && !c.edited && !c.duplicateOf)
    // Unused footage first, then the most recent.
    .sort((a, b) => (a.uses > 0 ? 1 : 0) - (b.uses > 0 ? 1 : 0) || time(b) - time(a));
  const picked = new Set<Clip>();
  for (const shot of shots) {
    const q = words(shot);
    all
      .map((c) => ({ c, r: relevance(c, q) }))
      .filter((x) => x.r > 0)
      .sort((x, y) => y.r - x.r)
      .slice(0, 4)
      .forEach((x) => picked.add(x.c));
  }
  const q = words(text);
  if (q.size) {
    all
      .map((c) => ({ c, r: relevance(c, q) }))
      .filter((x) => x.r > 0)
      .sort((x, y) => y.r - x.r)
      .slice(0, Math.max(0, CANDIDATES * 0.6 - picked.size))
      .forEach((x) => picked.add(x.c));
  }
  for (const c of all) {
    if (picked.size >= CANDIDATES) break;
    picked.add(c);
  }
  const pool = [...picked].slice(0, CANDIDATES);
  if (pool.length < 2) throw new Error("A story needs at least two clips in your library.");

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  const shown: Clip[] = [];
  for (const c of pool) {
    const jpg = await frameBuffer(c.file, Math.max(0, c.duration / 2), 320).catch(() => null);
    if (!jpg) continue;
    shown.push(c);
    const moments = (c.ai?.moments ?? c.moments ?? [])
      .slice(0, 3)
      .map((m) => `${m.start.toFixed(1)}–${m.end.toFixed(1)}s${m.description ? ` ${m.description}` : ""}`)
      .join("; ");
    content.push({
      type: "text",
      text:
        `Clip ${shown.length}: ${c.duration.toFixed(1)}s` +
        (c.scene ? `, ${c.scene}` : "") +
        (c.capturedAt ? `, filmed ${c.capturedAt.slice(0, 10)}` : "") +
        (c.ai?.summary ? `. ${c.ai.summary}` : "") +
        (c.note ? ` Creator's note: ${c.note}` : "") +
        (moments ? ` Best moments: ${moments}` : ""),
    });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
  }
  if (shown.length < 2) throw new Error("Couldn't read enough clips to build a story.");
  return { shown, content };
}

export async function planStory(storyline: string, targetSeconds: number): Promise<VideoPlan> {
  const { petName, handle, story, scenes } = store.settings();
  const { shown, content } = await clipCandidates(storyline);

  // Proven hooks from TikTok research (a few per situation), so the story's hook stands on one too.
  const proven = scenes.flatMap((sc) => provenCaptions(sc).slice(0, 3));
  content.push({
    type: "text",
    text:
      (proven.length
        ? `PROVEN HOOKS from the most-viewed TikToks in this creator's situations:\n` +
          proven.map((c, i) => `${i + 1}. "${c.text}"${c.views ? ` (${c.views.toLocaleString("en")} views)` : ""}`).join("\n") +
          `\nBuild the first beat's text (the hook) on the pattern or wording of one of these, made about this story, ` +
          `and set basedOn to its number (-1 if none fits).\n\n`
        : "") +
      `The creator's storyline for a vertical video of ${petName}${handle ? ` (${handle})` : ""}:\n"""${storyline}"""\n\n` +
      `Turn it into beats (3–7, in the storyline's order) and pick for each beat the clip above that shows it best, ` +
      `and the part of that clip to use (start/end seconds inside the clip, 1.5–5s each; prefer the best moments). ` +
      `Use each clip at most once. If no clip fits a beat, merge or drop that beat rather than using a wrong clip.` +
      `\nThe whole video should be about ${targetSeconds}s.` +
      `\nOn-screen text per beat: short (under ~8 words), like a creator telling the story, not describing what's ` +
      `visible. The first beat's text is the hook and has to stop the scroll on its own.` +
      `\nPost description: 4–7 sentences in the creator's voice telling this story, tied into the bigger journey, ` +
      `ending with a question. Emoji ok, no hashtags.` +
      (story ? `\nThe account's story, for the description: ${story}` : "") +
      `\nHashtags: exactly 3 without #: one big (1M–5M posts), one mid (50K–100K), one small (~10K).`,
  });

  const out = await structured<{
    title: string;
    basedOn: number;
    beats: { clip: number; start: number; end: number; text: string }[];
    postCaption: string;
    hashtags: string[];
  }>({
    system:
      "You edit short story videos for a creator who travels the world with their dog. You match each beat of their " +
      "storyline to the footage that really shows it, and write on-screen text that tells the story.",
    content,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "basedOn", "beats", "postCaption", "hashtags"],
      properties: {
        title: { type: "string" },
        basedOn: { type: "integer", description: "Number of the proven hook the first beat's text is built on, or -1" },
        beats: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["clip", "start", "end", "text"],
            properties: {
              clip: { type: "integer", description: "The clip's number" },
              start: { type: "number" },
              end: { type: "number" },
              text: { type: "string" },
            },
          },
        },
        postCaption: { type: "string" },
        hashtags: { type: "array", items: { type: "string" } },
      },
    },
    effort: "medium",
  });

  // Keep beats that point at a real clip, each clip once, inside its length.
  const used = new Set<string>();
  const segments: Segment[] = [];
  const texts: string[] = [];
  for (const b of out.beats) {
    const clip = shown[b.clip - 1];
    if (!clip || used.has(clip.id)) continue;
    used.add(clip.id);
    const start = Math.max(0, Math.min(b.start, clip.duration - 1));
    const end = Math.max(start + 1, Math.min(b.end, clip.duration, start + 6));
    segments.push({ clipId: clip.id, start, end });
    texts.push(b.text.trim());
  }
  if (segments.length < 2) throw new Error("Couldn't find clips that match this storyline. Try describing moments you've filmed.");

  // Each beat's text shows while its part plays; the last stays to the end.
  const overlays: Overlay[] = [];
  let t = 0;
  for (const [i, s] of segments.entries()) {
    const len = s.end - s.start;
    if (texts[i]) overlays.push({ text: texts[i], start: t, end: i === segments.length - 1 ? t + len + 1 : t + len });
    t += len;
  }
  const scene = shown.find((c) => c.id === segments[0].clipId)?.scene;
  return {
    template: "auto",
    title: out.title,
    hook: overlays[0]?.text ?? out.title,
    overlays,
    segments,
    postCaption: out.postCaption,
    hashtags: out.hashtags.map((h) => h.replace(/^#/, "")).slice(0, 3),
    format: "story",
    basedOn: (() => {
      const c = proven[out.basedOn - 1];
      return c ? { text: c.text, views: c.views, url: c.url } : undefined;
    })(),
    plannedBy: "claude",
    concept: storyline.slice(0, 300),
    scene: scene && scenes.includes(scene) ? scene : undefined,
  };
}

/** Spoken words per second, for a line's length before it's recorded. */
const WORDS_PER_SECOND = 2.6;
export const estimateSeconds = (text: string) => Math.max(1.6, text.split(/\s+/).filter(Boolean).length / WORDS_PER_SECOND + 0.4);

/**
 * A voiceover story: a script used word for word, or a talk track (rough points) turned into a
 * spoken script in the creator's voice. Each spoken line gets the clip that shows it best, or a
 * note of what footage is missing. The creator then records the lines.
 */
export async function planVoiceDraft(
  mode: "script" | "talk",
  source: string,
  partner?: { name: string; handle?: string; about: string; mustInclude?: string },
): Promise<Omit<StoryDraft, "id" | "createdAt" | "source" | "mode" | "partnerId">> {
  const { petName, handle, story, scenes } = store.settings();
  const { marked, shots } = parseShots(source);
  const { shown, content } = await clipCandidates(source, shots);
  const proven = scenes.flatMap((sc) => provenCaptions(sc).slice(0, 3));
  content.push({
    type: "text",
    text:
      (mode === "script"
        ? `The creator's VOICEOVER SCRIPT, to be used WORD FOR WORD:\n"""${marked}"""\n\n` +
          `Split it into spoken lines in order (one sentence or a natural phrase each, about 2–6 seconds spoken). ` +
          `Don't change, add or drop any words.`
        : `The creator's TALK TRACK (rough points of what they want to say):\n"""${marked}"""\n\n` +
          `Write the voiceover they'll read, in their voice: natural spoken English, first person, short sentences, ` +
          `covering every point in order. The first line is a hook that stops the scroll. Split it into spoken lines ` +
          `(about 2–6 seconds each, 6–14 lines).` +
          (proven.length
            ? `\nFor the hook, build on the pattern of one of these proven TikTok hooks:\n` +
              proven.map((c, i) => `${i + 1}. "${c.text}"`).join("\n")
            : "")) +
      (shots.length
        ? `\n\n{SHOT: …} marks are the creator's directions for the footage, NOT words to say: every line after a ` +
          `mark (until the next mark) must use a clip that really shows that shot; set "shot" on those lines to it. ` +
          `If no clip shows it, set clip to -1 and "missing" to that shot. Lines without a direction: pick yourself.`
        : "") +
      `\n\nFor each line pick the clip above that best shows what's being said, and the part of it to use (start/end ` +
      `seconds inside the clip). The part should last about as long as the line takes to say (~${WORDS_PER_SECOND} words ` +
      `per second), so prefer clips long enough. A clip may be reused for different parts only if nothing else fits. ` +
      `If NO clip shows a line (e.g. a product screen or a moment that wasn't filmed), set clip to -1 and describe the ` +
      `shot that's needed in "missing".` +
      (partner
        ? `\n\nThis is a paid collaboration with ${partner.name}${partner.handle ? ` (${partner.handle})` : ""}: ${partner.about}`
        : "") +
      `\n\nAlso write the post description (in the creator's voice, about this video, tied into the bigger journey` +
      `${partner ? `, mentioning ${partner.handle || partner.name}${partner.mustInclude ? ` and including exactly: ${partner.mustInclude}` : ""}, ending with "#ad"` : ", ending with a question"}; ` +
      `no hashtags) and exactly 3 hashtags without # (one 1M–5M posts, one 50K–100K, one ~10K).` +
      (story ? `\nThe account's story: ${story}` : "") +
      `\nThe pet is ${petName}${handle ? `, account ${handle}` : ""}.`,
  });
  const out = await structured<{
    title: string;
    basedOn: number;
    lines: { text: string; clip: number; start: number; end: number; missing: string; shot: string }[];
    postCaption: string;
    hashtags: string[];
  }>({
    system:
      "You edit voiceover videos for a creator who travels the world with their dog: you match every spoken line to " +
      "the footage that really shows it, and you never pretend a clip shows something it doesn't.",
    content,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "basedOn", "lines", "postCaption", "hashtags"],
      properties: {
        title: { type: "string" },
        basedOn: { type: "integer", description: "Number of the proven hook the first line builds on, or -1" },
        lines: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["text", "clip", "start", "end", "missing", "shot"],
            properties: {
              text: { type: "string", description: "The spoken words of this line" },
              clip: { type: "integer", description: "The clip's number, or -1 if none shows this line" },
              start: { type: "number" },
              end: { type: "number" },
              missing: { type: "string", description: "If clip is -1: the shot this line needs. Otherwise empty." },
              shot: { type: "string", description: "The creator's shot direction for this line, or empty" },
            },
          },
        },
        postCaption: { type: "string" },
        hashtags: { type: "array", items: { type: "string" } },
      },
    },
    effort: "medium",
  });
  const lines: DraftLine[] = out.lines
    .map((l) => ({ ...l, text: stripShots(l.text), shot: l.shot.trim() || undefined }))
    .filter((l) => l.text)
    .map((l) => {
      const clip = shown[l.clip - 1];
      if (!clip) return { text: l.text, shot: l.shot, missing: l.missing.trim() || l.shot || "a clip that shows this" };
      const start = Math.max(0, Math.min(l.start, clip.duration - 0.5));
      return { text: l.text, shot: l.shot, clipId: clip.id, start, end: Math.max(start + 0.5, Math.min(l.end, clip.duration)) };
    });
  if (!lines.length) throw new Error("Couldn't turn that into spoken lines. Try again with a bit more text.");
  const firstScene = shown.find((c) => c.id === lines.find((l) => l.clipId)?.clipId)?.scene;
  const b = mode === "talk" ? proven[out.basedOn - 1] : undefined;
  return {
    title: out.title,
    lines,
    postCaption: out.postCaption,
    hashtags: out.hashtags.map((h) => h.replace(/^#/, "")).slice(0, 3),
    basedOn: b ? { text: b.text, views: b.views, url: b.url } : undefined,
    scene: firstScene && scenes.includes(firstScene) ? firstScene : undefined,
  };
}

/** Short subtitle chunks (a few words each), timed across the line's length in proportion to their length. */
export function captionChunks(text: string, start: number, seconds: number, maxWords = 5): Overlay[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) chunks.push(words.slice(i, i + maxWords).join(" "));
  const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
  let t = start;
  return chunks.map((c) => {
    const len = (seconds * c.length) / total;
    const o: Overlay = { text: c, start: t, end: t + len, at: "caption" };
    t += len;
    return o;
  });
}

/**
 * Turn a draft into a video plan: each line lasts as long as its recording (or its estimated
 * reading time), the clip part fits that length, captions follow the words, and the recordings
 * go on the timeline as the voiceover.
 */
export function planFromDraft(draft: StoryDraft, withVoice: boolean): VideoPlan {
  const missing = draft.lines.filter((l) => !l.clipId);
  if (missing.length) throw new Error(`${missing.length} line(s) have no clip yet: ${missing.map((l) => `"${l.text.slice(0, 40)}"`).join(", ")}`);
  if (withVoice && draft.lines.some((l) => !l.audio)) throw new Error("Record every line first, or make it with captions only.");
  const segments: Segment[] = [];
  const overlays: Overlay[] = [];
  const voiceover: { file: string; start: number }[] = [];
  let t = 0;
  for (const line of draft.lines) {
    const clip = store.clip(line.clipId!);
    if (!clip || clip.status !== "ready") throw new Error(`A clip for "${line.text.slice(0, 40)}" is no longer in the library.`);
    const want = (withVoice ? line.audioSeconds ?? estimateSeconds(line.text) : estimateSeconds(line.text)) + 0.25;
    let start = line.start ?? 0;
    let speed = 1;
    let part = want;
    if (clip.duration >= want) {
      if (start + want > clip.duration) start = clip.duration - want;
    } else {
      // Too short: use all of it, slowed down (at most to half speed).
      start = 0;
      part = clip.duration;
      speed = Math.max(0.5, clip.duration / want);
    }
    segments.push({ clipId: clip.id, start, end: start + part, speed });
    const length = part / speed;
    if (withVoice && line.audio) voiceover.push({ file: line.audio, start: t + 0.1 });
    overlays.push(...captionChunks(line.text, t + 0.1, Math.max(0.8, length - 0.2)));
    t += length;
  }
  const first = draft.lines[0].text;
  return {
    template: "auto",
    plannedBy: "claude",
    format: "story",
    title: draft.title,
    hook: first,
    overlays,
    segments,
    voiceover: withVoice ? voiceover : undefined,
    postCaption: draft.postCaption,
    hashtags: draft.hashtags,
    basedOn: draft.basedOn,
    scene: draft.scene,
    concept: draft.source.slice(0, 300),
  };
}
