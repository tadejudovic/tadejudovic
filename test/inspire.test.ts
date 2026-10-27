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

test("inspirational videos speak to everyone (with the Mix setting)", () => {
  store.updateSettings({ captionAudience: "mix" });
  assert.equal(nextAudience("inspire"), "everyone");
});

test("asked for an inspirational video with only outside footage left, it's still made", async () => {
  clip("o2", "beach");
  const r = await plan({ template: "auto", targetSeconds: 12, count: 1, clipIds: [], pickFromPool: true, useAi: false, format: "inspire", options: {} as any });
  assert.equal(r.plans.length, 1);
  assert.equal(r.plans[0].format, "inspire");
});

test("a hook only claims a reference it visibly builds on", async () => {
  const { echoes } = await import("../src/ai/director.ts");
  assert.equal(echoes("You always ask which airline Lex flies with / but the seat you book matters more", "If you are traveling with your dog, they must remain in their carrier underneath the seat"), false);
  assert.equal(echoes("The carrier stays under the seat the whole flight", "If you are traveling with your dog, they must remain in their carrier underneath the seat"), true);
  assert.equal(echoes("POV: your dog clears security first", "POV: you forgot the passport"), true);
});

test("basic checks catch airport codes and odd capitals in the headline", async () => {
  const { basicChecks } = await import("../src/checks.ts");
  const plan = (text: string) => ({ format: "fun", segments: [{ clipId: "c", start: 0, end: 5 }], overlays: [{ text, start: 0, end: 6 }] }) as any;
  const bad = basicChecks(plan("Dog goes Cross country FLL LA"));
  assert.ok(bad.some((p) => p.includes("FLL")));
  assert.ok(bad.some((p) => p.includes("Cross")));
  assert.deepEqual(basicChecks(plan("Lex rides the baggage belt to Tokyo"), "Tokyo, Japan"), []);
});

test("a place on screen must be where the clip was filmed", async () => {
  const { basicChecks } = await import("../src/checks.ts");
  const plan = (text: string) => ({ format: "inspire", segments: [{ clipId: "c", start: 0, end: 5 }], overlays: [{ text, start: 0, end: 6 }] }) as any;
  assert.ok(basicChecks(plan("pov: you take an evening walk in nyc"), "Toronto, Canada").some((p) => p.includes("nyc")));
  assert.ok(basicChecks(plan("An evening walk in Paris"), undefined).some((p) => p.includes("Paris")));
  assert.deepEqual(basicChecks(plan("An evening walk in Toronto"), "Toronto, Ontario, Canada"), []);
});
