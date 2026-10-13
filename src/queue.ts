import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

/** Minimal in-process work queue with bounded concurrency. */
export class Queue {
  private running = 0;
  private waiting: (() => Promise<void>)[] = [];
  constructor(private concurrency: number) {}

  push(task: () => Promise<void>) {
    this.waiting.push(task);
    this.next();
  }

  /** Run this task before anything already waiting. */
  pushFront(task: () => Promise<void>) {
    this.waiting.unshift(task);
    this.next();
  }

  get pending() {
    return this.waiting.length + this.running;
  }

  private next() {
    while (this.running < this.concurrency && this.waiting.length) {
      const task = this.waiting.shift()!;
      this.running++;
      task()
        .catch((err) => console.error("[queue]", err))
        .finally(() => {
          this.running--;
          this.next();
        });
    }
  }
}

/**
 * All heavy video work (imports and renders) shares one lane, so at most one
 * ffmpeg job decodes video at a time: decoding phone footage is memory-hungry
 * and small instances (Render Starter: 512 MB) restart when they run out.
 * Renders jump the line, so videos the creator asked for aren't stuck behind
 * a big album import. HEAVY_CONCURRENCY raises the limit on bigger machines.
 */
const heavy = new Queue(Math.max(1, Number(process.env.HEAVY_CONCURRENCY) || 1));

/**
 * Which heavy jobs are running, written to disk. If the server dies (e.g. out of
 * memory) mid-job, the next start knows exactly which clip or video caused it and
 * can mark it failed instead of retrying it forever.
 */
export interface Job {
  kind: "clip" | "render" | "example";
  id: string;
}
const RUNNING_FILE = path.join(config.dataDir, ".running-jobs.json");
const running = new Map<string, Job>();
let stopping = false;
/** Stop recording jobs (the process is shutting down). */
export function markStopping() {
  stopping = true;
}
const persist = () => {
  try {
    fs.writeFileSync(RUNNING_FILE, JSON.stringify([...running.values()]));
  } catch {}
};

/** Jobs that were running when the previous process died. Read once at startup. */
export function jobsFromLastCrash(): Job[] {
  try {
    const jobs = JSON.parse(fs.readFileSync(RUNNING_FILE, "utf8")) as Job[];
    fs.rmSync(RUNNING_FILE, { force: true });
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    return [];
  }
}

/**
 * Called on a graceful stop (a deploy): whatever is running was interrupted, it didn't crash
 * the server, so the next start should retry it rather than blame it.
 */
export function forgetRunningJobs() {
  try {
    fs.rmSync(RUNNING_FILE, { force: true });
  } catch {}
}

function tracked(task: () => Promise<void>, job?: Job) {
  if (!job) return task;
  const key = `${job.kind}:${job.id}`;
  return async () => {
    if (stopping) return;
    running.set(key, job);
    persist();
    try {
      await task();
    } finally {
      running.delete(key);
      if (!stopping) persist();
    }
  };
}

export const ingestQueue = {
  push: (task: () => Promise<void>, job?: Job) => heavy.push(tracked(task, job)),
  get pending() {
    return heavy.pending;
  },
};

export const renderQueue = {
  push: (task: () => Promise<void>, job?: Job) => heavy.pushFront(tracked(task, job)),
  get pending() {
    return heavy.pending;
  },
};
