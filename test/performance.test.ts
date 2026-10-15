import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-perf-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { postsDueForStats, reviewFeedback } = await import("../src/generate.ts");
const { isTikTokPostUrl } = await import("../src/ai/tiktokSearch.ts");
const { feedbackText } = await import("../src/ai/director.ts");

const DAY = 86400_000;
const video = (id: string, hook: string, posted?: object) =>
  store.addRender({ id, createdAt: new Date().toISOString(), plan: { hook, format: "fun", segments: [] } as any, options: {} as any, status: "done", progress: 1, review: "approved", posted: posted as any });

test("only TikTok post links are accepted", () => {
  assert.ok(isTikTokPostUrl("https://www.tiktok.com/@lex.poodle/video/7421"));
  assert.ok(isTikTokPostUrl("https://vm.tiktok.com/ZMabc/"));
  assert.ok(!isTikTokPostUrl("https://instagram.com/reel/abc"));
});

test("posted videos' stats refresh daily for two weeks", () => {
  const now = Date.now();
  video("new", "a", { url: "https://www.tiktok.com/x", addedAt: new Date(now).toISOString() });
  video("fresh", "b", { url: "https://www.tiktok.com/y", addedAt: new Date(now - 2 * DAY).toISOString(), fetchedAt: new Date(now - 3600_000).toISOString(), stats: { views: 10 } });
  video("stale", "c", { url: "https://www.tiktok.com/z", addedAt: new Date(now - 3 * DAY).toISOString(), fetchedAt: new Date(now - DAY).toISOString(), stats: { views: 10 } });
  video("old", "d", { url: "https://www.tiktok.com/w", addedAt: new Date(now - 20 * DAY).toISOString(), fetchedAt: new Date(now - 2 * DAY).toISOString(), stats: { views: 10 } });
  assert.deepEqual(postsDueForStats(now).map((r) => r.id).sort(), ["new", "stale"]);
});

test("the AI is told how posted videos actually did, best first", () => {
  video("hit", "the hit hook", { url: "https://www.tiktok.com/h", addedAt: new Date().toISOString(), stats: { views: 1_200_000, saves: 3000 } });
  const f = reviewFeedback();
  assert.equal(f.performance![0].text, "the hit hook");
  const text = feedbackText(f);
  assert.match(text, /HOW POSTED VIDEOS ACTUALLY DID/);
  assert.match(text, /"the hit hook" \[fun\]: 1\.2M views/);
});
