import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checklistFilters, tipText } from "../src/media/render.ts";
import { config } from "../src/config.ts";

test("a tip's number or label is taken off its text", () => {
  assert.equal(tipText("1. Weigh the bag"), "Weigh the bag");
  assert.equal(tipText("#2 Book early"), "Book early");
  assert.equal(tipText("Step 3: Pack light"), "Pack light");
  assert.equal(tipText("Pack light"), "Pack light");
});

test("the checklist: the tip being read is yellow, read ones are ticked, the next ones show their number", () => {
  if (!fs.existsSync(config.fontFile ?? "")) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-"));
  const rows = [
    { text: "Weigh dog and bag", start: 1, end: 4 },
    { text: "Under 8 kg total", start: 4, end: 7 },
    { text: "Light carrier", start: 7, end: 10 },
  ];
  const c = checklistFilters(rows, { top: 900, size: 50, font: config.fontFile!, tmp, listEnd: 10 });
  const yellowRows = c.filters.filter((f) => f.startsWith("drawbox") && f.includes("0xF5C400@1") && /w=\d{3,}/.test(f));
  assert.ok(yellowRows.some((f) => f.includes("between(t,1.00,4.00)")));
  // The first two are ticked once read, until the list goes; the last one is never "read".
  assert.deepEqual(c.ticks.map((t) => [t.start, t.end]), [[4, 10], [7, 10]]);
  // The second and third show only their number until their turn.
  assert.ok(c.filters.some((f) => f.includes("color=white@0.9") && f.includes("between(t,1.00,4.00)")));
  assert.ok(c.filters.some((f) => f.includes("color=white@0.9") && f.includes("between(t,1.00,7.00)")));
  assert.ok(c.height > 3 * 50);
});
