import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-picker-${process.pid}-${Date.now()}`);
process.env.MEMORY_MB = "512";
const { store } = await import("../src/store.ts");
const { download } = await import("../src/google/picker.ts");

test("a picked video downloads Google's 1080p version on a small server, the original if there's none", async () => {
  store.setGoogle({ access_token: "t", expires_at: Date.now() + 3600_000 } as any);
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url).replace(/^.*(?==)/, ""));
    if (String(url).endsWith("=m37")) return new Response("x", { status: 404, headers: { "content-type": "image/png" } });
    if (String(url).endsWith("=m22")) return new Response("x", { status: 200, headers: { "content-type": "image/jpeg" } });
    return new Response("video-bytes", { status: 200, headers: { "content-type": "video/mp4" } });
  }) as any;
  const dest = path.join(os.tmpdir(), `picked-${Date.now()}.mp4`);
  try {
    await download({ id: "a", type: "VIDEO", mediaFile: { baseUrl: "https://lh3.googleusercontent.com/ppa/x", mimeType: "video/mp4", filename: "a.mp4" } }, dest);
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(asked, ["=m37", "=m22", "=dv"]);
  assert.equal(fs.readFileSync(dest, "utf8"), "video-bytes");
});
