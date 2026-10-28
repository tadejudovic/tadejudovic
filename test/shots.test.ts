import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-shots-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { editShots } = await import("../src/generate.ts");

const clip = (id: string, scene: string, summary = "Lex in the backpack") =>
  store.addClip({ id, source: "upload", filename: "x.mp4", file: "/x", kind: "video", importedAt: "2026-10-01T00:00:00Z", capturedAt: "2026-10-01T10:00:00Z", duration: 8, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready", scene, ai: { summary, tags: [], moments: [{ start: 3, end: 5, score: 0.9, description: "", tags: [] }] } } as any);
const len = (segs: any[]) => segs.reduce((a, x) => a + (x.end - x.start) / (x.speed ?? 1), 0);
const video = (id: string) => {
  const overlays = [{ text: "Can dogs fly in the cabin?", start: 0, end: 6 }];
  store.addRender({ id, createdAt: new Date().toISOString(), status: "done", progress: 1, review: "approved", reviewedAt: "2026-10-26T00:00:00Z", options: {} as any,
    plan: { format: "tips", overlays, hook: overlays[0].text, segments: [{ clipId: "a", start: 0, end: 2, speed: 1 }, { clipId: "b", start: 2, end: 4, speed: 1 }, { clipId: "c", start: 1, end: 3, speed: 1 }] } } as any);
};

test("shots from the timeline: swap, cut and never use keep the video's length and text", () => {
  clip("a", "airport terminal");
  clip("b", "inside airplane");
  clip("c", "hotel room");
  clip("plane2", "inside airplane");
  clip("other", "beach");
  video("v1");
  const fresh = editShots("v1", ["keep", "swap", "remove"]);
  assert.notEqual(fresh.id, "v1");
  assert.equal(store.render("v1"), undefined);
  const segs = fresh.plan.segments;
  assert.equal(segs[0].clipId, "a");
  assert.equal(segs[1].clipId, "plane2", "the swap is footage of the same kind");
  assert.ok(!segs.some((x: any) => x.clipId === "c" || x.clipId === "b"));
  assert.ok(Math.abs(len(segs) - 6) < 0.05, `still 6 s, got ${len(segs)}`);
  assert.deepEqual(fresh.plan.overlays, [{ text: "Can dogs fly in the cabin?", start: 0, end: 6 }]);
  assert.equal(fresh.review, "approved");

  video("v2");
  const again = editShots("v2", ["never"]);
  assert.equal(store.clip("a")!.disliked, true);
  assert.notEqual(again.plan.segments[0].clipId, "a");
  assert.throws(() => editShots(again.id, ["keep"]), /isn't ready/);
  video("v3");
  assert.throws(() => editShots("v3", ["remove", "remove", "remove"]), /at least one/);
});

test("shots can be moved and trimmed, and the video keeps its length", () => {
  clip("m1", "airport terminal");
  clip("m2", "inside airplane");
  clip("m3", "hotel room");
  const overlays = [{ text: "x", start: 0, end: 6 }];
  store.addRender({ id: "v4", createdAt: new Date().toISOString(), status: "done", progress: 1, review: "pending", options: {} as any,
    plan: { format: "fun", overlays, hook: "x", segments: [{ clipId: "m1", start: 0, end: 2, speed: 1 }, { clipId: "m2", start: 2, end: 4, speed: 1 }, { clipId: "m3", start: 1, end: 3, speed: 1 }] } } as any);
  const fresh = editShots("v4", [], { order: [2, 0, 1], trims: [{ index: 0, start: 0.5, end: 2 }] });
  const segs = fresh.plan.segments;
  assert.deepEqual(segs.map((x: any) => x.clipId), ["m3", "m1", "m2"]);
  assert.equal(segs[1].start, 0.5, "the first shot was pulled in at its start");
  assert.ok(Math.abs(len(segs) - 6) < 0.05, `still 6 s, got ${len(segs)}`);
  // An order that isn't every shot once is ignored.
  store.addRender({ id: "v5", createdAt: new Date().toISOString(), status: "done", progress: 1, review: "pending", options: {} as any,
    plan: { format: "fun", overlays, hook: "x", segments: [{ clipId: "m1", start: 0, end: 2, speed: 1 }, { clipId: "m2", start: 2, end: 4, speed: 1 }] } } as any);
  assert.deepEqual(editShots("v5", [], { order: [0, 0] }).plan.segments.map((x: any) => x.clipId), ["m1", "m2"]);
});

test("a shot whose footage left the library can be regenerated or deleted, not kept", () => {
  clip("g1", "beach");
  clip("g2", "beach");
  clip("g3", "beach");
  clip("g4", "beach");
  store.updateClip("g2", { status: "archived" } as any);
  const overlays = [{ text: "x", start: 0, end: 4 }];
  const make = (id: string) => store.addRender({ id, createdAt: new Date().toISOString(), status: "done", progress: 1, review: "pending", options: {} as any,
    plan: { format: "fun", overlays, hook: "x", segments: [{ clipId: "g1", start: 0, end: 2, speed: 1 }, { clipId: "g2", start: 0, end: 2, speed: 1 }] } } as any);
  make("w1");
  assert.throws(() => editShots("w1", ["swap", "keep"]), /Shot 2's footage is no longer in your library/);
  const fresh = editShots("w1", ["keep", "swap"]);
  assert.ok(!fresh.plan.segments.some((x: any) => x.clipId === "g2"), "the gone footage is replaced");
  make("w2");
  assert.ok(editShots("w2", ["keep", "remove"]).plan.segments.every((x: any) => x.clipId !== "g2"));
});
