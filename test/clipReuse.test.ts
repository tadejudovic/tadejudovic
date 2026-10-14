import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-reuse-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { syncClipUses } = await import("../src/generate.ts");
const { videosMadeToday } = await import("../src/dailyLimit.ts");

const clip = (id: string, uses: number) =>
  store.addClip({ id, source: "upload", filename: "x.mp4", file: "/x", kind: "video", importedAt: "2020-01-01T00:00:00Z", duration: 8, width: 1080, height: 1920, hasAudio: true, uses, status: "ready" } as any);
const video = (id: string, clipId: string) =>
  store.addRender({ id, createdAt: new Date().toISOString(), plan: { segments: [{ clipId, start: 0, end: 3 }] } as any, options: {} as any, status: "done", progress: 1, review: "pending", usesCounted: true });
const uses = (id: string) => store.clip(id)!.uses;

test("a rejected video hands its clip back; posting or undoing keeps it used", () => {
  clip("c1", 1);
  video("v1", "c1");
  store.updateRender("v1", { review: "rejected", rejectReason: "text" });
  syncClipUses("v1");
  assert.equal(uses("c1"), 0);
  syncClipUses("v1"); // idempotent
  assert.equal(uses("c1"), 0);
  store.updateRender("v1", { review: "approved", rejectReason: undefined });
  syncClipUses("v1");
  assert.equal(uses("c1"), 1);
});

test("rejecting for a bad clip doesn't hand it back", () => {
  clip("c2", 1);
  video("v2", "c2");
  store.updateRender("v2", { review: "rejected", rejectReason: "clip" });
  syncClipUses("v2");
  assert.equal(uses("c2"), 1);
});

test("finished videos still count toward today's limit", () => {
  const before = videosMadeToday();
  store.addRender({ id: "v3", createdAt: new Date().toISOString(), plan: {} as any, options: {} as any, status: "done", progress: 1, review: "pending", usesCounted: true });
  assert.equal(videosMadeToday(), before + 1);
});
