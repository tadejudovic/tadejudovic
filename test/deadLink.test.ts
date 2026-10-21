import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-dead-${process.pid}-${Date.now()}`);
const { deadLink } = await import("../src/albums.ts");

test("an expired album link is retried, a photo is skipped", () => {
  assert.equal(deadLink("=m37: image/png 404, =m22: image/png 404, =dv: image/png 404, =m18: image/png 404"), true);
  assert.equal(deadLink("=m37: no answer within 45s, =m22: image/png 404"), true);
  assert.equal(deadLink("=m37: image/jpeg, =m22: image/jpeg, =dv: image/jpeg"), false);
});
