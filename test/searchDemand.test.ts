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
});
