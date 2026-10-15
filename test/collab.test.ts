import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-collab-${process.pid}-${Date.now()}`);
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";
const { store } = await import("../src/store.ts");
const { makeCollabVersion } = await import("../src/generate.ts");

test("a collab version needs a known video and partner", async () => {
  await assert.rejects(makeCollabVersion("nope", "nope"), /Unknown video/);
  store.addRender({ id: "r1", createdAt: new Date().toISOString(), plan: { segments: [{ clipId: "gone", start: 0, end: 3 }] } as any, options: {} as any, status: "done", progress: 1, review: "approved" });
  await assert.rejects(makeCollabVersion("r1", "nope"), /Unknown partner/);
  store.savePartner({ id: "p1", name: "Sherpa", handle: "@sherpapet", about: "carrier" });
  await assert.rejects(makeCollabVersion("r1", "p1"), /no longer in the library/);
});
