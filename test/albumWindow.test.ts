import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-window-${process.pid}`);
const html = fs.readFileSync(new URL("./fixtures/album.html", import.meta.url), "utf8");
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => {
  if (String(input).startsWith("https://photos.app.goo.gl/")) return new Response(html, { headers: { "content-type": "text/html" } });
  return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
}) as typeof fetch;

const { store } = await import("../src/store.ts");
const { addAlbum, setRecentDays, syncAlbum } = await import("../src/albums.ts");

test("new albums only import videos from the last 30 days; old ones aren't marked seen", async () => {
  // The fixture's items are from 2024.
  const album = addAlbum("https://photos.app.goo.gl/WindowTest");
  assert.equal(album.recentDays, 30);
  assert.deepEqual(await syncAlbum(album.id), { newItems: 0 });
  assert.equal(store.album(album.id)!.tooOld, 3);
  assert.equal(store.album(album.id)!.seen.length, 0);

  // Widening the window picks them up.
  setRecentDays(album.id, 0);
  assert.deepEqual(await syncAlbum(album.id), { newItems: 3 });
  assert.equal(store.album(album.id)!.tooOld, 0);
  globalThis.fetch = realFetch;
});

test("clips are imported as the next five rounds need them", async () => {
  const { importBudget } = await import("../src/albums.ts");
  for (const c of store.clips()) store.updateClip(c.id, { status: "error" });
  store.updateAuto({ dailyCount: 5 });
  assert.equal(importBudget(), 27); // 5 rounds of 5 + 2 spare
  const base = { source: "upload", filename: "x.mp4", file: "/x", kind: "video", importedAt: "", duration: 5, width: 1080, height: 1920, hasAudio: true, uses: 0 } as any;
  for (let i = 0; i < 26; i++) store.addClip({ ...base, id: `u${i}`, status: "ready" });
  store.addClip({ ...base, id: "busy", status: "importing" });
  assert.equal(importBudget(), 0); // enough unused footage: nothing more is imported
});
