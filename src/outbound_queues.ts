// OutboundQueues: per-peer frame queues for the retry delivery loop.
// Only peer_link.ts touches this — it enqueues frames for delivery and
// drains them on each retry tick, re-enqueueing anything that failed.

import type { Frame } from "./proto.ts";

const OUTBOUND_QUEUE_CAP = 4096;

class OutboundQueue {
  frames: Frame[] = [];

  push(f: Frame) {
    this.frames.push(f);
    while (this.frames.length > OUTBOUND_QUEUE_CAP) this.frames.shift();
  }
  drain(): Frame[] {
    const out = this.frames;
    this.frames = [];
    return out;
  }
}

export class OutboundQueues {
  private queues: Map<string, OutboundQueue> = new Map();

  /** Add a frame to the queue for dest. Creates the queue if it doesn't exist. */
  enqueue(dest: string, frame: Frame): void {
    let q = this.queues.get(dest);
    if (!q) {
      q = new OutboundQueue();
      this.queues.set(dest, q);
    }
    q.push(frame);
  }

  /** Drain all queued frames for dest. Returns [] if dest is unknown or queue is empty. */
  drain(dest: string): Frame[] {
    return this.queues.get(dest)?.drain() ?? [];
  }

  /** All destinations that have ever had a frame enqueued (including now-empty queues). */
  destinations(): string[] {
    return [...this.queues.keys()];
  }
}
