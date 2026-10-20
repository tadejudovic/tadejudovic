import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-rounds-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { runDailyBatch } = await import("../src/scheduler.ts");
const { kindsToMake, daySetDone } = await import("../src/daySet.ts");

const now = () => new Date().toISOString();
const add = (id: string, format: string, review: "pending" | "approved" | "rejected", extra: object = {}) =>
  store.addRender({ id, createdAt: now(), reviewedAt: review === "pending" ? undefined : now(), status: "done", progress: 1, review, options: {} as any, plan: { segments: [], format } as any, ...extra } as any);

test("the day runs until one of each kind is kept: each kind not kept has one waiting", async () => {
  store.updateSettings({ dailyMix: { fun: 1, educational: 1, inspirational: 1 } } as any);
  assert.deepEqual(kindsToMake(), ["tips", "fun", "inspire"]);
  add("t1", "tips", "pending");
  add("f1", "fun", "pending");
  assert.deepEqual(kindsToMake(), ["inspire"]);
  // Kept: that kind is done for the day.
  store.updateRender("t1", { review: "approved", reviewedAt: now() });
  assert.deepEqual(kindsToMake(), ["inspire"]);
  // Rejected without a reason: another of its kind, after a minute (a reason may still come).
  store.updateRender("f1", { review: "rejected", reviewedAt: now() });
  assert.deepEqual(kindsToMake(), ["inspire"]);
  assert.deepEqual(kindsToMake(Date.now() + 61_000), ["fun", "inspire"]);
  // Rejected with a reason: its remake is on the way, so nothing else of the kind.
  add("f2", "fun", "rejected", { rejectReason: "text", remadeAs: "pending" });
  assert.deepEqual(kindsToMake(Date.now() + 61_000), ["inspire"]);
  // A story made on request doesn't count as any kind.
  add("s1", "story", "approved");
  add("i1", "inspire", "approved");
  add("f3", "fun", "approved");
  assert.ok(daySetDone());
  assert.deepEqual(await runDailyBatch(), { renders: [], skipped: "today's set is done" });
});

test("recent footage first: a situation with only old clips waits behind one filmed lately", async () => {
  const { pickBySituation } = await import("../src/generate.ts");
  const scenes = store.settings().scenes;
  const clip = (id: string, scene: string, capturedAt: string) =>
    store.addClip({ id, source: "upload", filename: "x.mp4", file: "/x", kind: "video", importedAt: "", capturedAt, duration: 8, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready", scene } as any);
  const oldOne = clip("old", scenes[0], "2026-03-05T10:00:00Z");
  const newOne = clip("new", scenes[1], "2026-10-12T10:00:00Z");
  assert.deepEqual(pickBySituation([oldOne, newOne], 1).map((c) => c.id), ["new"]);
});

test("each kind not kept has a spare on standby; a rejection brings it in at once", async () => {
  const { toMake, promoteSpares, waitingOf, sparesOf } = await import("../src/daySet.ts");
  // A fresh day for this test: everything before counts as yesterday. Spares switched on (Labs).
  store.updateSettings({ countFrom: new Date().toISOString(), features: { spares: true } } as any);
  for (const r of store.renders()) store.updateRender(r.id, { review: "rejected", rejectReason: "text", remadeAs: undefined, reviewedAt: "2020-01-01T00:00:00Z" } as any);
  assert.deepEqual(toMake().map((x) => `${x.kind}${x.standby ? "+" : ""}`), ["tips", "fun", "inspire"]);
  add("vt", "tips", "pending");
  // The one for Review is there: next comes its spare.
  assert.deepEqual(toMake().find((x) => x.kind === "tips"), { kind: "tips", standby: true });
  add("st", "tips", "pending", { standby: true });
  assert.equal(toMake().find((x) => x.kind === "tips"), undefined);
  assert.equal(waitingOf("tips"), 1);
  assert.equal(sparesOf("tips").length, 1);
  // Rejected (with a reason): the spare steps in straight away.
  store.updateRender("vt", { review: "rejected", rejectReason: "text", reviewedAt: new Date().toISOString() });
  assert.equal(promoteSpares(), 1);
  assert.equal(store.render("st")!.standby, false);
  assert.equal(waitingOf("tips"), 1);
  // ...and a new spare is made in the background.
  assert.deepEqual(toMake().find((x) => x.kind === "tips"), { kind: "tips", standby: true });
  // Kept: no more for that kind today, spares included.
  store.updateRender("st", { review: "approved", reviewedAt: new Date().toISOString() });
  assert.equal(toMake().find((x) => x.kind === "tips"), undefined);
});

test("the heavy lane runs the videos for Review first, then spares, previews, imports", async () => {
  const { Queue } = await import("../src/queue.ts");
  const q = new Queue(1);
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  q.push(() => gate.then(() => void order.push("running import")), 3);
  for (const [name, p] of [["import", 3], ["preview", 2], ["spare", 1], ["video", 0], ["video 2", 0]] as const)
    q.push(async () => void order.push(name), p);
  release();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(order, ["running import", "video", "video 2", "spare", "preview", "import"]);
});

test("spares are off unless switched on in Labs", async () => {
  const { toMake } = await import("../src/daySet.ts");
  store.updateSettings({ features: {}, countFrom: new Date(Date.now() + 1000).toISOString() } as any);
  add("only", "inspire", "pending");
  assert.equal(toMake().find((x) => x.kind === "inspire"), undefined);
});

test("a remake cut off by a restart doesn't block its kind for good", () => {
  const ids = store.renders().map((r: any) => r.id);
  for (const id of ids) store.removeRender(id);
  const old = new Date(Date.now() - 20 * 60_000).toISOString();
  store.addRender({ id: "stuck", createdAt: old, reviewedAt: old, status: "done", progress: 1, review: "rejected", remadeAs: "pending", rejectReason: "edit", options: {} as any, plan: { segments: [], format: "tips" } as any } as any);
  assert.ok(kindsToMake().includes("tips"));
  store.addRender({ id: "writing", createdAt: now(), reviewedAt: now(), status: "done", progress: 1, review: "rejected", remadeAs: "pending", rejectReason: "edit", options: {} as any, plan: { segments: [], format: "fun" } as any } as any);
  assert.ok(!kindsToMake().includes("fun"));
});
