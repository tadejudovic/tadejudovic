import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-audience-${process.pid}-${Date.now()}`);
const { isQuestion, dedupeQuestions } = await import("../src/audience.ts");

const c = (text: string, likes = 0, author = "someone") => ({ text, likes, author, post: "p" });

test("only real questions of a few words count", () => {
  assert.ok(isQuestion(c("Which airline do you fly with?")));
  assert.ok(isQuestion(c("how did you get him into Japan")));
  assert.ok(isQuestion(c("what bag is that, it looks so comfy")));
  assert.ok(!isQuestion(c("so cute 😍😍")));
  assert.ok(!isQuestion(c("@anna look!!")));
  assert.ok(!isQuestion(c("airline?"))); // too short to learn from
  assert.ok(!isQuestion(c("He is the cutest dog ever honestly")));
  // The creator's own replies don't count.
  assert.ok(!isQuestion(c("Which airline do you think it was?", 0, "lex.poodle"), "@lex.poodle"));
});

test("the same question asked twice counts once, the most liked copy kept", () => {
  const out = dedupeQuestions([c("Which airline do you fly with?", 2), c("which airline do you fly with", 9), c("What bag is that?", 1)]);
  assert.equal(out.length, 2);
  assert.equal(out[0].likes, 9);
});
