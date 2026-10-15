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
