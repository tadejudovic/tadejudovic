import { config } from "../config.ts";
import { frameBuffer } from "../media/ffmpeg.ts";
import { structured } from "./director.ts";
import { aiAvailable } from "./budget.ts";

/** A box in the frame, as fractions (0..1 from the left / top). */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Where faces are (the dog's head, people's faces) while each piece of text is on screen, read from
 * frames of the cut video itself, so text is placed beside them, not on them. One quick look with
 * the small model for the whole video. `windows` are the text's on-screen times; returns the boxes
 * seen at any moment of each window (empty when unknown).
 */
export async function facesDuring(file: string, windows: { start: number; end: number }[], duration: number): Promise<Box[][]> {
  const none = windows.map(() => [] as Box[]);
  if (!config.claude.enabled || !aiAvailable() || !windows.length) return none;
  // Up to 3 moments per window (start, middle, end), at most 20 frames in all.
  const per = Math.max(1, Math.min(3, Math.floor(20 / windows.length)));
  const frames: { w: number; t: number }[] = [];
  windows.forEach((win, w) => {
    const a = Math.max(0, win.start + 0.2);
    const b = Math.min(duration - 0.05, Math.max(a, win.end - 0.2));
    const ts = per === 1 ? [(a + b) / 2] : per === 2 ? [a, b] : [a, (a + b) / 2, b];
    for (const t of ts) frames.push({ w, t });
  });
  const content: Parameters<typeof structured>[0]["content"] = [];
  const shown: typeof frames = [];
  for (const f of frames) {
    const jpg = await frameBuffer(file, f.t, 320).catch(() => null);
    if (!jpg) continue;
    shown.push(f);
    content.push({ type: "text", text: `Frame ${shown.length}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
  }
  if (!shown.length) return none;
  content.push({
    type: "text",
    text:
      "For each frame of this vertical video, give a box around the whole dog (head, body and tail, including the " +
      "bag or carrier it's in when it peeks out of one) and around each person's face, as fractions of the frame " +
      "(x 0 = left … 1 = right, y 0 = top … 1 = bottom), a little generous: text must never cover them. No box when " +
      "neither is in the frame.",
  });
  try {
    const r = await structured<{ frames: { n: number; boxes: Box[] }[] }>({
      system: "You locate faces in video frames precisely.",
      content,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["frames"],
        properties: {
          frames: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["n", "boxes"],
              properties: {
                n: { type: "integer" },
                boxes: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["x0", "y0", "x1", "y1"],
                    properties: { x0: { type: "number" }, y0: { type: "number" }, x1: { type: "number" }, y1: { type: "number" } },
                  },
                },
              },
            },
          },
        },
      },
      effort: "low",
      model: config.claude.fastModel,
    });
    const out = windows.map(() => [] as Box[]);
    for (const f of r.frames) {
      const at = shown[f.n - 1];
      if (!at) continue;
      for (const b of f.boxes) {
        const box = { x0: clamp(Math.min(b.x0, b.x1)), y0: clamp(Math.min(b.y0, b.y1)), x1: clamp(Math.max(b.x0, b.x1)), y1: clamp(Math.max(b.y0, b.y1)) };
        // Ignore nonsense: empty boxes, or "faces" covering most of the frame.
        if (box.x1 - box.x0 > 0.02 && box.y1 - box.y0 > 0.02 && (box.x1 - box.x0) * (box.y1 - box.y0) < 0.5) out[at.w].push(box);
      }
    }
    return out;
  } catch (err) {
    console.warn("[faces]", (err as Error).message);
    return none;
  }
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
