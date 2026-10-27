import { test } from "node:test";
import assert from "node:assert/strict";
import { keyWord, isBoxed } from "../src/media/render.ts";

test("the highlight look picks a number or price first, else the longest meaningful word", () => {
  assert.equal(keyWord("Can your dog fly in the cabin for $45?"), "$45");
  assert.equal(keyWord("POV: the energy shift at the airport"), "airport");
  assert.equal(keyWord("it is what it is"), undefined);
  assert.equal(isBoxed("blackbox"), true);
  assert.equal(isBoxed("highlight"), false);
});
