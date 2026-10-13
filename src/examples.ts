import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { store, newId } from "./store.ts";
import { probe, frameAt } from "./media/ffmpeg.ts";
import { analyzeExample } from "./ai/director.ts";
import { ingestQueue } from "./queue.ts";
import type { Example } from "./types.ts";

const dir = path.join(config.dataDir, "examples");
fs.mkdirSync(dir, { recursive: true });

/**
 * Reference videos that performed well. Claude reads their on-screen text and
 * structure once; the write-up is then given to the director as a style guide.
 */
export function addExample(opts: {
  tmpFile?: string;
  filename?: string;
  note?: string;
  overlayText?: string;
  views?: number;
}): Example {
  const id = newId();
  let file: string | undefined;
  if (opts.tmpFile) {
    file = path.join(dir, `${id}${path.extname(opts.filename ?? "").toLowerCase() || ".mp4"}`);
    fs.renameSync(opts.tmpFile, file);
  }
  const ex = store.addExample({
    id,
    addedAt: new Date().toISOString(),
    filename: opts.filename,
    file,
    note: opts.note,
    overlayText: opts.overlayText,
    views: opts.views,
    status: file ? "analyzing" : "ready",
  });
  if (file) ingestQueue.push(() => analyze(id), { kind: "example", id });
  return ex;
}

async function analyze(id: string) {
  const ex = store.example(id);
  if (!ex?.file) return;
  try {
    const info = await probe(ex.file);
    const thumb = path.join(dir, `${id}.jpg`);
    await frameAt(ex.file, Math.min(1, info.duration / 2), thumb);
    store.updateExample(id, { duration: info.duration, thumb });
    if (config.claude.enabled) {
      store.updateExample(id, { analysis: await analyzeExample(ex.file, info.duration, ex.note) });
    }
    store.updateExample(id, { status: "ready", error: undefined });
  } catch (err) {
    store.updateExample(id, { status: "error", error: (err as Error).message });
  }
}

export function reanalyzeExample(id: string) {
  store.updateExample(id, { status: "analyzing" });
  ingestQueue.push(() => analyze(id), { kind: "example", id });
}

export function deleteExample(id: string) {
  const ex = store.example(id);
  for (const f of [ex?.file, ex?.thumb]) if (f) fs.rmSync(f, { force: true });
  store.removeExample(id);
}
