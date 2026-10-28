// Regression test: CiLog frames are broadcast to peers when a job runs locally.
//
// Before the fix, runLocalPipeline called runPipeline without an onLog callback,
// so peers never received CiLog frames and couldn't display build logs for runs
// that executed on a remote node.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { $ } from "bun";
import { handleAssignment } from "./scheduler.ts";
import { CiDomain } from "./ci_domain.ts";
import { decodeFrame, verifyFrame } from "../proto.ts";
import * as ed from "../ed25519.ts";
import type { SchedulerCtx } from "./scheduler.ts";
import type { CiMessage, Pipeline } from "../proto.ts";
import type { PeerEntry } from "../peer_registry.ts";
import type { NodeCapabilities } from "./types.ts";

// ---------- helpers ----------

async function dockerAvailable(): Promise<boolean> {
  const proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc.exitCode === 0;
}

async function setupMirror(root: string, repo: string, pipelineYml: string): Promise<string> {
  const mirrorDir = path.join(root, "repos", `${repo}.git`);
  await fs.mkdir(mirrorDir, { recursive: true });
  await $`git -C ${mirrorDir} init --bare --initial-branch=main`.quiet();

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-logbroadcast-work-"));
  try {
    await $`git clone ${mirrorDir} ${workDir}`.quiet();
    await $`git -C ${workDir} config user.email ci@test`.quiet();
    await $`git -C ${workDir} config user.name CI`.quiet();
    await fs.mkdir(path.join(workDir, ".mesh"), { recursive: true });
    await fs.writeFile(path.join(workDir, ".mesh", "mesh-ci.yml"), pipelineYml);
    await $`git -C ${workDir} add .`.quiet();
    await $`git -C ${workDir} commit -m init`.quiet();
    await $`git -C ${workDir} push origin +HEAD:refs/heads/main`.quiet();
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }

  const shaText = await $`git -C ${mirrorDir} rev-parse HEAD`.quiet().text();
  return shaText.trim();
}

async function makeCtx(root: string): Promise<SchedulerCtx> {
  const ci = new CiDomain();
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = await ed.getPublicKeyAsync(seed);

  const caps: NodeCapabilities = {
    os: "linux", arch: "x64", labels: [], tools: [], runner: true,
    load: { jobs_running: 0, cpu_percent: 0, mem_free_mb: 8192 },
  };
  const bobEntry = { addresses: ["http://bob:7979"], capabilities: caps } as unknown as PeerEntry;

  return {
    root,
    config: {
      self: { name: "alice", peer_port: 7979 },
      runner: {
        enabled: true,
        max_concurrent_jobs: 4,
        labels: [],
        tools: [],
        workdir: path.join(root, "workdir"),
        log_stream_interval_ms: 500,
        max_worktree_age_minutes: 60,
        max_worktree_disk_mb: 2048,
        log_retention_runs: 50,
        buildkit_addr: "",
        registry_url: "",
        buildx_builder: "ci-builder",
      },
      transport: { tls: false, poll_secs: 30 },
      peers: [{ name: "bob", peer_port: 7979 }],
      source_path: "",
    },
    ci,
    identity: { privateKey: seed, publicKey, pubkeyString: "ed25519:test", certPem: null, keyPem: null },
    peers: {
      entries: () => new Map([["bob", bobEntry]]).entries(),
      get: (name: string) => name === "bob" ? bobEntry : undefined,
    } as unknown as SchedulerCtx["peers"],
    repos: {
      ensure: (_: string) => ({ noteSource: () => {}, sourceList: () => [] }),
      keys: () => [][Symbol.iterator](),
      entries: () => [][Symbol.iterator](),
    } as unknown as SchedulerCtx["repos"],
    repoLocks: new Map(),
    outbound: { enqueue: () => {} } as unknown as SchedulerCtx["outbound"],
    notifyStatusChanged: () => {},
    notifyIssueChanged: () => {},
    notifyCiRunChanged: () => {},
    recordPeerAddress: async () => false,
  };
}

/** Wait for a run to reach a terminal status, or throw on timeout. */
async function waitForCompletion(ctx: SchedulerCtx, runId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = ctx.ci.getRun(runId);
    if (run && run.status !== "pending" && run.status !== "running") return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`run ${runId} did not complete within ${timeoutMs}ms`);
}

// ---------- suite ----------

describe("CiLog broadcast from runLocalPipeline", () => {
  let root: string;
  let hasDocker: boolean;
  let originalFetch: typeof globalThis.fetch;
  const capturedFrameBodies: Uint8Array[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-logbroadcast-test-"));
    hasDocker = await dockerAvailable();
    originalFetch = globalThis.fetch;
    capturedFrameBodies.length = 0;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.body) {
        const ab = await new Response(init.body as BodyInit).arrayBuffer();
        capturedFrameBodies.push(new Uint8Array(ab));
      }
      return new Response("", { status: 200 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("broadcasts CiLog frames to peers as job output is produced", async () => {
    if (!hasDocker) return;

    const repo = "test-repo";
    const pipelineYml = `
pipeline:
  name: ${repo}
on:
  manual: true
runner:
  labels: []
  fallback: any
jobs:
  hello:
    image: alpine:3
    commands:
      - echo hello-from-ci
`.trimStart();

    const sha = await setupMirror(root, repo, pipelineYml);
    const ctx = await makeCtx(root);

    const pipeline: Pipeline = {
      name: repo,
      on: { manual: true },
      runner: { labels: [], fallback: "any" },
      jobs: {
        hello: { image: "alpine:3", commands: ["echo hello-from-ci"], depends_on: [], secrets: [] },
      },
    };

    const runId = crypto.randomUUID();
    await handleAssignment(ctx, {
      type: "CiAssignment",
      run_id: runId,
      repo,
      ref: "refs/heads/main",
      sha,
      pipeline,
      triggered_by: { type: "manual", initiator: "test" },
    });

    await waitForCompletion(ctx, runId);
    // Give void-fired broadcastCiFrame promises time to resolve their fetch calls.
    await new Promise((r) => setTimeout(r, 200));

    // Decode all broadcast frames and find CiLog entries.
    // verifyFrame decodes the inner message (decodeMessage is not exported).
    const ciLogFrames: CiMessage[] = [];
    for (const body of capturedFrameBodies) {
      try {
        const frame = decodeFrame(body);
        const msg = await verifyFrame(frame, ctx.identity.publicKey);
        if (msg.kind === "CiFrame" && msg.msg.type === "CiLog") {
          ciLogFrames.push(msg.msg);
        }
      } catch { /* ignore non-CiFrame bodies */ }
    }

    expect(ciLogFrames.length).toBeGreaterThan(0);
    const allData = ciLogFrames.map((f) => (f as Extract<CiMessage, { type: "CiLog" }>).data).join("");
    expect(allData).toContain("hello-from-ci");
  });
});
