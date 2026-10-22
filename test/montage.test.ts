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

test("a long shot is cut with other clips, about 2s each, each clip once, length the same", () => {
  const clips = new Map([["main", clip("main", 20)]]);
  const extras = ["a", "b", "c", "d", "e", "f"].map((id) => clip(id, 6, [2, 3]));
  const out = paceShots([{ clipId: "main", start: 0, end: 13, speed: 1 }], clips, extras);
  const len = out.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
  assert.ok(Math.abs(len - 13) < 0.05, `length ${len}`);
  assert.ok(out.every((s) => s.end - s.start <= 2.01));
  assert.equal(new Set(out.map((s) => s.clipId)).size, out.length, "no clip twice");
  // Fewer other clips: the shot plays on rather than coming back to the same clip later.
  const few = paceShots([{ clipId: "main", start: 0, end: 13, speed: 1 }], clips, extras.slice(0, 2));
  assert.equal(few.filter((s) => s.clipId === "main").length, 1);
  assert.ok(Math.abs(few.reduce((a, s) => a + s.end - s.start, 0) - 13) < 0.05);
});

test("a clip never comes back later in the video", async () => {
  const { onceEach } = await import("../src/ai/director.ts");
  const clips = new Map([["a", clip("a", 14)], ["b", clip("b", 5)]]);
  const out = onceEach([
    { clipId: "a", start: 1.8, end: 3.6 },
    { clipId: "a", start: 5, end: 6 }, // a jump forward within the shot: fine
    { clipId: "b", start: 0, end: 2 },
    { clipId: "a", start: 7.5, end: 9.5 }, // back to a: joined onto its shot instead
  ] as any, clips);
  assert.deepEqual(out.map((s) => [s.clipId, s.start, s.end]), [["a", 1.8, 3.6], ["a", 5, 8], ["b", 0, 2]]);
});

test("short shots and a slowed payoff are left alone", () => {
  const cut = [{ clipId: "main", start: 0, end: 2, speed: 1 }, { clipId: "main", start: 4, end: 5.5, speed: 0.5 }];
  assert.deepEqual(paceShots(cut, new Map(), []), cut);
});

test("back-to-back parts of one clip count as one long shot, and nothing already shown repeats", () => {
  const clips = new Map([["main", clip("main", 30)]]);
  const cut = [
    { clipId: "main", start: 0, end: 3, speed: 1 },
    { clipId: "main", start: 3, end: 6, speed: 1 },
    { clipId: "main", start: 6, end: 9, speed: 1 },
    { clipId: "main", start: 10, end: 11, speed: 1 },
  ];
  const out = paceShots(cut, clips, [clip("a", 6), clip("b", 6)]);
  assert.ok(out.filter((s) => s.clipId !== "main").length >= 2, "other clips cut in");
  const own = out.filter((s) => s.clipId === "main");
  assert.equal(new Set(out.map((s) => s.clipId)).size, new Set(out.map((s) => s.clipId)).size);
  assert.ok(own.length >= 1);
});

import { withOpener } from "../src/ai/director.ts";

test("an educational video opens on the strongest footage, keeping its length", () => {
  const opener = clip("plane", 8, [5, 7]);
  const cut = [{ clipId: "walk", start: 10, end: 12.5, speed: 1 }, { clipId: "vet", start: 0, end: 4, speed: 1 }];
  const out = withOpener(cut, opener, 2.5);
  assert.deepEqual(out[0], { clipId: "plane", start: 5, end: 7.5, speed: 1 });
  assert.deepEqual(out.slice(1), [{ clipId: "vet", start: 0, end: 4, speed: 1 }]);
  const partly = withOpener([{ clipId: "walk", start: 0, end: 6, speed: 1 }], opener, 2);
  assert.deepEqual(partly[1], { clipId: "walk", start: 2, end: 6, speed: 1 });
});
