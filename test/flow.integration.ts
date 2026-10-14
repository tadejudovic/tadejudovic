// Offline end-to-end check of the daily flow: watch album → import videos → daily batch → renders.
// Run with: DATA_DIR=/tmp/x FOOTAGE_DIR=/path/with/portrait.mp4+landscape.mov npx tsx test/flow.integration.ts
import fs from "node:fs";
import path from "node:path";

const footage = process.env.FOOTAGE_DIR!;
const html = fs.readFileSync(new URL("./fixtures/album.html", import.meta.url), "utf8");
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (url.startsWith("https://photos.app.goo.gl/")) return new Response(html, { headers: { "content-type": "text/html" } });
  const serve = (f: string, type = "video/mp4") => new Response(fs.readFileSync(path.join(footage, f)), { headers: { "content-type": type } });
  if (url.endsWith("VIDEO1=dv")) return serve("portrait.mp4");
  // A vague content type: detected by sniffing the file header.
  if (url.endsWith("VIDEO3=dv")) return serve("portrait2.mp4", "application/octet-stream");
  if (url.includes("PHOTO2=")) return new Response("jpeg", { headers: { "content-type": "image/jpeg" } });
  if (url.includes("googleusercontent.com")) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
  return realFetch(input, init);
}) as typeof fetch;

const { store } = await import("../src/store.ts");
const { addAlbum, syncAlbum } = await import("../src/albums.ts");
const { runDailyBatch } = await import("../src/scheduler.ts");
const { ingestQueue, renderQueue } = await import("../src/queue.ts");
const wait = async (q: { pending: number }) => { while (q.pending) await new Promise((r) => setTimeout(r, 500)); };

const album = addAlbum("https://photos.app.goo.gl/TestAlbum123", 0);
console.log("first sync:", await syncAlbum(album.id));
await wait(ingestQueue);
console.log("clips:", store.clips().map((c) => [c.source, c.status, c.duration, c.capturedAt]));
console.log("album:", (({ seen, ...a }) => ({ ...a, seen: seen.length }))(store.album(album.id)!));
if (store.album(album.id)!.videoCount !== 2) throw new Error("expected 2 videos imported");
console.log("second sync:", await syncAlbum(album.id));

store.updateAuto({ dailyCount: 3, template: "auto", targetSeconds: 10 });
const batch = await runDailyBatch();
console.log("batch:", batch.warning ?? "", batch.renders.map((r) => r.plan.hook));
await wait(renderQueue);
for (const r of store.renders()) console.log("render:", r.status, r.batch, r.review, r.duration?.toFixed(1), r.error ?? "", r.plan.segments.length);
console.log("again same day:", (await runDailyBatch()).skipped);
process.exit(0);
