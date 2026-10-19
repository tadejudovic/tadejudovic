import { config } from "../config.ts";
import { frameBuffer } from "../media/ffmpeg.ts";
import { structured } from "./director.ts";
import type { Clip, EditorReview, Render } from "../types.ts";

/**
 * The editor's review: the finished video looked at like the best TikTok editor would, from frames
 * of the render itself at the moments that matter (the first second, each piece of text), with the
 * text timeline and the footage used. Says whether it's ready, what's wrong, and for a text problem
 * the corrected text.
 */
export interface EditorVerdict {
  scores: EditorReview["scores"];
  verdict: EditorReview["verdict"];
  issues: string[];
  /** fix_text: the corrected text, one per piece of text, same order and roles. */
  texts: string[];
  /** remake: what the new version must do differently. */
  remakeBrief: string;
}

const KIND: Record<string, string> = { tips: "educational", fun: "fun / entertaining", inspire: "inspirational" };

export async function reviewVideo(r: Render, duration: number, clips: Map<string, Clip>, petName: string): Promise<EditorVerdict> {
  const overlays = r.plan.overlays ?? [{ text: r.plan.hook, start: 0, end: duration }];
  // The first second, then each piece of text while it's on screen, then the end: at most 10 frames.
  const times = [0.3, 1.2, ...overlays.slice(1).map((o) => (o.start + Math.min(o.end, duration)) / 2), duration - 0.4]
    .filter((t) => t >= 0 && t < duration)
    .slice(0, 10);
  const content: Parameters<typeof structured>[0]["content"] = [];
  for (const t of times) {
    const jpg = await frameBuffer(r.file!, t, 360).catch(() => null);
    if (!jpg) continue;
    content.push({ type: "text", text: `Frame at ${t.toFixed(1)}s` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
  }
  let at = 0;
  const footage = r.plan.segments.map((s) => {
    const c = clips.get(s.clipId);
    const len = (s.end - s.start) / (s.speed ?? 1);
    const line = `${at.toFixed(1)}–${(at + len).toFixed(1)}s: ${c?.ai?.summary ?? c?.scene ?? "?"}${c?.scene ? ` [${c.scene}]` : ""}${c?.capturedAt ? `, filmed ${c.capturedAt.slice(0, 10)}` : ""}`;
    at += len;
    return line;
  });
  content.push({
    type: "text",
    text:
      `A ${KIND[r.plan.format ?? "fun"] ?? ""} TikTok/Reels video of ${petName} (${duration.toFixed(1)}s), about to go to the ` +
      `creator for approval. Today is ${new Date().toISOString().slice(0, 10)}.\n\n` +
      `On-screen text (in order; the first is the headline):\n` +
      overlays.map((o, i) => `${i + 1}. "${o.text}" ${o.start.toFixed(1)}–${Math.min(o.end, duration).toFixed(1)}s`).join("\n") +
      `\n\nFootage, in order:\n${footage.join("\n")}\n\n` +
      `Review it as the best short-form editor there is, from the frames above. Score each 1–10:\n` +
      `- hook: would the headline stop a stranger's scroll? Short, plain, curious, for anyone (not only dog owners), ` +
      `not label-style, not about who asks.\n` +
      `- firstSecond: is the opening frame strong (clear subject, movement or a face), not a dull or blurry start?\n` +
      `- textPlacement: does any text cover a face (the dog's or a person's) or the main action in the frames? Is ` +
      `it inside the safe area (not at the very edges, not in the bottom fifth)?\n` +
      `- footage: does the footage fit what the text says while it's on screen (e.g. an airport point over airport ` +
      `footage), is it recent rather than old, and does it flow without odd jumps?\n` +
      `- pacing: tight, no dead or static stretches, each piece of text long enough to read, nothing dragging.\n` +
      `- readability: can each piece of text be read at a glance, and does the whole make sense to a stranger?\n\n` +
      `Verdict: "pass" when every score is 7 or more. Otherwise "fix_text" when the problems are only in the words ` +
      `(give the corrected texts: exactly ${overlays.length}, same order and roles, same rules for the headline), or ` +
      `"remake" when the footage, the cut or the pacing is the problem (say in remakeBrief what the new version must ` +
      `do differently). Issues: the specific problems, short, the way you'd tell the creator. Be honest and strict: ` +
      `a video that's only fine is not a pass.`,
  });
  return structured<EditorVerdict>({
    system:
      "You are the best TikTok and Instagram Reels editor working today: you know what stops the scroll, what keeps " +
      "people watching and what makes them share. You review videos before they're posted and you don't let weak " +
      "ones through.",
    content,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["scores", "verdict", "issues", "texts", "remakeBrief"],
      properties: {
        scores: {
          type: "object",
          additionalProperties: false,
          required: ["hook", "firstSecond", "textPlacement", "footage", "pacing", "readability"],
          properties: Object.fromEntries(["hook", "firstSecond", "textPlacement", "footage", "pacing", "readability"].map((k) => [k, { type: "integer" }])),
        },
        verdict: { type: "string", enum: ["pass", "fix_text", "remake"] },
        issues: { type: "array", items: { type: "string" } },
        texts: { type: "array", items: { type: "string" } },
        remakeBrief: { type: "string" },
      },
    },
    effort: "medium",
    model: config.claude.model,
  });
}
