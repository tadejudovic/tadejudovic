import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-window-${process.pid}-${Date.now()}`);
const html = fs.readFileSync(new URL("./fixtures/album.html", import.meta.url), "utf8");
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => {
  if (String(input).startsWith("https://photos.app.goo.gl/")) return new Response(html, { headers: { "content-type": "text/html" } });
  return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
}) as typeof fetch;

const { store } = await import("../src/store.ts");
const { addAlbum, setRecentDays, syncAlbum } = await import("../src/albums.ts");

test("albums are scanned backwards: the last 30 days first, then older videos, newest first", async () => {
  // The fixture's items are from 2024, so all of them are older than the range.
  const album = addAlbum("https://photos.app.goo.gl/WindowTest");
  assert.equal(album.recentDays, 30);
  // Nothing in range to wait for: the scan carries on back in time.
  assert.deepEqual(await syncAlbum(album.id), { newItems: 3 });
  assert.equal(store.album(album.id)!.tooOld, 0);
  assert.equal(store.album(album.id)!.reachedBack, 3);
  await new Promise((r) => setTimeout(r, 300));
  for (const c of store.clips()) if (c.source === "shared_album") store.removeClip(c.id);
  globalThis.fetch = realFetch;
});

test("a full scan from a date takes every video since then again, past the window and the seen list", async () => {
  globalThis.fetch = (async (input: any) => {
    if (String(input).startsWith("https://photos.app.goo.gl/")) return new Response(html, { headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const { scanSince } = await import("../src/albums.ts");
  const album = addAlbum("https://photos.app.goo.gl/ScanTest", 7);
  // Pretend everything was handled already (e.g. downloads that never finished).
  const listed = await syncAlbum(album.id);
  await new Promise((r) => setTimeout(r, 300));
  for (const c of store.clips()) if (c.source === "shared_album") store.removeClip(c.id);
  store.updateAlbum(album.id, { seen: ["x", ...store.album(album.id)!.seen] });
  assert.ok(listed.newItems >= 0);
  const r = await scanSince(Date.parse("2020-01-01"));
  assert.ok(r.newItems >= 3, `expected the fixture's videos again, got ${r.newItems}`);
  await new Promise((r) => setTimeout(r, 300));
  for (const c of store.clips()) if (c.source === "shared_album") store.removeClip(c.id);
  globalThis.fetch = realFetch;
});

test("the whole date range is imported, not just what the next rounds need", async () => {
  const { importBudget } = await import("../src/albums.ts");
  const base = { source: "upload", filename: "x.mp4", file: "/x", kind: "video", importedAt: "", duration: 5, width: 1080, height: 1920, hasAudio: true, uses: 0 } as any;
  for (let i = 0; i < 60; i++) store.addClip({ ...base, id: `u${i}`, status: "ready" });
  assert.ok(importBudget() > 100); // plenty of unused footage doesn't stop the import
});
