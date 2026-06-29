// Bare repo mirrors at ~/.mesh/repos/<name>.git.

import * as path from "node:path";
import { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import type { Divergence, RepoRegistry } from "./repo_registry.ts";
import { normalizePeerUrl, type Config } from "./config.ts";
import type { RepoStatus, BranchStatus } from "./proto.ts";
import type { PeerRegistry } from "./peer_registry.ts";
import * as git from "./git.ts";

export interface RepoStoreCtx {
  config: Config;
  root: string;
  repos: RepoRegistry;
  peers: PeerRegistry;
}

// ---------- paths ----------

export function mirrorPath(root: string, repo: string): string {
  return path.join(root, "repos", `${repo}.git`);
}

function metaPath(root: string, repo: string): string {
  return path.join(root, "repos", `${repo}.meta.json`);
}

// ---------- repo metadata ----------

export interface RepoMeta {
  introduced_by: string;
  introduced_at: string;
}

export async function loadRepoMeta(root: string, repo: string): Promise<RepoMeta | null> {
  try {
    const raw = await fs.readFile(metaPath(root, repo), "utf8");
    return JSON.parse(raw) as RepoMeta;
  } catch {
    return null;
  }
}

export async function saveRepoMeta(root: string, repo: string, meta: RepoMeta): Promise<void> {
  const file = metaPath(root, repo);
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(meta), "utf8");
  await fs.rename(tmp, file);
}

// ---------- startup scan ----------

/** Scan ~/.mesh/repos/ and return the names of all existing bare mirrors. */
export async function scanMirrors(root: string): Promise<string[]> {
  const dir = path.join(root, "repos");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const e of entries) {
    if (e.isDirectory() && e.name.endsWith(".git")) {
      names.push(e.name.slice(0, -4));
    }
  }
  return names;
}

// ---------- mirror lifecycle ----------

export async function ensureMirrors(state: RepoStoreCtx): Promise<void> {
  // Init bare mirrors for all repos already in the registry (discovered from
  // peers or pre-populated by scanMirrors at startup). Does not consult config.
  for (const name of state.repos.keys()) {
    const dir = mirrorPath(state.root, name);
    await git.initBare(dir);
  }
}

// ---------- sync ----------

export async function fetchAll(state: RepoStoreCtx): Promise<void> {
  const me = state.config.self.name;

  // Fetch all known repos from any reachable peer that advertises them.
  for (const [name, local] of state.repos.entries()) {
    const dir = mirrorPath(state.root, name);
    if (!(await exists(dir))) {
      try {
        await git.initBare(dir);
      } catch (e) {
        console.warn(`init bare ${dir} failed:`, (e as Error).message);
        continue;
      }
    }
    for (const source of local.sourceList()) {
      if (source === me) continue;
      const peer = state.peers.get(source);
      if (!peer || !peer.isConnected()) continue;
      try {
        const out = await reconcileFromPeer(state, source, name);
        if (out.divergent.length > 0) {
          console.warn(
            `repo ${name} peer ${source}: ${out.divergent.length} divergent branch(es) parked under refs/replicas/`,
          );
        }
        await markFresh(state, name, dir);
        break;
      } catch (e) {
        console.debug(`reconcile ${name} from ${source} failed:`, (e as Error).message);
      }
    }
  }
}

async function markFresh(state: RepoStoreCtx, name: string, dir: string): Promise<void> {
  const local = state.repos.ensure(name);
  local.lastFetch = Date.now();
  const head = await git.headSha(dir);
  if (head) local.lastHead = head;
}

// ---------- reconcile from peer ----------

export interface ReconcileOutcome {
  advanced: string[];
  divergent: Divergence[];
}

export async function reconcileFromPeer(
  state: RepoStoreCtx,
  peer: string,
  repo: string,
): Promise<ReconcileOutcome> {
  const dir = mirrorPath(state.root, repo);
  if (!(await exists(dir))) await git.initBare(dir);

  const peerEntry = state.peers.get(peer);
  if (!peerEntry || peerEntry.addresses.length === 0) {
    throw new Error(`no address for peer ${peer}`);
  }
  const { baseUrl } = normalizePeerUrl(peerEntry.addresses[0]!, state.config.transport.tls);
  const url = `${baseUrl}/${repo}.git`;
  const remotesRefspec = `+refs/heads/*:refs/remotes/${peer}/*`;

  const exit = await Bun.spawn(
    [
      "git",
      "fetch",
      "--prune",
      url,
      remotesRefspec,
    ],
    {
      cwd: dir,
      env: { ...process.env, GIT_SSL_NO_VERIFY: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  ).exited;
  if (exit !== 0) {
    throw new Error(`git fetch ${remotesRefspec} from ${url} into ${dir} failed`);
  }

  const advanced: string[] = [];
  const divergent: Divergence[] = [];
  const remotePrefix = `refs/remotes/${peer}/`;
  const remoteRefs = await git.listRefs(dir, remotePrefix);

  for (const [branch, theirSha] of remoteRefs) {
    const localRef = `refs/heads/${branch}`;
    const replicaRef = `refs/replicas/${peer}/heads/${branch}`;
    const localSha = await git.refSha(dir, localRef);
    if (!localSha) {
      await git.updateRef(dir, localRef, theirSha);
      advanced.push(branch);
      await git.deleteRef(dir, replicaRef);
      continue;
    }
    if (localSha === theirSha) {
      await git.deleteRef(dir, replicaRef);
      continue;
    }
    if (await git.isAncestor(dir, localSha, theirSha)) {
      await git.updateRef(dir, localRef, theirSha);
      advanced.push(branch);
      await git.deleteRef(dir, replicaRef);
    } else if (await git.isAncestor(dir, theirSha, localSha)) {
      await git.deleteRef(dir, replicaRef);
    } else {
      await git.updateRef(dir, replicaRef, theirSha);
      divergent.push({
        peer,
        branch,
        replica_ref: replicaRef,
        their_sha: theirSha,
      });
    }
  }

  const local = state.repos.ensure(repo);
  local.setDivergencesForPeer(peer, divergent);
  return { advanced, divergent };
}

// ---------- repo status for heartbeat ----------

export async function repoStatuses(state: RepoStoreCtx): Promise<RepoStatus[]> {
  const out: RepoStatus[] = [];
  for (const [name] of state.repos.entries()) {
    const dir = mirrorPath(state.root, name);
    const head_sha = (await git.headSha(dir)) ?? null;
    const branchPairs = await git.branchHeads(dir);
    const branches: BranchStatus[] = branchPairs.map(([n, s]) => ({ name: n, sha: s }));
    out.push({ name, head_sha, branches });
  }
  return out;
}

export async function resetRepo(state: RepoStoreCtx, name: string): Promise<void> {
  const dir = mirrorPath(state.root, name);
  if (await exists(dir)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  await git.initBare(dir);
}

// ---------- ref snapshot diff ----------

// Diff two `refs/heads/*` snapshots so we can build a RefUpdate gossip frame
// after a successful receive-pack.
export function diffRefSnapshots(
  before: Array<[string, string]>,
  after: Array<[string, string]>,
): Array<{ name: string; old_sha: string; new_sha: string }> {
  const zero = "0000000000000000000000000000000000000000";
  const beforeMap = new Map(before);
  const afterMap = new Map(after);
  const changes: Array<{ name: string; old_sha: string; new_sha: string }> = [];
  for (const [name, newSha] of afterMap) {
    const oldSha = beforeMap.get(name);
    if (oldSha !== newSha) {
      changes.push({
        name,
        old_sha: oldSha ?? zero,
        new_sha: newSha,
      });
    }
  }
  for (const [name, oldSha] of beforeMap) {
    if (!afterMap.has(name)) {
      changes.push({ name, old_sha: oldSha, new_sha: zero });
    }
  }
  return changes;
}

// ---------- fetch loop ----------

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function runFetchLoop(state: RepoStoreCtx, secs: number): Promise<void> {
  const interval = Math.max(5, secs) * 1000;
  while (true) {
    try {
      await fetchAll(state);
    } catch (e) {
      console.warn("periodic fetch failed:", (e as Error).message);
    }
    await sleep(interval);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
