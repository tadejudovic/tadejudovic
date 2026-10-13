import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-sit-${process.pid}`);

const { pickBySituation } = await import("../src/generate.ts");
const { parseCaptions } = await import("../src/ai/research.ts");
import type { Clip } from "../src/types.ts";

const clip = (id: string, scene: string | undefined, uses = 0, score = 0.5): Clip => ({
  id, source: "upload", filename: id, file: id, kind: "video", importedAt: "", duration: 12, width: 1080, height: 1920,
  hasAudio: true, status: "ready", uses, scene, moments: [{ start: 0, end: 3, score }],
});

test("pickBySituation rotates situations before repeating one", () => {
  const clips = [
    clip("s1", "security check", 0, 0.9), clip("s2", "security check", 0, 0.8), clip("s3", "security check", 0, 0.7),
    clip("g1", "boarding gate"), clip("p1", "inside the airplane"), clip("x1", undefined),
  ];
  const picked = pickBySituation(clips, 4).map((c) => c.id);
  assert.deepEqual(new Set(picked.slice(0, 3)), new Set(["s1", "g1", "p1"]), JSON.stringify(picked));
  assert.ok(!picked.slice(0, 3).includes("x1"), "unsorted clips come after known situations");
  assert.equal(picked.length, 4);
});

test("pickBySituation prefers unused clips within a situation", () => {
  const picked = pickBySituation([clip("old", "boarding gate", 3, 0.99), clip("new", "boarding gate", 0, 0.2)], 1);
  assert.equal(picked[0].id, "new");
});

test("parseCaptions keeps sourced fields and drops junk", () => {
  const caps = parseCaptions('found:\n{"captions":[{"text":"POV: security","views":2400000,"url":"https://www.tiktok.com/@a/video/1","kind":"overlay"},{"text":"x","views":"lots","url":"javascript:alert(1)"},{"nope":1}]}');
  assert.equal(caps.length, 2);
  assert.equal(caps[0].views, 2400000);
  assert.equal(caps[1].views, undefined);
  assert.equal(caps[1].url, undefined);
});
