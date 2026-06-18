// In-memory state: peers, repo statuses, divergences, outbound retry queues.

import * as os from "node:os";
import * as path from "node:path";
import type { Frame } from "./proto.ts";
import type { Config, AddressCache } from "./config.ts";
import { loadAddressCache, saveAddressCache } from "./config.ts";
import type { Identity } from "./identity.ts";
import type { NodeCapabilities, CiState, CicdConfig } from "./ci/types.ts";
import { emptyCiState } from "./ci/types.ts";

export interface Divergence {
  peer: string;
  branch: string;
  replica_ref: string;
  their_sha: string;
}

export class RepoLocal {
  lastFetch: number | null = null; // millis since epoch
  lastHead: string | null = null;
  sources: Set<string> = new Set();
  divergences: Divergence[] = [];

  noteSource(peer: string) {
    this.sources.add(peer);
  }
  sourceList(): string[] {
    return [...this.sources].sort();
  }
  divergenceList(): Divergence[] {
    return [...this.divergences];
  }
  setDivergencesForPeer(peer: string, next: Divergence[]) {
    this.divergences = [...this.divergences.filter((d) => d.peer !== peer), ...next];
  }
}

export class PeerEntry {
  addresses: string[] = [];
  lastHeartbeat: number | null = null;
  lastPostOk: number | null = null;
  lastPostSeen: number | null = null;
  lastConfigHash: string | null = null;
  lastIssueSyncMs: number | null = null; // epoch ms of last successful issue full-sync pull
  capabilities: NodeCapabilities | null = null;

  isConnected(): boolean {
    const recent = (t: number | null) => t != null && Date.now() - t < 60_000;
    return recent(this.lastPostOk) || recent(this.lastPostSeen);
  }
  notePostOk() {
    this.lastPostOk = Date.now();
  }
  notePostSeen() {
    this.lastPostSeen = Date.now();
  }
  /** Prepend addr to the addresses list if it isn't already first. Returns true if changed. */
  addAddress(addr: string): boolean {
    if (this.addresses[0] === addr) return false;
    this.addresses = [addr, ...this.addresses.filter((a) => a !== addr)];
    return true;
  }
  noteHeartbeat(addr: string | null, cfgHash: string | null): boolean {
    this.lastHeartbeat = Date.now();
    let changed = false;
    if (addr != null) changed = this.addAddress(addr);
    if (cfgHash != null) this.lastConfigHash = cfgHash;
    return changed;
  }
}

const OUTBOUND_QUEUE_CAP = 4096;

export class OutboundQueue {
  frames: Frame[] = [];

  push(f: Frame) {
    this.frames.push(f);
    while (this.frames.length > OUTBOUND_QUEUE_CAP) this.frames.shift();
  }
  drain(): Frame[] {
    const out = this.frames;
    this.frames = [];
    return out;
  }
}

export interface PendingInvite {
  expiryMs: number;
  address: string;
}

export class DaemonState {
  root: string;
  config: Config;
  identity: Identity;
  peers: Map<string, PeerEntry> = new Map();
  repos: Map<string, RepoLocal> = new Map();
  addressCache: AddressCache = { addresses: {} };
  outbound: Map<string, OutboundQueue> = new Map();
  listenAddr: string | null = null;
  pendingInvites: Map<string, PendingInvite> = new Map();
  issueChangedCallbacks: Array<(repo: string) => void> = [];
  statusChangedCallbacks: Array<() => void> = [];
  // CI state
  ci: CiState = emptyCiState();
  ciConfig: CicdConfig | null = null;
  ciCapabilities: NodeCapabilities | null = null;
  // Callbacks for CI run changes (SSE)
  ciRunChangedCallbacks: Array<(repo: string) => void> = [];
  private shutdownResolve: (() => void) | null = null;
  private shutdownPromise: Promise<void>;

  constructor(root: string, config: Config, identity: Identity) {
    this.root = root;
    this.config = config;
    this.identity = identity;
    this.shutdownPromise = new Promise((res) => (this.shutdownResolve = res));
  }

  static async create(root: string, config: Config, identity: Identity): Promise<DaemonState> {
    const s = new DaemonState(root, config, identity);
    s.addressCache = await loadAddressCache(root);
    for (const p of config.peers) {
      if (p.name === config.self.name) continue;
      const entry = new PeerEntry();
      // Merge: cached addresses first (most recently seen), then static config addresses.
      const cached = s.addressCache.addresses[p.name] ?? [];
      const merged = [...cached, ...p.addresses.filter((a) => !cached.includes(a))];
      entry.addresses = merged;
      s.peers.set(p.name, entry);
    }
    for (const r of config.repos) {
      s.repos.set(r.name, new RepoLocal());
    }
    return s;
  }

  ensureRepo(name: string): RepoLocal {
    let r = this.repos.get(name);
    if (!r) {
      r = new RepoLocal();
      this.repos.set(name, r);
    }
    return r;
  }

  refreshPeers() {
    for (const p of this.config.peers) {
      if (p.name === this.config.self.name) continue;
      if (this.peers.has(p.name)) continue;
      const entry = new PeerEntry();
      const cached = this.addressCache.addresses[p.name] ?? [];
      entry.addresses = [...cached, ...p.addresses.filter((a) => !cached.includes(a))];
      this.peers.set(p.name, entry);
    }
  }

  enqueueFor(dest: string, frame: Frame) {
    let q = this.outbound.get(dest);
    if (!q) {
      q = new OutboundQueue();
      this.outbound.set(dest, q);
    }
    q.push(frame);
  }

  async recordPeerAddress(peer: string, address: string): Promise<boolean> {
    const entry = this.peers.get(peer);
    if (!entry) return false;
    if (!entry.addAddress(address)) return false;
    this.addressCache.addresses[peer] = entry.addresses;
    try {
      await saveAddressCache(this.root, this.addressCache);
    } catch (e) {
      console.warn("failed to persist address cache:", e);
    }
    return true;
  }

  notifyIssueChanged(repo: string): void {
    for (const cb of this.issueChangedCallbacks) cb(repo);
  }

  notifyStatusChanged(): void {
    for (const cb of this.statusChangedCallbacks) cb();
  }

  notifyCiRunChanged(repo: string): void {
    for (const cb of this.ciRunChangedCallbacks) cb(repo);
  }

  signalShutdown() {
    this.shutdownResolve?.();
  }

  onShutdown(): Promise<void> {
    return this.shutdownPromise;
  }
}

// ---------- root path resolution ----------

export function defaultRoot(): string {
  return path.join(os.homedir(), ".mesh");
}
