import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-feedback-${process.pid}`);
const { store } = await import("../src/store.ts");
const { reviewFeedback } = await import("../src/generate.ts");
const { feedbackText } = await import("../src/ai/director.ts");

const add = (id: string, hook: string, review: "approved" | "rejected" | "pending", rejectReason?: "text" | "clip") =>
  store.addRender({
    id, createdAt: new Date().toISOString(), reviewedAt: new Date().toISOString(), status: "done", progress: 1, review, rejectReason,
    options: {} as any, plan: { hook, scene: "boarding gate", segments: [] } as any,
  });

test("swipe decisions become guidance for the AI director", () => {
  add("k", "POV: the energy shift at the gate", "approved");
  add("x", "Lex is a good boy", "rejected", "text");
  add("p", "not reviewed yet", "pending");
  const f = reviewFeedback();
  assert.deepEqual(f.kept.map((k) => k.text), ["POV: the energy shift at the gate"]);
  assert.deepEqual(f.rejected.map((k) => [k.text, k.reason]), [["Lex is a good boy", "text"]]);
  const text = feedbackText(f);
  assert.match(text, /Kept:\n- "POV: the energy shift at the gate" \(boarding gate\)/);
  assert.match(text, /Rejected:\n- "Lex is a good boy" \(boarding gate\): the text was off/);
  assert.equal(feedbackText({ kept: [], rejected: [] }), "");
});
