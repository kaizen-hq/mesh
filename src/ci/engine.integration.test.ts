import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { setupWorktree, removeWorktree, runPipeline } from "./engine.ts";
import type { Pipeline, PipelineRun, RunnerConfig } from "./types.ts";

// ---------- helpers ----------

async function initRepo(dir: string): Promise<string> {
  const run = (args: string[]) =>
    Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe" }).exited;

  await run(["git", "init"]);
  await run(["git", "config", "user.email", "test@mesh.local"]);
  await run(["git", "config", "user.name", "Mesh Test"]);
  await fs.writeFile(path.join(dir, "hello.txt"), "hello");
  await run(["git", "add", "hello.txt"]);
  await run(["git", "commit", "-m", "init"]);

  const shaProc = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: dir, stdout: "pipe", stderr: "pipe",
  });
  await shaProc.exited;
  return (await new Response(shaProc.stdout).text()).trim();
}

async function dockerAvailable(): Promise<boolean> {
  const proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc.exitCode === 0;
}

function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mesh-ci-test-"));
}

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    run_id: crypto.randomUUID(),
    repo: "test-repo",
    ref: "refs/heads/main",
    sha: "",
    triggered_by: { type: "manual", initiator: "test" },
    runner: "test-runner",
    status: "pending",
    started_at: new Date().toISOString(),
    jobs: {},
    ...overrides,
  };
}

function makeRunnerConfig(workdir: string, overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    enabled: true,
    labels: [],
    max_concurrent_jobs: 4,
    workdir,
    tools: [],
    log_stream_interval_ms: 100,
    max_worktree_age_minutes: 60,
    max_worktree_disk_mb: 512,
    log_retention_runs: 10,
    buildkit_addr: "",
    registry_url: "",
    buildx_builder: "ci-builder",
    ...overrides,
  };
}

// ---------- setupWorktree / removeWorktree ----------

describe("setupWorktree", () => {
  let repoDir: string;
  let workdir: string;
  let sha: string;

  beforeEach(async () => {
    repoDir = await makeTmpDir();
    workdir = await makeTmpDir();
    sha = await initRepo(repoDir);
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("creates a worktree directory at workdir/<runId>", async () => {
    const runId = crypto.randomUUID();
    const dest = await setupWorktree(repoDir, runId, sha, workdir);
    expect(dest).toBe(path.join(workdir, runId));
    const stat = await fs.stat(dest);
    expect(stat.isDirectory()).toBe(true);
  });

  it("the worktree contains the committed file", async () => {
    const runId = crypto.randomUUID();
    const dest = await setupWorktree(repoDir, runId, sha, workdir);
    const content = await fs.readFile(path.join(dest, "hello.txt"), "utf8");
    expect(content).toBe("hello");
  });

  it("throws when the sha does not exist in the repo", async () => {
    await expect(
      setupWorktree(repoDir, crypto.randomUUID(), "0000000000000000000000000000000000000000", workdir),
    ).rejects.toThrow();
  });
});

describe("removeWorktree", () => {
  let repoDir: string;
  let workdir: string;
  let sha: string;

  beforeEach(async () => {
    repoDir = await makeTmpDir();
    workdir = await makeTmpDir();
    sha = await initRepo(repoDir);
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("removes the worktree directory and deregisters it from git", async () => {
    const runId = crypto.randomUUID();
    const dest = await setupWorktree(repoDir, runId, sha, workdir);
    await removeWorktree(repoDir, dest);
    await expect(fs.stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not throw when the worktree path does not exist", async () => {
    const ghost = path.join(workdir, "nonexistent");
    await expect(removeWorktree(repoDir, ghost)).resolves.toBeUndefined();
  });
});

// ---------- runPipeline (docker mode, requires Docker) ----------

describe("runPipeline (docker mode)", () => {
  let repoDir: string;
  let workdir: string;
  let meshRoot: string;
  let sha: string;
  let hasDocker: boolean;

  beforeEach(async () => {
    hasDocker = await dockerAvailable();
    repoDir = await makeTmpDir();
    workdir = await makeTmpDir();
    meshRoot = await makeTmpDir();
    sha = await initRepo(repoDir);
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
    await fs.rm(meshRoot, { recursive: true, force: true });
  });

  it("runs a single docker job and returns passed", async () => {
    if (!hasDocker) return;
    const pipeline: Pipeline = {
      name: "test",
      on: { manual: true },
      runner: { labels: [], fallback: "none" },
      jobs: {
        hello: { image: "alpine:3", commands: ["echo hello"], depends_on: [], secrets: [] },
      },
    };
    const run = makeRun({ sha, repo: "test-repo" });
    const result = await runPipeline(pipeline, run, {
      root: meshRoot,
      repoPath: repoDir,
      runnerConfig: makeRunnerConfig(workdir),
      secrets: {},
    });
    expect(result.status).toBe("passed");
    expect(result.jobs["hello"]?.status).toBe("passed");
    expect(result.jobs["hello"]?.exit_code).toBe(0);
  });

  it("returns failed when a command exits non-zero", async () => {
    if (!hasDocker) return;
    const pipeline: Pipeline = {
      name: "test",
      on: { manual: true },
      runner: { labels: [], fallback: "none" },
      jobs: {
        fail: { image: "alpine:3", commands: ["exit 1"], depends_on: [], secrets: [] },
      },
    };
    const run = makeRun({ sha, repo: "test-repo" });
    const result = await runPipeline(pipeline, run, {
      root: meshRoot,
      repoPath: repoDir,
      runnerConfig: makeRunnerConfig(workdir),
      secrets: {},
    });
    expect(result.status).toBe("failed");
    expect(result.jobs["fail"]?.status).toBe("failed");
  });

  it("runs jobs in dependency order", async () => {
    if (!hasDocker) return;
    const order: string[] = [];
    const pipeline: Pipeline = {
      name: "test",
      on: { manual: true },
      runner: { labels: [], fallback: "none" },
      jobs: {
        build: { image: "alpine:3", commands: ["echo build"], depends_on: ["test"], secrets: [] },
        test: { image: "alpine:3", commands: ["echo test"], depends_on: [], secrets: [] },
      },
    };
    const run = makeRun({ sha, repo: "test-repo" });
    const result = await runPipeline(pipeline, run, {
      root: meshRoot,
      repoPath: repoDir,
      runnerConfig: makeRunnerConfig(workdir),
      secrets: {},
      onLog: async (_runId, jobName) => { order.push(jobName); },
    });
    expect(result.status).toBe("passed");
    expect(order.indexOf("test")).toBeLessThan(order.indexOf("build"));
  });

  it("skips downstream jobs when an upstream job fails", async () => {
    if (!hasDocker) return;
    const pipeline: Pipeline = {
      name: "test",
      on: { manual: true },
      runner: { labels: [], fallback: "none" },
      jobs: {
        test: { image: "alpine:3", commands: ["exit 1"], depends_on: [], secrets: [] },
        build: { image: "alpine:3", commands: ["echo build"], depends_on: ["test"], secrets: [] },
        deploy: { image: "alpine:3", commands: ["echo deploy"], depends_on: ["build"], secrets: [] },
      },
    };
    const run = makeRun({ sha, repo: "test-repo" });
    const result = await runPipeline(pipeline, run, {
      root: meshRoot,
      repoPath: repoDir,
      runnerConfig: makeRunnerConfig(workdir),
      secrets: {},
    });
    expect(result.status).toBe("failed");
    expect(result.jobs["test"]?.status).toBe("failed");
    expect(result.jobs["build"]?.status).toBe("skipped");
    expect(result.jobs["deploy"]?.status).toBe("skipped");
  });

  it("injects MESH_SHA, MESH_REF, MESH_RUN_ID into containers", async () => {
    if (!hasDocker) return;
    const pipeline: Pipeline = {
      name: "test",
      on: { manual: true },
      runner: { labels: [], fallback: "none" },
      jobs: {
        env: {
          image: "alpine:3",
          commands: [`echo "$MESH_SHA $MESH_REF $MESH_RUN_ID"`],
          depends_on: [],
          secrets: [],
        },
      },
    };
    const run = makeRun({ sha, repo: "test-repo" });
    let logOut = "";
    const result = await runPipeline(pipeline, run, {
      root: meshRoot,
      repoPath: repoDir,
      runnerConfig: makeRunnerConfig(workdir),
      secrets: {},
      onLog: async (_runId, _jobName, line) => { logOut += line; },
    });
    expect(result.status).toBe("passed");
    expect(logOut).toContain(sha);
    expect(logOut).toContain("refs/heads/main");
    expect(logOut).toContain(run.run_id);
  });

  it("calls onRunUpdate with status transitions", async () => {
    if (!hasDocker) return;
    const updates: string[] = [];
    const pipeline: Pipeline = {
      name: "test",
      on: { manual: true },
      runner: { labels: [], fallback: "none" },
      jobs: {
        hello: { image: "alpine:3", commands: ["echo hello"], depends_on: [], secrets: [] },
      },
    };
    const run = makeRun({ sha, repo: "test-repo" });
    await runPipeline(pipeline, run, {
      root: meshRoot,
      repoPath: repoDir,
      runnerConfig: makeRunnerConfig(workdir),
      secrets: {},
      onRunUpdate: async (r) => { updates.push(r.status); },
    });
    expect(updates).toContain("running");
    expect(updates[updates.length - 1]).toBe("passed");
  });
});
