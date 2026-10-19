import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-places-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { parseIso6709, countryOf } = await import("../src/geo.ts");
const { onTopic, placeOff } = await import("../src/generate.ts");

test("phones' GPS positions are read from the video file", () => {
  assert.deepEqual(parseIso6709("+38.7223-009.1393/"), { lat: 38.7223, lon: -9.1393 });
  assert.deepEqual(parseIso6709("+35.6895+139.6917+040.000/"), { lat: 35.6895, lon: 139.6917 });
  assert.equal(parseIso6709(undefined), undefined);
  assert.equal(parseIso6709("+0000+00000/"), undefined);
  assert.equal(countryOf("Lisbon, Portugal"), "Portugal");
});

test("a country switched off in Themes keeps its footage out of videos", () => {
  store.updateSettings({ onlySituations: false });
  const c = store.addClip({ id: "lis", source: "upload", filename: "x", file: "/x", kind: "video", importedAt: "", duration: 8, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready", place: "Lisbon, Portugal" } as any);
  assert.equal(onTopic(c), true);
  store.updateSettings({ themesOff: ["place:Portugal"] });
  assert.equal(placeOff(c), true);
  assert.equal(onTopic(c), false);
});
