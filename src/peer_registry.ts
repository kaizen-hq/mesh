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
  lastIssueSyncMs: number | null = null; // epoch ms of last successful issue full-sync pull
  lastCiSyncMs: number | null = null;    // epoch ms of last successful CI runs full-sync pull
  capabilities: NodeCapabilities | null = null;

  isConnected(windowMs = 60_000): boolean {
    const recent = (t: number | null) => t != null && Date.now() - t < windowMs;
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
  noteHeartbeat(addr: string | null): boolean {
    this.lastHeartbeat = Date.now();
    let changed = false;
    if (addr != null) changed = this.addAddress(addr);
    return changed;
  }
}

export class PeerRegistry {
  private peers: Map<string, PeerEntry> = new Map();
  private pubkeys: Map<string, string> = new Map(); // name → pubkey string (ed25519:...)
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
      // Static addresses from mesh.toml take priority over cached discoveries.
      // Cached addresses are kept as fallback for peers with no static config.
      entry.addresses = p.addresses.length > 0
        ? [...p.addresses, ...cached.filter((a) => !p.addresses.includes(a))]
        : [...cached];
      registry.peers.set(p.name, entry);
      registry.pubkeys.set(p.name, p.pubkey);
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

  /** Look up a peer's pubkey string. Returns undefined for unknown peers. */
  getPubkey(name: string): string | undefined {
    return this.pubkeys.get(name);
  }

  /**
   * Add a peer learned via PeerList introduction. In-memory only — never
   * written to mesh.toml. If the peer is already known, only addresses are
   * updated (existing pubkey from config is authoritative).
   */
  addIntroduced(name: string, pubkey: string, addresses: string[], introducedBy: string): void {
    if (this.peers.has(name)) {
      const entry = this.peers.get(name)!;
      for (const addr of addresses) entry.addAddress(addr);
      return;
    }
    console.log(`peer ${name} introduced by ${introducedBy} — holding in memory, not written to mesh.toml`);
    const entry = new PeerEntry();
    entry.addresses = [...addresses];
    this.peers.set(name, entry);
    this.pubkeys.set(name, pubkey);
  }

  /**
   * Returns all known peers (excluding the given name) with their pubkeys and
   * addresses, suitable for building a PeerList message payload.
   */
  allPeers(excludeName: string): Array<{ name: string; pubkey: string; addresses: string[] }> {
    const result: Array<{ name: string; pubkey: string; addresses: string[] }> = [];
    for (const [name, entry] of this.peers) {
      if (name === excludeName) continue;
      const pubkey = this.pubkeys.get(name);
      if (!pubkey) continue;
      result.push({ name, pubkey, addresses: [...entry.addresses] });
    }
    return result;
  }

  /** Add peers from config that are not yet tracked. Skips self and existing entries. */
  refresh(config: Config): void {
    for (const p of config.peers) {
      if (p.name === config.self.name) continue;
      if (this.peers.has(p.name)) {
        // Always keep config pubkey authoritative even if peer was previously introduced.
        this.pubkeys.set(p.name, p.pubkey);
        continue;
      }
      const entry = new PeerEntry();
      const cached = this.addressCache.addresses[p.name] ?? [];
      entry.addresses = p.addresses.length > 0
        ? [...p.addresses, ...cached.filter((a) => !p.addresses.includes(a))]
        : [...cached];
      this.peers.set(p.name, entry);
      this.pubkeys.set(p.name, p.pubkey);
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
