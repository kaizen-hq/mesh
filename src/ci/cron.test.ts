import { describe, it, expect } from "bun:test";
import {
  parseCron,
  nextSlot,
  slotKey,
  electWinner,
  type CronExpr,
} from "./cron.ts";

// ---------- parseCron ----------

describe("parseCron - standard fields", () => {
  it("parses wildcard for all fields", () => {
    const e = parseCron("* * * * *");
    expect(e.minute).toEqual({ type: "any" });
    expect(e.hour).toEqual({ type: "any" });
    expect(e.dom).toEqual({ type: "any" });
    expect(e.month).toEqual({ type: "any" });
    expect(e.dow).toEqual({ type: "any" });
  });

  it("parses specific values", () => {
    const e = parseCron("0 2 1 6 3");
    expect(e.minute).toEqual({ type: "value", v: 0 });
    expect(e.hour).toEqual({ type: "value", v: 2 });
    expect(e.dom).toEqual({ type: "value", v: 1 });
    expect(e.month).toEqual({ type: "value", v: 6 });
    expect(e.dow).toEqual({ type: "value", v: 3 });
  });

  it("parses ranges", () => {
    const e = parseCron("1-5 * * * *");
    expect(e.minute).toEqual({ type: "range", from: 1, to: 5 });
  });

  it("parses step on wildcard", () => {
    const e = parseCron("*/15 * * * *");
    expect(e.minute).toEqual({ type: "step", from: 0, to: 59, step: 15 });
  });

  it("parses step on range", () => {
    const e = parseCron("0-30/5 * * * *");
    expect(e.minute).toEqual({ type: "step", from: 0, to: 30, step: 5 });
  });

  it("parses lists of values", () => {
    const e = parseCron("0,15,30,45 * * * *");
    expect(e.minute).toEqual({ type: "list", values: [0, 15, 30, 45] });
  });

  it("rejects too few fields", () => {
    expect(() => parseCron("* * * *")).toThrow();
  });

  it("rejects too many fields", () => {
    expect(() => parseCron("* * * * * *")).toThrow();
  });

  it("rejects values out of range for minute", () => {
    expect(() => parseCron("60 * * * *")).toThrow();
  });

  it("rejects values out of range for hour", () => {
    expect(() => parseCron("* 24 * * *")).toThrow();
  });
});

describe("parseCron - aliases", () => {
  it("parses @hourly", () => {
    const e = parseCron("@hourly");
    expect(e.minute).toEqual({ type: "value", v: 0 });
    expect(e.hour).toEqual({ type: "any" });
  });

  it("parses @daily", () => {
    const e = parseCron("@daily");
    expect(e.minute).toEqual({ type: "value", v: 0 });
    expect(e.hour).toEqual({ type: "value", v: 0 });
  });

  it("parses @weekly", () => {
    const e = parseCron("@weekly");
    expect(e.minute).toEqual({ type: "value", v: 0 });
    expect(e.hour).toEqual({ type: "value", v: 0 });
    expect(e.dow).toEqual({ type: "value", v: 0 });
  });

  it("parses @monthly", () => {
    const e = parseCron("@monthly");
    expect(e.minute).toEqual({ type: "value", v: 0 });
    expect(e.hour).toEqual({ type: "value", v: 0 });
    expect(e.dom).toEqual({ type: "value", v: 1 });
  });

  it("rejects unknown aliases", () => {
    expect(() => parseCron("@yearly")).toThrow();
  });
});

// ---------- nextSlot ----------

describe("nextSlot", () => {
  it("returns current minute if cron matches now", () => {
    // 2024-01-15 10:30:00 UTC (a Monday, dow=1)
    const now = new Date("2024-01-15T10:30:00Z");
    const e = parseCron("30 10 * * *");
    const next = nextSlot(e, now);
    expect(next.getUTCFullYear()).toBe(2024);
    expect(next.getUTCMonth()).toBe(0); // January
    expect(next.getUTCDate()).toBe(15);
    expect(next.getUTCHours()).toBe(10);
    expect(next.getUTCMinutes()).toBe(30);
  });

  it("returns the next matching minute within the hour", () => {
    const now = new Date("2024-01-15T10:00:00Z");
    const e = parseCron("30 10 * * *");
    const next = nextSlot(e, now);
    expect(next.getUTCHours()).toBe(10);
    expect(next.getUTCMinutes()).toBe(30);
  });

  it("advances to next hour when minute has passed", () => {
    const now = new Date("2024-01-15T10:31:00Z");
    const e = parseCron("30 * * * *"); // every hour at :30
    const next = nextSlot(e, now);
    expect(next.getUTCHours()).toBe(11);
    expect(next.getUTCMinutes()).toBe(30);
  });

  it("handles step expressions", () => {
    const now = new Date("2024-01-15T10:07:00Z");
    const e = parseCron("*/15 * * * *");
    const next = nextSlot(e, now);
    expect(next.getUTCMinutes()).toBe(15);
  });

  it("advances to next day when hour has passed", () => {
    const now = new Date("2024-01-15T02:01:00Z");
    const e = parseCron("0 2 * * *"); // daily at 02:00
    const next = nextSlot(e, now);
    expect(next.getUTCDate()).toBe(16);
    expect(next.getUTCHours()).toBe(2);
    expect(next.getUTCMinutes()).toBe(0);
  });

  it("handles @hourly", () => {
    const now = new Date("2024-01-15T10:05:00Z");
    const e = parseCron("@hourly");
    const next = nextSlot(e, now);
    expect(next.getUTCHours()).toBe(11);
    expect(next.getUTCMinutes()).toBe(0);
  });
});

// ---------- slotKey ----------

describe("slotKey", () => {
  it("formats a deterministic key for repo/job/slot", () => {
    const d = new Date("2024-01-15T10:30:00Z");
    const key = slotKey("my-repo", "nightly", d);
    expect(key).toBe("my-repo/nightly/2024-01-15T10:30:00.000Z");
  });
});

// ---------- electWinner ----------

describe("electWinner", () => {
  it("returns null for empty claims", () => {
    expect(electWinner([], "my-repo/nightly/2024-01-15T10:30:00.000Z")).toBeNull();
  });

  it("returns the only claimer if one claim", () => {
    const winner = electWinner(
      [{ claimer: "alice", capability_hash: "aaa" }],
      "slot",
    );
    expect(winner).toBe("alice");
  });

  it("produces a deterministic winner from multiple claims", () => {
    const claims = [
      { claimer: "alice", capability_hash: "aaa" },
      { claimer: "bob", capability_hash: "bbb" },
      { claimer: "carol", capability_hash: "ccc" },
    ];
    const slot = "my-repo/nightly/2024-01-15T10:30:00.000Z";
    const winner1 = electWinner(claims, slot);
    const winner2 = electWinner([...claims].reverse(), slot);
    expect(winner1).toBe(winner2); // deterministic regardless of order
    expect(["alice", "bob", "carol"]).toContain(winner1 as string);
  });

  it("excludes removed claimers on re-election", () => {
    const claims = [
      { claimer: "alice", capability_hash: "aaa" },
      { claimer: "bob", capability_hash: "bbb" },
    ];
    const slot = "my-repo/nightly/2024-01-15T10:30:00.000Z";
    const first = electWinner(claims, slot);
    const remaining = claims.filter((c) => c.claimer !== first);
    const second = electWinner(remaining, slot);
    expect(second).not.toBe(first as string);
  });
});
