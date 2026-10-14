import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-hashtags-${process.pid}-${Date.now()}`);
const { withResearchedTags } = await import("../src/generate.ts");
import { candidates, chooseHashtags, parseVideoCount, pickThree, tagsOf } from "../src/ai/hashtags.ts";

test("tagsOf reads the structured list and #words in the description", () => {
  assert.deepEqual(tagsOf({ hashtags: [{ name: "DogsOfTikTok" }] }, "at the gate #flyingwithdog #dogsoftiktok"), ["dogsoftiktok", "flyingwithdog"]);
});

test("candidates are ranked by the views of the videos that used them", () => {
  const c = candidates([{ views: 1_000_000, tags: ["a", "b"] }, { views: 50_000, tags: ["b", "c"] }]);
  assert.deepEqual(c.map((x) => x.tag), ["b", "a", "c"]);
});

test("pickThree picks one big (1–5M), one mid (50–100K), one small (~10K) and skips huge tags", () => {
  const picked = pickThree([
    { tag: "dog", score: 9, posts: 400_000_000 },
    { tag: "dogsoftiktok", score: 8, posts: 90_000_000 },
    { tag: "travelwithdog", score: 7, posts: 2_400_000 },
    { tag: "flyingwithdog", score: 6, posts: 80_000 },
    { tag: "poodlesoftiktok", score: 5, posts: 3_100_000 },
    { tag: "dogatairport", score: 4, posts: 11_000 },
  ]);
  assert.deepEqual(picked.map((p) => [p.tag, p.tier]), [["travelwithdog", "big"], ["flyingwithdog", "mid"], ["dogatairport", "small"]]);
});

test("parseVideoCount reads TikTok's challenge stats", () => {
  assert.equal(parseVideoCount('{"challengeInfo":{"stats":{"videoCount":240512,"viewCount":0}}}'), 240512);
  assert.equal(parseVideoCount('"statsV2":{"videoCount":"3100000"}'), 3100000);
  assert.equal(parseVideoCount("<html>blocked</html>"), undefined);
});

test("chooseHashtags looks up counts and reports when none could be read", async () => {
  const counts: Record<string, number> = { a: 2_000_000, b: 75_000, c: 9_000 };
  const r = await chooseHashtags([{ tag: "a", score: 3 }, { tag: "b", score: 2 }, { tag: "c", score: 1 }], async (t) => counts[t]);
  assert.deepEqual(r.picked.map((p) => p.tag), ["a", "b", "c"]);
  const none = await chooseHashtags([{ tag: "a", score: 1 }], async () => undefined);
  assert.equal(none.found, 0);
});

test("videos get exactly three hashtags, topped up from the AI's", () => {
  assert.deepEqual(withResearchedTags(["a", "b"], ["A", "x", "y"]), ["a", "b", "x"]);
  assert.deepEqual(withResearchedTags(["a", "b", "c"], ["x"]), ["a", "b", "c"]);
});
