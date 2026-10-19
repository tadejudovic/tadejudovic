import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const dir = path.join(os.tmpdir(), `lexstudio-mix-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
// An existing install from before the daily mix: rounds of 5, limit 5.
fs.writeFileSync(
  path.join(dir, "db.json"),
  JSON.stringify({ clips: [], renders: [], settings: { petName: "Lex", maxVideosPerDay: 5 }, albums: [], examples: [], auto: { enabled: true, dailyCount: 5, dailyTime: "08:00", template: "auto", targetSeconds: 12, syncEveryHours: 3 }, research: {}, spend: { month: "", usd: 0, calls: 0 } }),
);
process.env.DATA_DIR = dir;
const { store } = await import("../src/store.ts");
const { mixSequence } = await import("../src/generate.ts");

test("existing installs switch to the daily mix: 2 fun, 2 educational, 2 inspirational per round", () => {
  assert.deepEqual(store.settings().dailyMix, { fun: 2, educational: 2, inspirational: 2 });
  assert.equal(store.auto().dailyCount, 6);
  assert.equal(store.settings().maxVideosPerDay, 6); // raised so a whole round fits
});

test("a round alternates kinds so every kind gets a candidate first", () => {
  assert.deepEqual(mixSequence({ fun: 2, educational: 2, inspirational: 2 }, 6), ["fun", "tips", "inspire", "fun", "tips", "inspire"]);
  assert.deepEqual(mixSequence({ fun: 2, educational: 2, inspirational: 2 }, 3), ["fun", "tips", "inspire"]);
  assert.deepEqual(mixSequence({ fun: 3, educational: 1, inspirational: 0 }, 4), ["fun", "tips", "fun", "fun"]);
  assert.deepEqual(mixSequence({ fun: 0, educational: 0, inspirational: 0 }, 2), ["fun", "fun"]);
});

test("small rounds don't all start with fun: the kind furthest behind today goes first", () => {
  const mix = { fun: 2, educational: 2, inspirational: 2 };
  assert.deepEqual(mixSequence(mix, 1, { fun: 1 }), ["tips"]);
  assert.deepEqual(mixSequence(mix, 1, { fun: 1, tips: 1 }), ["inspire"]);
  assert.deepEqual(mixSequence(mix, 2, { fun: 2, tips: 1 }), ["inspire", "tips"]);
  // One-video rounds all day: fun, educational, inspirational in turn.
  const made: Record<string, number> = {};
  const seq = [];
  for (let i = 0; i < 6; i++) {
    const [k] = mixSequence(mix, 1, made);
    seq.push(k);
    made[k] = (made[k] ?? 0) + 1;
  }
  assert.deepEqual(seq, ["fun", "tips", "inspire", "fun", "tips", "inspire"]);
});

test("with fewer clips than kinds, the kind made longest ago goes first (inspirational isn't always the one left out)", () => {
  const mix = { fun: 1, educational: 1, inspirational: 1 };
  const now = Date.now();
  assert.deepEqual(mixSequence(mix, 2, {}, { fun: now, tips: now - 1000 }), ["inspire", "tips"]);
});
