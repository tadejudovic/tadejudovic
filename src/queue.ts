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

export const ingestQueue = {
  push: (task: () => Promise<void>) => heavy.push(task),
  get pending() {
    return heavy.pending;
  },
};

export const renderQueue = {
  push: (task: () => Promise<void>) => heavy.pushFront(task),
  get pending() {
    return heavy.pending;
  },
};
