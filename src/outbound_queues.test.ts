import { describe, it, expect } from "bun:test";
import { OutboundQueues } from "./outbound_queues.ts";
import type { Frame } from "./proto.ts";

// ---------- fixtures ----------

function makeFrame(payload: number): Frame {
  return {
    version: 1,
    sender: "alice",
    dest: "bob",
    signature: new Uint8Array(64),
    payload: new Uint8Array([payload]),
  };
}

// ---------- enqueue / drain ----------

describe("OutboundQueues.drain()", () => {
  it("returns [] for an unknown destination", () => {
    const q = new OutboundQueues();
    expect(q.drain("unknown")).toEqual([]);
  });

  it("returns [] for a destination whose queue is empty", () => {
    const q = new OutboundQueues();
    q.enqueue("bob", makeFrame(1));
    q.drain("bob"); // empty it
    expect(q.drain("bob")).toEqual([]);
  });

  it("returns enqueued frames in insertion order", () => {
    const q = new OutboundQueues();
    const f1 = makeFrame(1);
    const f2 = makeFrame(2);
    const f3 = makeFrame(3);
    q.enqueue("bob", f1);
    q.enqueue("bob", f2);
    q.enqueue("bob", f3);
    expect(q.drain("bob")).toEqual([f1, f2, f3]);
  });

  it("drain() empties the queue", () => {
    const q = new OutboundQueues();
    q.enqueue("bob", makeFrame(1));
    q.drain("bob");
    expect(q.drain("bob")).toEqual([]);
  });

  it("queues for different destinations are independent", () => {
    const q = new OutboundQueues();
    const f1 = makeFrame(1);
    const f2 = makeFrame(2);
    q.enqueue("bob", f1);
    q.enqueue("carol", f2);
    expect(q.drain("bob")).toEqual([f1]);
    expect(q.drain("carol")).toEqual([f2]);
  });

  it("draining one destination does not affect another", () => {
    const q = new OutboundQueues();
    q.enqueue("bob", makeFrame(1));
    q.enqueue("carol", makeFrame(2));
    q.drain("bob");
    expect(q.drain("carol")).toHaveLength(1);
  });
});

describe("OutboundQueues.enqueue()", () => {
  it("creates a queue on first enqueue for a destination", () => {
    const q = new OutboundQueues();
    q.enqueue("bob", makeFrame(1));
    expect(q.drain("bob")).toHaveLength(1);
  });

  it("appends to an existing queue", () => {
    const q = new OutboundQueues();
    q.enqueue("bob", makeFrame(1));
    q.enqueue("bob", makeFrame(2));
    expect(q.drain("bob")).toHaveLength(2);
  });

  it("enqueue after drain re-fills the queue", () => {
    const q = new OutboundQueues();
    q.enqueue("bob", makeFrame(1));
    q.drain("bob");
    q.enqueue("bob", makeFrame(2));
    expect(q.drain("bob")).toHaveLength(1);
  });

  it("respects the 4096 frame cap by dropping the oldest", () => {
    const q = new OutboundQueues();
    for (let i = 0; i < 4097; i++) {
      q.enqueue("bob", makeFrame(i % 256));
    }
    const frames = q.drain("bob");
    expect(frames).toHaveLength(4096);
    // i=0 is dropped; i=1 becomes the oldest remaining
    expect(frames[0].payload[0]).toBe(1);
  });
});

// ---------- destinations ----------

describe("OutboundQueues.destinations()", () => {
  it("returns [] when no frames have been enqueued", () => {
    const q = new OutboundQueues();
    expect(q.destinations()).toEqual([]);
  });

  it("includes a destination after enqueue", () => {
    const q = new OutboundQueues();
    q.enqueue("bob", makeFrame(1));
    expect(q.destinations()).toContain("bob");
  });

  it("includes a destination even after its queue is drained", () => {
    const q = new OutboundQueues();
    q.enqueue("bob", makeFrame(1));
    q.drain("bob");
    expect(q.destinations()).toContain("bob");
  });

  it("includes all destinations that have ever had frames enqueued", () => {
    const q = new OutboundQueues();
    q.enqueue("bob", makeFrame(1));
    q.enqueue("carol", makeFrame(2));
    const dests = q.destinations().sort();
    expect(dests).toEqual(["bob", "carol"]);
  });
});
