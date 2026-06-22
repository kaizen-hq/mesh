// Bare repo mirrors at ~/.mesh/repos/<name>.git. Mirror of src/repo_store.rs.

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { Divergence, RepoRegistry } from "./repo_registry.ts";
import { findRepo, normalizePeerUrl, type Config } from "./config.ts";
import type { RepoStatus, BranchStatus } from "./proto.ts";
import type { PeerRegistry } from "./peer_registry.ts";
import * as git from "./git.ts";

export interface RepoStoreCtx {
  config: Config;
  root: string;
  repos: RepoRegistry;
  peers: PeerRegistry;
}

export function mirrorPath(root: string, repo: string): string {
  return path.join(root, "repos", `${repo}.git`);
}

export async function ensureMirrors(state: RepoStoreCtx): Promise<void> {
  for (const r of state.config.repos) {
    const dir = mirrorPath(state.root, r.name);
    await git.initBare(dir);
    state.repos.ensure(r.name);
  }
  for (const name of state.repos.keys()) {
    const dir = mirrorPath(state.root, name);
    await git.initBare(dir);
  }
}

export async function fetchAll(state: RepoStoreCtx): Promise<void> {
  const home = os.homedir();
  const me = state.config.self.name;

  // 1) Contributed repos: fetch from working copy.
  for (const r of state.config.repos) {
    const dir = mirrorPath(state.root, r.name);
    const src = path.join(home, r.path);
    const present = (await exists(path.join(src, ".git"))) || (await exists(path.join(src, "HEAD")));
    if (!present) {
      continue;
    }
    try {
      await git.fetchIntoBare(dir, src);
      await markFresh(state, r.name, dir);
    } catch (e) {
      console.warn(`fetch from working copy ${src} failed:`, (e as Error).message);
    }
  }

  // 2) Discovered repos: fetch from any reachable advertising peer.
  for (const [name, local] of state.repos.entries()) {
    if (findRepo(state.config, name)) continue;
    const dir = mirrorPath(state.root, name);
    if (!(await exists(dir))) {
      try {
        await git.initBare(dir);
      } catch (e) {
        console.warn(`init bare ${dir} failed:`, (e as Error).message);
        continue;
      }
    }
    let fetched = false;
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
        fetched = true;
        break;
      } catch (e) {
        console.debug(`reconcile ${name} from ${source} failed:`, (e as Error).message);
      }
    }
    if (!fetched) {
      console.debug(`no reachable source for ${name}`);
    }
  }
}

async function markFresh(state: RepoStoreCtx, name: string, dir: string): Promise<void> {
  const local = state.repos.ensure(name);
  local.lastFetch = Date.now();
  const head = await git.headSha(dir);
  if (head) local.lastHead = head;
}

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

export async function repoStatuses(state: RepoStoreCtx): Promise<RepoStatus[]> {
  const out: RepoStatus[] = [];
  for (const r of state.config.repos) {
    const dir = mirrorPath(state.root, r.name);
    const head_sha = (await git.headSha(dir)) ?? null;
    const branchPairs = await git.branchHeads(dir);
    const branches: BranchStatus[] = branchPairs.map(([n, s]) => ({ name: n, sha: s }));
    out.push({ name: r.name, head_sha, branches });
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
  // initial pass immediately
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
