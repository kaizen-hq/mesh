// mesh.toml parsing + peer_addresses.toml parsing + URL helpers.
// mesh.toml and peer_addresses.toml are the canonical config format.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as toml from "./toml.ts";
import { sha256Hex } from "./proto.ts";

export interface SelfSection {
  name: string;
  peer_port: number;
}

export interface PeerEntry {
  name: string;
  pubkey: string;
  addresses: string[];
}

export interface RepoEntry {
  name: string;
  path: string;
  branches: string[];
}

export interface TransportSection {
  tls: boolean;
  poll_secs: number;
}

export interface Config {
  self: SelfSection;
  peers: PeerEntry[];
  repos: RepoEntry[];
  transport: TransportSection;
  raw_hash: string;
  source_path: string;
}

const DEFAULT_PEER_PORT = 7979;

export async function loadConfig(file: string): Promise<Config> {
  const raw = await fs.readFile(file, "utf8");
  const hash = sha256Hex(new TextEncoder().encode(raw));
  const t = toml.parse(raw) as Record<string, unknown>;

  const selfSec = (t["self"] ?? {}) as Record<string, unknown>;
  const name = typeof selfSec.name === "string" ? selfSec.name : "";
  if (!name.trim()) {
    throw new Error(`${file}: [self].name is required`);
  }
  const peer_port =
    typeof selfSec.peer_port === "number" ? selfSec.peer_port : DEFAULT_PEER_PORT;

  const peers = ((t["peers"] as unknown[]) ?? []).map((p) => {
    const o = p as Record<string, unknown>;
    // Accept both `address = "..."` (legacy) and `addresses = [...]` in TOML.
    const addresses: string[] = Array.isArray(o.addresses)
      ? o.addresses.filter((a): a is string => typeof a === "string")
      : typeof o.address === "string"
        ? [o.address]
        : [];
    return {
      name: String(o.name),
      pubkey: String(o.pubkey),
      addresses,
    } satisfies PeerEntry;
  });

  const repos = ((t["repos"] as unknown[]) ?? []).map((r) => {
    const o = r as Record<string, unknown>;
    return {
      name: String(o.name),
      path: String(o.path),
      branches: Array.isArray(o.branches) ? o.branches.map(String) : [],
    } satisfies RepoEntry;
  });

  const tx = (t["transport"] ?? {}) as Record<string, unknown>;
  const transport: TransportSection = {
    tls: !!tx.tls,
    poll_secs: typeof tx.poll_secs === "number" ? tx.poll_secs : 1,
  };

  return {
    self: { name, peer_port },
    peers,
    repos,
    transport,
    raw_hash: hash,
    source_path: file,
  };
}

export function seedConfig(myName: string, myPubkey: string): string {
  return toml.stringify({
    self: { name: myName },
    peers: [{ name: myName, pubkey: myPubkey }],
    repos: [],
  });
}

// ---------- mesh.toml mutation ----------

interface RawConfigDoc {
  self?: Record<string, unknown>;
  peers?: Array<Record<string, unknown>>;
  repos?: Array<Record<string, unknown>>;
  transport?: Record<string, unknown>;
}

async function readDoc(file: string): Promise<RawConfigDoc> {
  const raw = await fs.readFile(file, "utf8");
  return toml.parse(raw) as RawConfigDoc;
}

async function writeDocAtomic(file: string, doc: RawConfigDoc): Promise<void> {
  const out = toml.stringify(doc as unknown as Record<string, unknown>);
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, out, "utf8");
  await fs.rename(tmp, file);
}

/** Add (or update) a peer entry in mesh.toml. Returns true if the file changed. */
export async function addPeerToConfig(
  file: string,
  peer: PeerEntry,
): Promise<boolean> {
  const doc = await readDoc(file);
  doc.peers ??= [];
  const existing = doc.peers.find((p) => String(p.name) === peer.name);
  if (existing) {
    let changed = false;
    if (String(existing.pubkey) !== peer.pubkey) {
      existing.pubkey = peer.pubkey;
      changed = true;
    }
    if (peer.addresses.length > 0) {
      const cur: string[] = Array.isArray(existing.addresses)
        ? (existing.addresses as string[])
        : typeof existing.address === "string"
          ? [existing.address as string]
          : [];
      // Merge: prepend new addresses not already in the list.
      const merged = [
        ...peer.addresses.filter((a) => !cur.includes(a)),
        ...cur,
      ];
      if (merged.length !== cur.length || merged.some((a, i) => a !== cur[i])) {
        existing.addresses = merged;
        delete existing.address;
        changed = true;
      }
    }
    if (!changed) return false;
  } else {
    const entry: Record<string, unknown> = { name: peer.name, pubkey: peer.pubkey };
    if (peer.addresses.length > 0) entry.addresses = [...peer.addresses];
    doc.peers.push(entry);
  }
  await writeDocAtomic(file, doc);
  return true;
}

/** Add (or update) a repo entry in mesh.toml. Returns true if the file changed. */
export async function addRepoToConfig(
  file: string,
  repo: RepoEntry,
): Promise<boolean> {
  const doc = await readDoc(file);
  doc.repos ??= [];
  const existing = doc.repos.find((r) => String(r.name) === repo.name);
  if (existing) {
    let changed = false;
    if (String(existing.path) !== repo.path) {
      existing.path = repo.path;
      changed = true;
    }
    const curBranches = Array.isArray(existing.branches)
      ? existing.branches.map(String)
      : [];
    if (
      curBranches.length !== repo.branches.length ||
      curBranches.some((b, i) => b !== repo.branches[i])
    ) {
      existing.branches = [...repo.branches];
      changed = true;
    }
    if (!changed) return false;
  } else {
    doc.repos.push({
      name: repo.name,
      path: repo.path,
      branches: [...repo.branches],
    });
  }
  await writeDocAtomic(file, doc);
  return true;
}

// ---------- peer_addresses.toml ----------

export interface AddressCache {
  addresses: Record<string, string[]>;
}

export function addressCachePath(root: string): string {
  return path.join(root, "peer_addresses.toml");
}

export async function loadAddressCache(root: string): Promise<AddressCache> {
  try {
    const raw = await fs.readFile(addressCachePath(root), "utf8");
    const t = toml.parse(raw) as Record<string, unknown>;
    const a = (t["addresses"] ?? {}) as Record<string, unknown>;
    const addresses: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(a)) {
      // Accept both legacy single string and new array format.
      if (typeof v === "string") addresses[k] = [v];
      else if (Array.isArray(v)) addresses[k] = v.filter((x): x is string => typeof x === "string");
    }
    return { addresses };
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "ENOENT") return { addresses: {} };
    throw e;
  }
}

export async function saveAddressCache(root: string, cache: AddressCache): Promise<void> {
  const out = toml.stringify({ addresses: cache.addresses });
  const target = addressCachePath(root);
  const tmp = target + ".tmp";
  await fs.writeFile(tmp, out, "utf8");
  await fs.rename(tmp, target);
}

// ---------- peer URL normalisation ----------

/**
 * Normalise a peer address string into a base URL + host:port. If the address
 * is bare (no scheme), `defaultTls` decides between http and https — callers
 * pass their own `transport.tls` so a TLS-enabled node defaults to https for
 * peers it talks to.
 *   "10.0.1.42:7979", tls=false → ["http://10.0.1.42:7979",  "10.0.1.42:7979"]
 *   "10.0.1.42:7979", tls=true  → ["https://10.0.1.42:7979", "10.0.1.42:7979"]
 *   "http://kyle:7979"          → ["http://kyle:7979",       "kyle:7979"]
 *   "https://alice:8443"        → ["https://alice:8443",     "alice:8443"]
 */
export function normalizePeerUrl(
  addr: string,
  defaultTls = false,
): { baseUrl: string; hostPort: string } {
  const trimmed = addr.replace(/\/$/, "");
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const hp = trimmed.split("://", 2)[1] ?? "";
    return { baseUrl: trimmed, hostPort: hp.replace(/\/$/, "") };
  }
  const scheme = defaultTls ? "https" : "http";
  return { baseUrl: `${scheme}://${trimmed}`, hostPort: trimmed };
}

export function findPeer(cfg: Config, name: string): PeerEntry | undefined {
  return cfg.peers.find((p) => p.name === name);
}

export function findRepo(cfg: Config, name: string): RepoEntry | undefined {
  return cfg.repos.find((r) => r.name === name);
}
