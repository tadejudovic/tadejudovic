import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-edu-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { nextPillar, coveredTopics, nextAudience, nextQuestion } = await import("../src/generate.ts");

let n = 0;
const add = (plan: any, review = "approved") =>
  store.addRender({ id: `r${++n}`, createdAt: new Date(Date.now() + n * 1000).toISOString(), status: "done", progress: 1, review, options: {} as any, plan: { segments: [], hashtags: [], ...plan } } as any);

test("educational themes rotate: destinations, airlines, gear", () => {
  add({ format: "tips", pillar: "destination", topic: "flying Lex to Brazil", hook: "h1" });
  assert.equal(nextPillar(), "airline");
  add({ format: "tips", pillar: "airline", topic: "LATAM with a dog", hook: "h2" });
  assert.equal(nextPillar(), "gear");
  assert.equal(nextPillar(new Set(["gear"])), "destination");
});

test("topics already made are never made again (rejected ones may come back)", () => {
  add({ format: "tips", pillar: "gear", topic: "Kato backpack", hook: "h3" }, "rejected");
  const covered = coveredTopics();
  assert.ok(covered.includes("flying Lex to Brazil") && covered.includes("LATAM with a dog"));
  assert.ok(!covered.includes("Kato backpack"));
});

test("fun and inspirational take turns between dog lovers and everyone", () => {
  assert.equal(nextAudience("fun"), "everyone");
  add({ format: "fun", audience: "everyone", hook: "f" });
  assert.equal(nextAudience("fun"), "pets");
  add({ format: "inspire", audience: "pets", hook: "i" });
  assert.equal(nextAudience("inspire"), "everyone");
});

test("the follower question matches the theme", () => {
  assert.match(nextQuestion(undefined, new Set(), "airline")!.q, /airline/i);
  assert.match(nextQuestion(undefined, new Set(), "gear")!.q, /bag|carrier/i);
});
