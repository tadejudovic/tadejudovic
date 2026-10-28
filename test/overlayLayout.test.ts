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

test("more text makes the footage longer: the clip runs on, never replays", () => {
  const need = readingSeconds(4);
  const longClip = lengthenFootage([{ clipId: "a", start: 0, end: 6, speed: 1 }], need, () => 30);
  assert.equal(longClip.length, 1);
  assert.ok(Math.abs(longClip[0].end - need) < 1e-9);
  const shortClip = lengthenFootage([{ clipId: "a", start: 0, end: 6, speed: 1 }], need, () => 7);
  assert.equal(shortClip.length, 1); // runs on to the clip's end, no replay
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
  assert.ok(xs.every((x) => x >= 0.29 && x <= 0.66));
  for (let i = 1; i < xs.length; i++) assert.notEqual(xs[i], xs[i - 1]);
  const s = spreadPoints([{ text: "h", start: 0, end: 9 }, { text: "1", start: 1, end: 3, y: 0.5 }, { text: "2", start: 3, end: 9, y: 0.6 }]);
  assert.ok(s.slice(1).every((p) => p.x !== undefined));
});

test("every point stays on screen long enough to read; a too-short video asks for more footage", async () => {
  const { timePoints, readSeconds } = await import("../src/overlayLayout.ts");
  const o = [
    { text: "What we check before every new country", start: 0, end: 9 },
    { text: "1. Read the destination's official pet entry rules", start: 1, end: 3, y: 0.5 },
    { text: "2. Plan ahead: some vaccines take weeks", start: 3, end: 5, y: 0.6 },
    { text: "3. Check every layover country too", start: 5, end: 9, y: 0.4 },
  ];
  const short = timePoints(o, 8);
  assert.ok(short.need > 8); // asks for longer footage
  const ok = timePoints(o, short.need + 2);
  for (const p of ok.overlays.slice(1)) assert.ok(Math.min(p.end, short.need + 2) - p.start >= readSeconds(p.text) - 1e-9);
  for (let i = 2; i < ok.overlays.length; i++) assert.ok(Math.abs(ok.overlays[i].start - ok.overlays[i - 1].end) < 1e-9);
});

test("lengthening never replays footage: shots run on into the rest of their clips", async () => {
  const { lengthenFootage } = await import("../src/overlayLayout.ts");
  const segs = lengthenFootage([{ clipId: "a", start: 0, end: 4, speed: 1 }, { clipId: "b", start: 2, end: 5, speed: 1 }], 12, (id) => (id === "a" ? 9 : 7));
  assert.deepEqual(segs.map((s) => [s.clipId, s.start, s.end]), [["a", 0, 7], ["b", 2, 7]]);
  // A clip that's too short stays short rather than looping.
  const short = lengthenFootage([{ clipId: "a", start: 0, end: 9.38, speed: 1 }], 25, () => 9.38);
  assert.equal(short.length, 1);
});

test("points without an arrow each take a clearly different spot", () => {
  const o = spreadPoints([
    { text: "h", start: 0, end: 20 },
    { text: "1", start: 2, end: 6, y: 0.3, x: 0.34 },
    { text: "2", start: 6, end: 10, y: 0.74, x: 0.6 },
    { text: "3", start: 10, end: 20, y: 0.3, x: 0.46 },
  ]);
  const spots = o.slice(1).map((p) => `${p.x},${p.y}`);
  assert.equal(new Set(spots).size, 3);
  assert.ok(o.slice(1).every((p) => p.y! >= 0.38));
});

test("a re-made video is brought up to today's rules, keeping its words", async () => {
  const { healPlan } = await import("../src/overlayLayout.ts");
  const seg = { clipId: "a", start: 0, end: 9.38, speed: 1 };
  const plan = {
    format: "tips",
    segments: [seg, seg, seg, seg],
    overlays: [
      { text: "If you're flying with your dog do these 3 things with the airline:", start: 0, end: 37.5 },
      { text: "1. Call airline to check open pet slots", start: 2.5, end: 7, y: 0.3, x: 0.34 },
      { text: "2. Book & call back to add your pet", start: 7, end: 11.5, y: 0.74, x: 0.6 },
      { text: "3. Buy the right carrier size", start: 11.5, end: 18.8, y: 0.3, x: 0.46 },
      { text: "Plan your pet's trip / at www.flywith.pet", start: 18.8, end: 37.5, y: 0.6 },
    ],
  };
  const h = healPlan(plan, "flywith.pet");
  assert.ok(h.segments.length <= 2);
  const total = h.segments.reduce((a, s) => a + (s.end - s.start), 0);
  const o = h.overlays!;
  assert.deepEqual(o.map((x) => x.text), plan.overlays.map((x) => x.text)); // the words stay
  assert.ok(Math.abs(o[4].start - (total - 3)) < 1e-6); // call to action: the last 3s
  assert.equal(new Set(o.slice(1, 4).map((p) => `${p.x},${p.y}`)).size, 3); // three different spots
});

test("stretched footage is spread over the shots instead of one shot running on", () => {
  const segs = lengthenFootage(
    [{ clipId: "a", start: 0, end: 2, speed: 1 }, { clipId: "b", start: 0, end: 2, speed: 1 }, { clipId: "c", start: 0, end: 2, speed: 1 }],
    9,
    () => 20,
  );
  const lens = segs.map((s) => s.end - s.start);
  assert.ok(Math.abs(lens.reduce((x, y) => x + y, 0) - 9) < 1e-9);
  assert.ok(lens.every((l) => l <= 3.5 + 1e-9), `no shot past 3.5 s: ${lens}`);
});
