import { test } from "node:test";
import assert from "node:assert/strict";
import { montage } from "../src/ai/director.ts";
import type { Clip } from "../src/types.ts";

const clip = (id: string, duration: number, moment?: [number, number]) =>
  ({ id, duration, moments: moment ? [{ start: moment[0], end: moment[1], score: 1 }] : [] }) as unknown as Clip;

test("an inspirational video cuts between moments instead of one uncut shot", () => {
  const out = montage([{ clipId: "main", start: 0, end: 11.5, speed: 1 }], [clip("a", 10, [6, 8]), clip("b", 8), clip("c", 12), clip("d", 9), clip("e", 9), clip("f", 9)], 12);
  assert.ok(out.length >= 4);
  assert.equal(out[0].clipId, "main");
  assert.ok(out[0].end - out[0].start <= 2.5);
  assert.ok(out[1].start <= 7 && out[1].end >= 7, "the extra clip's best moment is used");
  assert.ok(out.reduce((a, s) => a + s.end - s.start, 0) >= 12);
});

test("without enough other footage the original cut stays", () => {
  const cut = [{ clipId: "main", start: 0, end: 11.5, speed: 1 }];
  assert.deepEqual(montage(cut, [clip("a", 3)], 12), cut);
});

import { paceShots } from "../src/ai/director.ts";

test("no shot holds longer than about 2s, and the length stays the same", () => {
  const clips = new Map([["main", clip("main", 20)]]);
  const out = paceShots([{ clipId: "main", start: 0, end: 13, speed: 1 }], clips, [clip("a", 6, [2, 3]), clip("b", 6)]);
  const len = out.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
  assert.ok(Math.abs(len - 13) < 0.05, `length ${len}`);
  assert.ok(out.every((s) => s.end - s.start <= 2.01));
  assert.ok(out.some((s) => s.clipId === "a") && out.some((s) => s.clipId === "b"));
  const own = out.filter((s) => s.clipId === "main");
  assert.ok(own.at(-1)!.end > 13, "jumps ahead in the main clip past dead stretches");
});

test("short shots and a slowed payoff are left alone", () => {
  const cut = [{ clipId: "main", start: 0, end: 2, speed: 1 }, { clipId: "main", start: 4, end: 5.5, speed: 0.5 }];
  assert.deepEqual(paceShots(cut, new Map(), []), cut);
});
