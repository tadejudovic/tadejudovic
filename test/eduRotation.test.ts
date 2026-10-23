import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-edu-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { nextPillar, nextAngle, coveredTopics, nextAudience, nextQuestion } = await import("../src/generate.ts");

let n = 0;
const add = (plan: any, review = "approved") =>
  store.addRender({ id: `r${++n}`, createdAt: new Date(Date.now() + n * 1000).toISOString(), status: "done", progress: 1, review, options: {} as any, plan: { segments: [], hashtags: [], ...plan } } as any);

test("educational themes rotate like the blog: Flights, Trips, Tricks", () => {
  add({ format: "tips", pillar: "airline", topic: "LATAM with a dog", hook: "h2" });
  assert.equal(nextPillar(), "destination");
  add({ format: "tips", pillar: "destination", topic: "flying Lex to Brazil", hook: "h1" });
  assert.equal(nextPillar(), "prep");
  assert.equal(nextPillar(new Set(["prep"])), "airline");
  // A rejected video doesn't count: its theme comes again.
  add({ format: "tips", pillar: "prep", topic: "security", hook: "h4" }, "rejected");
  assert.equal(nextPillar(), "prep");
  // Older videos' "airport" and "gear" count as Tricks.
  add({ format: "tips", pillar: "airport", topic: "the gate", hook: "h5" });
  assert.equal(nextPillar(), "airline");
});

test("angles within a theme take turns", () => {
  const first = nextAngle("prep")!;
  add({ format: "tips", pillar: "prep", angle: first, topic: "a", hook: "a" });
  const second = nextAngle("prep")!;
  assert.notEqual(second, first);
  add({ format: "tips", pillar: "prep", angle: second, topic: "b", hook: "b" });
  assert.ok(![first, second].includes(nextAngle("prep")!));
});

test("topics already made are never made again (rejected ones may come back)", () => {
  add({ format: "tips", pillar: "prep", topic: "Kato backpack", hook: "h3" }, "rejected");
  const covered = coveredTopics();
  assert.ok(covered.includes("flying Lex to Brazil") && covered.includes("LATAM with a dog"));
  assert.ok(!covered.includes("Kato backpack"));
});

test("fun and inspirational are mostly for everyone, now and then for dog lovers (2 to 1)", () => {
  assert.equal(nextAudience("fun"), "everyone");
  add({ format: "fun", audience: "everyone", hook: "f" });
  assert.equal(nextAudience("fun"), "everyone");
  add({ format: "fun", audience: "everyone", hook: "f2" });
  assert.equal(nextAudience("fun"), "pets");
  add({ format: "inspire", audience: "pets", hook: "i" });
  assert.equal(nextAudience("inspire"), "everyone");
});

test("the follower question matches the theme", () => {
  assert.match(nextQuestion(undefined, new Set(), "airline")!.q, /airline/i);
  assert.match(nextQuestion(undefined, new Set(), "prep")!.q, /bag|carrier/i);
  // The airport is part of Tricks now: its questions come up there.
  assert.match(nextQuestion(undefined, new Set(["What bag / carrier do you fly with?", "How do you keep Lex stress-free when flying?"]), "prep")!.q, /pee/i);
  assert.match(nextQuestion(undefined, new Set(), "destination")!.q, /traveled|requirements/i);
});

test("footage beyond the airport is offered for the daily outside video: long enough, unused, not an edit", async () => {
  const { outsideClips } = await import("../src/generate.ts");
  const base = { source: "upload", filename: "x.mp4", file: "/x", kind: "video", importedAt: "", width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready" } as any;
  store.addClip({ ...base, id: "beach", scene: "beach", duration: 12 });
  store.addClip({ ...base, id: "tiny", scene: "beach", duration: 3 });
  store.addClip({ ...base, id: "unsorted", scene: "other", duration: 12 });
  store.addClip({ ...base, id: "gate", scene: store.settings().scenes[0], duration: 12 });
  store.addClip({ ...base, id: "edit", scene: "beach", duration: 12, edited: true });
  assert.deepEqual(outsideClips().map((c) => c.id), ["beach"]);
});

test("broad and deep take turns, and deep trips use routes Lex actually traveled", async () => {
  const { nextDepth, travelRoutes } = await import("../src/generate.ts");
  add({ format: "tips", pillar: "destination", depth: "broad", hook: "Europe" });
  assert.equal(nextDepth(), "deep");
  add({ format: "tips", pillar: "airline", depth: "deep", hook: "Lufthansa" });
  assert.equal(nextDepth(), "broad");
  const c = (id: string, at: string, place: string) =>
    store.addClip({ id, source: "upload", filename: "x", file: "/x", kind: "video", importedAt: at, capturedAt: at, duration: 8, width: 1080, height: 1920, hasAudio: false, uses: 0, status: "ready", place } as any);
  c("t1", "2026-08-01T10:00:00Z", "Mexico City, Mexico");
  c("t2", "2026-08-03T10:00:00Z", "Cancún, Mexico");
  c("t3", "2026-09-01T10:00:00Z", "Toronto, Ontario, Canada");
  c("t4", "2026-10-01T10:00:00Z", "Lisbon, Portugal");
  assert.deepEqual(travelRoutes(), ["Canada → Portugal", "Mexico → Canada"]);
  add({ format: "tips", pillar: "destination", depth: "deep", route: "Canada → Portugal", hook: "CA-PT" });
  assert.deepEqual(travelRoutes(), ["Mexico → Canada", "Canada → Portugal"]);
});
