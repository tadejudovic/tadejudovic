import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-tiktok-${process.pid}-${Date.now()}`);
process.env.APIFY_TOKEN = "test-token";
const { normalizeItem, searchQueries, searchTikTok } = await import("../src/ai/tiktokSearch.ts");

test("normalizeItem maps the TikTok scraper's output", () => {
  const v = normalizeItem({
    webVideoUrl: "https://www.tiktok.com/@a/video/1",
    text: "POV: my dog at security #dogsoftiktok",
    playCount: 2_100_000,
    diggCount: 300_000,
    authorMeta: { name: "a" },
    videoMeta: { coverUrl: "https://p16.tiktokcdn.com/cover.jpeg" },
    createTimeISO: "2026-05-01T10:00:00.000Z",
  });
  assert.equal(v?.views, 2_100_000);
  assert.equal(v?.author, "a");
  assert.equal(v?.cover, "https://p16.tiktokcdn.com/cover.jpeg");
  assert.equal(normalizeItem({ webVideoUrl: "https://x", playCount: 0 }), null);
  assert.equal(normalizeItem({ text: "no url", playCount: 5 }), null);
});

test("searchQueries mirror how the creator searches", () => {
  assert.deepEqual(searchQueries("Security check"), ["dog security check", "pov dog security check", "flying with dog security check"]);
});

test("searchTikTok calls Apify, dedupes and sorts by views", async () => {
  const real = globalThis.fetch;
  let called: { url: string; body: any } | null = null;
  globalThis.fetch = (async (url: string, init: any) => {
    called = { url, body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify([
        { webVideoUrl: "https://t/1", playCount: 10 },
        { webVideoUrl: "https://t/2", playCount: 500 },
        { webVideoUrl: "https://t/1", playCount: 10 },
      ]),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const out = await searchTikTok(["dog boarding gate"]);
    assert.deepEqual(out.map((v) => v.url), ["https://t/2", "https://t/1"]);
    assert.match(called!.url, /clockworks~tiktok-scraper\/run-sync-get-dataset-items\?token=test-token/);
    assert.deepEqual(called!.body.searchQueries, ["dog boarding gate"]);
  } finally {
    globalThis.fetch = real;
  }
});

test("hashtag post counts are read from the different shapes Apify actors return", async () => {
  const { parseHashtagItem } = await import("../src/ai/tiktokSearch.ts");
  assert.deepEqual(parseHashtagItem({ name: "dogsoftiktok", videoCount: 51200000, viewCount: 9e11 }), ["dogsoftiktok", 51200000]);
  assert.deepEqual(parseHashtagItem({ hashtag: "#FlyingWithDog", stats: { videoCount: "214000" } }), ["flyingwithdog", 214000]);
  assert.deepEqual(parseHashtagItem({ challengeName: "petcabin", statsV2: { videoCount: "9800" } }), ["petcabin", 9800]);
  assert.equal(parseHashtagItem({ name: "x" }), null);
});
