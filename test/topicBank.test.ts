import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-topics-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { pickTopic, topicBankStale, sourcesText, FLYWITH_ROUTES } = await import("../src/topicBank.ts");

const idea = (id: string, over: any = {}) => ({ id, title: id, kind: "fun", audience: "owners", specificity: "broad", sources: ["tiktok search"], demand: 3, clipIds: [], ...over });
const clip = (id: string, scene: string) =>
  store.addClip({ id, source: "upload", filename: id, file: "/x", kind: "video", importedAt: "2026-10-01T00:00:00Z", duration: 8, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready", scene, ai: { summary: `Lex at the ${scene}`, tags: [], moments: [] } } as any);
const used = (id: string, ideaId: string, audience: string, daysAgo = 1) =>
  store.addRender({ id, createdAt: new Date(Date.now() - daysAgo * 86400_000).toISOString(), status: "done", progress: 1, review: "pending", options: {} as any,
    plan: { format: "fun", hook: "x", segments: [], topicIdea: { id: ideaId, title: ideaId, audience, specificity: "broad", sources: [] } } } as any);

test("the idea that fits the clip wins, and an idea isn't reused for 45 days", () => {
  clip("k1", "airport terminal");
  store.updateSettings({ topicBank: { at: new Date().toISOString(), ideas: [idea("big", { demand: 5 }), idea("fits", { demand: 2, clipIds: ["k1"] }), idea("edu", { kind: "tips", pillar: "airline" })] } } as any);
  assert.equal(pickTopic("fun", store.clip("k1"))!.id, "fits", "footage first: the clip's own idea");
  assert.equal(pickTopic("fun", undefined)!.id, "big", "otherwise the most wanted");
  assert.equal(pickTopic("tips", undefined)!.id, "edu", "only ideas of the video's kind");
  used("r1", "big", "owners");
  assert.notEqual(pickTopic("fun", undefined)!.id, "big", "used lately: not again");
  assert.equal(pickTopic("fun", undefined, new Set(["fits", "big"]))?.id, undefined, "nothing left of this kind");
});

test("audiences are kept in balance: the one furthest behind its share comes next", () => {
  store.updateSettings({ topicBank: { at: new Date().toISOString(), ideas: [idea("o", { audience: "owners", demand: 4 }), idea("c", { audience: "considering", demand: 3 }), idea("e", { audience: "everyone", demand: 3 })] } } as any);
  for (let i = 0; i < 4; i++) used(`ro${i}`, `old-o${i}`, "owners", 2);
  used("re", "old-e", "everyone", 2);
  assert.equal(pickTopic("fun", undefined)!.audience, "considering");
});

test("the research reads every source, and a new search export makes the bank stale", () => {
  const text = sourcesText();
  for (const label of ["TIKTOK", "GOOGLE", "WHAT PEOPLE TYPE", "FOLLOWERS", "COMMENTS", "FLYWITH.PET", "TRENDING NOW", "FOOTAGE ON HAND", "ALREADY COVERED"]) assert.ok(text.includes(label), label);
  assert.ok(text.includes(FLYWITH_ROUTES[0].route));
  store.updateSettings({ topicBank: { at: new Date().toISOString(), ideas: [] } } as any);
  assert.equal(topicBankStale(), false);
  store.updateSettings({ keywordTopicsAt: new Date(Date.now() + 1000).toISOString() } as any);
  assert.equal(topicBankStale(), true);
});

test("the toothbrush test: an everyday problem for many beats a rare one with the same demand", () => {
  store.updateSettings({ topicBank: { at: new Date().toISOString(), ideas: [
    idea("rare", { kind: "inspire", demand: 4, reach: 2, frequency: 1 }),
    idea("daily", { kind: "inspire", demand: 4, reach: 5, frequency: 5 }),
  ] } } as any);
  assert.equal(pickTopic("inspire", undefined)!.id, "daily");
});

test("the research's answer format uses nothing the API refuses (no minimum/maximum on numbers)", async () => {
  const { SCHEMA } = await import("../src/topicBank.ts");
  const text = JSON.stringify(SCHEMA);
  assert.ok(!/"minimum"|"maximum"/.test(text));
});

test("an idea's evidence only counts when it's really in the data; made-up figures are dropped", async () => {
  const { verifyEvidence } = await import("../src/topicBank.ts");
  const sections = [
    { name: "trending posts", title: "", lines: ['[security check] "Service dog vs TSA": 18,400,000 views (https://tiktok.com/x)'] },
    { name: "flywith routes", title: "", lines: ["tier 1: US → UK: post-Brexit rules confuse people constantly"] },
  ];
  const ok = verifyEvidence(['"Service dog vs TSA": 18,400,000 views', "tier 1: US → UK: post-Brexit rules"], sections);
  assert.deepEqual(ok.map((e) => e.source), ["trending posts", "flywith routes"]);
  assert.match(ok[0].line, /tiktok\.com/, "the whole line, with its link");
  assert.equal(verifyEvidence(["Service dog vs TSA got 50M views last week"], sections).length, 0, "not in the data: dropped");
});
