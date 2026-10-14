import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-dupes-${process.pid}-${Date.now()}`);
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";
const { store } = await import("../src/store.ts");
const { markDuplicates } = await import("../src/albums.ts");
const { onTopic } = await import("../src/generate.ts");

const base = { source: "shared_album", filename: "x.mp4", file: "/x", kind: "video", duration: 8.2, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready", scene: "airport terminal" } as any;

test("a video imported from two albums is only used once", () => {
  const at = "2026-10-01T09:15:42.123Z";
  store.addClip({ ...base, id: "first", capturedAt: at, importedAt: "2026-10-02T00:00:00Z" });
  store.addClip({ ...base, id: "second", capturedAt: at, importedAt: "2026-10-03T00:00:00Z" });
  store.addClip({ ...base, id: "other", capturedAt: "2026-10-01T09:15:43.000Z", importedAt: "2026-10-03T00:00:00Z" });
  assert.equal(markDuplicates(), 1);
  assert.equal(store.clip("second")!.duplicateOf, "first");
  assert.equal(onTopic(store.clip("second")!), false);
  assert.equal(onTopic(store.clip("first")!), true);
  assert.equal(onTopic(store.clip("other")!), true);
  assert.equal(markDuplicates(), 0); // already handled
});

test("the copy that was already used is the one kept", () => {
  const at = "2026-10-05T12:00:00.500Z";
  store.addClip({ ...base, id: "a", capturedAt: at, importedAt: "2026-10-06T00:00:00Z" });
  store.addClip({ ...base, id: "b", capturedAt: at, importedAt: "2026-10-07T00:00:00Z", uses: 1 });
  markDuplicates();
  assert.equal(store.clip("a")!.duplicateOf, "b");
  assert.equal(store.clip("b")!.duplicateOf, undefined);
});
