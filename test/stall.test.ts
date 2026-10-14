import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-stall-${process.pid}-${Date.now()}`);
const { saveResponse } = await import("../src/google/sharedAlbum.ts");

test("a download that stops sending data is abandoned instead of hanging forever", async () => {
  // Sends one chunk, then nothing, ever.
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])); },
    pull() { return new Promise(() => {}); },
  });
  const dest = path.join(os.tmpdir(), `stall-${process.pid}.mp4`);
  const started = Date.now();
  await assert.rejects(saveResponse(new Response(body), dest, 300), /stalled/);
  assert.ok(Date.now() - started < 3000);
  fs.rmSync(dest, { force: true });
});

test("a normal download still saves completely", async () => {
  const data = new Uint8Array(200_000).fill(7);
  const dest = path.join(os.tmpdir(), `ok-${process.pid}.bin`);
  await saveResponse(new Response(data), dest, 300);
  assert.equal(fs.statSync(dest).size, 200_000);
  fs.rmSync(dest, { force: true });
});
