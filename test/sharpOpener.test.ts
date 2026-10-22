import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lexstudio-sharp-"));
process.env.DATA_DIR = dir;
const { store } = await import("../src/store.ts");
const { sharpOpener, newOpening } = await import("../src/generate.ts");

const make = (name: string, vf: string) => {
  const file = path.join(dir, name);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=6", "-vf", vf, "-c:v", "libx264", "-preset", "ultrafast", file]);
  return file;
};
const clip = (id: string, file: string, scene: string) =>
  store.addClip({ id, source: "upload", filename: `${id}.mp4`, file, kind: "video", importedAt: "2026-10-01T00:00:00Z", capturedAt: "2026-10-01T10:00:00Z", duration: 6, width: 360, height: 640, hasAudio: false, uses: 0, status: "ready", scene, ai: { summary: "Lex on the plane", tags: [], moments: [{ start: 1, end: 3, score: 0.9, description: "", tags: [] }] } } as any);

test("the opening is the sharpest strong footage, and a waiting video can get it", async () => {
  clip("main", make("main.mp4", "null"), "airport terminal");
  clip("blurry", make("blurry.mp4", "gblur=sigma=8"), "inside the airplane");
  clip("sharp", make("sharp.mp4", "null"), "under the airplane seat");
  const o = await sharpOpener(store.clip("main")!, []);
  assert.equal(o?.clip.id, "sharp");

  const overlays = [{ text: "Can dogs fly to Europe in the cabin?", start: 0, end: 12 }, { text: "1. Yes, if dog plus bag is light", start: 2.5, end: 6, y: 0.4 }];
  store.addRender({ id: "v", createdAt: new Date().toISOString(), status: "done", progress: 1, review: "pending", options: {} as any, editor: { verdict: "remake" } as any,
    plan: { format: "tips", hook: overlays[0].text, overlays, segments: [{ clipId: "blurry", start: 0, end: 2.5, speed: 1 }, { clipId: "main", start: 0, end: 6, speed: 1 }] } } as any);
  const fresh = await newOpening("v", { 1: "1. Yes, if dog + bag is under 8 kg" });
  assert.ok(fresh);
  assert.equal(fresh!.plan.segments[0].clipId, "sharp");
  assert.equal(fresh!.plan.segments[1].clipId, "main");
  assert.equal(fresh!.plan.overlays![1].text, "1. Yes, if dog + bag is under 8 kg");
  assert.equal(store.render("v"), undefined);
});
