import { test } from "node:test";
import assert from "node:assert/strict";
import { fillByRepeating, limitSlowMotion } from "../src/ai/director.ts";

const seg = (start: number, end: number, speed = 1) => ({ clipId: "c", start, end, speed });

test("slow motion only for one short moment, never to stretch a video", () => {
  const out = limitSlowMotion([seg(0, 6, 0.5), seg(6, 7.5, 0.5), seg(7.5, 9, 0.6)]);
  assert.deepEqual(out.map((s) => s.speed), [1, 0.5, 1]);
});

test("a short clip is replayed at real speed to give time to read, not slowed down", () => {
  const out = fillByRepeating([seg(0, 5)], 12);
  assert.equal(out.length, 3);
  assert.ok(out.every((s) => s.speed === 1));
  assert.deepEqual(fillByRepeating([seg(0, 14)], 12).length, 1);
});

test("arrows only point at a visible object the text names", async () => {
  const { arrowTarget } = await import("../src/ai/director.ts");
  assert.equal(arrowTarget("1. Kato backpack", "black backpack Lex sits in"), true);
  assert.equal(arrowTarget("2. PetPace health tracker", "tracker on his collar"), true);
  assert.equal(arrowTarget("3. A ton of documents", ""), false);
  assert.equal(arrowTarget("3. A ton of documents", "the airplane seat"), false);
});
