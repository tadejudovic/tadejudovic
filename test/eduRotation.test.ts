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

test("educational themes rotate over the week: airlines, destinations, airport, prep", () => {
  add({ format: "tips", pillar: "airline", topic: "LATAM with a dog", hook: "h2" });
  assert.equal(nextPillar(), "destination");
  add({ format: "tips", pillar: "destination", topic: "flying Lex to Brazil", hook: "h1" });
  assert.equal(nextPillar(), "airport");
  assert.equal(nextPillar(new Set(["airport"])), "prep");
  // A rejected video doesn't count: its theme comes again.
  add({ format: "tips", pillar: "airport", topic: "security", hook: "h4" }, "rejected");
  assert.equal(nextPillar(), "airport");
  // Older videos' "gear" counts as prep.
  add({ format: "tips", pillar: "gear", topic: "the bag", hook: "h5" });
  assert.equal(nextPillar(), "airport");
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
  assert.match(nextQuestion(undefined, new Set(), "airport")!.q, /pee/i);
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
