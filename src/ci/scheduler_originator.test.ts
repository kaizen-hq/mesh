// Integration test for the originating-node run persistence fix.
//
// Regression: when onRefUpdate assigned a run to a peer, the originating node
// never stored the run in state.ci or on disk. Subsequent CiStarted / CiCompleted
// frames from the runner would silently drop because handleCiRunUpdate's guard
// `if (run)` found nothing in memory.
//
// Fix: state.ci.setRun(run) + saveRun() before sendAssignment().

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { $ } from "bun";
import { onRefUpdate, onManualRun } from "./scheduler.ts";
import { CiDomain } from "./ci_domain.ts";
import { listRuns } from "./store.ts";
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
  manual: true

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

/** Bare git mirror at root/repos/<repo>.git with one commit containing mesh-ci.yml. */
async function setupMirror(root: string, repo: string): Promise<string> {
  const mirrorDir = path.join(root, "repos", `${repo}.git`);
  await fs.mkdir(mirrorDir, { recursive: true });
  await $`git -C ${mirrorDir} init --bare`.quiet();

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-sched-work-"));
  try {
    await $`git clone ${mirrorDir} ${workDir}`.quiet();
    await $`git -C ${workDir} config user.email ci@test`.quiet();
    await $`git -C ${workDir} config user.name CI`.quiet();
    await fs.mkdir(path.join(workDir, ".mesh"), { recursive: true });
    await fs.writeFile(path.join(workDir, ".mesh", "mesh-ci.yml"), PIPELINE_YML);
    await $`git -C ${workDir} add .`.quiet();
    await $`git -C ${workDir} commit -m init`.quiet();
    const refspec = "+HEAD:refs/heads/main";
    await $`git -C ${workDir} push origin ${refspec}`.quiet();
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
  return mirrorDir;
}

/** Minimal SchedulerCtx where "bob" is an available runner with no addresses.
 *  sendAssignment() will sign the frame then immediately exit the address loop. */
async function makeCtx(root: string): Promise<SchedulerCtx> {
  const ci = new CiDomain();
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = await ed.getPublicKeyAsync(seed);

  const bobCaps: NodeCapabilities = {
    os: "linux",
    arch: "x64",
    labels: [],
    tools: [],
    runner: true,
    load: { jobs_running: 0, cpu_percent: 0, mem_free_mb: 8192 },
  };
  const bobEntry = { addresses: [], capabilities: bobCaps } as unknown as PeerEntry;

  const fakePeers = {
    entries: () => new Map<string, PeerEntry>([["bob", bobEntry]]).entries(),
    get: (name: string) => (name === "bob" ? bobEntry : undefined),
  };

  const fakeRepos = {
    ensure: (_name: string) => ({ noteSource: () => {}, sourceList: () => [] }),
    keys: () => [][Symbol.iterator](),
    entries: () => [][Symbol.iterator](),
  };

  return {
    root,
    config: {
      self: { name: "alice", peer_port: 7979 },
      runner: {
        enabled: true,
        max_concurrent_jobs: 4,
        execution_modes: ["shell"],
        labels: [],
        env_passthrough: [],
        workdir: path.join(root, "workdir"),
      },
      transport: { tls: false, poll_secs: 30 },
      repos: [],
      peers: [],
      raw_hash: "",
      source_path: "",
    },
    ci,
    identity: { privateKey: seed, publicKey, pubkeyString: `ed25519:test`, certPem: null, keyPem: null },
    peers: fakePeers as unknown as SchedulerCtx["peers"],
    repos: fakeRepos as unknown as SchedulerCtx["repos"],
    notifyCiRunChanged: () => {},
  };
}

// ---------- tests ----------

let root: string;
let ctx: SchedulerCtx;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-orig-test-"));
  ctx = await makeCtx(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("originating node persists run before assignment", () => {
  it("onRefUpdate: run is in state.ci immediately after assignment to peer", async () => {
    const repo = "test-repo";
    await setupMirror(root, repo);

    await onRefUpdate(ctx, repo, "refs/heads/main", "HEAD");

    const runs = ctx.ci.allRuns().filter((r) => r.repo === repo);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("pending");
    expect(runs[0]!.triggered_by.type).toBe("push");
  });

  it("onRefUpdate: run is persisted to disk before assignment to peer", async () => {
    const repo = "test-repo";
    await setupMirror(root, repo);

    await onRefUpdate(ctx, repo, "refs/heads/main", "HEAD");

    // Allow the void saveRun() microtask to settle
    await new Promise((r) => setTimeout(r, 50));

    const index = await listRuns(root, repo);
    expect(index).toHaveLength(1);
  });

  it("onManualRun: run is in state.ci immediately after assignment to peer", async () => {
    const repo = "test-repo";
    const mirrorDir = await setupMirror(root, repo);
    const sha = (await $`git -C ${mirrorDir} rev-parse HEAD`.quiet()).stdout.toString().trim();

    await onManualRun(ctx, repo, "refs/heads/main", sha);

    const runs = ctx.ci.allRuns().filter((r) => r.repo === repo);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("pending");
    expect(runs[0]!.triggered_by.type).toBe("manual");
  });

  it("status updates from the runner can be applied because run is in state.ci", async () => {
    const repo = "test-repo";
    await setupMirror(root, repo);

    await onRefUpdate(ctx, repo, "refs/heads/main", "HEAD");

    const run = ctx.ci.allRuns().find((r) => r.repo === repo)!;
    expect(run).toBeDefined();

    // Simulate what handleCiRunUpdate does when CiStarted arrives
    const foundOnStarted = ctx.ci.getRun(run.run_id);
    expect(foundOnStarted).toBeDefined(); // before fix: would be undefined
    foundOnStarted!.status = "running";
    expect(ctx.ci.getRun(run.run_id)!.status).toBe("running");

    // Simulate what handleCiRunUpdate does when CiCompleted arrives
    const foundOnCompleted = ctx.ci.getRun(run.run_id);
    expect(foundOnCompleted).toBeDefined();
    foundOnCompleted!.status = "passed";
    expect(ctx.ci.getRun(run.run_id)!.status).toBe("passed");
  });

  it("run is NOT created for a ref that doesn't match branch filters", async () => {
    const repo = "test-repo";
    await setupMirror(root, repo);

    // Push to a branch not in the pipeline's on.push.branches list
    await onRefUpdate(ctx, repo, "refs/heads/feature/x", "HEAD");

    expect(ctx.ci.allRuns().filter((r) => r.repo === repo)).toHaveLength(0);
  });
});
