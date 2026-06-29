// mesh.toml parsing + peer_addresses.toml parsing + URL helpers.
// mesh.toml and peer_addresses.toml are the canonical config format.

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as toml from "./toml.ts";
import { sha256Hex } from "./proto.ts";
import type { RunnerConfig } from "./ci/types.ts";

export interface SelfSection {
  name: string;
  peer_port: number;
}

export interface PeerEntry {
  name: string;
  pubkey: string;
  addresses: string[];
}

export interface TransportSection {
  tls: boolean;
  poll_secs: number;
}

export interface Config {
  self: SelfSection;
  peers: PeerEntry[];
  transport: TransportSection;
  runner: RunnerConfig;
  raw_hash: string;
  source_path: string;
}

const DEFAULT_PEER_PORT = 7979;

export const DEFAULT_RUNNER: RunnerConfig = {
  enabled: true,
  execution_modes: ["docker"],
  labels: [],
  max_concurrent_jobs: 2,
  workdir: path.join(os.homedir(), ".mesh", "ci", "runs"),
  tools: [],
  env_passthrough: [],
  log_stream_interval_ms: 500,
  max_worktree_age_minutes: 60,
  max_worktree_disk_mb: 2048,
  log_retention_runs: 50,
};

const KNOWN_TOP_LEVEL = new Set(["self", "peers", "transport", "runner"]);
const KNOWN_SELF = new Set(["name", "peer_port"]);
const KNOWN_TRANSPORT = new Set(["tls", "poll_secs"]);
const KNOWN_RUNNER = new Set([
  "enabled", "execution_modes", "labels", "max_concurrent_jobs",
  "workdir", "tools", "env_passthrough", "log_stream_interval_ms", "max_worktree_age_minutes",
  "max_worktree_disk_mb", "log_retention_runs",
]);
const KNOWN_PEER = new Set(["name", "pubkey", "addresses", "address"]);

function warnUnknown(file: string, section: string, obj: Record<string, unknown>, known: Set<string>): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      console.warn(`WARN ${file}: unknown field "${section ? section + "." : ""}${key}"`);
    }
  }
}

export async function loadConfig(file: string): Promise<Config> {
  const raw = await fs.readFile(file, "utf8");
  const hash = sha256Hex(new TextEncoder().encode(raw));
  const t = toml.parse(raw) as Record<string, unknown>;

  warnUnknown(file, "", t, KNOWN_TOP_LEVEL);

  const selfSec = (t["self"] ?? {}) as Record<string, unknown>;
  warnUnknown(file, "self", selfSec, KNOWN_SELF);
  const name = typeof selfSec.name === "string" ? selfSec.name : "";
  if (!name.trim()) {
    throw new Error(`${file}: [self].name is required`);
  }
  const peer_port =
    typeof selfSec.peer_port === "number" ? selfSec.peer_port : DEFAULT_PEER_PORT;

  const peers = ((t["peers"] as unknown[]) ?? []).map((p) => {
    const o = p as Record<string, unknown>;
    warnUnknown(file, "peers[]", o, KNOWN_PEER);
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

  if (t["repos"]) {
    console.warn(`WARN ${file}: [repos] is no longer supported — repos are discovered automatically via git push`);
  }

  const tx = (t["transport"] ?? {}) as Record<string, unknown>;
  warnUnknown(file, "transport", tx, KNOWN_TRANSPORT);
  const transport: TransportSection = {
    tls: typeof tx.tls === "boolean" ? tx.tls : true,
    poll_secs: typeof tx.poll_secs === "number" ? tx.poll_secs : 1,
  };

  const rr = (t["runner"] ?? {}) as Record<string, unknown>;
  warnUnknown(file, "runner", rr, KNOWN_RUNNER);
  const runner: RunnerConfig = {
    enabled: typeof rr.enabled === "boolean" ? rr.enabled : DEFAULT_RUNNER.enabled,
    execution_modes: Array.isArray(rr.execution_modes)
      ? (rr.execution_modes as unknown[]).filter((m): m is string => typeof m === "string")
      : DEFAULT_RUNNER.execution_modes,
    labels: Array.isArray(rr.labels)
      ? (rr.labels as unknown[]).filter((l): l is string => typeof l === "string")
      : DEFAULT_RUNNER.labels,
    max_concurrent_jobs:
      typeof rr.max_concurrent_jobs === "number" ? rr.max_concurrent_jobs : DEFAULT_RUNNER.max_concurrent_jobs,
    workdir: typeof rr.workdir === "string" ? rr.workdir : DEFAULT_RUNNER.workdir,
    tools: Array.isArray(rr.tools)
      ? (rr.tools as unknown[]).filter((t): t is string => typeof t === "string")
      : DEFAULT_RUNNER.tools,
    env_passthrough: Array.isArray(rr.env_passthrough)
      ? (rr.env_passthrough as unknown[]).filter((v): v is string => typeof v === "string")
      : DEFAULT_RUNNER.env_passthrough,
    log_stream_interval_ms:
      typeof rr.log_stream_interval_ms === "number" ? rr.log_stream_interval_ms : DEFAULT_RUNNER.log_stream_interval_ms,
    max_worktree_age_minutes:
      typeof rr.max_worktree_age_minutes === "number" ? rr.max_worktree_age_minutes : DEFAULT_RUNNER.max_worktree_age_minutes,
    max_worktree_disk_mb:
      typeof rr.max_worktree_disk_mb === "number" ? rr.max_worktree_disk_mb : DEFAULT_RUNNER.max_worktree_disk_mb,
    log_retention_runs:
      typeof rr.log_retention_runs === "number" ? rr.log_retention_runs : DEFAULT_RUNNER.log_retention_runs,
  };

  return {
    self: { name, peer_port },
    peers,
    transport,
    runner,
    raw_hash: hash,
    source_path: file,
  };
}

export function seedConfig(myName: string, myPubkey: string): string {
  return toml.stringify({
    self: { name: myName },
    runner: {
      enabled: true,
      execution_modes: ["docker"],
    },
    peers: [{ name: myName, pubkey: myPubkey }],
  });
}

// ---------- mesh.toml mutation ----------

interface RawConfigDoc {
  self?: Record<string, unknown>;
  runner?: Record<string, unknown>;
  peers?: Array<Record<string, unknown>>;
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
 * peers it talks to. Defaults to true (TLS on).
 *   "10.0.1.42:7979", tls=true  → ["https://10.0.1.42:7979", "10.0.1.42:7979"]
 *   "10.0.1.42:7979", tls=false → ["http://10.0.1.42:7979",  "10.0.1.42:7979"]
 *   "http://kyle:7979"          → ["http://kyle:7979",       "kyle:7979"]
 *   "https://alice:8443"        → ["https://alice:8443",     "alice:8443"]
 */
export function normalizePeerUrl(
  addr: string,
  defaultTls = true,
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

// ---------- pending_invites.json ----------
// Persisted so a daemon restart doesn't silently invalidate in-flight invites.

export interface PersistedInvite {
  expiryMs: number;
  address: string;
}

export async function loadPendingInvites(root: string): Promise<Map<string, PersistedInvite>> {
  const file = path.join(root, "pending_invites.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const obj = JSON.parse(raw) as Record<string, PersistedInvite>;
    const now = Date.now();
    const map = new Map<string, PersistedInvite>();
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v?.expiryMs === "number" && v.expiryMs > now) {
        map.set(k, v);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

export function defaultRoot(): string {
  return path.join(os.homedir(), ".mesh");
}

export async function savePendingInvites(root: string, invites: Map<string, PersistedInvite>): Promise<void> {
  const obj: Record<string, PersistedInvite> = {};
  for (const [k, v] of invites) obj[k] = v;
  const file = path.join(root, "pending_invites.json");
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(obj), "utf8");
  await fs.rename(tmp, file);
}
