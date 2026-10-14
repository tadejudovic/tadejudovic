import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-rounds-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { awaitingReview, runDailyBatch } = await import("../src/scheduler.ts");

test("no new round until every video of the last one is reviewed", async () => {
  const add = (id: string, status: "done" | "rendering", review: "pending" | "approved" | "rejected") =>
    store.addRender({ id, createdAt: new Date().toISOString(), status, progress: 1, review, options: {} as any, plan: { segments: [] } as any });
  add("a", "done", "approved");
  add("b", "done", "pending");
  add("c", "rendering", "pending");
  assert.equal(awaitingReview(), 2);
  await assert.rejects(runDailyBatch({ force: true }), /Review the 2 videos/);
  assert.deepEqual(await runDailyBatch(), { renders: [], skipped: "waiting for review" });
  store.updateRender("b", { review: "rejected" });
  store.updateRender("c", { status: "done", review: "approved" });
  assert.equal(awaitingReview(), 0);
});
