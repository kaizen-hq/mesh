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

// ---------- security helpers (exported for testing) ----------

/**
 * Returns true if a volume source string is an unsafe host path.
 * Blocked prefixes: absolute (/), home-dir (~), env-var ($), traversal (..).
 * Named volumes (bare alphanumeric names like "node_cache") are allowed.
 */
function isUnsafeVolumeSource(src: string): boolean {
  const s = src.trimStart();
  return s.startsWith("/") || s.startsWith("~") || s.startsWith("$") || s.startsWith("..");
}

/**
 * Throws if the compose file content contains unsafe options that would
 * allow a container to reach the mesh daemon or gain host privileges.
 *
 * Volumes are validated by parsing the YAML so all notations are covered:
 *   - Block-style list:  volumes:\n  - /host:/container
 *   - Flow-style list:   volumes: ["/host:/container"]
 *   - Long syntax:       volumes:\n  - type: bind\n    source: /host
 */
export function validateComposeFile(content: string, jobName: string): void {
  if (/network_mode\s*:\s*["']?host["']?/.test(content)) {
    throw new Error(
      `job "${jobName}": network_mode: host is not permitted in CI compose files`,
    );
  }
  if (/^\s+privileged\s*:\s*true/m.test(content)) {
    throw new Error(
      `job "${jobName}": privileged: true is not permitted in CI compose files`,
    );
  }

  // Parse the YAML so all volume notations (block, flow, long-syntax) are
  // inspected structurally rather than via regex over raw text.
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(content);
  } catch {
    // Unparseable compose files are rejected at a higher level; skip the
    // volume check here rather than masking the real parse error.
    return;
  }

  if (doc == null || typeof doc !== "object") return;
  const services = (doc as Record<string, unknown>)["services"];
  if (services == null || typeof services !== "object") return;

  for (const [, svc] of Object.entries(services as Record<string, unknown>)) {
    if (svc == null || typeof svc !== "object") continue;
    const volumes = (svc as Record<string, unknown>)["volumes"];
    if (!Array.isArray(volumes)) continue;

    for (const vol of volumes) {
      if (typeof vol === "string") {
        // Short syntax: "source:target[:options]" or "target" (anonymous).
        // A string with no colon is an anonymous volume — always safe.
        const colon = vol.indexOf(":");
        if (colon === -1) continue;
        const source = vol.slice(0, colon);
        if (isUnsafeVolumeSource(source)) {
          throw new Error(
            `job "${jobName}": host-path volume mounts are not permitted in CI compose files`,
          );
        }
      } else if (vol != null && typeof vol === "object") {
        // Long syntax: { type: "bind", source: "...", target: "..." }
        const source = (vol as Record<string, unknown>)["source"];
        if (typeof source === "string" && isUnsafeVolumeSource(source)) {
          throw new Error(
            `job "${jobName}": host-path volume mounts are not permitted in CI compose files`,
          );
        }
      }
    }
  }
}

/**
 * Returns the argv for a shell command.
 *
 * netIsolate: wrap with `unshare --net` (Linux only, when available).
 * useSetsid:  wrap with `setsid` so the shell becomes its own session/process-
 *             group leader. When true, proc.pid == pgid, enabling callers to
 *             kill lingering background processes via `kill -9 -<pid>`.
 */
export function buildShellCmdArgs(
  cmd: string,
  netIsolate: boolean,
  useSetsid = false,
): string[] {
  const inner: string[] = netIsolate
    ? ["unshare", "--net", "sh", "-c", cmd]
    : ["sh", "-c", cmd];
  return useSetsid ? ["setsid", ...inner] : inner;
}

/**
 * Merges run-level secrets with job-level overrides. Injects MESH_PUSH_TOKEN
 * only when the job declares push: true and a token is available.
 */
export function buildJobSecrets(
  runSecrets: Record<string, string>,
  job: JobDefinition,
  pushToken?: string,
): Record<string, string> {
  const jobSecrets: Record<string, string> = { ...runSecrets };
  if (job.push && pushToken) {
    jobSecrets["MESH_PUSH_TOKEN"] = pushToken;
  }
  return jobSecrets;
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
    const raw = await fs.readFile(composeFile, "utf8").catch(() => "");
    validateComposeFile(raw, jobName);
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
    return (await spawnAndLog("docker", args, { env: buildDockerEnv(secrets) }, secrets, onLog)).exitCode;
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
  isolatedUser = false,
): Record<string, string> {
  const env: Record<string, string> = {};
  // Always include enough to locate binaries and write temp files.
  // Omit HOME when running as a different user: the daemon's home directory
  // is not writable by the jobs uid, so passing it causes tool cache writes
  // (npm, cargo, go) to fail. The job's HOME will be set by the caller.
  for (const key of isolatedUser
    ? ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]
    : ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
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
  jobHome: string | undefined,
  secrets: Record<string, string>,
  envPassthrough: string[],
  networkIsolation: boolean,
  jobsUid: number,
  jobsGid: number,
  onLog: (line: string) => Promise<void>,
  meshVars: { sha: string; ref: string; runId: string },
): Promise<number> {
  const env = buildShellEnv(envPassthrough, secrets, jobsUid > 0);
  if (jobHome) env["HOME"] = jobHome;
  // Expose the commit SHA, ref, and run ID so jobs don't need to query git
  // (the worktree's .git points into ~/.mesh which the jobs user can't read).
  env["MESH_SHA"] = meshVars.sha;
  env["MESH_REF"] = meshVars.ref;
  env["MESH_RUN_ID"] = meshVars.runId;

  // Isolate network only when the runner config allows it (Linux only, and
  // unshare must be available — the startup probe sets network_isolation=false
  // on hosts where it isn't), and the job hasn't opted out with network: true.
  // Use setsid on Linux when running as a dedicated jobs user: the shell
  // becomes its own session/process-group leader (proc.pid == pgid), which
  // lets us kill any background processes it left behind before the next job
  // (which may carry MESH_PUSH_TOKEN) starts.
  const useSetsid = process.platform === "linux" && jobsUid > 0;
  const netIsolate = networkIsolation && process.platform === "linux" && !job.network;
  let lastExit = 0;
  for (const cmd of job.commands) {
    const argv = buildShellCmdArgs(cmd, netIsolate, useSetsid);
    const { exitCode, pid } = await spawnAndLog(
      argv[0]!, argv.slice(1),
      { cwd: worktree, env, uid: jobsUid || undefined, gid: jobsGid || undefined },
      secrets, onLog,
      // Register the pid synchronously after spawn so the active set reflects
      // every running job command at all times, including during concurrent runs.
      useSetsid ? (p) => activeShellJobPgids.add(p) : undefined,
    );

    if (useSetsid) {
      // Phase 1: kill processes in the shell's own process group (the common
      // case — background procs from `cmd & ; do_work` stay in the same pgid).
      await killProcessGroup(pid, jobsUid, jobsGid);

      // Phase 2: if no other job command is currently running as jobs_uid, do a
      // full uid-wide sweep to catch any processes that escaped their pgid by
      // calling setsid/setpgrp themselves. This is safe when the active set
      // becomes empty because jobs_uid is dedicated to CI job execution only.
      activeShellJobPgids.delete(pid);
      if (activeShellJobPgids.size === 0) {
        await killAllJobsUidOrphans(jobsUid, jobsGid);
      }
    }

    if (exitCode !== 0) return exitCode;
    lastExit = exitCode;
  }
  return lastExit;
}

// ---------- spawn helper ----------

// PIDs of shell-job commands that are currently running (across all concurrent
// pipeline runs). Each command is wrapped with setsid so pid == pgid. A pid is
// added synchronously right after Bun.spawn returns (before any await), so the
// set always reflects the live set of running job pgids.
const activeShellJobPgids = new Set<number>();

async function spawnAndLog(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; uid?: number; gid?: number },
  secrets: Record<string, string>,
  onLog: (line: string) => Promise<void>,
  // Called synchronously after spawn, before any await, so callers can register
  // the pid in activeShellJobPgids while the process is still running.
  onPid?: (pid: number) => void,
): Promise<{ exitCode: number; pid: number }> {
  // Explicit generics fix: uid/gid are missing from bun-types 1.3.14 so we
  // cast options through unknown. The explicit <"ignore","pipe","pipe"> tells
  // TypeScript the return shape (proc.stdout/stderr are ReadableStream), which
  // the cast would otherwise erase.
  const proc = Bun.spawn<"ignore", "pipe", "pipe">([cmd, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    uid: opts.uid,
    gid: opts.gid,
    stdout: "pipe",
    stderr: "pipe",
  } as unknown as Parameters<typeof Bun.spawn<"ignore", "pipe", "pipe">>[1]);

  // Register before any await so the pid is in the active set for the entire
  // duration of the process, including when concurrent cleanup runs check it.
  onPid?.(proc.pid);

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
  return { exitCode: proc.exitCode ?? 1, pid: proc.pid };
}

/**
 * Sends SIGKILL to every process in the given process group.
 * `kill` is a shell built-in on minimal images (no /bin/kill binary), so we
 * invoke it via sh. Errors are silently swallowed: the group may be empty.
 *
 * Pre-condition: the target process was spawned with `setsid` so that
 * proc.pid == pgid (the process became its own session and group leader).
 */
async function killProcessGroup(pgid: number, uid: number, gid: number): Promise<void> {
  const proc = Bun.spawn<"ignore", "ignore", "ignore">(
    ["sh", "-c", `kill -9 -- -${pgid}`],
    { uid, gid, stdout: "ignore", stderr: "ignore" } as unknown as Parameters<
      typeof Bun.spawn<"ignore", "ignore", "ignore">
    >[1],
  );
  await proc.exited.catch(() => {});
}

/**
 * Kills every process owned by jobs_uid that is NOT part of a currently-running
 * job command (i.e., not in activeShellJobPgids). This sweeps up any processes
 * that escaped their process group by calling setsid/setpgrp themselves.
 *
 * `kill -9 -1` as jobs_uid sends SIGKILL to all jobs_uid processes except the
 * caller (the sh process itself), which is permitted by Linux kill(2) semantics.
 * It is only safe to call when activeShellJobPgids is empty (no other concurrent
 * job command is running as jobs_uid), because it kills indiscriminately.
 */
async function killAllJobsUidOrphans(uid: number, gid: number): Promise<void> {
  const proc = Bun.spawn<"ignore", "ignore", "ignore">(
    ["sh", "-c", "kill -9 -1"],
    { uid, gid, stdout: "ignore", stderr: "ignore" } as unknown as Parameters<
      typeof Bun.spawn<"ignore", "ignore", "ignore">
    >[1],
  );
  await proc.exited.catch(() => {});
}

// ---------- worktree management ----------

export async function setupWorktree(
  repoPath: string,
  runId: string,
  sha: string,
  workdir: string,
  jobsUid?: number,
  jobsGid?: number,
): Promise<string> {
  await fs.mkdir(workdir, { recursive: true });
  // 1777: sticky + world-writable, like /tmp itself. The sticky bit prevents
  // uid=65533 (mesh-jobs) from deleting uid=1001 run dirs and vice versa.
  // World-write is required so jobs uid can mkdir its own run subdir here.
  await fs.chmod(workdir, 0o1777);
  const dest = path.join(workdir, runId);

  // When running jobs as a different user, pre-create the worktree directory
  // owned by that user. Git accepts a pre-existing empty directory and will
  // populate it with source files (owned by the daemon uid, read-only to the
  // job — intentional). The job owns the directory itself, so it can freely
  // create node_modules/, dist/, target/, etc. without CAP_CHOWN.
  if (jobsUid && jobsGid) {
    // -m 777: world-writable so uid=1001 (git worktree add) can create .git,
    // and uid=65533 (job) can create node_modules/ etc. inside the same dir.
    const mkdirProc = Bun.spawn<"ignore", "pipe", "pipe">(["mkdir", "-m", "777", dest], {
      uid: jobsUid, gid: jobsGid, stdout: "pipe", stderr: "pipe",
    } as unknown as Parameters<typeof Bun.spawn<"ignore", "pipe", "pipe">>[1]);
    await mkdirProc.exited;
    if (mkdirProc.exitCode !== 0) {
      const stderr = await new Response(mkdirProc.stderr).text();
      throw new Error(`mkdir ${dest} as uid=${jobsUid} failed (exit ${mkdirProc.exitCode}): ${stderr.trim()}`);
    }
  }

  const proc = Bun.spawn(["git", "worktree", "add", dest, sha], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git worktree add ${sha} failed (exit ${proc.exitCode}): ${stderr.trim()}`);
  }
  return dest;
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  jobsUid?: number,
  jobsGid?: number,
): Promise<void> {
  // When jobs ran as a different uid they own files inside the worktree that
  // uid=1001 cannot delete. Run rm -rf as the jobs uid first so all
  // jobs-owned files are removed, then let git deregister the worktree.
  if (jobsUid && jobsGid) {
    const rmProc = Bun.spawn<"ignore", "pipe", "pipe">(["rm", "-rf", worktreePath], {
      uid: jobsUid, gid: jobsGid, stdout: "pipe", stderr: "pipe",
    } as unknown as Parameters<typeof Bun.spawn<"ignore", "pipe", "pipe">>[1]);
    await rmProc.exited;
  }
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
  // When set, injected as MESH_PUSH_TOKEN into jobs that declare push: true.
  pushToken?: string;
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
    worktree = await setupWorktree(
      repoPath, run.run_id, run.sha, runnerConfig.workdir,
      runnerConfig.jobs_uid || undefined, runnerConfig.jobs_gid || undefined,
    );
  } catch (e) {
    run.status = "failed";
    run.completed_at = new Date().toISOString();
    await saveRun(root, run).catch(() => {}); // best-effort; always re-throw the original error
    opts.onRunUpdate?.(run);
    throw e;
  }

  run.status = "running";
  await saveRun(root, run);
  await opts.onRunUpdate?.(run);

  // Create a per-run home directory for the jobs user once, shared across all
  // shell jobs in this run. Cleaned up in the finally block alongside worktree.
  let jobHome: string | undefined;
  if (runnerConfig.jobs_uid > 0) {
    jobHome = path.join(os.tmpdir(), `mesh-jobs-home-${run.run_id}`);
    const mkHomeProc = Bun.spawn<"ignore", "pipe", "pipe">(["mkdir", "-p", jobHome], {
      uid: runnerConfig.jobs_uid, gid: runnerConfig.jobs_gid, stdout: "pipe", stderr: "pipe",
    } as unknown as Parameters<typeof Bun.spawn<"ignore", "pipe", "pipe">>[1]);
    await mkHomeProc.exited;
  }

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

      const jobSecrets = buildJobSecrets(secrets, jobDef, opts.pushToken);

      let exitCode: number;
      try {
        if (jobDef.mode === "shell") {
          exitCode = await runShellJob(
            jobDef, worktree, jobHome, jobSecrets,
            runnerConfig.env_passthrough, runnerConfig.network_isolation,
            runnerConfig.jobs_uid, runnerConfig.jobs_gid,
            onLog,
            { sha: run.sha, ref: run.ref, runId: run.run_id },
          );
        } else {
          exitCode = await runDockerJob(jobDef, jobName, worktree, jobSecrets, onLog);
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
    await removeWorktree(
      repoPath, worktree,
      runnerConfig.jobs_uid || undefined, runnerConfig.jobs_gid || undefined,
    ).catch(() => {});
    if (jobHome && runnerConfig.jobs_uid) {
      const rmHome = Bun.spawn<"ignore", "pipe", "pipe">(["rm", "-rf", jobHome], {
        uid: runnerConfig.jobs_uid, gid: runnerConfig.jobs_gid, stdout: "pipe", stderr: "pipe",
      } as unknown as Parameters<typeof Bun.spawn<"ignore", "pipe", "pipe">>[1]);
      await rmHome.exited.catch(() => {});
    }
  }

  run.status = failed.size > 0 ? "failed" : "passed";
  run.completed_at = new Date().toISOString();
  await saveRun(root, run);
  await opts.onRunUpdate?.(run);

  return run;
}
