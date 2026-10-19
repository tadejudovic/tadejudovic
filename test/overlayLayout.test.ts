import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutPoints, lengthenFootage, readingSeconds, spreadPoints } from "../src/overlayLayout.ts";

test("edited list text: hook stays on top, points one after another in different spots", () => {
  const o = layoutPoints(["Do these 4 things", "#1 Check rules", "#2 Microchip", "#3 Book early", "#4 Pack"], 14);
  assert.equal(o[0].start, 0);
  assert.ok(o[0].end > 14);
  assert.equal(o[0].y, undefined);
  const ys = o.slice(1).map((p) => p.y);
  for (let i = 1; i < ys.length; i++) assert.notEqual(ys[i], ys[i - 1]);
  for (let i = 2; i < o.length; i++) assert.ok(Math.abs(o[i].start - o[i - 1].end) < 1e-9); // back to back
  assert.ok(o[o.length - 1].end > 14);
});

test("more text makes the footage longer: the clip runs on, then replays once at most", () => {
  const need = readingSeconds(4);
  const longClip = lengthenFootage([{ clipId: "a", start: 0, end: 6, speed: 1 }], need, () => 30);
  assert.equal(longClip.length, 1);
  assert.ok(Math.abs(longClip[0].end - need) < 1e-9);
  const shortClip = lengthenFootage([{ clipId: "a", start: 0, end: 6, speed: 1 }], need, () => 7);
  assert.equal(shortClip.length, 2); // runs on to the clip's end, then one replay at most
  assert.ok(shortClip.every((s) => s.speed === 1));
});

test("points the AI put in one spot are spread over the frame", () => {
  const o = spreadPoints([
    { text: "hook", start: 0, end: 13 },
    { text: "1", start: 2, end: 5, y: 0.6 },
    { text: "2", start: 5, end: 8, y: 0.6 },
    { text: "3", start: 8, end: 13, y: 0.6 },
  ]);
  assert.equal(new Set(o.slice(1).map((p) => p.y)).size, 3);
});

test("points zig-zag across the frame, not just up and down", () => {
  const o = layoutPoints(["Hook", "1. A", "2. B", "3. C"], 12);
  const xs = o.slice(1).map((p) => p.x!);
  assert.ok(xs.every((x) => x > 0.3 && x < 0.65));
  for (let i = 1; i < xs.length; i++) assert.notEqual(xs[i], xs[i - 1]);
  const s = spreadPoints([{ text: "h", start: 0, end: 9 }, { text: "1", start: 1, end: 3, y: 0.5 }, { text: "2", start: 3, end: 9, y: 0.6 }]);
  assert.ok(s.slice(1).every((p) => p.x !== undefined));
});
