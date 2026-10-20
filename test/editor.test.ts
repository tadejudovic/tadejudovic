import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-editor-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { editorPass, editorReviewer } = await import("../src/generate.ts");

const scores = { hook: 8, body: 8, ending: 8 };
const p = { visual: 8, text: 8, motion: 8, sound: 8, note: "" };
const parts = { hook: p, body: p, ending: p };
const add = (id: string, plan: object = {}) =>
  store.addRender({
    id, createdAt: new Date().toISOString(), status: "rendering", progress: 0.97, review: "pending", file: "/nope.mp4", options: {} as any,
    plan: { format: "tips", hook: "Old hook", segments: [{ clipId: "c", start: 0, end: 8 }], hashtags: [], overlays: [{ text: "Old hook", start: 0, end: 9 }, { text: "1. One", start: 2, end: 9, y: 0.4 }], ...plan },
  } as any);

test("a video that passes goes to Review with the editor's scores", async () => {
  add("p1");
  editorReviewer.review = async () => ({ scores, parts, dropOff: [], verdict: "pass", issues: [], texts: [], remakeBrief: "" });
  await editorPass("p1", 8);
  const r = store.render("p1")!;
  assert.equal(r.status, "done");
  assert.equal(r.editor?.outcome, "passed");
});

test("with retries off (the default), a failing video goes to Review once, with the editor's notes", async () => {
  add("o1");
  editorReviewer.review = async () => ({ scores: { ...scores, hook: 4 }, parts, dropOff: [], verdict: "fix_text", issues: ["Weak hook"], texts: ["New hook", "1. One"], remakeBrief: "" });
  await editorPass("o1", 8);
  assert.equal(store.render("o1")!.review, "pending");
  assert.equal(store.render("o1")!.editor?.outcome, "let_through");
  assert.ok(!store.renders().some((r) => r.plan.hook === "New hook"));
});

test("a weak hook gets its text fixed and checked again; the first try is set aside, not deleted", async () => {
  store.updateSettings({ features: { retries: true } } as any);
  add("t1");
  editorReviewer.review = async () => ({ scores: { ...scores, hook: 4 }, parts, dropOff: [{ at: 1, why: "label-style hook" }], verdict: "fix_text", issues: ["Hook is label-style"], texts: ["Where do dogs pee when they fly?", "1. One"], remakeBrief: "" });
  await editorPass("t1", 8);
  const old = store.render("t1")!;
  assert.equal(old.review, "rejected");
  assert.equal(old.rejectedBy, "editor");
  const fixed = store.renders().find((r) => r.plan.hook === "Where do dogs pee when they fly?")!;
  assert.equal(fixed.plan.editorPass, 1);
  assert.equal(fixed.plan.remakeOf, "t1");
  assert.equal(old.remadeAs, fixed.id);
});

test("after the last attempt, the best-scoring one goes to Review", async () => {
  // Attempt 1 scored better than attempt 3.
  add("a1", { hook: "First" });
  store.updateRender("a1", { status: "done", review: "rejected", rejectedBy: "editor", rejectReason: "edit", editor: { at: "", scores: { hook: 7, body: 7, ending: 7 }, verdict: "remake", issues: [], outcome: "remade" } } as any);
  add("a3", { hook: "Third", editorPass: 2, remakeOf: "a1" });
  editorReviewer.review = async () => ({ scores: { hook: 5, body: 6, ending: 6 }, parts, dropOff: [], verdict: "remake", issues: ["Weak opening"], texts: [], remakeBrief: "Open on movement" });
  await editorPass("a3", 8);
  assert.equal(store.render("a1")!.review, "pending");
  assert.equal(store.render("a1")!.editor?.outcome, "let_through");
  assert.equal(store.render("a3")!.review, "rejected");
  assert.equal(store.render("a3")!.rejectedBy, "editor");
});
