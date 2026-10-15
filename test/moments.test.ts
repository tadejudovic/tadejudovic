import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-moments-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { momentsOf } = await import("../src/moments.ts");
const { pickBySituation } = await import("../src/generate.ts");

const base = { source: "shared_album", filename: "x.mp4", file: "/x", kind: "video", importedAt: "2026-10-01T00:00:00Z", duration: 8, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready" } as any;
const at = (min: number) => new Date(Date.UTC(2026, 9, 10, 8, 0) + min * 60_000).toISOString();
const clip = (id: string, scene: string, min: number) => store.addClip({ ...base, id, scene, capturedAt: at(min) });

store.updateSettings({ scenes: ["inside the airplane", "security check"] });
const seat1 = clip("seat1", "inside the airplane", 0);
const seat2 = clip("seat2", "inside the airplane", 12);
const seat3 = clip("seat3", "inside the airplane", 25);
const laterFlight = clip("flight2", "inside the airplane", 60 * 24 * 3);
const security = clip("sec", "security check", 5);

test("shots of the same situation filmed within half an hour are takes of one moment", () => {
  const m = momentsOf([seat1, seat2, seat3, laterFlight, security]);
  assert.equal(m.get("seat2"), m.get("seat1"));
  assert.equal(m.get("seat3"), m.get("seat1"));
  assert.notEqual(m.get("flight2"), m.get("seat1"));
  assert.notEqual(m.get("sec"), m.get("seat1")); // same time, different situation
});

test("a round uses one take per moment", () => {
  const picked = pickBySituation([seat1, seat2, seat3, laterFlight, security], 5).map((c) => c.id);
  assert.equal(picked.filter((id) => id.startsWith("seat")).length, 1);
  assert.ok(picked.includes("flight2") && picked.includes("sec"));
  assert.equal(picked.length, 3);
});

test("another take of a moment waits a few days after one was used", () => {
  store.addRender({ id: "r1", createdAt: new Date().toISOString(), plan: { segments: [{ clipId: "seat1", start: 0, end: 3 }] } as any, options: {} as any, status: "done", progress: 1, review: "approved" });
  const picked = pickBySituation([seat2, seat3, laterFlight, security], 5).map((c) => c.id);
  assert.ok(!picked.some((id) => id.startsWith("seat")));
  // A rejected video doesn't hold the moment back.
  store.updateRender("r1", { review: "rejected", rejectReason: "text" });
  assert.equal(pickBySituation([seat2, seat3], 5).length, 1);
});
