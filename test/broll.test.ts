import { test } from "node:test";
import assert from "node:assert/strict";

const { withBroll } = await import("../src/ai/director.ts");

test("b-roll plays while its point is on screen; the main clip carries on around it, same length", () => {
  const main = [{ clipId: "main", start: 0, end: 18, speed: 1 }];
  const walk = { id: "walk", duration: 10, ai: { moments: [{ start: 4, end: 8, score: 0.9 }] } } as any;
  const short = { id: "short", duration: 2 } as any;
  const out = withBroll(main, [
    { start: 2.5, end: 7.5, clip: walk },
    { start: 7.5, end: 12, clip: undefined },
    { start: 12, end: 16, clip: short },
  ], 20);
  const len = (xs: any[]) => xs.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
  assert.ok(Math.abs(len(out) - 20) < 0.01);
  // Timeline: main 0-2.5, walk 5s (from its best moment, kept inside the clip), main on from 2.5...
  assert.deepEqual(out[0], { clipId: "main", start: 0, end: 2.5, speed: 1 });
  assert.deepEqual(out[1], { clipId: "walk", start: 4, end: 9, speed: 1 });
  assert.equal(out[2].clipId, "main");
  assert.equal(out[2].start, 2.5);
  // A clip shorter than its window plays whole, the main clip fills the rest.
  const s = out.find((x: any) => x.clipId === "short");
  assert.deepEqual([s!.start, s!.end], [0, 2]);
});
