import type Anthropic from "@anthropic-ai/sdk";
import { store } from "../store.ts";
import { frameBuffer } from "../media/ffmpeg.ts";
import { structured } from "./director.ts";
import type { Clip, Overlay, Segment, VideoPlan } from "../types.ts";

/**
 * Day vlogs: the clips filmed on one day, in the order they were filmed, cut to their best moment
 * each, with a hook on top and a short line per moment, like a "day in the life" video.
 */

/** The local calendar day a clip was filmed ("2026-10-12"). */
export const dayOf = (c: Clip) => (c.capturedAt ? c.capturedAt.slice(0, 10) : undefined);

const usable = (c: Clip) =>
  c.status === "ready" && c.kind === "video" && c.height >= c.width && !c.edited && !c.duplicateOf && c.duration >= 2;

/** Days with enough footage for a vlog, newest first. */
export function vlogDays(min = 3): { day: string; clips: number; places: string[]; thumbs: string[]; minutes: number }[] {
  const byDay = new Map<string, Clip[]>();
  for (const c of store.clips()) {
    const d = dayOf(c);
    if (d && usable(c)) byDay.set(d, [...(byDay.get(d) ?? []), c]);
  }
  return [...byDay.entries()]
    .filter(([, cs]) => cs.length >= min)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, cs]) => ({
      day,
      clips: cs.length,
      places: [...new Set(cs.map((c) => c.place).filter((p): p is string => !!p))].slice(0, 3),
      thumbs: cs.sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? "")).slice(0, 4).map((c) => c.id),
      minutes: Math.round(cs.reduce((a, c) => a + c.duration, 0) / 60),
    }));
}

export async function planDayVlog(day: string, targetSeconds = 30): Promise<VideoPlan> {
  const { petName, handle, story } = store.settings();
  const clips = store
    .clips()
    .filter((c) => usable(c) && dayOf(c) === day)
    .sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""));
  if (clips.length < 2) throw new Error("That day doesn't have enough clips for a vlog.");
  // At most 12, spread over the day when there are more.
  const shown = clips.length <= 12 ? clips : Array.from({ length: 12 }, (_, i) => clips[Math.floor((i * clips.length) / 12)]);

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const [i, c] of shown.entries()) {
    const jpg = await frameBuffer(c.file, Math.max(0, c.duration / 2), 320).catch(() => null);
    const best = (c.ai?.moments ?? c.moments ?? []).slice(0, 2).map((m) => `${m.start.toFixed(1)}–${m.end.toFixed(1)}s ${m.description ?? ""}`.trim()).join("; ");
    content.push({
      type: "text",
      text:
        `Clip ${i + 1}: filmed ${c.capturedAt?.slice(11, 16) ?? "?"}, ${c.duration.toFixed(1)}s` +
        (c.place ? `, ${c.place}` : "") +
        (c.ai?.summary ? `. ${c.ai.summary}` : "") +
        (best ? ` Best moments: ${best}` : ""),
    });
    if (jpg) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
  }
  content.push({
    type: "text",
    text:
      `These are all the clips ${petName}${handle ? ` (${handle})` : ""} and their human filmed on ${day}, in order. Make ` +
      `a day-in-the-life vlog of about ${targetSeconds}s: pick the moments that tell the day (in the order they ` +
      `happened, skip dull or repetitive ones, 2–4s each), the part of each clip to use (start/end seconds inside it), ` +
      `a hook that stays on top the whole video and makes people want to see the day (e.g. "A day flying ` +
      `${petName} to Lisbon", "24 hours in Tokyo with a dog"), and for each moment a short line (3–7 words, like a ` +
      `vlogger's note: "6am: airport zoomies", "first espresso, he wants some"). ` +
      `Then the post description: the day's story in a few sentences, in the creator's voice, ending with a question; ` +
      `no hashtags. And exactly 3 hashtags without #.` +
      (story ? `\nThe account's story: ${story}` : ""),
  });
  const out = await structured<{
    title: string;
    hook: string;
    moments: { clip: number; start: number; end: number; text: string }[];
    postCaption: string;
    hashtags: string[];
  }>({
    system: "You edit day-in-the-life vlogs for a creator who travels the world with their dog.",
    content,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "hook", "moments", "postCaption", "hashtags"],
      properties: {
        title: { type: "string" },
        hook: { type: "string" },
        moments: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["clip", "start", "end", "text"],
            properties: { clip: { type: "integer" }, start: { type: "number" }, end: { type: "number" }, text: { type: "string" } },
          },
        },
        postCaption: { type: "string" },
        hashtags: { type: "array", items: { type: "string" } },
      },
    },
    effort: "medium",
  });

  // In the order filmed, each clip once, 1.5–5s.
  const picked = out.moments
    .map((m) => ({ m, clip: shown[m.clip - 1] }))
    .filter((x): x is { m: typeof x.m; clip: Clip } => !!x.clip)
    .filter((x, i, all) => all.findIndex((y) => y.clip.id === x.clip.id) === i)
    .sort((a, b) => shown.indexOf(a.clip) - shown.indexOf(b.clip));
  if (picked.length < 2) throw new Error("Couldn't build a vlog from that day's clips.");
  const segments: Segment[] = [];
  const overlays: Overlay[] = [];
  let t = 0;
  for (const [i, { m, clip }] of picked.entries()) {
    const start = Math.max(0, Math.min(m.start, clip.duration - 1.5));
    const end = Math.min(clip.duration, Math.max(start + 1.5, Math.min(m.end, start + 5)));
    segments.push({ clipId: clip.id, start, end, speed: 1 });
    const len = end - start;
    if (m.text.trim()) overlays.push({ text: m.text.trim(), start: t, end: i === picked.length - 1 ? t + len + 1 : t + len, y: 0.64 });
    t += len;
  }
  overlays.unshift({ text: out.hook.trim() || out.title, start: 0, end: t + 1 });
  return {
    template: "auto",
    title: out.title,
    hook: overlays[0].text,
    overlays,
    segments,
    postCaption: out.postCaption,
    hashtags: out.hashtags.map((h) => h.replace(/^#/, "")).slice(0, 3),
    format: "story",
    vlogDay: day,
    plannedBy: "claude",
  };
}
