import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-inspire-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { plan, nextAudience } = await import("../src/generate.ts");

const clip = (id: string, scene: string, energy?: number[]) =>
  store.addClip({ id, source: "upload", filename: "x.mp4", file: "/x", kind: "video", importedAt: "2020-01-01T00:00:00Z", capturedAt: "2026-10-01T10:00:00Z", duration: 8, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready", scene, energy } as any);

test("the inspirational video is made even when its clip has no sound analysis", async () => {
  store.updateSettings({ dailyMix: { fun: 1, educational: 1, inspirational: 1 } } as any);
  const e = Array(16).fill(0.5);
  clip("a1", "airport terminal", e);
  clip("a2", "security check", e);
  clip("a3", "check-in desk", e);
  clip("o1", "city walk"); // no energy
  const r = await plan({ template: "auto", targetSeconds: 12, count: 3, clipIds: ["a1", "a2", "a3"], pickFromPool: true, useAi: false, options: {} as any });
  const inspire = r.plans.find((p) => p.format === "inspire");
  assert.ok(inspire, "no inspirational video");
  assert.equal(inspire.segments[0].clipId, "o1");
});

test("inspirational videos speak to everyone", () => {
  assert.equal(nextAudience("inspire"), "everyone");
});
