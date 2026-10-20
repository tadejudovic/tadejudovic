import { test } from "node:test";
import assert from "node:assert/strict";
import { montage } from "../src/ai/director.ts";
import type { Clip } from "../src/types.ts";

const clip = (id: string, duration: number, moment?: [number, number]) =>
  ({ id, duration, moments: moment ? [{ start: moment[0], end: moment[1], score: 1 }] : [] }) as unknown as Clip;

test("an inspirational video cuts between moments instead of one uncut shot", () => {
  const out = montage([{ clipId: "main", start: 0, end: 11.5, speed: 1 }], [clip("a", 10, [6, 8]), clip("b", 8), clip("c", 12), clip("d", 9)], 12);
  assert.ok(out.length >= 4);
  assert.equal(out[0].clipId, "main");
  assert.ok(out[0].end - out[0].start <= 4.5);
  assert.ok(out[1].start <= 7 && out[1].end >= 7, "the extra clip's best moment is used");
  assert.ok(out.reduce((a, s) => a + s.end - s.start, 0) >= 12);
});

test("without enough other footage the original cut stays", () => {
  const cut = [{ clipId: "main", start: 0, end: 11.5, speed: 1 }];
  assert.deepEqual(montage(cut, [clip("a", 3)], 12), cut);
});
