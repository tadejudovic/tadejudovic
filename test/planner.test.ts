import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `pawcut-test-${process.pid}-${Date.now()}`);

const { findMoments } = await import("../src/media/analyze.ts");
const { heuristicPlan, fitWindow, stretchToTarget } = await import("../src/planner.ts");
const { wrap, screenText } = await import("../src/media/render.ts");
import type { Clip, TemplateId } from "../src/types.ts";

function clip(id: string, duration: number, peakAt: number, capturedAt?: string): Clip {
  const energy = Array.from({ length: Math.ceil(duration / 0.5) }, (_, i) =>
    Math.abs(i * 0.5 - peakAt) < 1.5 ? 0.9 : 0.1,
  );
  return {
    id, source: "upload", filename: `${id}.mp4`, file: `/x/${id}.mp4`, kind: "video",
    importedAt: new Date().toISOString(), capturedAt, duration, width: 1080, height: 1920,
    hasAudio: true, status: "ready", energy, moments: findMoments(energy, duration), uses: 0,
  };
}

test("findMoments puts the strongest window first and keeps windows apart", () => {
  const curve = [0.1, 0.1, 0.1, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
  const moments = findMoments(curve, 10, 3);
  assert.ok(moments[0].start >= 1.5 && moments[0].end <= 5.5, JSON.stringify(moments[0]));
  for (let i = 1; i < moments.length; i++) {
    assert.ok(Math.abs(moments[i].start - moments[0].start) >= 3);
  }
});

test("findMoments handles clips shorter than the window", () => {
  assert.deepEqual(findMoments([0.5, 0.5], 1, 3), [{ start: 0, end: 1, score: 0.5 }]);
});

test("fitWindow stays inside the clip", () => {
  const w = fitWindow({ clipId: "a", clipDuration: 5, start: 4, end: 5, score: 1 }, 3);
  assert.deepEqual(w, { start: 2, end: 5 });
});

test("stretchToTarget lands on the target length, accounting for speed", () => {
  const clips = new Map([["a", clip("a", 30, 5)], ["b", clip("b", 30, 5)]]);
  const out = stretchToTarget(
    [{ clipId: "a", start: 5, end: 10 }, { clipId: "b", start: 5, end: 10, speed: 0.5 }],
    clips,
    12,
  );
  const total = out.reduce((a, s) => a + (s.end - s.start) / (s.speed ?? 1), 0);
  assert.ok(Math.abs(total - 12) < 0.5, `total ${total}`);
});

for (const template of ["quick_cuts", "single_moment", "pov_story", "then_vs_now"] as TemplateId[]) {
  test(`heuristicPlan(${template}) produces a valid plan near the target length`, () => {
    const clips = [
      clip("a", 12, 3, "2021-03-01T00:00:00Z"),
      clip("b", 20, 10, "2022-06-01T00:00:00Z"),
      clip("c", 8, 6, "2024-01-01T00:00:00Z"),
      clip("d", 15, 2, "2026-09-01T00:00:00Z"),
    ];
    const plan = heuristicPlan({ template, targetSeconds: 15, clips, petName: "Lex", used: new Map() });
    assert.ok(plan.segments.length > 0);
    assert.ok(!plan.hook.includes("{pet}"));
    const byId = new Map(clips.map((c) => [c.id, c]));
    let total = 0;
    for (const s of plan.segments) {
      const c = byId.get(s.clipId)!;
      assert.ok(s.start >= 0 && s.end <= c.duration && s.end > s.start, JSON.stringify(s));
      total += (s.end - s.start) / (s.speed ?? 1);
    }
    assert.ok(Math.abs(total - 15) <= 1.5, `total ${total}`);
    if (template === "then_vs_now") {
      assert.match(plan.segments[0].caption ?? "", /^THEN/);
      assert.ok(plan.segments.some((s) => s.caption?.startsWith("NOW")));
    }
  });
}

test("screenText strips emoji and wrap keeps lines short", () => {
  assert.equal(screenText("Lex heard the doorbell 🔔🐶"), "Lex heard the doorbell");
  const lines = wrap("Me pretending I didn't hear the words bath time", 20);
  assert.ok(lines.every((l) => l.length <= 20), JSON.stringify(lines));
  assert.equal(lines.join(" "), "Me pretending I didn't hear the words bath time");
  assert.deepEqual(wrap("tell me you have a poodle without telling me", 24), ["tell me you have", "a poodle without", "telling me"]);
  assert.deepEqual(wrap("nobody: / Lex at 6am:", 24), ["nobody:", "Lex at 6am:"]);
});
