import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-faq-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { nextQuestion } = await import("../src/generate.ts");

test("educational videos start from the creator's six questions", () => {
  const qs = store.settings().faq.map((f) => f.q);
  assert.equal(qs.length, 6);
  assert.ok(qs.some((q) => /bag/i.test(q)) && qs.some((q) => /pee/i.test(q)));
});

test("questions take turns, matched to the footage where possible", () => {
  // Nothing asked yet: the clip's situation decides (under-the-seat footage → the bag question).
  assert.match(nextQuestion("under the airplane seat")!.q, /bag/i);
  assert.match(nextQuestion("airport terminal")!.q, /pee/i);
  // Once the bag question was answered, the next under-seat video answers something else.
  store.addRender({ id: "r1", createdAt: new Date().toISOString(), plan: { segments: [], faq: store.settings().faq[0].q } as any, options: {} as any, status: "done", progress: 1, review: "approved" });
  assert.doesNotMatch(nextQuestion("under the airplane seat")!.q, /bag/i);
  // Not twice in one round.
  const first = nextQuestion("security check")!;
  assert.notEqual(nextQuestion("security check", new Set([first.q]))!.q, first.q);
});
