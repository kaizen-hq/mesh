// Push-triggered scheduling, capability matching, assignment protocol.

import type { DaemonState } from "../state.ts";
import type { Pipeline, PipelineRun, TriggerKind, NodeCapabilities, RunnerRequirements } from "./types.ts";
import type { CiMessage } from "../proto.ts";
import { signFrame } from "../proto.ts";
import { loadPipeline } from "./config.ts";
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

// ---------- build peer capability entries from DaemonState ----------

function peerCapabilities(state: DaemonState): PeerCapabilityEntry[] {
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
      max_concurrent_jobs: state.ciConfig?.runner.max_concurrent_jobs ?? 2,
    });
  }
  return entries;
}

// ---------- ref update hook ----------

const ASSIGNMENT_TIMEOUT_MS = 5000;

export async function onRefUpdate(
  state: DaemonState,
  repo: string,
  ref: string,
  sha: string,
): Promise<void> {
  // Find the repo path to load mesh-ci.yml
  const repoCfg = state.config.repos.find((r) => r.name === repo);
  if (!repoCfg) return;

  const repoAbsPath = path.isAbsolute(repoCfg.path)
    ? repoCfg.path
    : path.join(os.homedir(), repoCfg.path);
  const pipeline = await loadPipeline(repoAbsPath).catch(() => null);
  if (!pipeline) return;
  if (!pipeline.on.push) return;
  if (!matchesBranch(ref, pipeline.on.push.branches)) return;

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
  const selectedPeer = selectRunner(candidates, pipeline.runner);

  if (selectedPeer) {
    await sendAssignment(state, selectedPeer, run, pipeline, trigger);
  } else {
    // Run locally as fallback
    scheduleLocalRun(state, pipeline, run);
  }
}

async function sendAssignment(
  state: DaemonState,
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
  if (!entry) return;

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
      if (resp.ok) { clearTimeout(timer); return; }
    } catch { /* try next addr */ } finally { clearTimeout(timer); }
  }
}

function scheduleLocalRun(state: DaemonState, pipeline: Pipeline, run: PipelineRun): void {
  state.ci.runs.set(run.run_id, run);
  state.notifyCiRunChanged(run.repo);
  void runLocalPipeline(state, pipeline, run);
}

async function runLocalPipeline(state: DaemonState, pipeline: Pipeline, run: PipelineRun): Promise<void> {
  const { runPipeline } = await import("./engine.ts");
  const repoCfg = state.config.repos.find((r) => r.name === run.repo);
  if (!repoCfg) return;
  const mirrorPath = repoStore.mirrorPath(state.root, run.repo);

  // Ensure the mirror has commits before creating a worktree. The fetch loop
  // runs every 60s, so on a fresh start the mirror may be empty. Fetch from
  // the working copy now so the worktree has something to check out.
  const workingCopyPath = path.isAbsolute(repoCfg.path)
    ? repoCfg.path
    : path.join(os.homedir(), repoCfg.path);
  try {
    await git.fetchIntoBare(mirrorPath, workingCopyPath);
  } catch {
    // Non-fatal: mirror may already be up to date or working copy may not exist.
  }

  const worktreePath = mirrorPath;

  const started = Date.now();
  const completed = await runPipeline(pipeline, run, {
    root: state.root,
    repoPath: worktreePath,
    runnerConfig: state.ciConfig!.runner,
    secrets: state.ciConfig!.secrets,
    onRunUpdate: async (updated) => {
      state.ci.runs.set(updated.run_id, updated);
      state.notifyCiRunChanged(updated.repo);
    },
  });

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
    duration_ms: Date.now() - started,
    log_hash: logHash,
  };
  void broadcastCiFrame(state, completedMsg).catch(() => {});

  // Cleanup log buffer
  state.ci.log_buffers.delete(run.run_id);
}

// ---------- CI frame broadcast helpers ----------

async function broadcastCiFrame(state: DaemonState, msg: CiMessage): Promise<void> {
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
  state: DaemonState,
  msg: Extract<CiMessage, { type: "CiAssignment" }>,
  sender?: string,
): Promise<void> {
  const cfg = state.ciConfig;
  const me = state.config.self.name;

  const decline = async (reason: string) => {
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

  if (!cfg?.runner.enabled) { await decline("runner not enabled"); return; }

  const running = [...state.ci.runs.values()].filter((r) => r.status === "running").length;
  if (running >= cfg.runner.max_concurrent_jobs) { await decline("at capacity"); return; }

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
  state.ci.runs.set(run.run_id, run);

  // Broadcast CiStarted to all peers
  const startedMsg: CiMessage = { type: "CiStarted", run_id: run.run_id, repo: run.repo, runner: me, started_at: run.started_at };
  void broadcastCiFrame(state, startedMsg).catch(() => {});

  void runLocalPipeline(state, msg.pipeline, run);
}
