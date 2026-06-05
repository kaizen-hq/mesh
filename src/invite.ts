// Pairing tokens + join handshake.
//
// `mesh invite` produces a short, signed token that the inviter shares with
// a teammate out-of-band (Slack/SMS/in-person). `mesh join <token>` decodes
// it, adds the inviter to the joiner's mesh.toml as a peer, and posts a
// signed join request to the inviter's `/mesh/join` endpoint. The inviter
// validates the nonce against its pending invites, then adds the joiner to
// its own mesh.toml. After this round-trip both sides know each other and
// the normal heartbeat/RefUpdate path takes over.

import * as ed from "@noble/ed25519";
import {
  base64Encode,
  base64Decode,
  decodePubkey,
  encodePubkey,
} from "./proto.ts";

export const INVITE_VERSION = 1;
const INVITE_PREFIX = "mesh1.";
const SIGN_CONTEXT = new TextEncoder().encode("mesh-invite-v1");
const JOIN_SIGN_CONTEXT = new TextEncoder().encode("mesh-join-v1");

const NONCE_BYTES = 16;
const PUBKEY_BYTES = 32;
const SIG_BYTES = 64;

export interface InviteToken {
  version: number;
  inviterPubkey: Uint8Array; // 32 bytes
  inviterName: string;
  address: string; // host:port that the joiner should contact
  nonce: Uint8Array; // 16 bytes
  expiryMs: number;
  signature: Uint8Array; // 64 bytes
}

function signedPayload(
  inviterName: string,
  address: string,
  nonce: Uint8Array,
  expiryMs: number,
): Uint8Array {
  const nameBytes = new TextEncoder().encode(inviterName);
  const addrBytes = new TextEncoder().encode(address);
  const expiryBuf = new Uint8Array(8);
  new DataView(expiryBuf.buffer).setBigUint64(0, BigInt(expiryMs), true);
  const total =
    SIGN_CONTEXT.length +
    1 +
    nameBytes.length +
    1 +
    addrBytes.length +
    1 +
    NONCE_BYTES +
    expiryBuf.length;
  const out = new Uint8Array(total);
  let o = 0;
  out.set(SIGN_CONTEXT, o); o += SIGN_CONTEXT.length;
  out[o++] = 0;
  out.set(nameBytes, o); o += nameBytes.length;
  out[o++] = 0;
  out.set(addrBytes, o); o += addrBytes.length;
  out[o++] = 0;
  out.set(nonce, o); o += NONCE_BYTES;
  out.set(expiryBuf, o);
  return out;
}

export async function buildInviteToken(opts: {
  inviterPubkey: Uint8Array;
  inviterName: string;
  address: string;
  ttlSecs: number;
  signingKey: Uint8Array;
}): Promise<InviteToken> {
  if (opts.inviterPubkey.length !== PUBKEY_BYTES) {
    throw new Error("inviter pubkey must be 32 bytes");
  }
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const expiryMs = Date.now() + Math.max(1, opts.ttlSecs) * 1000;
  const payload = signedPayload(opts.inviterName, opts.address, nonce, expiryMs);
  const signature = await ed.signAsync(payload, opts.signingKey);
  return {
    version: INVITE_VERSION,
    inviterPubkey: opts.inviterPubkey,
    inviterName: opts.inviterName,
    address: opts.address,
    nonce,
    expiryMs,
    signature,
  };
}

export function encodeInviteToken(t: InviteToken): string {
  const nameBytes = new TextEncoder().encode(t.inviterName);
  const addrBytes = new TextEncoder().encode(t.address);
  if (nameBytes.length > 255) throw new Error("inviter name too long");
  if (addrBytes.length > 255) throw new Error("address too long");
  const total =
    1 + PUBKEY_BYTES + NONCE_BYTES + 8 + 1 + nameBytes.length + 1 + addrBytes.length + SIG_BYTES;
  const buf = new Uint8Array(total);
  let o = 0;
  buf[o++] = t.version & 0xff;
  buf.set(t.inviterPubkey, o); o += PUBKEY_BYTES;
  buf.set(t.nonce, o); o += NONCE_BYTES;
  new DataView(buf.buffer).setBigUint64(o, BigInt(t.expiryMs), true);
  o += 8;
  buf[o++] = nameBytes.length;
  buf.set(nameBytes, o); o += nameBytes.length;
  buf[o++] = addrBytes.length;
  buf.set(addrBytes, o); o += addrBytes.length;
  buf.set(t.signature, o);
  return INVITE_PREFIX + base64urlEncode(buf);
}

export function decodeInviteToken(s: string): InviteToken {
  if (!s.startsWith(INVITE_PREFIX)) {
    throw new Error(`invite token must start with ${INVITE_PREFIX}`);
  }
  const buf = base64urlDecode(s.slice(INVITE_PREFIX.length));
  let o = 0;
  const need = (n: number) => {
    if (buf.length - o < n) throw new Error("invite token truncated");
  };
  need(1);
  const version = buf[o++]!;
  if (version !== INVITE_VERSION) {
    throw new Error(`unsupported invite version: ${version}`);
  }
  need(PUBKEY_BYTES);
  const inviterPubkey = buf.slice(o, o + PUBKEY_BYTES); o += PUBKEY_BYTES;
  need(NONCE_BYTES);
  const nonce = buf.slice(o, o + NONCE_BYTES); o += NONCE_BYTES;
  need(8);
  const expiryMs = Number(new DataView(buf.buffer, buf.byteOffset + o, 8).getBigUint64(0, true));
  o += 8;
  need(1);
  const nameLen = buf[o++]!;
  need(nameLen);
  const inviterName = new TextDecoder().decode(buf.slice(o, o + nameLen)); o += nameLen;
  need(1);
  const addrLen = buf[o++]!;
  need(addrLen);
  const address = new TextDecoder().decode(buf.slice(o, o + addrLen)); o += addrLen;
  need(SIG_BYTES);
  const signature = buf.slice(o, o + SIG_BYTES);
  return { version, inviterPubkey, inviterName, address, nonce, expiryMs, signature };
}

export async function verifyInviteToken(t: InviteToken): Promise<void> {
  const payload = signedPayload(t.inviterName, t.address, t.nonce, t.expiryMs);
  const ok = await ed.verifyAsync(t.signature, payload, t.inviterPubkey);
  if (!ok) throw new Error("invite signature failed verification");
  if (t.expiryMs < Date.now()) throw new Error("invite token has expired");
}

// ---------- /mesh/join request body ----------

export interface JoinRequest {
  version: number;
  nonce: string; // base64
  joiner_name: string;
  joiner_pubkey: string; // "ed25519:..."
  signature: string; // base64
}

export interface JoinResponse {
  ok: boolean;
  inviter_name?: string;
  inviter_pubkey?: string;
  error?: string;
}

function joinSignedPayload(
  nonce: Uint8Array,
  joinerName: string,
  joinerPubkey: Uint8Array,
): Uint8Array {
  const nameBytes = new TextEncoder().encode(joinerName);
  const total =
    JOIN_SIGN_CONTEXT.length + 1 + NONCE_BYTES + 1 + nameBytes.length + 1 + PUBKEY_BYTES;
  const out = new Uint8Array(total);
  let o = 0;
  out.set(JOIN_SIGN_CONTEXT, o); o += JOIN_SIGN_CONTEXT.length;
  out[o++] = 0;
  out.set(nonce, o); o += NONCE_BYTES;
  out[o++] = 0;
  out.set(nameBytes, o); o += nameBytes.length;
  out[o++] = 0;
  out.set(joinerPubkey, o);
  return out;
}

export async function buildJoinRequest(opts: {
  nonce: Uint8Array;
  joinerName: string;
  joinerPubkey: Uint8Array;
  signingKey: Uint8Array;
}): Promise<JoinRequest> {
  const payload = joinSignedPayload(opts.nonce, opts.joinerName, opts.joinerPubkey);
  const sig = await ed.signAsync(payload, opts.signingKey);
  return {
    version: INVITE_VERSION,
    nonce: base64Encode(opts.nonce),
    joiner_name: opts.joinerName,
    joiner_pubkey: encodePubkey(opts.joinerPubkey),
    signature: base64Encode(sig),
  };
}

export async function verifyJoinRequest(req: JoinRequest): Promise<{
  nonce: Uint8Array;
  joinerName: string;
  joinerPubkey: Uint8Array;
}> {
  if (req.version !== INVITE_VERSION) {
    throw new Error(`unsupported join request version: ${req.version}`);
  }
  if (typeof req.joiner_name !== "string" || !req.joiner_name.trim()) {
    throw new Error("joiner_name missing");
  }
  const nonce = base64Decode(req.nonce);
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`nonce must be ${NONCE_BYTES} bytes`);
  }
  const joinerPubkey = decodePubkey(req.joiner_pubkey);
  const sig = base64Decode(req.signature);
  if (sig.length !== SIG_BYTES) {
    throw new Error(`signature must be ${SIG_BYTES} bytes`);
  }
  const payload = joinSignedPayload(nonce, req.joiner_name, joinerPubkey);
  const ok = await ed.verifyAsync(sig, payload, joinerPubkey);
  if (!ok) throw new Error("join request signature failed");
  return { nonce, joinerName: req.joiner_name, joinerPubkey };
}

export function nonceHex(nonce: Uint8Array): string {
  return Array.from(nonce)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------- base64url helpers ----------

function base64urlEncode(b: Uint8Array): string {
  return base64Encode(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return base64Decode(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}
