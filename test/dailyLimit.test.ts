import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-limit-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { videosLeftToday, videosMadeToday } = await import("../src/dailyLimit.ts");

const add = (id: string, createdAt: Date, countUse?: boolean) =>
  store.addRender({ id, createdAt: createdAt.toISOString(), plan: {} as any, options: {} as any, status: "done", progress: 1, review: "pending", countUse });

test("only new videos made today count toward the daily limit", () => {
  store.updateSettings({ maxVideosPerDay: 3 });
  add("a", new Date());
  add("b", new Date());
  add("edit", new Date(), false); // re-render after editing the text: same video
  add("old", new Date(Date.now() - 2 * 86400_000));
  assert.equal(videosMadeToday(), 2);
  assert.equal(videosLeftToday(), 1);
  add("c", new Date());
  assert.equal(videosLeftToday(), 0);
});
