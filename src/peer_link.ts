// Push-only peer link: POST signed Frames to peers, retry on failure with
// exponential backoff. Mirror of src/peer_link.rs.

import type { DaemonState } from "./state.ts";
import { normalizePeerUrl } from "./config.ts";
import {
  encodeFrame,
  signFrame,
  PROTOCOL_VERSION,
  type Frame,
  type Message,
  type RefChange,
  type RepoStatus,
  type IssueEvent,
} from "./proto.ts";
import * as repoStore from "./repo_store.ts";
import * as git from "./git.ts";
import * as issues from "./issues.ts";

const HTTP_TIMEOUT_MS = 10_000;
const RETRY_TICK_SECS = 2;
const RETRY_BACKOFF_MAX_SECS = 60;

// ---------- inbound frame handling ----------

export async function handleInboundFrame(
  state: DaemonState,
  sender: string,
  msg: Message,
): Promise<void> {
  const peerEntry = state.peers.get(sender);
  peerEntry?.notePostSeen();
  switch (msg.kind) {
    case "Hello":
      peerEntry?.noteHeartbeat(null, msg.config_hash);
      break;
    case "Heartbeat":
      peerEntry?.noteHeartbeat(null, msg.config_hash);
      for (const r of msg.repos) {
        state.ensureRepo(r.name).noteSource(sender);
      }
      scheduleReconcileIfStale(state, sender, msg.repos);
      scheduleIssueSyncIfStale(state, sender, msg.repos);
      state.notifyStatusChanged();
      break;
    case "RefUpdate":
      // run async; do not block the HTTP handler
      void handleInboundRefUpdate(state, sender, msg.repo, msg.refs);
      break;
    case "IssueEvent":
      void (async () => {
        try {
          await issues.applyIssueEvent(state.root, msg.event);
          state.notifyIssueChanged(msg.event.repo);
        } catch (e) {
          console.warn(`apply IssueEvent failed (repo=${msg.event.repo}):`, (e as Error).message);
        }
      })();
      break;
  }
}

async function handleInboundRefUpdate(
  state: DaemonState,
  sender: string,
  repo: string,
  _refs: RefChange[],
): Promise<void> {
  const local = state.ensureRepo(repo);
  local.noteSource(sender);

  let outcome;
  try {
    outcome = await repoStore.reconcileFromPeer(state, sender, repo);
  } catch (e) {
    console.warn(
      `reconcile after RefUpdate failed (repo=${repo} peer=${sender}):`,
      (e as Error).message,
    );
    return;
  }

  if (outcome.advanced.length > 0) {
    const dir = repoStore.mirrorPath(state.root, repo);
    const changes: Array<{ name: string; old_sha: string; new_sha: string }> = [];
    for (const branch of outcome.advanced) {
      const sha = await git.refSha(dir, `refs/heads/${branch}`);
      if (sha) {
        changes.push({ name: branch, old_sha: "", new_sha: sha });
      }
    }
    if (changes.length > 0) {
      broadcastRefUpdate(state, repo, changes, sender);
    }
  }
  for (const d of outcome.divergent) {
    console.info(
      `repo=${repo} peer=${d.peer} branch=${d.branch}: divergence parked at ${d.replica_ref}`,
    );
  }

  const dir = repoStore.mirrorPath(state.root, repo);
  const head = await git.headSha(dir);
  if (head) local.lastHead = head;
  local.lastFetch = Date.now();
  state.notifyStatusChanged();
}

function scheduleReconcileIfStale(
  state: DaemonState,
  peer: string,
  advertised: RepoStatus[],
): void {
  // Fire-and-forget; reconciliation can take a few seconds.
  void (async () => {
    for (const r of advertised) {
      const dir = repoStore.mirrorPath(state.root, r.name);
      let stale = false;
      try {
        await Bun.file(dir).exists();
      } catch {
        // ignore
      }
      // Always reconcile if we don't already have it.
      const haveDir = await Bun.file(dir + "/HEAD").exists();
      if (!haveDir) {
        stale = true;
      } else {
        for (const b of r.branches) {
          const local = await git.refSha(dir, `refs/heads/${b.name}`);
          if (local !== b.sha) {
            stale = true;
            break;
          }
        }
      }
      if (!stale) continue;
      // Skip repos we contribute ourselves — our working copy wins.
      if (state.config.repos.some((cr) => cr.name === r.name)) continue;
      try {
        await repoStore.reconcileFromPeer(state, peer, r.name);
      } catch (e) {
        console.debug(
          `heartbeat-triggered reconcile failed (repo=${r.name} peer=${peer}):`,
          (e as Error).message,
        );
      }
    }
  })();
}

// ---------- outbound push ----------

async function postFrame(baseUrl: string, frame: Frame): Promise<boolean> {
  const bytes = encodeFrame(frame);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  // Bun's fetch accepts an extra `tls` option to skip cert verification —
  // identity comes from frame signatures, not TLS. The option isn't part of
  // the standard `RequestInit`, so we widen the type locally.
  const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
    signal: controller.signal,
    tls: { rejectUnauthorized: false },
  };
  try {
    const resp = await fetch(`${baseUrl}/mesh/frame`, init);
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function sendTo(state: DaemonState, peer: string, frame: Frame): Promise<void> {
  const entry = state.peers.get(peer);
  if (!entry || entry.addresses.length === 0) {
    state.enqueueFor(peer, frame);
    return;
  }
  for (const addr of entry.addresses) {
    const { baseUrl } = normalizePeerUrl(addr, state.config.transport.tls);
    const ok = await postFrame(baseUrl, frame);
    if (ok) {
      entry.notePostOk();
      // Promote the working address to front for future sends.
      if (entry.addAddress(addr)) {
        await state.recordPeerAddress(peer, addr);
      }
      return;
    }
  }
  state.enqueueFor(peer, frame);
}

// ---------- retry loop ----------

export async function runRetryLoop(state: DaemonState): Promise<void> {
  const backoffs = new Map<string, number>(); // peer → backoff secs
  const lastAttempt = new Map<string, number>(); // peer → epoch ms

  while (true) {
    await sleep(RETRY_TICK_SECS * 1000);

    const peers = [...state.outbound.keys()];
    for (const peer of peers) {
      const backoff = backoffs.get(peer) ?? 0;
      if (backoff > 0) {
        const last = lastAttempt.get(peer) ?? 0;
        if (Date.now() - last < backoff * 1000) continue;
      }

      const q = state.outbound.get(peer);
      if (!q) {
        backoffs.delete(peer);
        lastAttempt.delete(peer);
        continue;
      }
      const frames = q.drain();
      if (frames.length === 0) {
        backoffs.delete(peer);
        lastAttempt.delete(peer);
        continue;
      }

      const entry = state.peers.get(peer);
      if (!entry || entry.addresses.length === 0) {
        for (const f of frames) state.enqueueFor(peer, f);
        continue;
      }

      // Try each known address in order; on success promote it to front.
      let remaining = frames;
      let successAddr: string | null = null;
      for (const addr of entry.addresses) {
        const { baseUrl } = normalizePeerUrl(addr, state.config.transport.tls);
        let i = 0;
        for (; i < remaining.length; i++) {
          const ok = await postFrame(baseUrl, remaining[i]!);
          if (!ok) break;
        }
        if (i === remaining.length) {
          successAddr = addr;
          remaining = [];
          break;
        }
        // This address failed at frame i; try next address from frame i onward.
        remaining = remaining.slice(i);
      }
      // Re-enqueue anything that couldn't be delivered.
      for (const f of remaining) state.enqueueFor(peer, f);

      lastAttempt.set(peer, Date.now());
      if (successAddr !== null) {
        entry.notePostOk();
        if (entry.addAddress(successAddr)) {
          await state.recordPeerAddress(peer, successAddr);
        }
        backoffs.delete(peer);
      } else {
        const next = Math.min(Math.max(backoff, 1) * 2, RETRY_BACKOFF_MAX_SECS);
        backoffs.set(peer, next);
      }
    }
  }
}

// ---------- heartbeat / hello ----------

export async function runHeartbeat(state: DaemonState, secs: number): Promise<void> {
  const intervalMs = Math.max(1, secs) * 1000;
  while (true) {
    await sleep(intervalMs);
    const me = state.config.self.name;
    const raw_hash = state.config.raw_hash;
    const repos = await repoStore.repoStatuses(state);

    for (const p of state.config.peers) {
      if (p.name === me) continue;
      const msg: Message = {
        kind: "Heartbeat",
        name: me,
        config_hash: raw_hash,
        repos,
      };
      let frame: Frame;
      try {
        frame = await signFrame(me, p.name, msg, state.identity.privateKey);
      } catch (e) {
        console.warn("sign heartbeat failed:", (e as Error).message);
        continue;
      }
      await sendTo(state, p.name, frame);
    }
  }
}

export async function runInitialHello(state: DaemonState): Promise<void> {
  const me = state.config.self.name;
  for (const p of state.config.peers) {
    if (p.name === me) continue;
    const msg: Message = {
      kind: "Hello",
      name: me,
      config_hash: state.config.raw_hash,
      version: PROTOCOL_VERSION,
    };
    try {
      const frame = await signFrame(me, p.name, msg, state.identity.privateKey);
      await sendTo(state, p.name, frame);
    } catch (e) {
      console.debug(`initial hello to ${p.name} failed:`, (e as Error).message);
    }
  }
}

// ---------- RefUpdate broadcast ----------

export function broadcastRefUpdate(
  state: DaemonState,
  repo: string,
  refs: Array<{ name: string; old_sha: string; new_sha: string }>,
  skip: string | null,
): void {
  if (refs.length === 0) return;
  void (async () => {
    const me = state.config.self.name;
    for (const p of state.config.peers) {
      if (p.name === me) continue;
      if (skip != null && p.name === skip) continue;
      const msg: Message = {
        kind: "RefUpdate",
        repo,
        refs,
      };
      try {
        const frame = await signFrame(me, p.name, msg, state.identity.privateKey);
        await sendTo(state, p.name, frame);
      } catch (e) {
        console.debug(`RefUpdate to ${p.name} failed:`, (e as Error).message);
      }
    }
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------- issue event broadcast ----------

export function broadcastIssueEvent(state: DaemonState, event: IssueEvent): void {
  void (async () => {
    const me = state.config.self.name;
    for (const p of state.config.peers) {
      if (p.name === me) continue;
      const msg: Message = { kind: "IssueEvent", event };
      try {
        const frame = await signFrame(me, p.name, msg, state.identity.privateKey);
        await sendTo(state, p.name, frame);
      } catch (e) {
        console.debug(`IssueEvent broadcast to ${p.name} failed:`, (e as Error).message);
      }
    }
  })();
}

// ---------- issue full sync (pull) ----------

export async function pullIssuesFromPeer(
  state: DaemonState,
  peer: string,
  repo: string,
): Promise<void> {
  const entry = state.peers.get(peer);
  if (!entry || entry.addresses.length === 0) return;

  for (const addr of entry.addresses) {
    const { baseUrl } = normalizePeerUrl(addr, state.config.transport.tls);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
      signal: controller.signal,
      tls: { rejectUnauthorized: false },
    };
    try {
      const resp = await fetch(
        `${baseUrl}/mesh/issues/${encodeURIComponent(repo)}/all`,
        init,
      );
      if (!resp.ok) continue;
      const peerIssues = (await resp.json()) as issues.IssueWire[];
      await issues.mergeFromPeer(state.root, repo, peerIssues);
      state.notifyIssueChanged(repo);
      return;
    } catch (e) {
      console.debug(`issue pull ${peer}/${repo} at ${addr} failed:`, (e as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }
}

function scheduleIssueSyncIfStale(
  state: DaemonState,
  peer: string,
  advertised: RepoStatus[],
): void {
  const entry = state.peers.get(peer);
  if (!entry) return;
  const now = Date.now();
  // Throttle: only pull once per minute per peer
  if (entry.lastIssueSyncMs !== null && now - entry.lastIssueSyncMs < 60_000) return;

  void (async () => {
    const ourRepos = new Set(state.repos.keys());
    for (const r of advertised) {
      if (!ourRepos.has(r.name)) continue;
      try {
        await pullIssuesFromPeer(state, peer, r.name);
      } catch (e) {
        console.debug(`issue sync ${peer}/${r.name} failed:`, (e as Error).message);
      }
    }
    entry.lastIssueSyncMs = now;
  })();
}
