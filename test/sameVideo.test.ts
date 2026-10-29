import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-samevideo-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { config } = await import("../src/config.ts");
const { analyzeClip } = await import("../src/library.ts");

test("the same video brought in twice is kept once", async () => {
  fs.mkdirSync(config.mediaDir, { recursive: true });
  const src = path.join(config.tmpDir, "src.mp4");
  fs.mkdirSync(config.tmpDir, { recursive: true });
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", src]);
  const add = (id: string, source: string) => {
    const file = path.join(config.mediaDir, `${id}.mp4`);
    fs.copyFileSync(src, file);
    return store.addClip({ id, source, filename: `${id}.mp4`, file, kind: "video", importedAt: new Date().toISOString(), duration: 0, width: 0, height: 0, hasAudio: false, uses: 0, status: "importing" } as any);
  };
  add("first", "upload");
  await analyzeClip("first");
  assert.equal(store.clip("first")!.status, "ready");
  add("again", "google_photos");
  await analyzeClip("again");
  const again = store.clip("again")!;
  assert.equal(again.status, "archived");
  assert.equal(again.duplicateOf, "first");
  assert.ok(!fs.existsSync(again.file), "its file is removed");
});
