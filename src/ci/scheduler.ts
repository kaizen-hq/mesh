// Push-triggered scheduling, capability matching, assignment protocol.

import type { Config } from "../config.ts";
import type { CiDomain } from "./ci_domain.ts";
import type { PeerRegistry } from "../peer_registry.ts";
import type { Identity } from "../identity.ts";

export interface SchedulerCtx {
  config: Config;
  root: string;
  identity: Identity;
  ci: CiDomain;
  peers: PeerRegistry;
  notifyCiRunChanged(repo: string): void;
}
import type { Pipeline, PipelineRun, TriggerKind, RunnerRequirements } from "./types.ts";
import type { CiMessage } from "../proto.ts";
import { signFrame } from "../proto.ts";
import { loadPipelineFromMirror } from "./config.ts";
import * as repoStore from "../repo_store.ts";
import { normalizePeerUrl } from "../config.ts";
import { encodeFrame } from "../proto.ts";
import * as os from "node:os";
import * as path from "node:path";
import * as git from "../git.ts";

// ---------- pure runner-selection types ----------

export interface PeerCapabilityEntry {
  name: string;
  runner: boolean;
  labels: string[];
  tools: string[];
  jobs_running: number;
  cpu_percent: number;
  mem_free_mb: number;
  max_concurrent_jobs: number;
}

// ---------- branch glob matching ----------

export function matchesBranch(ref: string, patterns: string[]): boolean {
  // Strip refs/heads/ prefix if present to get the bare branch name.
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  return patterns.some((pattern) => globMatch(branch, pattern));
}

function globMatch(str: string, pattern: string): boolean {
  // Convert glob to a regex. Supports * and **.
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials (not * or ?)
    .replace(/\*\*/g, "\x00") // placeholder for **
    .replace(/\*/g, "[^/]*")  // * matches within a path segment
    .replace(/\x00/g, ".*");  // ** matches across segments
  return new RegExp(`^${regexStr}$`).test(str);
}

// ---------- runner selection algorithm ----------

export function selectRunner(
  peers: PeerCapabilityEntry[],
  req: RunnerRequirements,
): string | null {
  const hasLabels = (p: PeerCapabilityEntry) =>
    req.labels.every((l) => p.labels.includes(l));
  const hasCapacity = (p: PeerCapabilityEntry) =>
    p.jobs_running < p.max_concurrent_jobs;

  // Priority 1: dedicated runners with required labels that have capacity
  const dedicated = peers.filter((p) => p.runner && hasLabels(p) && hasCapacity(p));
  if (dedicated.length > 0) {
    return pickBest(dedicated);
  }

  // Priority 2: any peer with required labels (fallback=any only)
  if (req.fallback === "any") {
    const any = peers.filter((p) => hasLabels(p) && hasCapacity(p));
    if (any.length > 0) return pickBest(any);
  }

  return null;
}

function pickBest(candidates: PeerCapabilityEntry[]): string {
  const sorted = [...candidates].sort((a, b) => {
    if (a.jobs_running !== b.jobs_running) return a.jobs_running - b.jobs_running;
    return a.cpu_percent - b.cpu_percent;
  });
  return sorted[0]!.name;
}

// ---------- build peer capability entries from Daemon ----------

function peerCapabilities(state: SchedulerCtx): PeerCapabilityEntry[] {
  const entries: PeerCapabilityEntry[] = [];
  for (const [name, peer] of state.peers.entries()) {
    const caps = peer.capabilities;
    if (!caps) continue;
    entries.push({
      name,
      runner: caps.runner,
      labels: caps.labels,
      tools: caps.tools,
      jobs_running: caps.load.jobs_running,
      cpu_percent: caps.load.cpu_percent,
      mem_free_mb: caps.load.mem_free_mb,
      max_concurrent_jobs: state.config.runner.max_concurrent_jobs,
    });
  }
  return entries;
}

// ---------- manual run hook ----------

export async function onManualRun(
  state: SchedulerCtx,
  repo: string,
  ref: string,
  sha: string,
): Promise<void> {
  console.log(`[ci] manual run requested: repo=${repo} ref=${ref} sha=${sha.slice(0, 7)}`);

  const mirrorDir = repoStore.mirrorPath(state.root, repo);
  const pipeline = await loadPipelineFromMirror(mirrorDir).catch((e) => {
    console.log(`[ci] manual run aborted: failed to load pipeline for ${repo}: ${(e as Error).message}`);
    return null;
  });
  if (!pipeline) {
    console.log(`[ci] manual run aborted: no .mesh/mesh-ci.yml found in mirror for ${repo}`);
    return;
  }
  if (!pipeline.on.manual) {
    console.log(`[ci] manual run aborted: pipeline for ${repo} does not have manual: true`);
    return;
  }

  const runId = crypto.randomUUID();
  const trigger: TriggerKind = { type: "manual", initiator: state.config.self.name };

  const run: PipelineRun = {
    run_id: runId,
    repo,
    ref,
    sha,
    triggered_by: trigger,
    runner: state.config.self.name,
    status: "pending",
    started_at: new Date().toISOString(),
    jobs: {},
  };

  const candidates = peerCapabilities(state);
  console.log(`[ci] runner candidates: [${candidates.map((c) => `${c.name}(runner=${c.runner},jobs=${c.jobs_running}/${c.max_concurrent_jobs})`).join(", ")}]`);
  const selectedPeer = selectRunner(candidates, pipeline.runner);

  if (selectedPeer) {
    console.log(`[ci] assigning run ${runId} to peer ${selectedPeer}`);
    await sendAssignment(state, selectedPeer, run, pipeline, trigger);
  } else {
    console.log(`[ci] no peer runner available, running ${runId} locally`);
    scheduleLocalRun(state, pipeline, run);
  }
}

// ---------- ref update hook ----------

const ASSIGNMENT_TIMEOUT_MS = 5000;

export async function onRefUpdate(
  state: SchedulerCtx,
  repo: string,
  ref: string,
  sha: string,
): Promise<void> {
  console.log(`[ci] ref update: repo=${repo} ref=${ref} sha=${sha.slice(0, 7)}`);

  const mirrorDir = repoStore.mirrorPath(state.root, repo);
  const pipeline = await loadPipelineFromMirror(mirrorDir).catch((e) => {
    console.log(`[ci] push trigger aborted: failed to load pipeline for ${repo}: ${(e as Error).message}`);
    return null;
  });
  if (!pipeline) {
    console.log(`[ci] push trigger aborted: no .mesh/mesh-ci.yml found in mirror for ${repo}`);
    return;
  }
  if (!pipeline.on.push) {
    console.log(`[ci] push trigger aborted: pipeline for ${repo} has no on.push configured`);
    return;
  }
  if (!matchesBranch(ref, pipeline.on.push.branches)) {
    console.log(`[ci] push trigger aborted: ref ${ref} does not match branch filters [${pipeline.on.push.branches.join(", ")}]`);
    return;
  }

  const runId = crypto.randomUUID();
  const trigger: TriggerKind = { type: "push", pusher: state.config.self.name };

  const run: PipelineRun = {
    run_id: runId,
    repo,
    ref,
    sha,
    triggered_by: trigger,
    runner: state.config.self.name,
    status: "pending",
    started_at: new Date().toISOString(),
    jobs: {},
  };

  const candidates = peerCapabilities(state);
  console.log(`[ci] runner candidates: [${candidates.map((c) => `${c.name}(runner=${c.runner},jobs=${c.jobs_running}/${c.max_concurrent_jobs})`).join(", ")}]`);
  const selectedPeer = selectRunner(candidates, pipeline.runner);

  if (selectedPeer) {
    console.log(`[ci] assigning run ${runId} to peer ${selectedPeer}`);
    await sendAssignment(state, selectedPeer, run, pipeline, trigger);
  } else {
    console.log(`[ci] no peer runner available, running ${runId} locally`);
    scheduleLocalRun(state, pipeline, run);
  }
}

async function sendAssignment(
  state: SchedulerCtx,
  peer: string,
  run: PipelineRun,
  pipeline: Pipeline,
  trigger: TriggerKind,
): Promise<void> {
  const msg: CiMessage = {
    type: "CiAssignment",
    run_id: run.run_id,
    repo: run.repo,
    ref: run.ref,
    sha: run.sha,
    pipeline,
    triggered_by: trigger,
  };

  const me = state.config.self.name;
  const frame = await signFrame(me, peer, { kind: "CiFrame", msg }, state.identity.privateKey);
  const entry = state.peers.get(peer);
  if (!entry) {
    console.log(`[ci] assignment failed: peer ${peer} not in registry`);
    return;
  }

  for (const addr of entry.addresses) {
    const { baseUrl } = normalizePeerUrl(addr, state.config.transport.tls);
    const bytes = encodeFrame(frame);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ASSIGNMENT_TIMEOUT_MS);
    const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
      signal: controller.signal,
      tls: { rejectUnauthorized: false },
    };
    try {
      const resp = await fetch(`${baseUrl}/mesh/frame`, init);
      if (resp.ok) {
        console.log(`[ci] assignment ${run.run_id} delivered to ${peer} via ${addr}`);
        clearTimeout(timer);
        return;
      }
      console.log(`[ci] assignment to ${peer} via ${addr} returned HTTP ${resp.status}`);
    } catch (e) {
      console.log(`[ci] assignment to ${peer} via ${addr} failed: ${(e as Error).message}`);
    } finally { clearTimeout(timer); }
  }
  console.log(`[ci] assignment ${run.run_id} could not be delivered to ${peer} (all addresses failed)`);
}

function scheduleLocalRun(state: SchedulerCtx, pipeline: Pipeline, run: PipelineRun): void {
  state.ci.setRun(run);
  state.notifyCiRunChanged(run.repo);
  void runLocalPipeline(state, pipeline, run);
}

async function runLocalPipeline(state: SchedulerCtx, pipeline: Pipeline, run: PipelineRun): Promise<void> {
  console.log(`[ci] starting local run ${run.run_id} for ${run.repo} @ ${run.ref}`);
  const { runPipeline } = await import("./engine.ts");
  const mirrorPath = repoStore.mirrorPath(state.root, run.repo);

  // If this node owns the repo, pre-fetch from the working copy so the mirror
  // is current before creating the worktree. Non-fatal: runner nodes won't have
  // a local working copy and the mirror is kept fresh by the fetch loop.
  const repoCfg = state.config.repos.find((r) => r.name === run.repo);
  if (repoCfg) {
    const workingCopyPath = path.isAbsolute(repoCfg.path)
      ? repoCfg.path
      : path.join(os.homedir(), repoCfg.path);
    try {
      await git.fetchIntoBare(mirrorPath, workingCopyPath);
      console.log(`[ci] mirror refreshed for ${run.repo}`);
    } catch (e) {
      console.log(`[ci] mirror refresh for ${run.repo} failed (continuing): ${(e as Error).message}`);
    }
  }

  const worktreePath = mirrorPath;

  const started = Date.now();
  const completed = await runPipeline(pipeline, run, {
    root: state.root,
    repoPath: worktreePath,
    runnerConfig: state.config.runner,
    secrets: state.ci.secrets,
    onRunUpdate: async (updated) => {
      state.ci.setRun(updated);
      state.notifyCiRunChanged(updated.repo);
    },
  });

  const duration = Date.now() - started;
  console.log(`[ci] run ${run.run_id} completed: status=${completed.status} duration=${duration}ms`);

  // Broadcast CiCompleted to all peers
  const { sha256Hex } = await import("../proto.ts");
  const { readLog } = await import("./store.ts");
  const logText = await readLog(state.root, run.repo, run.run_id);
  const logHash = sha256Hex(new TextEncoder().encode(logText));
  const completedMsg: CiMessage = {
    type: "CiCompleted",
    run_id: run.run_id,
    repo: run.repo,
    status: completed.status === "passed" ? "passed" : "failed",
    duration_ms: duration,
    log_hash: logHash,
  };
  void broadcastCiFrame(state, completedMsg).catch(() => {});

  // Cleanup log buffer
  state.ci.deleteLogBuffer(run.run_id);
}

// ---------- CI frame broadcast helpers ----------

async function broadcastCiFrame(state: SchedulerCtx, msg: CiMessage): Promise<void> {
  const me = state.config.self.name;
  for (const p of state.config.peers) {
    if (p.name === me) continue;
    try {
      const frame = await signFrame(me, p.name, { kind: "CiFrame", msg }, state.identity.privateKey);
      const entry = state.peers.get(p.name);
      if (!entry) continue;
      for (const addr of entry.addresses) {
        const { baseUrl } = normalizePeerUrl(addr, state.config.transport.tls);
        const bytes = encodeFrame(frame);
        const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: bytes,
          tls: { rejectUnauthorized: false },
        };
        try {
          const resp = await fetch(`${baseUrl}/mesh/frame`, init);
          if (resp.ok) break;
        } catch { /* try next */ }
      }
    } catch (e) {
      console.debug(`CI broadcast to ${p.name} failed:`, (e as Error).message);
    }
  }
}

// ---------- inbound CiAssignment handler ----------

export async function handleAssignment(
  state: SchedulerCtx,
  msg: Extract<CiMessage, { type: "CiAssignment" }>,
  sender?: string,
): Promise<void> {
  const cfg = state.config.runner;
  const me = state.config.self.name;

  const decline = async (reason: string) => {
    console.log(`[ci] declining assignment ${msg.run_id} from ${sender ?? "unknown"}: ${reason}`);
    if (!sender) return;
    const declineMsg: CiMessage = { type: "CiDeclined", run_id: msg.run_id, runner: me, reason };
    try {
      const frame = await signFrame(me, sender, { kind: "CiFrame", msg: declineMsg }, state.identity.privateKey);
      const entry = state.peers.get(sender);
      if (!entry) return;
      for (const addr of entry.addresses) {
        const { baseUrl } = normalizePeerUrl(addr, state.config.transport.tls);
        const bytes = encodeFrame(frame);
        const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: bytes,
          tls: { rejectUnauthorized: false },
        };
        try { const r = await fetch(`${baseUrl}/mesh/frame`, init); if (r.ok) break; } catch { /* try next */ }
      }
    } catch { /* best effort */ }
  };

  if (!cfg.enabled) { await decline("runner not enabled"); return; }

  const running = state.ci.allRuns().filter((r) => r.status === "running").length;
  if (running >= cfg.max_concurrent_jobs) { await decline("at capacity"); return; }

  console.log(`[ci] accepted assignment ${msg.run_id} for ${msg.repo} @ ${msg.ref} from ${sender ?? "self"}`);

  // Send CiAccepted back to sender
  if (sender) {
    const acceptMsg: CiMessage = { type: "CiAccepted", run_id: msg.run_id, runner: me };
    try {
      const frame = await signFrame(me, sender, { kind: "CiFrame", msg: acceptMsg }, state.identity.privateKey);
      const entry = state.peers.get(sender);
      if (entry) {
        for (const addr of entry.addresses) {
          const { baseUrl } = normalizePeerUrl(addr, state.config.transport.tls);
          const bytes = encodeFrame(frame);
          const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: bytes,
            tls: { rejectUnauthorized: false },
          };
          try { const r = await fetch(`${baseUrl}/mesh/frame`, init); if (r.ok) break; } catch { /* try next */ }
        }
      }
    } catch { /* best effort */ }
  }

  const run: PipelineRun = {
    run_id: msg.run_id,
    repo: msg.repo,
    ref: msg.ref,
    sha: msg.sha,
    triggered_by: msg.triggered_by,
    runner: me,
    status: "pending",
    started_at: new Date().toISOString(),
    jobs: {},
  };
  state.ci.setRun(run);

  // Broadcast CiStarted to all peers
  const startedMsg: CiMessage = { type: "CiStarted", run_id: run.run_id, repo: run.repo, runner: me, started_at: run.started_at };
  void broadcastCiFrame(state, startedMsg).catch(() => {});

  void runLocalPipeline(state, msg.pipeline, run);
}
