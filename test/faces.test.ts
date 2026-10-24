import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-faces-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { config } = await import("../src/config.ts");
const { renderVideo, faceFinder } = await import("../src/media/render.ts");

test("points and the hook stay off faces seen while they're on screen", async () => {
  fs.mkdirSync(config.mediaDir, { recursive: true });
  const f = path.join(config.mediaDir, "f.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x335577:size=1080x1920:rate=30:duration=8", "-f", "lavfi", "-i", "sine=duration=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f]);
  const clip = store.addClip({ id: "f", source: "upload", filename: "f.mp4", file: f, kind: "video", importedAt: "", duration: 8, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready" } as any);
  // A face right where the hook sits and where the first point was asked to go.
  const face = { x0: 0.15, y0: 0.12, x1: 0.6, y1: 0.5 };
  const seen: { start: number; end: number }[][] = [];
  faceFinder.find = async (_file, windows) => (seen.push(windows), windows.map(() => [face]));
  const plan = {
    template: "auto", title: "t", hook: "h",
    segments: [{ clipId: "f", start: 0, end: 8, speed: 1 }],
    overlays: [
      { text: "3 seats to avoid with a dog", start: 0, end: 9 },
      { text: "1. Skip bulkhead rows", start: 2, end: 5, y: 0.4, x: 0.34 },
      { text: "2. No exit rows", start: 5, end: 9, y: 0.6, x: 0.6 },
    ],
    postCaption: "", hashtags: [],
  } as any;
  const out = await renderVideo("faces", plan, new Map([["f", clip]]), { keepOriginalAudio: true, textStyle: "yellowbox", textSize: "medium", fontId: "montserrat" } as any, () => {});
  assert.ok(seen.length === 1 && seen[0].length >= 3);
  if (process.env.LOOK_DIR) {
    for (const t of [1, 3]) execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", String(t), "-i", out.file, "-frames:v", "1", "-vf", `drawbox=x=${0.15 * 1080}:y=${0.12 * 1920}:w=${0.45 * 1080}:h=${0.38 * 1920}:color=red@0.6:t=8,scale=360:-1`, path.join(process.env.LOOK_DIR, `faces-${t}.png`)]);
  }
});

test("no text lands on the dog: points move around it, smaller than the headline", async () => {
  const f = path.join(config.mediaDir, "f2.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x335577:size=1080x1920:rate=30:duration=10", "-f", "lavfi", "-i", "sine=duration=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f]);
  const clip = store.addClip({ id: "f2", source: "upload", filename: "f2.mp4", file: f, kind: "video", importedAt: "", duration: 10, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready" } as any);
  // Lex across the whole middle of the frame.
  const dog = { x0: 0, y0: 0.3, x1: 1, y1: 0.7 };
  faceFinder.find = async (_file, windows) => windows.map(() => [dog]);
  const plan = {
    template: "auto", title: "t", hook: "h", format: "tips",
    segments: [{ clipId: "f2", start: 0, end: 10, speed: 1 }],
    overlays: [
      { text: "2 mistakes that ban dogs from the cabin", start: 0, end: 11 },
      { text: "MISTAKE: Weighing your dog without the bag", start: 2.5, end: 5, y: 0.4, x: 0.3 },
      { text: "INSTEAD: Weigh dog and carrier together", start: 5, end: 7.5, y: 0.62, x: 0.63 },
      { text: "1. Confirm the pet spot first", start: 7.5, end: 11, y: 0.5, x: 0.5 },
    ],
    postCaption: "", hashtags: [],
  } as any;
  const out = await renderVideo("dog", plan, new Map([["f2", clip]]), { keepOriginalAudio: true, textStyle: "yellowbox", textSize: "medium", fontId: "montserrat" } as any, () => {});
  for (const t of [3.5, 6, 9]) {
    // The dog's band, shrunk a little at the edges: no yellow text box inside it.
    const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out.file, "-frames:v", "1", "-vf", `crop=1080:${Math.round(0.36 * 1920)}:0:${Math.round(0.32 * 1920)},scale=270:-1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    let yellow = 0;
    for (let i = 0; i < raw.length; i += 3) if (raw[i] > 200 && raw[i + 1] > 160 && raw[i + 2] < 90) yellow++;
    assert.ok(yellow / (raw.length / 3) < 0.003, `text on the dog at ${t}s (${yellow} yellow pixels)`);
  }
});

test("the headline stays at the top even when Lex fills most of the frame", async () => {
  const f = path.join(config.mediaDir, "f3.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x335577:size=1080x1920:rate=30:duration=6", "-f", "lavfi", "-i", "sine=duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f]);
  const clip = store.addClip({ id: "f3", source: "upload", filename: "f3.mp4", file: f, kind: "video", importedAt: "", duration: 6, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready" } as any);
  faceFinder.find = async (_file, windows) => windows.map(() => [{ x0: 0.05, y0: 0.18, x1: 0.95, y1: 0.95 }]);
  const plan = {
    template: "auto", title: "t", hook: "h", format: "inspire",
    segments: [{ clipId: "f3", start: 0, end: 6, speed: 1 }],
    overlays: [{ text: "Those last steps before boarding / still feel like a beginning", start: 0, end: 7 }],
    postCaption: "", hashtags: [],
  } as any;
  const out = await renderVideo("top", plan, new Map([["f3", clip]]), { keepOriginalAudio: true, textStyle: "yellowbox", textSize: "medium", fontId: "montserrat" } as any, () => {});
  const yellowIn = (y: number, h: number) => {
    const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", "2", "-i", out.file, "-frames:v", "1", "-vf", `crop=1080:${Math.round(h * 1920)}:0:${Math.round(y * 1920)},scale=270:-1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    let n = 0;
    for (let i = 0; i < raw.length; i += 3) if (raw[i] > 200 && raw[i + 1] > 160 && raw[i + 2] < 90) n++;
    return n;
  };
  assert.ok(yellowIn(0.05, 0.3) > 500, "headline in the top part");
  assert.equal(yellowIn(0.4, 0.5), 0, "nothing in the lower part");
});
