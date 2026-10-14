import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isAlbumUrl, parseAlbumHtml } from "../src/google/sharedAlbum.ts";
import { parseFormats } from "../src/ai/trends.ts";

const html = fs.readFileSync(new URL("./fixtures/album.html", import.meta.url), "utf8");

test("parses media items out of a shared album page", () => {
  const page = parseAlbumHtml(html);
  assert.equal(page.title, "Lex & friends – high potential");
  assert.deepEqual(
    page.items.map((i) => [i.id, i.width, i.height, i.takenAt]),
    [
      ["AF1QipVideoOne", 1080, 1920, 1727000000000],
      ["AF1QipPhotoTwo", 4032, 3024, 1727500000000],
      ["AF1QipVideoThree", 1920, 1080, 1728000000000],
    ],
  );
  assert.equal(page.items[0].baseUrl, "https://lh3.googleusercontent.com/pw/AP1GczVIDEO1");
});

test("recognizes shared album links", () => {
  assert.ok(isAlbumUrl("https://photos.app.goo.gl/AbCdEf123"));
  assert.ok(isAlbumUrl("https://photos.google.com/share/AF1QipX?key=abc"));
  assert.ok(!isAlbumUrl("https://photos.google.com/"));
  assert.ok(!isAlbumUrl("https://example.com/share/x"));
});

test("parseFormats tolerates prose around the JSON", () => {
  const f = parseFormats('Here you go:\n{"formats":[{"pattern":"POV: ___","example":"POV: Lex at the vet","fits":"vet"},{"bad":1}]}\nDone.');
  assert.deepEqual(f, [{ pattern: "POV: ___", example: "POV: Lex at the vet", fits: "vet" }]);
});

test("finds the full album address however the redirect page escapes it", async () => {
  const { findShareUrl } = await import("../src/google/sharedAlbum.ts");
  const want = "https://photos.google.com/share/AF1QipMg67Z_H-7tc?key=SWJYNVBCaXdX";
  assert.equal(findShareUrl(`<meta http-equiv="refresh" content="0;url=${want.replace("&", "&amp;")}">`), want);
  assert.equal(findShareUrl(`window.location.replace("${want.replaceAll("/", "\\/")}")`), want);
  assert.equal(findShareUrl(`"\\u0068ttps:\\u002F\\u002Fphotos.google.com\\u002Fshare\\u002FAF1QipMg67Z_H-7tc?key\\u003dSWJYNVBCaXdX"`.replace("\\u0068", "h")), want);
  assert.equal(findShareUrl(`<a href="/continue?u=${encodeURIComponent(want)}">`), want);
  assert.equal(findShareUrl("<html>nothing here</html>"), undefined);
});

test("follows a chain of short links to the album", async () => {
  const { fetchAlbum } = await import("../src/google/sharedAlbum.ts");
  const album = fs.readFileSync(new URL("./fixtures/album.html", import.meta.url), "utf8");
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    seen.push(url);
    if (url === "https://photos.app.goo.gl/first") return new Response(null, { status: 302, headers: { location: "https://photos.app.goo.gl/second" } });
    if (url === "https://photos.app.goo.gl/second")
      return new Response(`<html><title>Google Photos</title><script>location.href="https:\\/\\/photos.google.com\\/share\\/AF1QipAlbum?key\\u003dK1"</script>`, { headers: { "content-type": "text/html" } });
    if (url.startsWith("https://photos.google.com/share/AF1QipAlbum?key=K1")) return new Response(album, { headers: { "content-type": "text/html" } });
    return new Response("?", { status: 404 });
  }) as typeof fetch;
  try {
    const page = await fetchAlbum("https://photos.app.goo.gl/first");
    assert.equal(page.items.length, 3);
    assert.ok(seen.includes("https://photos.google.com/share/AF1QipAlbum?key=K1"), JSON.stringify(seen));
  } finally {
    globalThis.fetch = real;
  }
});

test("album links are found in pasted share text", async () => {
  const { albumUrlFrom } = await import("../src/google/sharedAlbum.ts");
  assert.equal(albumUrlFrom("Check out this album: https://photos.app.goo.gl/AbC123xyz"), "https://photos.app.goo.gl/AbC123xyz");
  assert.equal(albumUrlFrom("photos.app.goo.gl/AbC123xyz"), "https://photos.app.goo.gl/AbC123xyz");
  assert.equal(albumUrlFrom(" https://photos.google.com/share/AF1Qip?key=abc. "), "https://photos.google.com/share/AF1Qip?key=abc");
  assert.equal(albumUrlFrom("http://photos.app.goo.gl/x1"), "https://photos.app.goo.gl/x1");
});
