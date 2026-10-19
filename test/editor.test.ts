import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-editor-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { editorPass, editorReviewer } = await import("../src/generate.ts");

const scores = { hook: 8, firstSecond: 8, textPlacement: 8, footage: 8, pacing: 8, readability: 8 };
const add = (id: string, plan: object = {}) =>
  store.addRender({
    id, createdAt: new Date().toISOString(), status: "rendering", progress: 0.97, review: "pending", file: "/nope.mp4", options: {} as any,
    plan: { format: "tips", hook: "Old hook", segments: [{ clipId: "c", start: 0, end: 8 }], hashtags: [], overlays: [{ text: "Old hook", start: 0, end: 9 }, { text: "1. One", start: 2, end: 9, y: 0.4 }], ...plan },
  } as any);

test("a video that passes goes to Review with the editor's scores", async () => {
  add("p1");
  editorReviewer.review = async () => ({ scores, verdict: "pass", issues: [], texts: [], remakeBrief: "" });
  await editorPass("p1", 8);
  const r = store.render("p1")!;
  assert.equal(r.status, "done");
  assert.equal(r.editor?.outcome, "passed");
});

test("a weak hook gets its text fixed once; after that it's let through with notes", async () => {
  add("t1");
  editorReviewer.review = async () => ({ scores: { ...scores, hook: 4 }, verdict: "fix_text", issues: ["Hook is label-style"], texts: ["Where do dogs pee when they fly?", "1. One"], remakeBrief: "" });
  await editorPass("t1", 8);
  assert.equal(store.render("t1"), undefined);
  const fixed = store.renders().find((r) => r.plan.hook === "Where do dogs pee when they fly?")!;
  assert.ok(fixed);
  assert.equal(fixed.plan.editorPass, 1);
  assert.equal(fixed.plan.overlays![0].text, "Where do dogs pee when they fly?");

  // Second look at the fixed one: still not great, but it isn't sent back again.
  add("t2", { editorPass: 1 });
  await editorPass("t2", 8);
  assert.equal(store.render("t2")!.status, "done");
  assert.equal(store.render("t2")!.editor?.outcome, "let_through");
});
