import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-audience-${process.pid}-${Date.now()}`);
const { worthReading, dedupeQuestions } = await import("../src/audience.ts");

const c = (text: string, likes = 0, author = "someone") => ({ text, likes, author, post: "p" });

test("comments of a few words of their own get a closer look; emojis, tags and the creator's replies don't", () => {
  assert.ok(worthReading(c("Which airline do you fly with?")));
  assert.ok(worthReading(c("need the link to that bag pls")));
  assert.ok(worthReading(c("I'd love to take mine to Japan")));
  assert.ok(!worthReading(c("so cute 😍😍")));
  assert.ok(!worthReading(c("@anna @mark look at this")));
  assert.ok(!worthReading(c("airline?")));
  assert.ok(!worthReading(c("Which airline do you think it was?", 0, "lex.poodle"), "@lex.poodle"));
});

test("the same question asked twice counts once, the most liked copy kept", () => {
  const out = dedupeQuestions([c("Which airline do you fly with?", 2), c("which airline do you fly with", 9), c("What bag is that?", 1)]);
  assert.equal(out.length, 2);
  assert.equal(out[0].likes, 9);
});
