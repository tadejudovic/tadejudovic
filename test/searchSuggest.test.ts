import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-suggest-${process.pid}-${Date.now()}`);
const { collectSuggestions } = await import("../src/searchSuggest.ts");

test("autocomplete suggestions are scored by how high and how often they're offered", async () => {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const q = new URL(url).searchParams.get("q")!;
    asked.push(q);
    return new Response(JSON.stringify([q, ["can my dog fly in cabin", `${q} rules`]]), { headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const out = await collectSuggestions(["dog on a plane"]);
    const top = out.sort((a, b) => b.impressions - a.impressions)[0];
    assert.equal(top.query, "can my dog fly in cabin");
    assert.equal(top.impressions, 10 * asked.length);
    assert.ok(asked.includes("how to dog on a plane"));
  } finally {
    globalThis.fetch = real;
  }
});
