import { describe, it, expect } from "bun:test";
import { selectRunner, rankRunners, matchesBranch, resolveShaviaIPeers, type PeerCapabilityEntry } from "./scheduler.ts";
import type { RunnerRequirements } from "./types.ts";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { $ } from "bun";

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

describe("rankRunners", () => {
  const req: RunnerRequirements = { labels: ["docker"], fallback: "any" };

  it("returns empty array when no peers", () => {
    expect(rankRunners([], req)).toEqual([]);
  });

  it("returns empty array when all peers fail label requirements", () => {
    const peers = [makePeer("alice", { labels: ["bare"] })];
    expect(rankRunners(peers, req)).toEqual([]);
  });

  it("returns empty array when all peers are at capacity", () => {
    const peers = [makePeer("alice", { jobs_running: 4, max_concurrent_jobs: 4 })];
    expect(rankRunners(peers, req)).toEqual([]);
  });

  it("returns all eligible candidates, not just the best one", () => {
    const peers = [makePeer("alice"), makePeer("bob"), makePeer("carol")];
    expect(rankRunners(peers, req)).toHaveLength(3);
  });

  it("orders candidates by jobs_running ascending", () => {
    const peers = [
      makePeer("alice", { jobs_running: 2 }),
      makePeer("bob", { jobs_running: 0 }),
      makePeer("carol", { jobs_running: 1 }),
    ];
    expect(rankRunners(peers, req)).toEqual(["bob", "carol", "alice"]);
  });

  it("uses cpu_percent as tiebreaker within the same jobs_running", () => {
    const peers = [
      makePeer("alice", { jobs_running: 0, cpu_percent: 80 }),
      makePeer("bob", { jobs_running: 0, cpu_percent: 20 }),
      makePeer("carol", { jobs_running: 0, cpu_percent: 50 }),
    ];
    expect(rankRunners(peers, req)).toEqual(["bob", "carol", "alice"]);
  });

  it("dedicated runners appear before fallback peers regardless of load", () => {
    const peers = [
      makePeer("non-runner", { runner: false, jobs_running: 0, cpu_percent: 0 }),
      makePeer("dedicated", { runner: true, jobs_running: 3, cpu_percent: 90 }),
    ];
    const ranked = rankRunners(peers, req);
    expect(ranked[0]).toBe("dedicated");
    expect(ranked[1]).toBe("non-runner");
  });

  it("with fallback=none, non-runner peers are excluded from the list", () => {
    const strictReq: RunnerRequirements = { labels: ["docker"], fallback: "none" };
    const peers = [
      makePeer("alice", { runner: false }),
      makePeer("bob", { runner: true }),
    ];
    expect(rankRunners(peers, strictReq)).toEqual(["bob"]);
  });

  it("with fallback=none, returns empty array when only non-runner peers exist", () => {
    const strictReq: RunnerRequirements = { labels: ["docker"], fallback: "none" };
    const peers = [makePeer("alice", { runner: false })];
    expect(rankRunners(peers, strictReq)).toEqual([]);
  });

  it("excludes capacity-full peers from both tiers", () => {
    const peers = [
      makePeer("full-runner", { runner: true, jobs_running: 4, max_concurrent_jobs: 4 }),
      makePeer("full-fallback", { runner: false, jobs_running: 4, max_concurrent_jobs: 4 }),
      makePeer("open", { runner: true, jobs_running: 1 }),
    ];
    expect(rankRunners(peers, req)).toEqual(["open"]);
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

// ---------- helpers for resolveShaviaIPeers tests ----------

const ALL_HEADS = "+refs/heads/*:refs/heads/*";

/** Non-bare repo with one commit — used as the "peer" source in fetches. */
async function makeSourceRepo(): Promise<{ dir: string; sha: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-src-"));
  await $`git -C ${dir} init -b main`.quiet();
  await $`git -C ${dir} config user.email ci@test`.quiet();
  await $`git -C ${dir} config user.name CI`.quiet();
  await $`git -C ${dir} commit --allow-empty -m init`.quiet();
  const sha = (await $`git -C ${dir} rev-parse HEAD`.quiet()).stdout.toString().trim();
  return { dir, sha };
}

/** Empty bare repo — used as the CI mirror. */
async function makeBareMirror(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-mirror-"));
  await $`git -C ${dir} init --bare`.quiet();
  return dir;
}

/** Fetch all heads from srcDir into mirrorDir (refspec passed as variable to avoid glob expansion). */
async function fetchIntoMirror(mirrorDir: string, srcDir: string): Promise<void> {
  await $`git -C ${mirrorDir} fetch ${srcDir} ${ALL_HEADS}`.quiet();
}

function peersIter(names: string[]): IterableIterator<[string, unknown]> {
  return names.map((n): [string, unknown] => [n, {}]).values();
}

describe("resolveShaviaIPeers", () => {
  it("does nothing when SHA already exists in mirror", async () => {
    const src = await makeSourceRepo();
    const mirror = await makeBareMirror();
    try {
      // Pre-populate mirror so the SHA is already present.
      await fetchIntoMirror(mirror, src.dir);
      const reconcileCalls: string[] = [];
      await resolveShaviaIPeers(mirror, src.sha, peersIter(["alice"]), async (peer) => {
        reconcileCalls.push(peer);
      });
      expect(reconcileCalls).toHaveLength(0);
    } finally {
      await fs.rm(src.dir, { recursive: true, force: true });
      await fs.rm(mirror, { recursive: true, force: true });
    }
  });

  it("calls reconcile until SHA appears (simulates stale mirror after force-push)", async () => {
    // src has the new SHA; mirror starts empty (stale working-copy fetch left it behind).
    const src = await makeSourceRepo();
    const mirror = await makeBareMirror();
    try {
      const reconcileCalls: string[] = [];

      await resolveShaviaIPeers(mirror, src.sha, peersIter(["alice"]), async (peer) => {
        reconcileCalls.push(peer);
        // Simulate what reconcileFromPeer does: fetch from the peer source into the mirror.
        await fetchIntoMirror(mirror, src.dir);
      });

      expect(reconcileCalls).toEqual(["alice"]);
      const check = await $`git -C ${mirror} cat-file -e ${src.sha}`.nothrow().quiet();
      expect(check.exitCode).toBe(0);
    } finally {
      await fs.rm(src.dir, { recursive: true, force: true });
      await fs.rm(mirror, { recursive: true, force: true });
    }
  });

  it("skips failing peers and tries the next one", async () => {
    const src = await makeSourceRepo();
    const mirror = await makeBareMirror();
    try {
      const reconcileCalls: string[] = [];

      await resolveShaviaIPeers(mirror, src.sha, peersIter(["unreachable", "bob"]), async (peer) => {
        reconcileCalls.push(peer);
        if (peer === "unreachable") throw new Error("connection refused");
        await fetchIntoMirror(mirror, src.dir);
      });

      expect(reconcileCalls).toEqual(["unreachable", "bob"]);
      const check = await $`git -C ${mirror} cat-file -e ${src.sha}`.nothrow().quiet();
      expect(check.exitCode).toBe(0);
    } finally {
      await fs.rm(src.dir, { recursive: true, force: true });
      await fs.rm(mirror, { recursive: true, force: true });
    }
  });

  it("stops after first successful reconcile even when more peers exist", async () => {
    const src = await makeSourceRepo();
    const mirror = await makeBareMirror();
    try {
      const reconcileCalls: string[] = [];

      await resolveShaviaIPeers(mirror, src.sha, peersIter(["alice", "bob"]), async (peer) => {
        reconcileCalls.push(peer);
        await fetchIntoMirror(mirror, src.dir);
      });

      expect(reconcileCalls).toEqual(["alice"]); // stopped after alice succeeded
    } finally {
      await fs.rm(src.dir, { recursive: true, force: true });
      await fs.rm(mirror, { recursive: true, force: true });
    }
  });
});
