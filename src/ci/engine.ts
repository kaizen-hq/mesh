// Job execution: worktree setup, Docker and shell runners, job DAG.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { Pipeline, JobDefinition, PipelineRun, JobRun, RunnerConfig } from "./types.ts";
import { appendLogChunk, saveRun } from "./store.ts";

// ---------- DAG types ----------

export interface JobDAG {
  nodes: Map<string, JobDefinition>;
  // jobName → set of direct dependents (downstream)
  dependents: Map<string, Set<string>>;
  // jobName → set of dependencies (upstream)
  deps: Map<string, Set<string>>;
}

// ---------- DAG construction ----------

export function buildDag(jobs: Record<string, JobDefinition>): JobDAG {
  const nodes = new Map(Object.entries(jobs));
  const deps = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const name of nodes.keys()) {
    deps.set(name, new Set());
    dependents.set(name, new Set());
  }

  for (const [name, job] of nodes.entries()) {
    for (const dep of job.depends_on) {
      if (!nodes.has(dep)) throw new Error(`job "${name}" depends on unknown job "${dep}"`);
      deps.get(name)!.add(dep);
      dependents.get(dep)!.add(name);
    }
  }

  // Detect cycles via DFS
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(n: string): void {
    if (inStack.has(n)) throw new Error(`cycle detected involving job "${n}"`);
    if (visited.has(n)) return;
    inStack.add(n);
    for (const dep of deps.get(n)!) dfs(dep);
    inStack.delete(n);
    visited.add(n);
  }

  for (const name of nodes.keys()) dfs(name);

  return { nodes, deps, dependents };
}

// ---------- topological sort (Kahn's algorithm) ----------

export function topologicalOrder(dag: JobDAG): string[] {
  const inDegree = new Map<string, number>();
  for (const [name, d] of dag.deps.entries()) inDegree.set(name, d.size);

  const queue: string[] = [...inDegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([n]) => n)
    .sort(); // stable sort for determinism

  const result: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    result.push(n);
    const ds = [...(dag.dependents.get(n) ?? [])].sort();
    for (const d of ds) {
      const deg = (inDegree.get(d) ?? 1) - 1;
      inDegree.set(d, deg);
      if (deg === 0) queue.push(d);
    }
    queue.sort();
  }

  return result;
}

// ---------- skip computation ----------

export function collectSkipped(dag: JobDAG, failed: Set<string>): Set<string> {
  const skipped = new Set<string>();
  const toVisit = [...failed];
  while (toVisit.length > 0) {
    const n = toVisit.pop()!;
    for (const dep of dag.dependents.get(n) ?? []) {
      if (!skipped.has(dep)) {
        skipped.add(dep);
        toVisit.push(dep);
      }
    }
  }
  return skipped;
}

// ---------- sequential job iterator ----------

export async function* sequentialJobs(dag: JobDAG): AsyncIterable<string> {
  const order = topologicalOrder(dag);
  for (const name of order) yield name;
}

// ---------- secret redaction ----------

function redactSecrets(line: string, secrets: Record<string, string>): string {
  let out = line;
  for (const v of Object.values(secrets)) {
    if (v) out = out.replaceAll(v, "***");
  }
  return out;
}

// ---------- docker execution ----------

async function runDockerJob(
  job: JobDefinition,
  jobName: string,
  worktree: string,
  secrets: Record<string, string>,
  onLog: (line: string) => Promise<void>,
): Promise<number> {
  let composeFile: string | null = null;
  let tmpComposeFile: string | null = null;

  if (job.compose && job.service) {
    composeFile = path.join(worktree, job.compose);
  } else if (job.image) {
    // Generate an ephemeral docker-compose.yml
    const secretEnv = job.secrets
      .map((s) => `      ${s}: \${${s}}`)
      .join("\n");
    const envBlock = secretEnv ? `    environment:\n${secretEnv}` : "";
    const yaml = `version: "3"\nservices:\n  ${jobName}:\n    image: ${job.image}\n    volumes:\n      - ${worktree}:/workspace\n    working_dir: /workspace\n${envBlock}    command: ["/bin/sh", "-c", ${JSON.stringify(job.commands.join(" && "))}]\n`;
    tmpComposeFile = path.join(os.tmpdir(), `mesh-ci-${Date.now()}-${jobName}.yml`);
    await fs.writeFile(tmpComposeFile, yaml, "utf8");
    composeFile = tmpComposeFile;
  } else {
    throw new Error(`job "${jobName}": docker mode requires image or compose+service`);
  }

  const svc = job.service ?? jobName;
  const envArgs: string[] = [];
  for (const s of job.secrets) {
    const val = secrets[s];
    if (val !== undefined) envArgs.push("--env", `${s}=${val}`);
  }

  const args = ["compose", "-f", composeFile, "run", "--rm", ...envArgs, svc];

  try {
    return await spawnAndLog("docker", args, { env: buildDockerEnv(secrets) }, secrets, onLog);
  } finally {
    if (tmpComposeFile) {
      await fs.unlink(tmpComposeFile).catch(() => {});
    }
  }
}

// ---------- docker execution environment ----------

// Build a minimal, explicit environment for the docker CLI process. The host
// process environment is NOT passed wholesale — only the vars the docker CLI
// needs to locate the daemon socket, plus the job's secrets so that docker
// compose ${VAR} substitution resolves from our explicit dict rather than
// arbitrary host vars.
function buildDockerEnv(secrets: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP",
    "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
  ]) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  // Secrets overlay last: compose ${SECRET} substitution resolves here, not host env.
  return { ...env, ...secrets };
}

// ---------- shell execution ----------

// Build a minimal, explicit environment for shell jobs. The host process
// environment is NOT inherited wholesale — only the baseline vars needed to
// find tools and write temp files, plus whatever the operator declared in
// [runner] env_passthrough, plus the job's secrets (highest priority).
function buildShellEnv(
  passthrough: string[],
  secrets: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  // Always include enough to locate binaries and write temp files.
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  // Operator-declared host vars (SSH_AUTH_SOCK, GOPATH, DOCKER_HOST, etc.)
  for (const key of passthrough) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  // Secrets overlay last so they can never be shadowed by a host var.
  return { ...env, ...secrets };
}

async function runShellJob(
  job: JobDefinition,
  worktree: string,
  secrets: Record<string, string>,
  envPassthrough: string[],
  onLog: (line: string) => Promise<void>,
): Promise<number> {
  const env = buildShellEnv(envPassthrough, secrets);
  let lastExit = 0;
  for (const cmd of job.commands) {
    const exit = await spawnAndLog("sh", ["-c", cmd], { cwd: worktree, env }, secrets, onLog);
    if (exit !== 0) return exit;
    lastExit = exit;
  }
  return lastExit;
}

// ---------- spawn helper ----------

async function spawnAndLog(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> },
  secrets: Record<string, string>,
  onLog: (line: string) => Promise<void>,
): Promise<number> {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const dec = new TextDecoder();

  async function drainStream(stream: ReadableStream<Uint8Array>, prefix = ""): Promise<void> {
    const reader = stream.getReader();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        await onLog(redactSecrets(prefix + line + "\n", secrets));
      }
    }
    if (buf) await onLog(redactSecrets(prefix + buf + "\n", secrets));
  }

  await Promise.all([drainStream(proc.stdout), drainStream(proc.stderr, "[stderr] ")]);
  await proc.exited;
  return proc.exitCode ?? 1;
}

// ---------- worktree management ----------

export async function setupWorktree(
  repoPath: string,
  runId: string,
  sha: string,
  workdir: string,
): Promise<string> {
  await fs.mkdir(workdir, { recursive: true });
  const dest = path.join(workdir, runId);
  const proc = Bun.spawn(["git", "worktree", "add", dest, sha], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`git worktree add failed with exit code ${proc.exitCode}`);
  }
  return dest;
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const proc = Bun.spawn(["git", "worktree", "remove", worktreePath, "--force"], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

// ---------- pipeline runner ----------

export interface RunPipelineOptions {
  root: string;
  repoPath: string;
  runnerConfig: RunnerConfig;
  secrets: Record<string, string>;
  onLog?: (runId: string, jobName: string, line: string) => Promise<void>;
  onRunUpdate?: (run: PipelineRun) => Promise<void>;
}

export async function runPipeline(
  pipeline: Pipeline,
  run: PipelineRun,
  opts: RunPipelineOptions,
): Promise<PipelineRun> {
  const { root, repoPath, runnerConfig, secrets } = opts;

  // Build DAG
  const dag = buildDag(pipeline.jobs);
  const order = topologicalOrder(dag);

  // Setup worktree
  let worktree: string;
  try {
    worktree = await setupWorktree(repoPath, run.run_id, run.sha, runnerConfig.workdir);
  } catch (e) {
    run.status = "failed";
    run.completed_at = new Date().toISOString();
    await saveRun(root, run);
    opts.onRunUpdate?.(run);
    throw e;
  }

  run.status = "running";
  await saveRun(root, run);
  await opts.onRunUpdate?.(run);

  const failed = new Set<string>();

  try {
    for (const jobName of order) {
      const jobDef = pipeline.jobs[jobName]!;
      const jobRun: JobRun = {
        job: jobName,
        status: "running",
        started_at: new Date().toISOString(),
        log_seq: 0,
      };
      run.jobs[jobName] = jobRun;
      await saveRun(root, run);
      await opts.onRunUpdate?.(run);

      // Skip if any dependency failed
      const skipped = collectSkipped(dag, failed);
      if (skipped.has(jobName)) {
        run.jobs[jobName]!.status = "skipped";
        await saveRun(root, run);
        continue;
      }

      // Check if mode is allowed
      if (jobDef.mode === "shell" && !runnerConfig.execution_modes.includes("shell")) {
        await appendLogChunk(root, run.repo, run.run_id, `[mesh-ci] job "${jobName}" requires shell mode but "shell" is not in execution_modes\n`);
        run.jobs[jobName]!.status = "failed";
        run.jobs[jobName]!.exit_code = 1;
        failed.add(jobName);
        await saveRun(root, run);
        continue;
      }

      const onLog = async (line: string) => {
        await appendLogChunk(root, run.repo, run.run_id, line);
        await opts.onLog?.(run.run_id, jobName, line);
      };

      let exitCode: number;
      try {
        if (jobDef.mode === "shell") {
          exitCode = await runShellJob(jobDef, worktree, secrets, runnerConfig.env_passthrough, onLog);
        } else {
          exitCode = await runDockerJob(jobDef, jobName, worktree, secrets, onLog);
        }
      } catch (e) {
        await onLog(`[mesh-ci] job "${jobName}" threw: ${(e as Error).message}\n`);
        exitCode = 1;
      }

      run.jobs[jobName]!.exit_code = exitCode;
      run.jobs[jobName]!.completed_at = new Date().toISOString();
      run.jobs[jobName]!.status = exitCode === 0 ? "passed" : "failed";
      if (exitCode !== 0) failed.add(jobName);
      await saveRun(root, run);
      await opts.onRunUpdate?.(run);
    }
  } finally {
    await removeWorktree(repoPath, worktree).catch(() => {});
  }

  run.status = failed.size > 0 ? "failed" : "passed";
  run.completed_at = new Date().toISOString();
  await saveRun(root, run);
  await opts.onRunUpdate?.(run);

  return run;
}
