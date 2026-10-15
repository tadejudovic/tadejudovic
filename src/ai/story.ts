import type Anthropic from "@anthropic-ai/sdk";
import { store } from "../store.ts";
import { frameBuffer } from "../media/ffmpeg.ts";
import { structured } from "./director.ts";
import type { Clip, Overlay, Segment, VideoPlan } from "../types.ts";

/**
 * Story videos: the creator writes a storyline, the AI finds a clip (and the best part of it) for
 * each beat, and the parts are stitched in order with a line of text per beat.
 */

/** How many clips the AI looks through (one frame each + their best moments). */
const CANDIDATES = 40;

export async function planStory(storyline: string, targetSeconds: number): Promise<VideoPlan> {
  const { petName, handle, story, scenes } = store.settings();
  const time = (c: Clip) => Date.parse(c.capturedAt ?? c.importedAt) || 0;
  const pool = store
    .clips()
    .filter((c) => c.status === "ready" && c.kind === "video" && c.height >= c.width && !c.disliked && !c.edited && !c.duplicateOf)
    // Unused footage first, then the most recent.
    .sort((a, b) => (a.uses > 0 ? 1 : 0) - (b.uses > 0 ? 1 : 0) || time(b) - time(a))
    .slice(0, CANDIDATES);
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

  content.push({
    type: "text",
    text:
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
      required: ["title", "beats", "postCaption", "hashtags"],
      properties: {
        title: { type: "string" },
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
    plannedBy: "claude",
    concept: storyline.slice(0, 300),
    scene: scene && scenes.includes(scene) ? scene : undefined,
  };
}
