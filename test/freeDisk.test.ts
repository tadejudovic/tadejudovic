import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lexstudio-disk-"));
process.env.DATA_DIR = dir;
const { store } = await import("../src/store.ts");
const { config } = await import("../src/config.ts");
const { freeDiskSpace } = await import("../src/library.ts");

test("files nothing needs are freed; what's in use stays", () => {
  const put = (p: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, Buffer.alloc(1000)), p);
  const base = { source: "google_photos", filename: "x", kind: "video", importedAt: "2026-10-01T00:00:00Z", duration: 5, width: 1080, height: 1920, hasAudio: false, uses: 0 } as any;
  store.addClip({ ...base, id: "ok", file: put(path.join(config.mediaDir, "ok.mp4")), status: "ready" });
  store.addClip({ ...base, id: "bad", file: put(path.join(config.mediaDir, "bad.orig.mp4")), status: "error" });
  const orphan = put(path.join(config.mediaDir, "nobody.mp4"));
  const oldTmp = put(path.join(config.tmpDir, "job1", "seg.mp4"));
  fs.utimesSync(path.join(config.tmpDir, "job1"), new Date(0), new Date(0));
  const keptVideo = put(path.join(config.rendersDir, "v1.mp4"));
  const strayVideo = put(path.join(config.rendersDir, "gone.mp4"));
  store.addRender({ id: "v1", createdAt: new Date().toISOString(), status: "done", progress: 1, review: "pending", file: keptVideo, options: {} as any, plan: { segments: [] } as any } as any);
  const freed = freeDiskSpace();
  assert.ok(freed >= 4000);
  assert.ok(fs.existsSync(path.join(config.mediaDir, "ok.mp4")));
  assert.ok(fs.existsSync(keptVideo));
  for (const p of [path.join(config.mediaDir, "bad.orig.mp4"), orphan, oldTmp, strayVideo]) assert.ok(!fs.existsSync(p), p);
});
