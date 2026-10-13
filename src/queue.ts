/** Minimal in-process work queue with bounded concurrency. */
export class Queue {
  private running = 0;
  private waiting: (() => Promise<void>)[] = [];
  constructor(private concurrency: number) {}

  push(task: () => Promise<void>) {
    this.waiting.push(task);
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

/** Ingest: download + analysis. Render: ffmpeg encodes are CPU-heavy, so one at a time. */
// One import at a time by default: decoding phone video is memory-hungry on small instances.
export const ingestQueue = new Queue(Math.max(1, Number(process.env.INGEST_CONCURRENCY) || 1));
export const renderQueue = new Queue(1);
