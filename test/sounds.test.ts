import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-sounds-${process.pid}-${Date.now()}`);
const { addSample, trendingSounds, soundOf } = await import("../src/sounds.ts");

const post = (n: number, sound: string, daysAgo: number, now: Date) => ({
  webVideoUrl: `https://www.tiktok.com/@a/video/${sound}${n}`,
  createTimeISO: new Date(now.getTime() - daysAgo * 86400_000).toISOString(),
  playCount: 1000 * n,
  musicMeta: { musicId: sound === "rising" ? "111" : "222", musicName: sound === "rising" ? "Rising Song" : "Big Old Song", musicAuthor: "Artist", musicOriginal: false },
});

test("a sound being picked up fast ranks as trending; a big but steady one doesn't", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  const items = [
    // Rising: 1 post a week ago, 8 in the last 3 days.
    post(1, "rising", 9, now),
    ...Array.from({ length: 8 }, (_, i) => post(i + 2, "rising", i % 3, now)),
    // Steady: ~1 a day for two weeks.
    ...Array.from({ length: 14 }, (_, i) => post(i + 1, "steady", i, now)),
  ];
  addSample(items, now);
  const top = trendingSounds(10, now);
  assert.equal(top[0]?.name, "Rising Song");
  assert.ok(!top.some((s) => s.name === "Big Old Song"));
  assert.match(top[0].url, /tiktok\.com\/music\/Rising-Song-111$/);
  // The same posts read again aren't counted twice.
  addSample(items, now);
  assert.equal(trendingSounds(10, now)[0].recent, top[0].recent);
});

test("a post's sound is read from either field layout", () => {
  assert.deepEqual(soundOf({ music: { id: "9", title: "original sound - lex", authorName: "lex" } }), { id: "9", name: "original sound - lex", author: "lex", original: true });
  assert.equal(soundOf({}), null);
});
