import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-vlog-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { vlogDays } = await import("../src/ai/vlog.ts");
const { awaitingReview } = await import("../src/scheduler.ts");

const clip = (id: string, capturedAt: string, extra: object = {}) =>
  store.addClip({ id, source: "upload", filename: "x.mp4", file: "/x", kind: "video", importedAt: "2020-01-01T00:00:00Z", capturedAt, duration: 8, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready", ...extra } as any);

test("days with 3+ usable vertical clips are offered, newest first, thumbnails in filming order", () => {
  clip("a3", "2026-10-01T18:00:00Z", { place: "Lisbon, Portugal" });
  clip("a1", "2026-10-01T08:00:00Z");
  clip("a2", "2026-10-01T12:00:00Z");
  clip("b1", "2026-10-05T08:00:00Z");
  clip("b2", "2026-10-05T09:00:00Z");
  clip("b3", "2026-10-05T10:00:00Z", { width: 1920, height: 1080 }); // landscape: not usable
  clip("c1", "2026-10-07T08:00:00Z");
  clip("c2", "2026-10-07T09:00:00Z");
  clip("c3", "2026-10-07T10:00:00Z");
  const days = vlogDays();
  assert.deepEqual(days.map((d) => d.day), ["2026-10-07", "2026-10-01"]);
  assert.deepEqual(days[1].thumbs, ["a1", "a2", "a3"]);
  assert.deepEqual(days[1].places, ["Lisbon, Portugal"]);
});

test("videos made on request don't hold back the daily ones", () => {
  const before = awaitingReview();
  const add = (id: string, format: string) =>
    store.addRender({ id, createdAt: new Date().toISOString(), plan: { format } as any, options: {} as any, status: "done", progress: 1, review: "pending" } as any);
  add("vlog", "story");
  assert.equal(awaitingReview(), before);
  add("fun", "fun");
  assert.equal(awaitingReview(), before + 1);
});
