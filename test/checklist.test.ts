import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tipWheelFilters, tipText } from "../src/media/render.ts";
import { config } from "../src/config.ts";

test("a tip's number or label is taken off its text", () => {
  assert.equal(tipText("1. Weigh the bag"), "Weigh the bag");
  assert.equal(tipText("#2 Book early"), "Book early");
  assert.equal(tipText("Step 3: Pack light"), "Pack light");
  assert.equal(tipText("Pack light"), "Pack light");
});

test("the tip wheel: one yellow band for the whole list, turning to each tip as it starts", () => {
  if (!fs.existsSync(config.fontFile ?? "")) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-"));
  const rows = [
    { text: "Weigh dog and bag", start: 1, end: 4 },
    { text: "Under 8 kg total", start: 4, end: 7 },
    { text: "Light carrier", start: 7, end: 10 },
  ];
  const c = tipWheelFilters(rows, { top: 900, size: 50, font: config.fontFile!, tmp, listEnd: 10 });
  const bands = c.filters.filter((f) => f.startsWith("drawbox") && f.includes("0xF5C400"));
  assert.equal(bands.length, 1);
  assert.ok(bands[0].includes("between(t,1.00,10.00)"));
  // The wheel turns at the second and third tips' starts, not before the first.
  const y = c.filters.find((f) => f.includes("y='") && f.includes("alpha="))!;
  assert.ok(y.includes("(t-4.00)") && y.includes("(t-7.00)") && !y.includes("(t-1.00)"));
  // Each tip: big in the band, small beside it.
  assert.equal(c.filters.filter((f) => f.includes("fontcolor=white")).length, 3);
});
