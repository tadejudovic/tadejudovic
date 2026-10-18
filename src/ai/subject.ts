import { config } from "../config.ts";
import { frameBuffer } from "../media/ffmpeg.ts";
import { structured } from "./director.ts";
import type { Clip, VideoPlan } from "../types.ts";

/**
 * Where the subject (the dog, faces, the main action) is in a video's frames, top to bottom, so text
 * can be kept off it. For videos planned before the AI reported it; a quick look at three frames.
 */
export async function detectSubject(plan: VideoPlan, clips: Map<string, Clip>): Promise<{ top: number; bottom: number } | undefined> {
  const picks = plan.segments.slice(0, 3);
  const times = picks.length >= 3 ? picks.map((s) => [s, (s.start + s.end) / 2] as const) : [0.2, 0.5, 0.8].map((f) => [picks[0], picks[0].start + (picks[0].end - picks[0].start) * f] as const);
  const content: Parameters<typeof structured>[0]["content"] = [];
  for (const [seg, t] of times) {
    const clip = clips.get(seg.clipId);
    if (!clip) continue;
    const jpg = await frameBuffer(clip.file, t, 384).catch(() => null);
    if (jpg) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
  }
  if (!content.length) return undefined;
  content.push({
    type: "text",
    text:
      "These are frames from one vertical video. Where is the subject, the dog and any faces or main action, from top " +
      "to bottom of the frame (0 = top, 1 = bottom)? Give one band that covers it in all the frames.",
  });
  const r = await structured<{ top: number; bottom: number }>({
    system: "You look at video frames and say where the subject is, precisely.",
    content,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["top", "bottom"],
      properties: { top: { type: "number" }, bottom: { type: "number" } },
    },
    effort: "low",
    model: config.claude.fastModel,
  });
  return r.bottom > r.top && r.top >= 0 && r.bottom <= 1 && r.bottom - r.top < 0.9 ? r : undefined;
}
