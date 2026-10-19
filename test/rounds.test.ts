import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-rounds-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { runDailyBatch } = await import("../src/scheduler.ts");
const { kindsToMake, daySetDone } = await import("../src/daySet.ts");

const now = () => new Date().toISOString();
const add = (id: string, format: string, review: "pending" | "approved" | "rejected", extra: object = {}) =>
  store.addRender({ id, createdAt: now(), reviewedAt: review === "pending" ? undefined : now(), status: "done", progress: 1, review, options: {} as any, plan: { segments: [], format } as any, ...extra } as any);

test("the day runs until one of each kind is kept: each kind not kept has one waiting", async () => {
  store.updateSettings({ dailyMix: { fun: 1, educational: 1, inspirational: 1 } } as any);
  assert.deepEqual(kindsToMake(), ["tips", "fun", "inspire"]);
  add("t1", "tips", "pending");
  add("f1", "fun", "pending");
  assert.deepEqual(kindsToMake(), ["inspire"]);
  // Kept: that kind is done for the day.
  store.updateRender("t1", { review: "approved", reviewedAt: now() });
  assert.deepEqual(kindsToMake(), ["inspire"]);
  // Rejected without a reason: another of its kind, after a minute (a reason may still come).
  store.updateRender("f1", { review: "rejected", reviewedAt: now() });
  assert.deepEqual(kindsToMake(), ["inspire"]);
  assert.deepEqual(kindsToMake(Date.now() + 61_000), ["fun", "inspire"]);
  // Rejected with a reason: its remake is on the way, so nothing else of the kind.
  add("f2", "fun", "rejected", { rejectReason: "text", remadeAs: "pending" });
  assert.deepEqual(kindsToMake(Date.now() + 61_000), ["inspire"]);
  // A story made on request doesn't count as any kind.
  add("s1", "story", "approved");
  add("i1", "inspire", "approved");
  add("f3", "fun", "approved");
  assert.ok(daySetDone());
  assert.deepEqual(await runDailyBatch(), { renders: [], skipped: "today's set is done" });
});

test("recent footage first: a situation with only old clips waits behind one filmed lately", async () => {
  const { pickBySituation } = await import("../src/generate.ts");
  const scenes = store.settings().scenes;
  const clip = (id: string, scene: string, capturedAt: string) =>
    store.addClip({ id, source: "upload", filename: "x.mp4", file: "/x", kind: "video", importedAt: "", capturedAt, duration: 8, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready", scene } as any);
  const oldOne = clip("old", scenes[0], "2026-03-05T10:00:00Z");
  const newOne = clip("new", scenes[1], "2026-10-12T10:00:00Z");
  assert.deepEqual(pickBySituation([oldOne, newOne], 1).map((c) => c.id), ["new"]);
});
