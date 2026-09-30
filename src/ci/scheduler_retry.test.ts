// Functional tests for assignWithFallback: peer retry on delivery failure, local fallback.
//
// These tests mock globalThis.fetch to control what each peer address returns, then
// verify that the scheduler tries peers in ranked order, stops on first success, caps
// retries at MAX_ASSIGNMENT_ATTEMPTS (3), and falls back to a local run when all fail.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { $ } from "bun";
import { onRefUpdate } from "./scheduler.ts";
import { CiDomain } from "./ci_domain.ts";
import * as ed from "../ed25519.ts";
import type { SchedulerCtx } from "./scheduler.ts";
import type { PeerEntry } from "../peer_registry.ts";
import type { NodeCapabilities } from "./types.ts";

// ---------- pipeline fixture ----------

const PIPELINE_YML = `
pipeline:
  name: test-repo

on:
  push:
    branches: [main]

runner:
  labels: []
  fallback: any

jobs:
  test:
    mode: shell
    commands:
      - echo hello
`.trimStart();

// ---------- helpers ----------

async function setupMirror(root: string, repo: string): Promise<string> {
  const mirrorDir = path.join(root, "repos", `${repo}.git`);
  await fs.mkdir(mirrorDir, { recursive: true });
  await $`git -C ${mirrorDir} init --bare --initial-branch=main`.quiet();

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-retry-work-"));
  try {
    await $`git clone ${mirrorDir} ${workDir}`.quiet();
    await $`git -C ${workDir} config user.email ci@test`.quiet();
    await $`git -C ${workDir} config user.name CI`.quiet();
    await fs.mkdir(path.join(workDir, ".mesh"), { recursive: true });
    await fs.writeFile(path.join(workDir, ".mesh", "mesh-ci.yml"), PIPELINE_YML);
    await $`git -C ${workDir} add .`.quiet();
    await $`git -C ${workDir} commit -m init`.quiet();
    await $`git -C ${workDir} push origin +HEAD:refs/heads/main`.quiet();
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
  return mirrorDir;
}

type PeerSpec = { name: string; addresses: string[]; runner?: boolean };

async function makeCtx(root: string, peerSpecs: PeerSpec[], opts: { runnerEnabled?: boolean } = {}): Promise<SchedulerCtx> {
  const ci = new CiDomain();
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = await ed.getPublicKeyAsync(seed);

  const caps: NodeCapabilities = {
    os: "linux",
    arch: "x64",
    labels: [],
    tools: [],
    runner: true,
    load: { jobs_running: 0, cpu_percent: 0, mem_free_mb: 8192 },
  };

  const peerMap = new Map<string, PeerEntry>(
    peerSpecs.map((s) => [
      s.name,
      { addresses: s.addresses, capabilities: { ...caps, runner: s.runner ?? true } } as unknown as PeerEntry,
    ]),
  );

  return {
    root,
    config: {
      self: { name: "alice", peer_port: 7979 },
      runner: {
        enabled: opts.runnerEnabled ?? true,
        max_concurrent_jobs: 4,
        execution_modes: ["shell"],
        labels: [],
        tools: [],
        env_passthrough: [],
        workdir: path.join(root, "workdir"),
        log_stream_interval_ms: 500,
        max_worktree_age_minutes: 60,
        max_worktree_disk_mb: 2048,
        log_retention_runs: 50,
      },
      transport: { tls: false, poll_secs: 30 },
      peers: [],
      repo_policies: [],
      source_path: "",
    },
    ci,
    identity: { privateKey: seed, publicKey, pubkeyString: "ed25519:test", certPem: null, keyPem: null },
    peers: {
      entries: () => peerMap.entries(),
      get: (name: string) => peerMap.get(name),
    } as unknown as SchedulerCtx["peers"],
    repos: {
      ensure: (_: string) => ({ noteSource: () => {}, sourceList: () => [] }),
      keys: () => [][Symbol.iterator](),
      entries: () => [][Symbol.iterator](),
    } as unknown as SchedulerCtx["repos"],
    notifyCiRunChanged: () => {},
  };
}

// ---------- suite ----------

describe("assignWithFallback: retry and local fallback", () => {
  let root: string;
  let originalFetch: typeof globalThis.fetch;
  const fetchedUrls: string[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-retry-test-"));
    originalFetch = globalThis.fetch;
    fetchedUrls.length = 0;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Replace globalThis.fetch. URLs in successUrls return 200; everything else returns defaultStatus. */
  function mockFetch(successUrls: string[], defaultStatus = 503): void {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      const url = input.toString();
      fetchedUrls.push(url);
      const status = successUrls.includes(url) ? 200 : defaultStatus;
      return new Response("", { status });
    }) as typeof fetch;
  }

  it("does not call fetch when no peer runners are registered", async () => {
    const ctx = await makeCtx(root, []);
    mockFetch([]);
    await setupMirror(root, "test-repo");

    await onRefUpdate(ctx, "test-repo", "refs/heads/main", "HEAD");

    expect(fetchedUrls).toHaveLength(0);
    expect(ctx.ci.allRuns()).toHaveLength(1);
  });

  it("tries only the first peer when it succeeds", async () => {
    const ctx = await makeCtx(root, [
      { name: "peer-a", addresses: ["localhost:7001"] },
      { name: "peer-b", addresses: ["localhost:7002"] },
      { name: "peer-c", addresses: ["localhost:7003"] },
    ]);
    mockFetch(["http://localhost:7001/mesh/frame"]); // peer-a succeeds
    await setupMirror(root, "test-repo");

    await onRefUpdate(ctx, "test-repo", "refs/heads/main", "HEAD");

    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain("localhost:7001");
  });

  it("tries the second peer when the first fails", async () => {
    const ctx = await makeCtx(root, [
      { name: "peer-a", addresses: ["localhost:7001"] },
      { name: "peer-b", addresses: ["localhost:7002"] },
    ]);
    mockFetch(["http://localhost:7002/mesh/frame"]); // only peer-b succeeds
    await setupMirror(root, "test-repo");

    await onRefUpdate(ctx, "test-repo", "refs/heads/main", "HEAD");

    expect(fetchedUrls).toHaveLength(2);
    expect(fetchedUrls[0]).toContain("localhost:7001");
    expect(fetchedUrls[1]).toContain("localhost:7002");
  });

  it("falls back to local run after all 3 peers fail", async () => {
    const ctx = await makeCtx(root, [
      { name: "peer-a", addresses: ["localhost:7001"] },
      { name: "peer-b", addresses: ["localhost:7002"] },
      { name: "peer-c", addresses: ["localhost:7003"] },
    ]);
    let localFallbackTriggered = false;
    ctx.notifyCiRunChanged = () => { localFallbackTriggered = true; };
    mockFetch([]); // all fail
    await setupMirror(root, "test-repo");

    await onRefUpdate(ctx, "test-repo", "refs/heads/main", "HEAD");

    expect(fetchedUrls).toHaveLength(3);
    expect(localFallbackTriggered).toBe(true);
  });

  it("caps retries at 3 even when more peers are available", async () => {
    const ctx = await makeCtx(root, [
      { name: "peer-a", addresses: ["localhost:7001"] },
      { name: "peer-b", addresses: ["localhost:7002"] },
      { name: "peer-c", addresses: ["localhost:7003"] },
      { name: "peer-d", addresses: ["localhost:7004"] },
    ]);
    mockFetch([]); // all fail
    await setupMirror(root, "test-repo");

    await onRefUpdate(ctx, "test-repo", "refs/heads/main", "HEAD");

    expect(fetchedUrls).toHaveLength(3);
    expect(fetchedUrls.some((u) => u.includes("localhost:7004"))).toBe(false);
  });

  it("run is recorded in state.ci before any assignment attempt", async () => {
    const ctx = await makeCtx(root, [
      { name: "peer-a", addresses: ["localhost:7001"] },
    ]);
    // Capture run state at the moment fetch fires (i.e., before assignment completes).
    let runExistedDuringFetch = false;
    globalThis.fetch = (async () => {
      runExistedDuringFetch = ctx.ci.allRuns().length === 1;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await setupMirror(root, "test-repo");

    await onRefUpdate(ctx, "test-repo", "refs/heads/main", "HEAD");

    expect(runExistedDuringFetch).toBe(true);
  });

  it("skips non-runner peers without a network call when self is an enabled runner", async () => {
    // Simulates the real-world topology: ci-runner (self, runner=true) sees only
    // non-runner peers (gitops-controller, agent, joeyguerra). Before this fix,
    // the ci-runner would POST a CiAssignment to each non-runner peer, wait for
    // a CiDeclined frame, then fall back to local — a wasteful round-trip per run.
    const ctx = await makeCtx(root, [
      { name: "mesh-gitops-controller", addresses: ["localhost:7001"], runner: false },
      { name: "joey-agent",             addresses: ["localhost:7002"], runner: false },
      { name: "joeyguerra",             addresses: ["localhost:7003"], runner: false },
    ]);
    let localFallbackTriggered = false;
    ctx.notifyCiRunChanged = () => { localFallbackTriggered = true; };
    mockFetch([]); // would fail if called
    await setupMirror(root, "test-repo");

    await onRefUpdate(ctx, "test-repo", "refs/heads/main", "HEAD");

    expect(fetchedUrls).toHaveLength(0);
    expect(localFallbackTriggered).toBe(true);
  });

  it("does not run locally when runner.enabled=false and no peers exist", async () => {
    const ctx = await makeCtx(root, [], { runnerEnabled: false });
    mockFetch([]);
    await setupMirror(root, "test-repo");

    await onRefUpdate(ctx, "test-repo", "refs/heads/main", "HEAD");

    expect(fetchedUrls).toHaveLength(0);
    const runs = ctx.ci.allRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
  });

  it("does not run locally when runner.enabled=false and all peer assignments fail", async () => {
    const ctx = await makeCtx(root, [
      { name: "peer-a", addresses: ["localhost:7001"] },
    ], { runnerEnabled: false });
    mockFetch([]); // peer-a fails
    await setupMirror(root, "test-repo");

    await onRefUpdate(ctx, "test-repo", "refs/heads/main", "HEAD");

    expect(fetchedUrls).toHaveLength(1);
    const runs = ctx.ci.allRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
  });

  it("peer with multiple addresses tries each address before moving to next peer", async () => {
    const ctx = await makeCtx(root, [
      { name: "peer-a", addresses: ["localhost:7001", "localhost:7011"] },
      { name: "peer-b", addresses: ["localhost:7002"] },
    ]);
    // Neither address of peer-a works; peer-b succeeds.
    mockFetch(["http://localhost:7002/mesh/frame"]);
    await setupMirror(root, "test-repo");

    await onRefUpdate(ctx, "test-repo", "refs/heads/main", "HEAD");

    expect(fetchedUrls).toHaveLength(3); // peer-a addr1, peer-a addr2, peer-b addr1
    expect(fetchedUrls[0]).toContain("localhost:7001");
    expect(fetchedUrls[1]).toContain("localhost:7011");
    expect(fetchedUrls[2]).toContain("localhost:7002");
  });
});
