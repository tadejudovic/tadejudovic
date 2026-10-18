import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const dir = path.join(os.tmpdir(), `lexstudio-pointed-${process.pid}-${Date.now()}`);
process.env.DATA_DIR = dir;
const { store } = await import("../src/store.ts");
const { config } = await import("../src/config.ts");
const { renderVideo } = await import("../src/media/render.ts");
const { probe } = await import("../src/media/ffmpeg.ts");

test("educational points: hook stays on top, each point placed on its own with an arrow", async () => {
  fs.mkdirSync(config.mediaDir, { recursive: true });
  const f = path.join(config.mediaDir, "p.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=9", "-f", "lavfi", "-i", "sine=frequency=300:duration=9", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f]);
  const clip = store.addClip({ id: "p", source: "upload", filename: "p.mp4", file: f, kind: "video", importedAt: "", duration: 9, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready" } as any);
  const plan = {
    template: "auto", title: "t", hook: "3 things I use to fly my dog around the world",
    segments: [{ clipId: "p", start: 0, end: 9, speed: 1 }],
    overlays: [
      { text: "which airline do you fly with Lex?? the one that passes these 3 checks", start: 0, end: 10 },
      { text: "1. Confirm pets can fly in the cabin", start: 1.5, end: 4, y: 0.3 },
      { text: "2. PetPace health tracker", start: 4, end: 6.5, y: 0.52, pointTo: { x: 0.6, y: 0.42 } },
      { text: "3. A ton of documents", start: 6.5, end: 10, y: 0.45 },
    ],
    postCaption: "", hashtags: [],
  } as any;
  const out = await renderVideo("pointed", plan, new Map([["p", clip]]), { keepOriginalAudio: true, textStyle: "yellowbox", textSize: "medium", fontId: "montserrat" } as any, () => {});
  const info = await probe(out.file);
  assert.ok(Math.abs(info.duration - 9) < 0.3);
  if (process.env.LOOK_DIR) {
    for (const t of [2.5, 5]) execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", String(t), "-i", out.file, "-frames:v", "1", "-vf", "scale=360:-1", path.join(process.env.LOOK_DIR, `pointed-${t}.png`)]);
  }
});
