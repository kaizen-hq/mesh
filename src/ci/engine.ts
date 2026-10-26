// Job execution: worktree setup, Docker runner, job DAG.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Pipeline, JobDefinition, PipelineRun, JobRun, RunnerConfig } from "./types.ts";
import { appendLogChunk, saveRun } from "./store.ts";
import { matchesBranch } from "./scheduler.ts";


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
  // Reject host networking — escapes the container's network namespace.
  if (/network_mode\s*:\s*["']?host["']?/.test(content)) {
    throw new Error(
      `job "${jobName}": network_mode: host is not permitted in CI compose files`,
    );
  }
  // Reject privileged mode — grants all Linux capabilities.
  if (/^\s+privileged\s*:\s*true/m.test(content)) {
    throw new Error(
      `job "${jobName}": privileged: true is not permitted in CI compose files`,
    );
  }
  // Reject pid: host — shares the host PID namespace, exposing all processes.
  if (/^\s+pid\s*:\s*["']?host["']?/m.test(content)) {
    throw new Error(
      `job "${jobName}": pid: host is not permitted in CI compose files`,
    );
  }
  // Reject ipc: host — shares the host IPC namespace.
  if (/^\s+ipc\s*:\s*["']?host["']?/m.test(content)) {
    throw new Error(
      `job "${jobName}": ipc: host is not permitted in CI compose files`,
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
    const svcObj = svc as Record<string, unknown>;

    // Reject cap_add with dangerous capabilities.
    const capAdd = svcObj["cap_add"];
    if (Array.isArray(capAdd)) {
      const dangerous = new Set([
        "SYS_ADMIN", "SYS_PTRACE", "NET_ADMIN", "SYS_MODULE",
        "SYS_RAWIO", "SYS_BOOT", "SYS_TIME", "MAC_ADMIN",
        "AUDIT_CONTROL", "DAC_READ_SEARCH", "SETUID", "SETGID",
      ]);
      for (const cap of capAdd) {
        if (typeof cap === "string" && dangerous.has(cap.toUpperCase())) {
          throw new Error(
            `job "${jobName}": cap_add: ${cap} is not permitted in CI compose files`,
          );
        }
      }
    }

    // Reject security_opt entries that disable security profiles.
    const secOpts = svcObj["security_opt"];
    if (Array.isArray(secOpts)) {
      for (const opt of secOpts) {
        if (typeof opt === "string") {
          const lower = opt.toLowerCase();
          if (lower.includes("apparmor=unconfined") || lower.includes("seccomp=unconfined") || lower.includes("seccomp:unconfined")) {
            throw new Error(
              `job "${jobName}": security_opt: ${opt} is not permitted in CI compose files`,
            );
          }
        }
      }
    }

    // Validate volumes.
    const volumes = svcObj["volumes"];
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
 * Filters run-level secrets to only those declared by the job.
 */
export function buildJobSecrets(
  runSecrets: Record<string, string>,
  job: JobDefinition,
): Record<string, string> {
  const jobSecrets: Record<string, string> = {};
  for (const s of job.secrets) {
    if (runSecrets[s] !== undefined) jobSecrets[s] = runSecrets[s]!;
  }
  return jobSecrets;
}

// ---------- docker execution ----------

interface DockerJobOpts {
  jobName: string;
  worktree: string;
  secrets: Record<string, string>;
  // Mesh-provided variables injected into every container.
  meshVars: { sha: string; ref: string; runId: string };
  onLog: (line: string) => Promise<void>;
}

async function runDockerJob(job: JobDefinition, opts: DockerJobOpts): Promise<number> {
  const { jobName, worktree, secrets, meshVars, onLog } = opts;

  // Mesh-injected vars: always present in every container.
  const meshEnvArgs: string[] = [
    "--env", `MESH_SHA=${meshVars.sha}`,
    "--env", `MESH_REF=${meshVars.ref}`,
    "--env", `MESH_RUN_ID=${meshVars.runId}`,
  ];

  // User-declared secrets (from secrets.yml, filtered to what this job listed).
  const envArgs: string[] = [];
  for (const s of job.secrets) {
    const val = secrets[s];
    if (val !== undefined) envArgs.push("--env", `${s}=${val}`);
  }

  if (job.image) {
    // Simple image job: use `docker run` directly — no compose dependency.
    const args = [
      "run", "--rm",
      "--volume", `${worktree}:/workspace`,
      "--workdir", "/workspace",
      ...meshEnvArgs,
      ...envArgs,
      job.image,
      "/bin/sh", "-c", job.commands.join(" && "),
    ];
    return (await spawnAndLog("docker", args, { env: buildDockerEnv(secrets) }, secrets, onLog)).exitCode;
  }

  if (job.compose && job.service) {
    // Compose job: validate the file then delegate to `docker compose run`.
    const composeFile = path.join(worktree, job.compose);
    const raw = await fs.readFile(composeFile, "utf8").catch(() => "");
    validateComposeFile(raw, jobName);

    const args = ["compose", "-f", composeFile, "run", "--rm", "--no-deps", ...meshEnvArgs, ...envArgs, job.service];
    return (await spawnAndLog("docker", args, { env: buildDockerEnv(secrets) }, secrets, onLog)).exitCode;
  }

  throw new Error(`job "${jobName}": requires image: or compose: + service:`);
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
    "DOCKER_CONTEXT", "BUILDKIT_HOST",
  ]) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  // Secrets overlay last: compose ${SECRET} substitution resolves here, not host env.
  return { ...env, ...secrets };
}

// ---------- spawn helper ----------

async function spawnAndLog(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> },
  secrets: Record<string, string>,
  onLog: (line: string) => Promise<void>,
): Promise<{ exitCode: number; pid: number }> {
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
  return { exitCode: proc.exitCode ?? 1, pid: proc.pid };
}

// ---------- worktree management ----------

export async function setupWorktree(
  repoPath: string,
  runId: string,
  sha: string,
  workdir: string,
): Promise<string> {
  await fs.mkdir(workdir, { recursive: true });
  await fs.chmod(workdir, 0o1777);
  const dest = path.join(workdir, runId);

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
): Promise<void> {
  const proc = Bun.spawn(["git", "worktree", "remove", worktreePath, "--force"], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

// ---------- pipeline runner ----------

// ---------- built-in job: uses: image ----------

/**
 * Builds and pushes a container image via buildkitd, returns the full image
 * reference including digest (e.g. "registry.local:5000/repo@sha256:abc...").
 */
export async function runImageJob(
  jobDef: JobDefinition,
  opts: {
    jobName: string;
    worktree: string;
    runnerConfig: RunnerConfig;
    repoName: string;
    sha: string;
    onLog: (line: string) => Promise<void>;
  },
): Promise<string> {
  const { jobName, worktree, runnerConfig, repoName, sha, onLog } = opts;
  if (!runnerConfig.buildkit_addr) {
    throw new Error(`job "${jobName}" (uses: image): runner.buildkit_addr is not configured`);
  }
  if (!runnerConfig.registry_url) {
    throw new Error(`job "${jobName}" (uses: image): runner.registry_url is not configured`);
  }

  const context = jobDef.with?.["context"] ?? ".";
  const dockerfile = jobDef.with?.["dockerfile"] ?? "Dockerfile";
  const imageTag = `${runnerConfig.registry_url}/${repoName}:${sha}`;
  const metaFile = path.join(os.tmpdir(), `mesh-ci-meta-${crypto.randomUUID()}.json`);

  const builderArgs = runnerConfig.buildx_builder ? ["--builder", runnerConfig.buildx_builder] : [];
  const env: Record<string, string> = {
    ...buildDockerEnv({}),
    BUILDKIT_HOST: runnerConfig.buildkit_addr,
    ...(runnerConfig.buildx_builder ? { BUILDX_BUILDER: runnerConfig.buildx_builder } : {}),
  };

  try {
    // If with.test_target is set, build that stage first (no push).
    // This runs RUN steps (e.g. test suites) that the final stage may not depend on.
    // The job fails immediately if the test stage exits non-zero.
    const testTarget = jobDef.with?.["test_target"];
    if (testTarget) {
      const testArgs = [
        "buildx", "build",
        ...builderArgs,
        "--target", testTarget,
        "--output", "type=cacheonly",
        "--file", path.join(worktree, context, dockerfile),
        path.join(worktree, context),
      ];
      const { exitCode: testExit } = await spawnAndLog("docker", testArgs, { env }, {}, onLog);
      if (testExit !== 0) {
        throw new Error(`job "${jobName}" (uses: image): test stage "${testTarget}" failed (exit ${testExit})`);
      }
    }

    const args = [
      "buildx", "build",
      ...builderArgs,
      "--push",
      "--metadata-file", metaFile,
      "--file", path.join(worktree, context, dockerfile),
      "--tag", imageTag,
      path.join(worktree, context),
    ];
    const { exitCode } = await spawnAndLog("docker", args, { env }, {}, onLog);
    if (exitCode !== 0) {
      throw new Error(`job "${jobName}" (uses: image): docker buildx build exited ${exitCode}`);
    }

    // Extract digest from the buildx metadata JSON.
    const metaRaw = await fs.readFile(metaFile, "utf8").catch(() => "{}");
    const meta = JSON.parse(metaRaw) as Record<string, unknown>;
    const digest = (meta["containerimage.digest"] ?? meta["image.digest"] ?? "") as string;
    if (!digest.startsWith("sha256:")) {
      throw new Error(`job "${jobName}" (uses: image): could not read image digest from metadata`);
    }
    return `${runnerConfig.registry_url}/${repoName}@${digest}`;
  } finally {
    await fs.unlink(metaFile).catch(() => {});
  }
}

// ---------- built-in job: uses: gitops ----------

/**
 * Patches a gitops bare repo on disk with a new image reference.
 * Reads the image ref from run.artifacts[with.image], clones the bare repo
 * via file://, patches the manifest, commits, and pushes back.
 */
export async function runGitopsJob(
  jobDef: JobDefinition,
  opts: {
    jobName: string;
    root: string;
    gitopsRepo: string;
    imageRef: string;
    onLog: (line: string) => Promise<void>;
    onRefUpdated?: (repo: string, ref: string, newSha: string, oldSha: string) => void;
  },
): Promise<void> {
  const { jobName, root, gitopsRepo, imageRef, onLog, onRefUpdated } = opts;
  const manifestPath = jobDef.with?.["manifest"];
  const imagePattern = jobDef.with?.["image_pattern"];
  if (!manifestPath) {
    throw new Error(`job "${jobName}" (uses: gitops): with.manifest is required`);
  }
  if (!imagePattern) {
    throw new Error(`job "${jobName}" (uses: gitops): with.image_pattern is required`);
  }

  const bareRepoPath = path.join(root, "repos", `${gitopsRepo}.git`);
  const cloneDir = path.join(os.tmpdir(), `mesh-ci-gitops-${crypto.randomUUID()}`);
  const dec = new TextDecoder();

  try {
    // Clone the bare repo locally via file:// (no HTTP, no token needed).
    const cloneResult = Bun.spawnSync(["git", "clone", `file://${bareRepoPath}`, cloneDir], {
      stdout: "pipe", stderr: "pipe",
    });
    if (cloneResult.exitCode !== 0) {
      throw new Error(
        `job "${jobName}" (uses: gitops): git clone failed: ${dec.decode(cloneResult.stderr).trim()}`,
      );
    }

    const fullManifestPath = path.join(cloneDir, manifestPath);
    const content = await fs.readFile(fullManifestPath, "utf8").catch((e) => {
      throw new Error(`job "${jobName}" (uses: gitops): cannot read manifest ${manifestPath}: ${(e as Error).message}`);
    });

    // Replace occurrences of `<imagePattern>[@:]...` with `<imageRef>`.
    const escaped = imagePattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`${escaped}(?:@sha256:[a-f0-9]+|:[^\\s"']+)`, "g");
    const patched = content.replace(regex, imageRef);
    if (patched === content) {
      // Pattern not found — fail rather than silently committing a no-op.
      // A typo in image_pattern should surface as a job failure, not a
      // successful deploy that changed nothing.
      throw new Error(
        `job "${jobName}" (uses: gitops): image_pattern "${imagePattern}" not found in ${manifestPath} — check the pattern matches the image reference in the manifest`,
      );
    }
    await fs.writeFile(fullManifestPath, patched, "utf8");

    const gitEnv = {
      GIT_AUTHOR_NAME: "mesh-ci", GIT_AUTHOR_EMAIL: "mesh-ci@localhost",
      GIT_COMMITTER_NAME: "mesh-ci", GIT_COMMITTER_EMAIL: "mesh-ci@localhost",
      PATH: process.env["PATH"] ?? "",
    };

    // Capture the old HEAD sha before the commit for the ref-update broadcast.
    const oldShaResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: cloneDir, env: gitEnv, stdout: "pipe", stderr: "pipe" });
    const oldSha = oldShaResult.exitCode === 0 ? dec.decode(oldShaResult.stdout).trim() : "0000000000000000000000000000000000000000";

    const addResult = Bun.spawnSync(["git", "add", manifestPath], { cwd: cloneDir, env: gitEnv, stdout: "pipe", stderr: "pipe" });
    if (addResult.exitCode !== 0) throw new Error(`job "${jobName}" (uses: gitops): git add failed`);

    const commitResult = Bun.spawnSync(
      ["git", "commit", "-m", `ci: update ${imagePattern} to ${imageRef}`],
      { cwd: cloneDir, env: gitEnv, stdout: "pipe", stderr: "pipe" },
    );
    if (commitResult.exitCode !== 0) throw new Error(`job "${jobName}" (uses: gitops): git commit failed`);

    // Push with retry + rebase. Two deploys running concurrently will both try
    // to push to the same branch; the loser needs to rebase and retry.
    const MAX_PUSH_ATTEMPTS = 3;
    let pushed = false;
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      const pushResult = Bun.spawnSync(["git", "push", "origin", "main"],
        { cwd: cloneDir, env: gitEnv, stdout: "pipe", stderr: "pipe" });
      if (pushResult.exitCode === 0) { pushed = true; break; }

      if (attempt < MAX_PUSH_ATTEMPTS) {
        await onLog(`[mesh-ci] gitops: push attempt ${attempt} failed, rebasing on origin/main and retrying...\n`);
        const fetchResult = Bun.spawnSync(["git", "fetch", "origin", "main"], { cwd: cloneDir, env: gitEnv, stdout: "pipe", stderr: "pipe" });
        if (fetchResult.exitCode !== 0) throw new Error(`job "${jobName}" (uses: gitops): git fetch failed before rebase`);
        const rebaseResult = Bun.spawnSync(["git", "rebase", "origin/main"], { cwd: cloneDir, env: gitEnv, stdout: "pipe", stderr: "pipe" });
        if (rebaseResult.exitCode !== 0) {
          Bun.spawnSync(["git", "rebase", "--abort"], { cwd: cloneDir, env: gitEnv, stdout: "pipe", stderr: "pipe" });
          throw new Error(`job "${jobName}" (uses: gitops): rebase conflict after push failure — deploy aborted to avoid data loss`);
        }
      } else {
        throw new Error(
          `job "${jobName}" (uses: gitops): git push failed after ${MAX_PUSH_ATTEMPTS} attempts: ${dec.decode(pushResult.stderr).trim()}`,
        );
      }
    }

    if (pushed) {
      const newShaResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: cloneDir, env: gitEnv, stdout: "pipe", stderr: "pipe" });
      const newSha = newShaResult.exitCode === 0 ? dec.decode(newShaResult.stdout).trim() : "";
      await onLog(`[mesh-ci] gitops: updated ${manifestPath} → ${imageRef}\n`);
      if (newSha) onRefUpdated?.(gitopsRepo, "refs/heads/main", newSha, oldSha);
    }
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- pipeline runner ----------

export interface RunPipelineOptions {
  root: string;
  repoPath: string;
  runnerConfig: RunnerConfig;
  secrets: Record<string, string>;
  onLog?: (runId: string, jobName: string, line: string) => Promise<void>;
  onRunUpdate?: (run: PipelineRun) => Promise<void>;
  // Called after a successful uses: gitops push so peers can be notified
  // of the updated ref immediately rather than waiting for the next periodic fetch.
  onRefUpdated?: (repo: string, ref: string, newSha: string, oldSha: string) => void;
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
    await saveRun(root, run).catch(() => {});
    opts.onRunUpdate?.(run);
    throw e;
  }

  run.status = "running";
  await saveRun(root, run);
  await opts.onRunUpdate?.(run);

  const failed = new Set<string>();

  const meshVars = {
    sha: run.sha,
    ref: run.ref,
    runId: run.run_id,
  };

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
      await saveRun(root, run).catch((e) => {
        console.warn(`[ci] run ${run.run_id}: saveRun failed: ${(e as Error).message}`);
      });
      await opts.onRunUpdate?.(run).catch((e) => {
        console.warn(`[ci] run ${run.run_id}: onRunUpdate failed: ${(e as Error).message}`);
      });

      // Best-effort: log I/O failures must not abort a run.
      const onLog = async (line: string) => {
        await appendLogChunk(root, run.repo, run.run_id, line).catch((e) => {
          console.warn(`[ci] run ${run.run_id}: failed to write log chunk: ${(e as Error).message}`);
        });
        await opts.onLog?.(run.run_id, jobName, line).catch((e) => {
          console.warn(`[ci] run ${run.run_id}: onLog callback failed: ${(e as Error).message}`);
        });
      };

      // Skip if any dependency failed
      const skipped = collectSkipped(dag, failed);
      if (skipped.has(jobName)) {
        run.jobs[jobName]!.status = "skipped";
        await saveRun(root, run).catch((e) => {
          console.warn(`[ci] run ${run.run_id}: saveRun failed: ${(e as Error).message}`);
        });
        continue;
      }

      // Job-level on: filter — skip if the trigger doesn't match the job's branch filter.
      if (jobDef.on?.push?.branches) {
        if (run.triggered_by.type !== "push") {
          await onLog(`[mesh-ci] job "${jobName}" skipped: job requires push trigger but run was triggered by ${run.triggered_by.type}\n`);
          run.jobs[jobName]!.status = "skipped";
          await saveRun(root, run).catch((e) => {
            console.warn(`[ci] run ${run.run_id}: saveRun failed: ${(e as Error).message}`);
          });
          continue;
        }
        if (!matchesBranch(run.ref, jobDef.on.push.branches)) {
          await onLog(`[mesh-ci] job "${jobName}" skipped: ref ${run.ref} does not match job on.push.branches filter\n`);
          run.jobs[jobName]!.status = "skipped";
          await saveRun(root, run).catch((e) => {
            console.warn(`[ci] run ${run.run_id}: saveRun failed: ${(e as Error).message}`);
          });
          continue;
        }
      }

      const jobSecrets = buildJobSecrets(secrets, jobDef);

      let exitCode: number;
      try {
        if (jobDef.uses === "image") {
          const imageRef = await runImageJob(jobDef, {
            jobName,
            worktree,
            runnerConfig,
            repoName: run.repo,
            sha: run.sha,
            onLog,
          });
          run.artifacts[jobName] = imageRef;
          exitCode = 0;
        } else if (jobDef.uses === "gitops") {
          const imageJobName = jobDef.with?.["image"];
          if (!imageJobName) throw new Error(`job "${jobName}" (uses: gitops): with.image is required`);
          const imageRef = run.artifacts[imageJobName];
          if (!imageRef) throw new Error(`job "${jobName}" (uses: gitops): artifact "${imageJobName}" not found — ensure the image job ran first`);
          const gitopsRepo = jobDef.with?.["repo"] ?? run.repo;
          await runGitopsJob(jobDef, { jobName, root, gitopsRepo, imageRef, onLog, onRefUpdated: opts.onRefUpdated });
          exitCode = 0;
        } else if (jobDef.image || jobDef.compose) {
          // image: and compose: job types require a Docker daemon socket.
          // This runner uses buildkitd only — there is no daemon. Use `uses: image` instead.
          if (runnerConfig.buildkit_addr) {
            throw new Error(
              `job "${jobName}": image: and compose: jobs require a Docker daemon, but this runner is buildkitd-only (buildkit_addr is set). ` +
              `Use \`uses: image\` for container builds.`,
            );
          }
          exitCode = await runDockerJob(jobDef, { jobName, worktree, secrets: jobSecrets, meshVars, onLog });
        } else {
          exitCode = await runDockerJob(jobDef, {
            jobName,
            worktree,
            secrets: jobSecrets,
            meshVars,
            onLog,
          });
        }
      } catch (e) {
        await onLog(`[mesh-ci] job "${jobName}" threw: ${(e as Error).message}\n`);
        exitCode = 1;
      }

      run.jobs[jobName]!.exit_code = exitCode;
      run.jobs[jobName]!.completed_at = new Date().toISOString();
      run.jobs[jobName]!.status = exitCode === 0 ? "passed" : "failed";
      if (exitCode !== 0) failed.add(jobName);
      await saveRun(root, run).catch((e) => {
        console.warn(`[ci] run ${run.run_id}: saveRun failed: ${(e as Error).message}`);
      });
      await opts.onRunUpdate?.(run).catch((e) => {
        console.warn(`[ci] run ${run.run_id}: onRunUpdate failed: ${(e as Error).message}`);
      });
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
