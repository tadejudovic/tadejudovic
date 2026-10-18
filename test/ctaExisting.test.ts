import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-cta-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { addCtaToExisting } = await import("../src/generate.ts");

test("existing educational videos get the call to action; their text and description stay", () => {
  store.addClip({ id: "c", source: "upload", filename: "c.mp4", file: "/missing.mp4", kind: "video", importedAt: "", duration: 30, width: 1080, height: 1920, hasAudio: true, uses: 1, status: "ready" } as any);
  const plan = {
    format: "tips", hook: "Hook", postCaption: "My own description", hashtags: [],
    segments: [{ clipId: "c", start: 0, end: 12, speed: 1 }],
    overlays: [{ text: "Hook", start: 0, end: 13 }, { text: "1. Point", start: 2, end: 6, y: 0.6 }, { text: "2. Point", start: 6, end: 13, y: 0.4 }],
  };
  store.addRender({ id: "edu", createdAt: new Date().toISOString(), status: "done", progress: 1, review: "pending", options: {} as any, plan } as any);
  store.addRender({ id: "fun", createdAt: new Date().toISOString(), status: "done", progress: 1, review: "pending", options: {} as any, plan: { ...plan, format: "fun" } } as any);
  assert.equal(addCtaToExisting(), 1);
  const fresh = store.renders().find((r) => r.plan.format === "tips")!;
  assert.notEqual(fresh.id, "edu");
  assert.equal(fresh.plan.postCaption, "My own description");
  const o = fresh.plan.overlays!;
  assert.match(o[o.length - 1].text, /flywith\.pet/);
  assert.equal(o[o.length - 1].start, 12);
  assert.ok(o[0].end > 15); // the hook stays to the new end
  assert.equal(o[2].end, 12); // the last point ends where the call to action starts
  assert.equal(fresh.plan.segments[0].end, 15);
  assert.equal(addCtaToExisting(), 0); // only once
});
