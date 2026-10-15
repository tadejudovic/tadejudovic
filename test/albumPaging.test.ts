import { test } from "node:test";
import assert from "node:assert/strict";

const item = (id: string, t: number) => [`AF1Qip${id}`, [`https://lh3.googleusercontent.com/pw/${id}`, 1080, 1920], t, "h", 7200000, t];
const page = (items: unknown[], token?: string) =>
  `<!doctype html><html><head><meta property="og:title" content="Lex"></head><body><script>AF_initDataCallback({key: 'ds:1', hash: '2', data:${JSON.stringify([null, items, ...(token ? [token] : [null]), ["Lex"]])}, sideChannel: {}});</script></body></html>`;
const batch = (items: unknown[], token?: string) =>
  `)]}'\n\n120\n${JSON.stringify([["wrb.fr", "snAcKc", JSON.stringify([null, items, token ?? null]), null, null, null, "generic"]])}\n25\n[["e",4,null,null,150]]\n`;

const SHARE = "https://photos.google.com/share/AF1QipAlbum123?key=SECRETKEY";
const requests: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (url.startsWith("https://photos.google.com/share/")) return new Response(page([item("A", 1760000000000), item("B", 1759000000000)], "TOKEN_PAGE_2"), { headers: { "content-type": "text/html" } });
  if (url.includes("batchexecute")) {
    const body = decodeURIComponent(String(init?.body ?? ""));
    requests.push(body);
    if (body.includes("TOKEN_PAGE_2")) return new Response(batch([item("C", 1700000000000), item("D", 1690000000000)], "TOKEN_PAGE_3"));
    if (body.includes("TOKEN_PAGE_3")) return new Response(batch([item("E", 1600000000000)]));
  }
  return new Response("no", { status: 404 });
}) as typeof fetch;

const { fetchAlbum, findPageToken, parseBatchResponse } = await import("../src/google/sharedAlbum.ts");

test("the load-more token sits right after the list of items", () => {
  assert.equal(findPageToken([null, [item("A", 1)], "TOKEN_XYZ_123", ["Lex"]]), "TOKEN_XYZ_123");
  assert.equal(findPageToken([null, [item("A", 1)], null, ["Lex"]]), undefined);
  assert.equal(parseBatchResponse(batch([item("C", 1)], "T2"), "snAcKc").length, 1);
});

test("big albums are listed in full, batch by batch", async () => {
  const p = await fetchAlbum(SHARE, { allPages: true });
  assert.deepEqual(p.items.map((i) => i.id), ["AF1QipA", "AF1QipB", "AF1QipC", "AF1QipD", "AF1QipE"]);
  assert.deepEqual(p.listing, { batches: 3, complete: true });
  assert.equal(requests.length, 2);
  assert.match(requests[0], /AF1QipAlbum123.*TOKEN_PAGE_2.*SECRETKEY/);
});

test("if Google won't give more, the first batch is still used", async () => {
  globalThis.fetch = (async (input: any) =>
    String(input).includes("batchexecute") ? new Response("denied", { status: 400 }) : new Response(page([item("A", 1)], "TOKEN_PAGE_2"))) as typeof fetch;
  const p = await fetchAlbum(SHARE, { allPages: true });
  assert.equal(p.items.length, 1);
  assert.equal(p.listing?.complete, false);
  assert.match(p.listing!.error!, /400/);
});
