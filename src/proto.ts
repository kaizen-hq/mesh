// mesh wire protocol.
//
// Frames use bincode encoding. ed25519 signatures cover:
// sender || 0 || dest || 0 || payload.
// Issue message variants (tag >= 3) carry a JSON-encoded payload string.

import * as ed from "./ed25519.ts";

// noble/ed25519 v2 async API uses WebCrypto for sha512 — no setup needed.
// Sync API (sign/verify) requires `etc.sha512Sync` wiring; we use async APIs
// throughout, so we skip that.

export const PROTOCOL_VERSION = 1;

// ---------- bincode encoder ----------

class Enc {
  private chunks: Uint8Array[] = [];
  private len = 0;

  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.push(b);
  }
  u16(v: number) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v & 0xffff, true);
    this.push(b);
  }
  u64(v: number | bigint) {
    const big = typeof v === "bigint" ? v : BigInt(v);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, big, true);
    this.push(b);
  }
  bytes(b: Uint8Array) {
    this.u64(b.length);
    this.push(b);
  }
  str(s: string) {
    this.bytes(new TextEncoder().encode(s));
  }
  variant(tag: number) {
    this.u32(tag);
  }
  raw(b: Uint8Array) {
    this.push(b);
  }
  finish(): Uint8Array {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
  private push(b: Uint8Array) {
    this.chunks.push(b);
    this.len += b.length;
  }
}

// ---------- bincode decoder ----------

class Dec {
  private off = 0;
  constructor(private buf: Uint8Array) {}
  remaining(): number {
    return this.buf.length - this.off;
  }
  u16(): number {
    this.need(2);
    const v = new DataView(
      this.buf.buffer,
      this.buf.byteOffset + this.off,
      2,
    ).getUint16(0, true);
    this.off += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = new DataView(
      this.buf.buffer,
      this.buf.byteOffset + this.off,
      4,
    ).getUint32(0, true);
    this.off += 4;
    return v;
  }
  u64(): number {
    this.need(8);
    const v = new DataView(
      this.buf.buffer,
      this.buf.byteOffset + this.off,
      8,
    ).getBigUint64(0, true);
    this.off += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("u64 too large for JS number");
    }
    return Number(v);
  }
  bytes(): Uint8Array {
    const n = this.u64();
    this.need(n);
    const b = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return b;
  }
  str(): string {
    return new TextDecoder().decode(this.bytes());
  }
  private need(n: number) {
    if (this.remaining() < n) {
      throw new Error(`bincode: need ${n}, have ${this.remaining()}`);
    }
  }
}

// ---------- protocol types ----------

export interface RepoStatus {
  name: string;
  head_sha: string | null;
  branches: BranchStatus[];
}

export interface BranchStatus {
  name: string;
  sha: string;
}

export interface RefChange {
  name: string;
  old_sha: string;
  new_sha: string;
}

// ---------- issue wire events ----------

export type IssueEvent =
  | {
      type: "IssueCreated";
      repo: string;
      id: string;
      title: string;
      body: string;
      labels: string[];
      author: string;
      created: string;
    }
  | {
      type: "IssueCommented";
      repo: string;
      id: string;
      author: string;
      created: string;
      body: string;
    }
  | {
      type: "IssueStatusChanged";
      repo: string;
      id: string;
      status: "open" | "closed" | "trashed";
      author: string;
      updated: string;
    }
  | {
      type: "IssueReordered";
      repo: string;
      id: string;
      order: number;
    };

// ---------- CI frame types ----------

import type { Pipeline, TriggerKind, NodeCapabilities } from "./ci/types.ts";

export type CiMessage =
  | { type: "CiAssignment"; run_id: string; repo: string; ref: string; sha: string; pipeline: Pipeline; triggered_by: TriggerKind }
  | { type: "CiAccepted"; run_id: string; runner: string }
  | { type: "CiDeclined"; run_id: string; runner: string; reason: string }
  | { type: "CiStarted"; run_id: string; repo: string; runner: string; started_at: string }
  | { type: "CiLog"; run_id: string; repo: string; job: string; seq: number; t: string; stream: "stdout" | "stderr"; data: string }
  | { type: "CiCompleted"; run_id: string; repo: string; status: "passed" | "failed"; duration_ms: number; log_hash: string }
  | { type: "CiCronClaim"; repo: string; job: string; slot: string; claimer: string; capability_hash: string };

// ---------- message union ----------

export type Message =
  | {
      kind: "Hello";
      name: string;
      config_hash: string;
      version: number;
    }
  | {
      kind: "Heartbeat";
      name: string;
      config_hash: string;
      repos: RepoStatus[];
      capabilities?: NodeCapabilities;
    }
  | {
      kind: "RefUpdate";
      repo: string;
      refs: RefChange[];
    }
  | {
      kind: "IssueEvent";
      event: IssueEvent;
    }
  | {
      kind: "CiFrame";
      msg: CiMessage;
    };

// ---------- encode / decode Message (bincode-compatible) ----------

function encodeMessage(msg: Message): Uint8Array {
  const e = new Enc();
  switch (msg.kind) {
    case "Hello":
      e.variant(0);
      e.str(msg.name);
      e.str(msg.config_hash);
      e.u32(msg.version);
      break;
    case "Heartbeat":
      e.variant(1);
      e.str(msg.name);
      e.str(msg.config_hash);
      e.u64(msg.repos.length);
      for (const r of msg.repos) {
        e.str(r.name);
        // Option<String> -> u8 tag (0 = None, 1 = Some) + value if Some
        if (r.head_sha == null) {
          e.raw(new Uint8Array([0]));
        } else {
          e.raw(new Uint8Array([1]));
          e.str(r.head_sha);
        }
        e.u64(r.branches.length);
        for (const b of r.branches) {
          e.str(b.name);
          e.str(b.sha);
        }
      }
      // Optional capabilities: encoded as JSON string prefixed by a presence byte
      if (msg.capabilities != null) {
        e.raw(new Uint8Array([1]));
        e.str(JSON.stringify(msg.capabilities));
      } else {
        e.raw(new Uint8Array([0]));
      }
      break;
    case "RefUpdate":
      e.variant(2);
      e.str(msg.repo);
      e.u64(msg.refs.length);
      for (const c of msg.refs) {
        e.str(c.name);
        e.str(c.old_sha);
        e.str(c.new_sha);
      }
      break;
    case "IssueEvent":
      e.variant(3);
      e.str(JSON.stringify(msg.event));
      break;
    case "CiFrame":
      e.variant(4);
      e.str(JSON.stringify(msg.msg));
      break;
  }
  return e.finish();
}

function decodeMessage(buf: Uint8Array): Message {
  const d = new Dec(buf);
  const tag = d.u32();
  switch (tag) {
    case 0: {
      const name = d.str();
      const config_hash = d.str();
      const version = d.u32();
      return { kind: "Hello", name, config_hash, version };
    }
    case 1: {
      const name = d.str();
      const config_hash = d.str();
      const repoCount = d.u64();
      const repos: RepoStatus[] = [];
      for (let i = 0; i < repoCount; i++) {
        const rname = d.str();
        const flagBuf = readByte(d);
        const head_sha = flagBuf === 1 ? d.str() : null;
        const branchCount = d.u64();
        const branches: BranchStatus[] = [];
        for (let j = 0; j < branchCount; j++) {
          branches.push({ name: d.str(), sha: d.str() });
        }
        repos.push({ name: rname, head_sha, branches });
      }
      // Optional capabilities (presence byte added in CI phase)
      let capabilities;
      if (d.remaining() > 0) {
        const flag = readByte(d);
        if (flag === 1) {
          capabilities = JSON.parse(d.str()) as import("./ci/types.ts").NodeCapabilities;
        }
      }
      return { kind: "Heartbeat", name, config_hash, repos, capabilities };
    }
    case 2: {
      const repo = d.str();
      const refCount = d.u64();
      const refs: RefChange[] = [];
      for (let i = 0; i < refCount; i++) {
        refs.push({ name: d.str(), old_sha: d.str(), new_sha: d.str() });
      }
      return { kind: "RefUpdate", repo, refs };
    }
    case 3: {
      const event = JSON.parse(d.str()) as IssueEvent;
      return { kind: "IssueEvent", event };
    }
    case 4: {
      const msg = JSON.parse(d.str()) as CiMessage;
      return { kind: "CiFrame", msg };
    }
    default:
      throw new Error(`unknown Message variant tag: ${tag}`);
  }
}

function readByte(d: Dec): number {
  // bincode u8 is just one byte.
  // Use bytes API: u8 isn't a thing, so read 1 raw byte via u16-trick is wrong.
  // Inline a small helper using a dummy view.
  const tmp = new Uint8Array(1);
  // workaround: pull 1 byte via a custom decode path
  const dAny = d as unknown as { buf: Uint8Array; off: number };
  if (dAny.buf.length - dAny.off < 1) throw new Error("bincode: u8 underrun");
  tmp[0] = dAny.buf[dAny.off]!;
  dAny.off += 1;
  return tmp[0]!;
}

// ---------- Frame ----------

export interface Frame {
  version: number;
  sender: string;
  dest: string;
  payload: Uint8Array;
  signature: Uint8Array;
}

function signInput(sender: string, dest: string, payload: Uint8Array): Uint8Array {
  const senderBytes = new TextEncoder().encode(sender);
  const destBytes = new TextEncoder().encode(dest);
  const out = new Uint8Array(senderBytes.length + destBytes.length + payload.length + 2);
  let o = 0;
  out.set(senderBytes, o);
  o += senderBytes.length;
  out[o++] = 0;
  out.set(destBytes, o);
  o += destBytes.length;
  out[o++] = 0;
  out.set(payload, o);
  return out;
}

export async function signFrame(
  sender: string,
  dest: string,
  msg: Message,
  signingKey: Uint8Array, // 32-byte ed25519 seed
): Promise<Frame> {
  const payload = encodeMessage(msg);
  const sig = await ed.signAsync(signInput(sender, dest, payload), signingKey);
  return {
    version: PROTOCOL_VERSION,
    sender,
    dest,
    payload,
    signature: sig,
  };
}

export function encodeFrame(frame: Frame): Uint8Array {
  const e = new Enc();
  e.u32(frame.version);
  e.str(frame.sender);
  e.str(frame.dest);
  e.bytes(frame.payload);
  e.bytes(frame.signature);
  return e.finish();
}

export function decodeFrame(buf: Uint8Array): Frame {
  const d = new Dec(buf);
  const version = d.u32();
  const sender = d.str();
  const dest = d.str();
  const payload = d.bytes();
  const signature = d.bytes();
  return { version, sender, dest, payload, signature };
}

/** Verify a Frame's ed25519 signature using a 32-byte public key, returning
 * the decoded Message on success. Throws if signature/decoding fails. */
export async function verifyFrame(
  frame: Frame,
  publicKey: Uint8Array,
): Promise<Message> {
  if (frame.signature.length !== 64) {
    throw new Error("frame signature is not 64 bytes");
  }
  const input = signInput(frame.sender, frame.dest, frame.payload);
  const ok = await ed.verifyAsync(frame.signature, input, publicKey);
  if (!ok) throw new Error("bad signature");
  return decodeMessage(frame.payload);
}

// ---------- pubkey codec ----------

const PUBKEY_PREFIX = "ed25519:";

export function encodePubkey(pub: Uint8Array): string {
  if (pub.length !== 32) throw new Error("ed25519 pubkey must be 32 bytes");
  return PUBKEY_PREFIX + base64Encode(pub);
}

export function decodePubkey(s: string): Uint8Array {
  if (!s.startsWith(PUBKEY_PREFIX)) {
    throw new Error(`pubkey must start with ${PUBKEY_PREFIX}`);
  }
  const bytes = base64Decode(s.slice(PUBKEY_PREFIX.length));
  if (bytes.length !== 32) throw new Error("decoded pubkey must be 32 bytes");
  return bytes;
}

// ---------- sha256 hex (used for config_hash) ----------

export function sha256Hex(data: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(data);
  return h.digest("hex");
}

// ---------- base64 helpers (Bun-compatible) ----------

export function base64Encode(b: Uint8Array): string {
  // Bun supports Buffer; using it keeps this portable across Bun and Node.
  return Buffer.from(b).toString("base64");
}

export function base64Decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}
