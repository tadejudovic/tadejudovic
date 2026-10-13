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
