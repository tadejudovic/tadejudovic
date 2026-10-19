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
