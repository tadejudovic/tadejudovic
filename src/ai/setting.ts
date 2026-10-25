import { config } from "../config.ts";
import { frameBuffer } from "../media/ffmpeg.ts";
import { structured } from "./director.ts";
import { aiAvailable } from "./budget.ts";

/**
 * How obvious it is, from one frame, that this is an airport or a plane with Lex in it: 0 (could be
 * anywhere, or no dog) to 3 (instantly: the plane, the gate, check-in, the cabin, the jet bridge).
 * One look with the small model for several frames; zeros when the AI isn't available.
 */
export async function settingClarity(frames: { file: string; t: number }[]): Promise<number[]> {
  if (!frames.length || !config.claude.enabled || !aiAvailable()) return frames.map(() => 0);
  const content: Parameters<typeof structured>[0]["content"] = [];
  for (const [i, f] of frames.entries()) {
    const jpg = await frameBuffer(f.file, f.t, 360).catch(() => null);
    content.push({ type: "text", text: `Frame ${i + 1}${jpg ? "" : " (missing)"}` });
    if (jpg) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
  }
  content.push({
    type: "text",
    text:
      "Each frame is the first frame of a short video's opening. For each, score 0–3 how instantly a stranger " +
      "scrolling past knows it's at an airport or on a plane, with the dog clearly in it: 3 = unmistakable (a plane, " +
      "the cabin, the gate, check-in desks, a jet bridge, departure boards, in the first glance), 2 = clear once you " +
      "look, 1 = could be an airport, 0 = could be anywhere (a carpet, a wall, a floor) or no dog.",
  });
  const r = await structured<{ scores: { n: number; score: number }[] }>({
    system: "You judge how clearly a video frame shows its setting.",
    content,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["scores"],
      properties: {
        scores: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["n", "score"], properties: { n: { type: "integer" }, score: { type: "integer" } } },
        },
      },
    },
    effort: "low",
    model: config.claude.fastModel,
  });
  return frames.map((_, i) => Math.max(0, Math.min(3, r.scores.find((s) => s.n === i + 1)?.score ?? 0)));
}
