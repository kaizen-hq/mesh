import { describe, it, expect } from "bun:test";
import { selectRunner, matchesBranch, type PeerCapabilityEntry } from "./scheduler.ts";
import type { RunnerRequirements } from "./types.ts";

function makePeer(
  name: string,
  overrides: Partial<PeerCapabilityEntry> = {},
): PeerCapabilityEntry {
  return {
    name,
    runner: true,
    labels: ["docker"],
    tools: ["docker", "bun"],
    jobs_running: 0,
    cpu_percent: 10,
    mem_free_mb: 4096,
    max_concurrent_jobs: 4,
    ...overrides,
  };
}

describe("selectRunner", () => {
  const req: RunnerRequirements = { labels: ["docker"], fallback: "any" };

  it("returns null when no peers available", () => {
    expect(selectRunner([], req)).toBeNull();
  });

  it("selects the only available peer", () => {
    const peers = [makePeer("alice")];
    expect(selectRunner(peers, req)).toBe("alice");
  });

  it("prefers dedicated runners over non-runners", () => {
    const peers = [
      makePeer("alice", { runner: false }),
      makePeer("bob", { runner: true }),
    ];
    expect(selectRunner(peers, req)).toBe("bob");
  });

  it("excludes peers missing required labels", () => {
    const peers = [
      makePeer("alice", { labels: ["bare"] }),
      makePeer("bob", { labels: ["docker", "linux"] }),
    ];
    expect(selectRunner(peers, req)).toBe("bob");
  });

  it("excludes peers at capacity", () => {
    const peers = [
      makePeer("alice", { jobs_running: 4, max_concurrent_jobs: 4 }),
      makePeer("bob", { jobs_running: 1, max_concurrent_jobs: 4 }),
    ];
    expect(selectRunner(peers, req)).toBe("bob");
  });

  it("ranks by jobs_running ascending", () => {
    const peers = [
      makePeer("alice", { jobs_running: 2 }),
      makePeer("bob", { jobs_running: 0 }),
      makePeer("carol", { jobs_running: 1 }),
    ];
    expect(selectRunner(peers, req)).toBe("bob");
  });

  it("uses cpu_percent as tiebreaker", () => {
    const peers = [
      makePeer("alice", { jobs_running: 0, cpu_percent: 80 }),
      makePeer("bob", { jobs_running: 0, cpu_percent: 20 }),
    ];
    expect(selectRunner(peers, req)).toBe("bob");
  });

  it("returns null if no candidates and fallback=none", () => {
    const strictReq: RunnerRequirements = { labels: ["gpu"], fallback: "none" };
    const peers = [makePeer("alice", { labels: ["docker"] })];
    expect(selectRunner(peers, strictReq)).toBeNull();
  });

  it("falls back to any peer with required labels when no dedicated runners and fallback=any", () => {
    const peers = [
      makePeer("alice", { runner: false, labels: ["docker"] }),
    ];
    expect(selectRunner(peers, req)).toBe("alice");
  });

  it("requires ALL required labels", () => {
    const multiReq: RunnerRequirements = { labels: ["docker", "linux"], fallback: "any" };
    const peers = [
      makePeer("alice", { labels: ["docker"] }),       // missing linux
      makePeer("bob", { labels: ["docker", "linux"] }),
    ];
    expect(selectRunner(peers, multiReq)).toBe("bob");
  });
});

describe("matchesBranch", () => {
  it("matches exact branch name", () => {
    expect(matchesBranch("refs/heads/main", ["main"])).toBe(true);
  });

  it("does not match different branch", () => {
    expect(matchesBranch("refs/heads/feature/x", ["main"])).toBe(false);
  });

  it("matches glob pattern", () => {
    expect(matchesBranch("refs/heads/release/1.0", ["release/*"])).toBe(true);
  });

  it("matches any of multiple patterns", () => {
    expect(matchesBranch("refs/heads/main", ["main", "release/*"])).toBe(true);
    expect(matchesBranch("refs/heads/release/2.0", ["main", "release/*"])).toBe(true);
    expect(matchesBranch("refs/heads/dev", ["main", "release/*"])).toBe(false);
  });

  it("handles refs without refs/heads/ prefix", () => {
    expect(matchesBranch("main", ["main"])).toBe(true);
  });

  it("handles double-star glob", () => {
    expect(matchesBranch("refs/heads/feat/a/b", ["feat/**"])).toBe(true);
  });
});
