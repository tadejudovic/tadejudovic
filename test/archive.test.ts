import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-archive-${process.pid}`);
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";
const { store } = await import("../src/store.ts");
const { config } = await import("../src/config.ts");
const { archiveUnusable } = await import("../src/library.ts");

fs.mkdirSync(config.mediaDir, { recursive: true });
const old = new Date(Date.now() - 8 * 86400_000).toISOString();
const clip = (id: string, extra: object) => {
  const file = path.join(config.mediaDir, `${id}.mp4`);
  fs.writeFileSync(file, "x");
  return store.addClip({ id, source: "shared_album", filename: "x.mp4", file, kind: "video", importedAt: old, duration: 8, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready", ...extra } as any);
};

test("week-old clips that will never be used lose their files but keep their record", () => {
  store.updateSettings({ scenes: ["airport terminal"], onlySituations: true });
  clip("beach", { scene: "other", sourceId: "AF1Qbeach" });
  clip("edited", { scene: "airport terminal", edited: true });
  clip("good", { scene: "airport terminal" });
  clip("fixedByHand", { scene: "other", sceneSetBy: "creator" });
  clip("fresh", { scene: "other", importedAt: new Date().toISOString() });
  assert.equal(archiveUnusable(), 2);
  assert.equal(store.clip("beach")!.status, "archived");
  assert.equal(fs.existsSync(path.join(config.mediaDir, "beach.mp4")), false);
  assert.equal(store.clip("edited")!.status, "archived");
  for (const id of ["good", "fixedByHand", "fresh"]) assert.equal(store.clip(id)!.status, "ready", id);
  assert.equal(store.hasSource("AF1Qbeach"), true); // never imported again
});
