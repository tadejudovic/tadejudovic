import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-perf-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { postsDueForStats, reviewFeedback } = await import("../src/generate.ts");
const { platformOf } = await import("../src/ai/tiktokSearch.ts");
const { feedbackText } = await import("../src/ai/director.ts");

const DAY = 86400_000;
const video = (id: string, hook: string, posts?: object[]) =>
  store.addRender({ id, createdAt: new Date().toISOString(), plan: { hook, format: "fun", segments: [] } as any, options: {} as any, status: "done", progress: 1, review: "approved", posts: posts as any });

test("TikTok and Instagram post links are recognised", () => {
  assert.equal(platformOf("https://www.tiktok.com/@lex.poodle/video/7421"), "tiktok");
  assert.equal(platformOf("https://vm.tiktok.com/ZMabc/"), "tiktok");
  assert.equal(platformOf("https://www.instagram.com/reel/C9xYz/"), "instagram");
  assert.equal(platformOf("https://instagram.com/p/C9xYz"), "instagram");
  assert.equal(platformOf("https://youtube.com/shorts/abc"), undefined);
});

test("each post's stats refresh daily for two weeks", () => {
  const now = Date.now();
  video("new", "a", [{ platform: "tiktok", url: "https://www.tiktok.com/x", addedAt: new Date(now).toISOString() }]);
  video("both", "b", [
    { platform: "tiktok", url: "https://www.tiktok.com/y", addedAt: new Date(now - 2 * DAY).toISOString(), fetchedAt: new Date(now - 3600_000).toISOString(), stats: { views: 10 } },
    { platform: "instagram", url: "https://www.instagram.com/reel/y", addedAt: new Date(now - 3 * DAY).toISOString(), fetchedAt: new Date(now - DAY).toISOString(), stats: { views: 10 } },
  ]);
  video("old", "d", [{ platform: "tiktok", url: "https://www.tiktok.com/w", addedAt: new Date(now - 20 * DAY).toISOString(), fetchedAt: new Date(now - 2 * DAY).toISOString(), stats: { views: 10 } }]);
  assert.deepEqual(postsDueForStats(now).map((d) => `${d.render.id}:${d.platform}`).sort(), ["both:instagram", "new:tiktok"]);
});

test("the AI is told how posted videos actually did on each platform, best first", () => {
  video("hit", "the hit hook", [
    { platform: "tiktok", url: "https://www.tiktok.com/h", addedAt: new Date().toISOString(), stats: { views: 1_200_000, saves: 3000 } },
    { platform: "instagram", url: "https://www.instagram.com/reel/h", addedAt: new Date().toISOString(), stats: { views: 90_000, likes: 4000 } },
  ]);
  const f = reviewFeedback();
  assert.equal(f.performance![0].text, "the hit hook");
  const text = feedbackText(f);
  assert.match(text, /"the hit hook" \[fun\] on TikTok: 1\.2M views/);
  assert.match(text, /"the hit hook" \[fun\] on Instagram: 90K plays, 4K likes/);
});

test("videos posted before Instagram support keep their TikTok link", async () => {
  const fs = await import("node:fs");
  const dir = path.join(os.tmpdir(), `lexstudio-perf-old-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "db.json"), JSON.stringify({ clips: [], renders: [{ id: "o", plan: { segments: [] }, posted: { url: "https://www.tiktok.com/o", addedAt: "2026-10-15T00:00:00Z" } }], settings: {}, albums: [], examples: [], research: {}, spend: { month: "", usd: 0, calls: 0 } }));
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["--import", "tsx", "-e", `const { store } = await import("${path.resolve("src/store.ts")}"); console.log(JSON.stringify(store.render("o")))`], { env: { ...process.env, DATA_DIR: dir } }).toString();
  const r = JSON.parse(out.trim().split("\n").pop()!);
  assert.equal(r.posts[0].platform, "tiktok");
  assert.equal(r.posted, undefined);
});
