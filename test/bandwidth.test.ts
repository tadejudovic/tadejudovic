import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-bw-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { countResponses, bytesThisMonth, playbackPaused, mediaStopped, flushBandwidth } = await import("../src/bandwidth.ts");
const { localDate } = await import("../src/dailyLimit.ts");

test("counts what's sent; playback pauses at 90% of 5 GB, everything stops at 98%", () => {
  const res: any = { write: () => true, end: () => res };
  countResponses({} as any, res, () => {});
  res.write(Buffer.alloc(1000));
  res.end("héllo");
  assert.equal(bytesThisMonth(), 1006);
  flushBandwidth();
  assert.equal(bytesThisMonth(), 1006);
  const month = localDate(new Date()).slice(0, 7);
  store.updateSettings({ bandwidth: { month, bytes: 4.4e9 } } as any);
  assert.equal(playbackPaused(), false);
  store.updateSettings({ bandwidth: { month, bytes: 4.6e9 } } as any);
  assert.ok(playbackPaused() && !mediaStopped());
  store.updateSettings({ bandwidth: { month, bytes: 4.95e9 } } as any);
  assert.ok(mediaStopped());
  // A new month starts from zero.
  store.updateSettings({ bandwidth: { month: "2000-01", bytes: 4.95e9 } } as any);
  assert.equal(bytesThisMonth(), 0);
});
