import { config } from "../config.ts";
import { frameBuffer, run } from "../media/ffmpeg.ts";
import { structured } from "./director.ts";
import type { Clip, EditorReview, Render } from "../types.ts";

/**
 * The editor's review: the finished video looked at like the best TikTok editor would, in its three
 * parts: the hook (the first 3 seconds, where viewers stay or go), the body, and the ending (the call
 * to action). Each part on its visual, its text, its motion and its sound, from frames of the render
 * itself (most of them in the first 3 seconds), the text timeline, the cuts and the sound levels.
 * Aim: a retention curve that stays high, not one that drops off a cliff after the first seconds.
 */
export interface EditorVerdict {
  scores: EditorReview["scores"];
  parts: NonNullable<EditorReview["parts"]>;
  dropOff: { at: number; why: string }[];
  verdict: EditorReview["verdict"];
  issues: string[];
  /** fix_text: the corrected text, one per piece of text, same order and roles. */
  texts: string[];
  /** remake: what the new version must do differently. */
  remakeBrief: string;
}

const KIND: Record<string, string> = { tips: "educational", fun: "fun / entertaining", inspire: "inspirational" };
const HOOK_SECONDS = 3;

/** Mean loudness (dB) of a stretch of the video, or undefined when it can't be read. */
async function loudness(file: string, start: number, length: number): Promise<number | undefined> {
  try {
    const { stderr } = await run("ffmpeg", ["-v", "info", "-ss", String(start), "-t", String(length), "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}
const describeLoudness = (db?: number) =>
  db === undefined ? "unknown" : db < -45 ? `silent (${db} dB)` : db < -30 ? `quiet (${db} dB)` : `audible (${db} dB)`;

/** The pass rule, whatever the model says: the hook must be strong, the rest solid. */
export const passes = (s: EditorReview["scores"]) => s.hook >= 8 && s.body >= 7 && s.ending >= 7;

export async function reviewVideo(r: Render, duration: number, clips: Map<string, Clip>, petName: string): Promise<EditorVerdict> {
  const overlays = r.plan.overlays ?? [{ text: r.plan.hook, start: 0, end: duration }];
  const hookEnd = Math.min(HOOK_SECONDS, duration);
  const endStart = Math.max(hookEnd, duration - 3);
  // Five looks inside the first 3 seconds, the body at each piece of text, two in the ending.
  const at = (t: number, part: string) => ({ t: Math.max(0, Math.min(duration - 0.05, t)), part });
  const frames = [
    ...[0.1, 0.7, 1.4, 2.1, 2.8].filter((t) => t < hookEnd).map((t) => at(t, "hook")),
    ...overlays
      .slice(1)
      .map((o) => (o.start + Math.min(o.end, duration)) / 2)
      .filter((t) => t >= hookEnd && t < endStart)
      .slice(0, 5)
      .map((t) => at(t, "body")),
    ...(duration - 3 > hookEnd ? [at(duration - 2.5, "ending"), at(duration - 0.3, "ending")] : []),
  ];
  const content: Parameters<typeof structured>[0]["content"] = [];
  for (const f of frames) {
    const jpg = await frameBuffer(r.file!, f.t, 360).catch(() => null);
    if (!jpg) continue;
    content.push({ type: "text", text: `${f.part.toUpperCase()} frame at ${f.t.toFixed(1)}s` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
  }
  // The cut: where shots change, and what each shot is.
  let t = 0;
  const shots = r.plan.segments.map((s) => {
    const c = clips.get(s.clipId);
    const len = (s.end - s.start) / (s.speed ?? 1);
    const line = `${t.toFixed(1)}–${(t + len).toFixed(1)}s${s.speed && s.speed !== 1 ? ` at ${s.speed}x` : ""}: ${c?.ai?.summary ?? c?.scene ?? "?"}${c?.scene ? ` [${c.scene}]` : ""}${c?.capturedAt ? `, filmed ${c.capturedAt.slice(0, 10)}` : ""}`;
    t += len;
    return line;
  });
  const [hookDb, bodyDb, endDb] = await Promise.all([
    loudness(r.file!, 0, hookEnd),
    loudness(r.file!, hookEnd, Math.max(0.5, endStart - hookEnd)),
    loudness(r.file!, endStart, duration - endStart),
  ]);
  const sound = [
    r.plan.voiceover?.length ? "a voiceover" : null,
    r.options.musicFile ? "background music" : null,
    r.options.keepOriginalAudio !== false ? "the clips' original sound" : null,
  ].filter(Boolean).join(", ") || "no sound";
  content.push({
    type: "text",
    text:
      `A ${KIND[r.plan.format ?? "fun"] ?? ""} TikTok/Reels video of ${petName}, ${duration.toFixed(1)}s, about to go to the ` +
      `creator for approval. Today is ${new Date().toISOString().slice(0, 10)}.\n\n` +
      `PARTS: hook = 0–${hookEnd.toFixed(1)}s (where viewers decide to stay or swipe), body = ${hookEnd.toFixed(1)}–` +
      `${endStart.toFixed(1)}s, ending = ${endStart.toFixed(1)}–${duration.toFixed(1)}s (the call to action / payoff).\n\n` +
      `On-screen text (the first is the headline):\n` +
      overlays.map((o, i) => `${i + 1}. "${o.text}" ${o.start.toFixed(1)}–${Math.min(o.end, duration).toFixed(1)}s`).join("\n") +
      `\n\nShots, in order:\n${shots.join("\n")}\n\n` +
      `Sound: ${sound}. Loudness: hook ${describeLoudness(hookDb)}, body ${describeLoudness(bodyDb)}, ending ${describeLoudness(endDb)}.` +
      `\n\nReview it as the best short-form editor there is. The goal is a retention curve that stays high, not one ` +
      `that drops off a cliff in the first seconds. For each part (hook, body, ending) score 1–10:\n` +
      `- visual: is the frame strong (a clear subject, a face, something happening), sharp, well framed? The hook's ` +
      `first frame must grab instantly.\n` +
      `- text: does the text work here? Hook: short, plain, curious, for anyone (not only dog owners), readable in ` +
      `a second, never covering a face or the action. Body: each point readable at a glance and matching the ` +
      `footage under it. Ending: a clear payoff or call to action.\n` +
      `- motion: movement and cuts: no static or dead stretch, shots change before attention drops, nothing drags; ` +
      `the hook moves from the first frame.\n` +
      `- sound: is there sound, does it fit (silence in the hook loses people), no jarring jumps?\n` +
      `Then each part's overall score (the hook weighs the most), where viewers would most likely leave (dropOff: ` +
      `the second and why, the most likely first), and the verdict: "pass" only when the hook is 8+ and the body ` +
      `and ending 7+. Otherwise "fix_text" when the words alone are the problem (give the corrected texts: exactly ` +
      `${overlays.length}, same order and roles, same rules for the headline), or "remake" when the visuals, the cut, ` +
      `the motion or the sound are (say in remakeBrief exactly what the new version must do, the first 3 seconds ` +
      `first, e.g. "open on Lex's face looking up from the carrier, cut by 2s"). Issues: the specific problems, ` +
      `short, the way you'd tell the creator. Be honest and strict: a video that's only fine is not a pass.`,
  });
  const part = {
    type: "object",
    additionalProperties: false,
    required: ["visual", "text", "motion", "sound", "note"],
    properties: { visual: { type: "integer" }, text: { type: "integer" }, motion: { type: "integer" }, sound: { type: "integer" }, note: { type: "string" } },
  };
  const v = await structured<EditorVerdict>({
    system:
      "You are the best TikTok and Instagram Reels editor working today: you know what stops the scroll in the first " +
      "second, what keeps people watching to the end and what makes them share. You review videos before they're " +
      "posted and you don't let weak ones through.",
    content,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["parts", "scores", "dropOff", "verdict", "issues", "texts", "remakeBrief"],
      properties: {
        parts: { type: "object", additionalProperties: false, required: ["hook", "body", "ending"], properties: { hook: part, body: part, ending: part } },
        scores: {
          type: "object",
          additionalProperties: false,
          required: ["hook", "body", "ending"],
          properties: { hook: { type: "integer" }, body: { type: "integer" }, ending: { type: "integer" } },
        },
        dropOff: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["at", "why"], properties: { at: { type: "number" }, why: { type: "string" } } },
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
  // The rule holds whatever the verdict says: a weak hook never passes.
  if (v.verdict === "pass" && !passes(v.scores)) v.verdict = v.texts.length === overlays.length && v.parts.hook.text < 8 && v.parts.hook.visual >= 7 ? "fix_text" : "remake";
  if (v.verdict !== "pass" && passes(v.scores) && !v.issues.length) v.verdict = "pass";
  return v;
}
