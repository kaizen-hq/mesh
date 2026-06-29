// Daemon: the Mediator orchestrator. Composes the four domain objects and
// owns all cross-domain coordination — config reload, address persistence,
// and SSE notifications. Callers interact with domain objects through Daemon
// rather than constructing or wiring them directly.

import type { Config } from "./config.ts";
import { loadPendingInvites, savePendingInvites } from "./config.ts";
import type { Identity } from "./identity.ts";
import type { PersistedInvite } from "./config.ts";
import { PeerRegistry } from "./peer_registry.ts";
import { RepoRegistry } from "./repo_registry.ts";
import { OutboundQueues } from "./outbound_queues.ts";
import { CiDomain } from "./ci/ci_domain.ts";

export type PendingInvite = PersistedInvite;

export class Daemon {
  readonly peers: PeerRegistry;
  readonly repos: RepoRegistry;
  readonly outbound: OutboundQueues;
  readonly ci: CiDomain;

  root: string;
  config: Config;
  identity: Identity;
  listenAddr: string | null = null;
  pendingInvites: Map<string, PendingInvite> = new Map();

  // SSE callbacks — registered by http_server, fired by Daemon.
  issueChangedCallbacks: Array<(repo: string) => void> = [];
  statusChangedCallbacks: Array<() => void> = [];
  ciRunChangedCallbacks: Array<(repo: string) => void> = [];

  private shutdownResolve: (() => void) | null = null;
  private shutdownPromise: Promise<void>;

  private constructor(
    root: string,
    config: Config,
    identity: Identity,
    peers: PeerRegistry,
    repos: RepoRegistry,
  ) {
    this.root = root;
    this.config = config;
    this.identity = identity;
    this.peers = peers;
    this.repos = repos;
    this.outbound = new OutboundQueues();
    this.ci = new CiDomain();
    this.shutdownPromise = new Promise((res) => (this.shutdownResolve = res));
  }

  static async create(root: string, config: Config, identity: Identity): Promise<Daemon> {
    const peers = await PeerRegistry.create(root, config);
    const repos = RepoRegistry.create();
    const daemon = new Daemon(root, config, identity, peers, repos);
    daemon.pendingInvites = await loadPendingInvites(root);
    return daemon;
  }

  // ---------- cross-domain operations ----------

  /** Reload config, refresh the peer list, and optionally persist invites. */
  reloadConfig(next: Config): void {
    this.config = next;
    this.peers.refresh(next);
  }

  /** Update peer address and persist to disk. Returns false if unchanged or peer unknown. */
  async recordPeerAddress(peer: string, address: string): Promise<boolean> {
    return this.peers.recordAddress(peer, address);
  }

  /** Persist the current pending invites map to disk. */
  async savePendingInvites(): Promise<void> {
    await savePendingInvites(this.root, this.pendingInvites);
  }

  // ---------- notifications (Mediator dispatches explicitly) ----------

  notifyIssueChanged(repo: string): void {
    for (const cb of this.issueChangedCallbacks) cb(repo);
  }

  notifyStatusChanged(): void {
    for (const cb of this.statusChangedCallbacks) cb();
  }

  notifyCiRunChanged(repo: string): void {
    for (const cb of this.ciRunChangedCallbacks) cb(repo);
  }

  // ---------- lifecycle ----------

  signalShutdown(): void {
    this.shutdownResolve?.();
  }

  onShutdown(): Promise<void> {
    return this.shutdownPromise;
  }
}
