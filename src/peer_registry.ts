// PeerRegistry: owns the peer map and address cache persistence.
// Callers get a PeerEntry from get() and mutate it directly for in-process
// fields (capabilities, sync timestamps, etc.). Persistence only happens
// through recordAddress(), which is the only operation that writes to disk.

import type { Config, AddressCache } from "./config.ts";
import { loadAddressCache, saveAddressCache } from "./config.ts";
import type { NodeCapabilities } from "./ci/types.ts";

export class PeerEntry {
  addresses: string[] = [];
  lastHeartbeat: number | null = null;
  lastPostOk: number | null = null;
  lastPostSeen: number | null = null;
  lastConfigHash: string | null = null;
  lastIssueSyncMs: number | null = null; // epoch ms of last successful issue full-sync pull
  lastCiSyncMs: number | null = null;    // epoch ms of last successful CI runs full-sync pull
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

export class PeerRegistry {
  private peers: Map<string, PeerEntry> = new Map();
  private addressCache: AddressCache = { addresses: {} };
  private root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root: string, config: Config): Promise<PeerRegistry> {
    const registry = new PeerRegistry(root);
    registry.addressCache = await loadAddressCache(root);
    for (const p of config.peers) {
      if (p.name === config.self.name) continue;
      const entry = new PeerEntry();
      const cached = registry.addressCache.addresses[p.name] ?? [];
      entry.addresses = [...cached, ...p.addresses.filter((a) => !cached.includes(a))];
      registry.peers.set(p.name, entry);
    }
    return registry;
  }

  get(name: string): PeerEntry | undefined {
    return this.peers.get(name);
  }

  has(name: string): boolean {
    return this.peers.has(name);
  }

  entries(): IterableIterator<[string, PeerEntry]> {
    return this.peers.entries();
  }

  /** Add peers from config that are not yet tracked. Skips self and existing entries. */
  refresh(config: Config): void {
    for (const p of config.peers) {
      if (p.name === config.self.name) continue;
      if (this.peers.has(p.name)) continue;
      const entry = new PeerEntry();
      const cached = this.addressCache.addresses[p.name] ?? [];
      entry.addresses = [...cached, ...p.addresses.filter((a) => !cached.includes(a))];
      this.peers.set(p.name, entry);
    }
  }

  /** Update a peer's address list and persist to disk. Returns false if unchanged or peer unknown. */
  async recordAddress(peer: string, address: string): Promise<boolean> {
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

  currentAddressCache(): AddressCache {
    return this.addressCache;
  }
}
