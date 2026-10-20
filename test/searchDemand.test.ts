import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-search-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { readQueries, searchTopicsFor } = await import("../src/searchDemand.ts");

const CSV = 'Top queries,Clicks,Impressions,CTR,Position\nkato dog backpack,4,33,12.12%,5.85\neasyjet pet policy,0,61,0%,10.51\n"""poodle"" ""in my books""",0,29,0%,8.14\nsite:tiktok.com travel,0,12,0%,2.33\n';

test("reads TikTok's search export from the zip or the csv", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "search-"));
  fs.writeFileSync(path.join(dir, "Queries.csv"), CSV);
  fs.writeFileSync(path.join(dir, "Posts.csv"), "Top posts,Clicks\n");
  const zip = path.join(dir, "export.zip");
  execFileSync("python3", ["-c", `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED);[z.write(sys.argv[2]+'/'+n,n) for n in ['Queries.csv','Posts.csv']];z.close()`, zip, dir]);
  const fromZip = readQueries(fs.readFileSync(zip), "export.zip");
  assert.deepEqual(fromZip.map((q) => q.query), ["kato dog backpack", "easyjet pet policy", '"poodle" "in my books"']);
  assert.equal(fromZip[1].impressions, 61);
  assert.deepEqual(readQueries(Buffer.from(CSV), "Queries.csv"), fromZip);
});

test("reads Google Ads Keyword Planner's export (UTF-16, tab-separated, title lines on top)", async () => {
  const { readExport } = await import("../src/searchDemand.ts");
  const tsv =
    "Keyword Stats 2026-10-19 at 01_45_32\n1 October 2025 - 30 September 2026\n" +
    "Keyword\tCurrency\tAvg. monthly searches\t3-month change\n" +
    "flying with a dog\tEUR\t14800\t0%\npet carriers for cats\tEUR\t110000\t0%\n";
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(tsv, "utf16le")]);
  const r = readExport(buf, "Keyword_Stats.csv");
  assert.equal(r.source, "google");
  assert.deepEqual(r.queries.map((q) => [q.query, q.impressions]), [["flying with a dog", 14800], ["pet carriers for cats", 110000]]);
});

test("Keyword Planner exports add up, newest numbers winning", async () => {
  const { mergeQueries } = await import("../src/searchDemand.ts");
  const merged = mergeQueries(
    [{ query: "flying with a dog", clicks: 0, impressions: 14800 }, { query: "dog carrier", clicks: 0, impressions: 33100 }],
    [{ query: "Flying with a dog", clicks: 0, impressions: 12100 }, { query: "cost to fly a dog", clicks: 0, impressions: 880 }],
  );
  assert.deepEqual(merged.map((q) => [q.query, q.impressions]), [["Flying with a dog", 12100], ["dog carrier", 33100], ["cost to fly a dog", 880]]);
});

test("each theme offers its most-searched topics that weren't covered yet", () => {
  store.updateSettings({
    searchTopics: [
      { topic: "easyJet pet policy", key: "easyJet", pillar: "airline", queries: ["easyjet pet policy"], impressions: 500, clicks: 0 },
      { topic: "Vueling pet policy", key: "Vueling", pillar: "airline", queries: ["vueling pet policy"], impressions: 200, clicks: 0 },
      { topic: "Kato dog backpack", key: "Kato", pillar: "prep", queries: ["kato dog backpack"], impressions: 33, clicks: 4 },
    ],
  } as any);
  assert.deepEqual(searchTopicsFor("airline").map((t) => t.topic), ["easyJet pet policy", "Vueling pet policy"]);
  store.addRender({ id: "e1", createdAt: new Date().toISOString(), status: "done", progress: 1, review: "pending", options: {} as any, plan: { format: "tips", pillar: "airline", topic: "Can your dog fly easyJet?", hook: "h", segments: [], hashtags: [] } } as any);
  assert.deepEqual(searchTopicsFor("airline").map((t) => t.topic), ["Vueling pet policy"]);
  // Every other video of a theme: after one built on a search, the next one isn't.
  store.addRender({ id: "e2", createdAt: new Date(Date.now() + 1000).toISOString(), status: "done", progress: 1, review: "pending", options: {} as any, plan: { format: "tips", pillar: "airline", topic: "x", searchTopic: "Vueling pet policy", hook: "h", segments: [], hashtags: [] } } as any);
  assert.deepEqual(searchTopicsFor("airline"), []);
  assert.deepEqual(searchTopicsFor("gear").map((t) => t.topic), ["Kato dog backpack"]);
  // With Google topics too, the two sources take turns.
  store.updateSettings({ keywordTopics: [{ topic: "Airline-approved dog carrier", key: "airline approved", pillar: "prep", queries: ["airline approved dog carrier"], impressions: 9900, clicks: 0, source: "google" }] } as any);
  assert.deepEqual(searchTopicsFor("prep").map((t) => t.topic), ["Kato dog backpack", "Airline-approved dog carrier"]);
});

test("Instagram post links lose their tracking parameters", async () => {
  const { cleanPostUrl } = await import("../src/postMatch.ts");
  assert.equal(cleanPostUrl("https://www.instagram.com/reel/Def6HCLR_aQ/?rpxt=MWF1dDVxaDNmMDRsbw=="), "https://www.instagram.com/reel/Def6HCLR_aQ/");
  assert.equal(cleanPostUrl("https://www.instagram.com/reel/DerVsbCxe6R?mdxt=x"), "https://www.instagram.com/reel/DerVsbCxe6R/");
});
