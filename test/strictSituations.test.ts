import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-strict-${process.pid}-${Date.now()}`);
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key"; // situations come from the AI
const { store } = await import("../src/store.ts");
const { onTopic } = await import("../src/generate.ts");
const { importBudget } = await import("../src/albums.ts");

const base = { source: "shared_album", filename: "x.mp4", file: "/x", kind: "video", importedAt: "2020-01-01T00:00:00Z", duration: 8, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready" } as any;

test("only clips from the creator's situations are used automatically", () => {
  store.updateAuto({ dailyCount: 4 });
  const airport = store.addClip({ ...base, id: "air", scene: "airport terminal" });
  const beach = store.addClip({ ...base, id: "beach", scene: "other" });
  assert.equal(onTopic(airport), true);
  assert.equal(onTopic(beach), false);
  store.updateSettings({ onlySituations: false });
  assert.equal(onTopic(beach), true);
  store.updateSettings({ onlySituations: true });
});

test("off-topic clips don't stop the importer from looking for on-topic ones", () => {
  for (let i = 0; i < 10; i++) store.addClip({ ...base, id: `b${i}`, scene: "other" });
  // 1 usable airport clip; 5 rounds of 4 + 2 spare => 21 more to find, despite 11 beach clips.
  assert.equal(importBudget(), 21);
});

test("imports are capped per day", () => {
  const today = new Date().toISOString();
  for (let i = 0; i < 78; i++) store.addClip({ ...base, id: `t${i}`, scene: "other", importedAt: today });
  assert.equal(importBudget(), 2); // 80 per day, 78 already imported today
});

test("videos that are already edits (text on them) are never used automatically", () => {
  const edit = store.addClip({ ...base, id: "edited", scene: "airport terminal", edited: true });
  assert.equal(onTopic(edit), false);
  store.updateSettings({ onlySituations: false });
  assert.equal(onTopic(edit), false);
  store.updateSettings({ onlySituations: true });
});
