import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-rounds-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { awaitingReview, runDailyBatch } = await import("../src/scheduler.ts");

test("no new videos while 3 are waiting for review; below that, the next ones are made", async () => {
  const add = (id: string, status: "done" | "rendering", review: "pending" | "approved" | "rejected") =>
    store.addRender({ id, createdAt: new Date().toISOString(), status, progress: 1, review, options: {} as any, plan: { segments: [] } as any });
  add("a", "done", "approved");
  add("b", "done", "pending");
  add("c", "rendering", "pending");
  add("d", "done", "pending");
  assert.equal(awaitingReview(), 3);
  await assert.rejects(runDailyBatch({ force: true }), /Review the 3 videos/);
  assert.deepEqual(await runDailyBatch(), { renders: [], skipped: "waiting for review" });
  // One reviewed: only 2 waiting, so the next video is made (here: no footage yet).
  store.updateRender("d", { review: "approved" });
  await assert.rejects(runDailyBatch({ force: true }), /No analyzed vertical videos|None of your clips/);
  store.updateRender("b", { review: "rejected" });
  store.updateRender("c", { status: "done", review: "approved" });
  assert.equal(awaitingReview(), 0);
});
