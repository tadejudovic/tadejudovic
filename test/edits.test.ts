import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-edits-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { reviewFeedback } = await import("../src/generate.ts");
const { feedbackText } = await import("../src/ai/director.ts");

test("the creator's corrections are kept and reach the AI as its strongest feedback", () => {
  store.addEdit({ what: "text", before: "same", after: "same" }); // no change: not kept
  store.addEdit({ what: "text", before: "POV: the desk asks for papers", after: "What we check before every new country", format: "tips" });
  store.addEdit({ what: "caption", before: "Long caption", after: "Short caption", format: "fun" });
  assert.equal(store.edits().length, 2);
  assert.equal(store.edits()[0].what, "caption"); // newest first
  // Deleting every video doesn't touch them.
  for (const r of [...store.renders()]) store.removeRender(r.id);
  const text = feedbackText(reviewFeedback());
  assert.match(text, /CORRECTIONS/);
  assert.match(text, /"POV: the desk asks for papers" → "What we check before every new country"/);
  assert.match(text, /Description \[fun\]: "Long caption" → "Short caption"/);
});

test("remakes count toward the day's safety cap (stories don't)", async () => {
  const { videosMadeToday } = await import("../src/dailyLimit.ts");
  const base = { createdAt: new Date().toISOString(), status: "done", progress: 1, options: {} as any };
  store.addRender({ ...base, id: "orig", review: "rejected", rejectReason: "text", plan: { segments: [], hashtags: [], hook: "a" } } as any);
  store.addRender({ ...base, id: "redo", review: "pending", plan: { segments: [], hashtags: [], hook: "b", remakeOf: "orig", remakeDepth: 1 } } as any);
  store.addRender({ ...base, id: "story", review: "pending", plan: { segments: [], hashtags: [], hook: "c", format: "story" } } as any);
  assert.equal(videosMadeToday(), 2);
});
