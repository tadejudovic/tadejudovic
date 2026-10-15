import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-roundmix-${process.pid}-${Date.now()}`);
delete process.env.ANTHROPIC_API_KEY; // the no-AI path still assigns kinds and picks clips the same way
const { store } = await import("../src/store.ts");
const { plan } = await import("../src/generate.ts");

const base = { source: "shared_album", filename: "x.mp4", file: "/x", kind: "video", importedAt: "2026-10-01T00:00:00Z", duration: 10, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready", moments: [{ start: 1, end: 6, score: 0.9 }], energy: Array.from({ length: 20 }, (_, i) => (i % 5) / 5) } as any;
const at = (min: number) => new Date(Date.UTC(2026, 9, 10, 8, 0) + min * 60_000).toISOString();

test("a round of three is one fun, one educational and one inspirational, from different situations", async () => {
  store.updateSettings({ scenes: ["inside the airplane", "security check", "airport terminal"], dailyMix: { fun: 2, educational: 2, inspirational: 2 } });
  // Three takes of one flight (strongest footage) and one clip from each other situation.
  for (const [i, id] of ["seat1", "seat2", "seat3"].entries()) store.addClip({ ...base, id, scene: "inside the airplane", capturedAt: at(i * 5), moments: [{ start: 1, end: 6, score: 1 }] });
  store.addClip({ ...base, id: "sec", scene: "security check", capturedAt: at(600) });
  store.addClip({ ...base, id: "term", scene: "airport terminal", capturedAt: at(900) });
  const ids = store.clips().map((c) => c.id);
  const { plans } = await plan({ template: "auto", targetSeconds: 12, count: 3, clipIds: ids, pickFromPool: true, useAi: true, options: {} as any });
  assert.deepEqual(plans.map((p) => p.format), ["fun", "tips", "inspire"]);
  const clips = plans.map((p) => p.segments[0].clipId);
  assert.equal(clips.filter((c) => c.startsWith("seat")).length, 1); // one take of the flight, not three
  assert.ok(clips.includes("sec") && clips.includes("term"));
});
