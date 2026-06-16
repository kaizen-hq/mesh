// Identity: ed25519 signing keypair + self-signed TLS cert (HTTPS mode only).
//
// Files in ~/.mesh/ (shared layout with the Rust mesh):
//   keys/daemon.ed25519       — PKCS#8 PEM (preferred, what Rust ed25519-dalek
//                                writes; also legacy 32-byte raw seed accepted)
//   keys/daemon.ed25519.pub   — public key as "ed25519:<base64>\n"
//   tls/cert.pem              — ECDSA P-256 self-signed cert (HTTPS mode)
//   tls/key.pem               — matching key (mode 0600)

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as ed from "@noble/ed25519";
import { encodePubkey } from "./proto.ts";

export interface Identity {
  privateKey: Uint8Array; // 32-byte ed25519 seed
  publicKey: Uint8Array; // 32-byte ed25519 public key
  pubkeyString: string; // "ed25519:<base64>"
  certPem: string | null;
  keyPem: string | null;
}

export async function loadOrCreate(root: string): Promise<Identity> {
  await fs.mkdir(path.join(root, "keys"), { recursive: true });
  await fs.mkdir(path.join(root, "tls"), { recursive: true });

  const seedPath = path.join(root, "keys", "daemon.ed25519");
  const pubPath = path.join(root, "keys", "daemon.ed25519.pub");
  let seed: Uint8Array;
  try {
    const raw = await fs.readFile(seedPath);
    seed = parseEd25519Key(raw);
  } catch (e: unknown) {
    if (!isNotFound(e)) throw e;
    seed = crypto.getRandomValues(new Uint8Array(32));
    // Write as PKCS#8 PEM so the Rust mesh can read this file too.
    await fs.writeFile(seedPath, encodePkcs8Pem(seed), { mode: 0o600 });
  }

  const publicKey = await ed.getPublicKeyAsync(seed);
  const pubkeyString = encodePubkey(publicKey);
  try {
    await fs.writeFile(pubPath, pubkeyString + "\n", { mode: 0o644 });
  } catch {
    // non-fatal
  }

  // TLS cert is generated lazily in ensureTlsCert() using node:crypto (SubtleCrypto).
  let certPem: string | null = null;
  let keyPem: string | null = null;
  try {
    certPem = (await fs.readFile(path.join(root, "tls", "cert.pem"))).toString("utf8");
    keyPem = (await fs.readFile(path.join(root, "tls", "key.pem"))).toString("utf8");
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }

  return { privateKey: seed, publicKey, pubkeyString, certPem, keyPem };
}

/**
 * Ensure a self-signed ECDSA P-256 TLS cert exists at `~/.mesh/tls/{cert,key}.pem`.
 * Uses SubtleCrypto (crypto.subtle) — no openssl subprocess required. Idempotent.
 */
export async function ensureTlsCert(root: string): Promise<{ cert: string; key: string }> {
  const certPath = path.join(root, "tls", "cert.pem");
  const keyPath = path.join(root, "tls", "key.pem");
  try {
    const cert = (await fs.readFile(certPath)).toString("utf8");
    const key = (await fs.readFile(keyPath)).toString("utf8");
    return { cert, key };
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }

  await fs.mkdir(path.join(root, "tls"), { recursive: true });
  const { cert, key } = await generateSelfSignedP256Cert();
  await fs.writeFile(certPath, cert);
  await fs.writeFile(keyPath, key, { mode: 0o600 });
  return { cert, key };
}

function isNotFound(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: string }).code;
  return code === "ENOENT";
}

// ---------- PKCS#8 PEM for ed25519 ----------
//
// Wire-compatible with the Rust mesh, which uses `ed25519-dalek` + the
// `pkcs8` feature to write keys. ed25519-dalek emits PKCS#8 v2 (DER includes
// the public key in a trailing context-specific [1] tag); we accept v1 or v2
// on read and emit v1 (48-byte DER) on write — both are valid PKCS#8 and
// `ed25519-dalek` parses both transparently.
//
// DER layout (v1):
//   30 2e               SEQUENCE, 46 bytes
//     02 01 00          INTEGER 0 (version)
//     30 05             SEQUENCE, 5 bytes
//       06 03 2b 65 70  OID 1.3.101.112 (id-Ed25519)
//     04 22             OCTET STRING, 34 bytes  (outer)
//       04 20           OCTET STRING, 32 bytes  (inner)
//         [32 bytes of seed]

function parseEd25519Key(raw: Buffer): Uint8Array {
  // Legacy: raw 32-byte seed (older mesh versions wrote this).
  if (raw.length === 32) {
    return new Uint8Array(raw);
  }
  const asString = raw.toString("utf8");
  if (asString.includes("-----BEGIN PRIVATE KEY-----")) {
    return parsePkcs8Pem(asString);
  }
  throw new Error(
    `unrecognized ed25519 key format (${raw.length} bytes); ` +
      `expected PKCS#8 PEM or raw 32-byte seed`,
  );
}

function parsePkcs8Pem(pem: string): Uint8Array {
  const m = pem.match(
    /-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END PRIVATE KEY-----/,
  );
  if (!m) throw new Error("PKCS#8 PEM markers not found");
  const der = Buffer.from(m[1]!.replace(/\s+/g, ""), "base64");
  // Look for the OCTET STRING OCTET STRING pattern wrapping the 32-byte seed.
  for (let i = 0; i <= der.length - 36; i++) {
    if (
      der[i] === 0x04 &&
      der[i + 1] === 0x22 &&
      der[i + 2] === 0x04 &&
      der[i + 3] === 0x20
    ) {
      return new Uint8Array(der.subarray(i + 4, i + 36));
    }
  }
  throw new Error("could not locate ed25519 seed in PKCS#8 DER");
}

// ---------- Self-signed ECDSA P-256 TLS certificate (SubtleCrypto) ----------
//
// X.509 Certificate DER structure (minimal, v3, self-signed):
//   Certificate ::= SEQUENCE {
//     tbsCertificate    TBSCertificate,
//     signatureAlgorithm AlgorithmIdentifier,   -- ecdsa-with-SHA256
//     signatureValue    BIT STRING              -- DER-encoded ECDSA-Sig-Value
//   }

async function generateSelfSignedP256Cert(): Promise<{ cert: string; key: string }> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  // exportKey("spki") returns a complete DER-encoded SubjectPublicKeyInfo — use it as-is.
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));

  const now = new Date();
  const expire = new Date(now.getTime() + 3650 * 24 * 60 * 60 * 1000);

  const algId = derSEQ(derOID(ECDSA_SHA256_OID));
  const name = derSEQ(derSET(derSEQ(derCat(derOID(OID_CN), derTlv(0x0c, new TextEncoder().encode("mesh.local"))))));

  const tbs = derSEQ(derCat(
    derTlv(0xa0, derINT(new Uint8Array([0x02]))),           // [0] EXPLICIT version v3
    derINT(tlsSerial()),                                     // serialNumber
    algId,                                                   // signature
    name,                                                    // issuer
    derSEQ(derCat(derUTCTime(now), derUTCTime(expire))),    // validity
    name,                                                    // subject
    spki,                                                    // subjectPublicKeyInfo
  ));

  const tbsBuf = new Uint8Array(tbs).buffer as ArrayBuffer;
  const rawSig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, tbsBuf),
  );

  const certificate = derSEQ(derCat(
    tbs,
    algId,
    derTlv(0x03, derCat(new Uint8Array([0x00]), ecdsaRawToDer(rawSig))), // BIT STRING
  ));

  return {
    cert: derToPem(certificate, "CERTIFICATE"),
    key: derToPem(pkcs8, "PRIVATE KEY"),
  };
}

// OID 1.2.840.10045.4.3.2  (ecdsa-with-SHA256)
const ECDSA_SHA256_OID = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]);
// OID 2.5.4.3  (commonName)
const OID_CN = new Uint8Array([0x55, 0x04, 0x03]);

function derCat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function derLen(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  if (n < 0x100) return new Uint8Array([0x81, n]);
  return new Uint8Array([0x82, (n >> 8) & 0xff, n & 0xff]);
}

function derTlv(tag: number, value: Uint8Array): Uint8Array {
  return derCat(new Uint8Array([tag]), derLen(value.length), value);
}

const derSEQ = (v: Uint8Array) => derTlv(0x30, v);
const derSET = (v: Uint8Array) => derTlv(0x31, v);
const derINT = (v: Uint8Array) => derTlv(0x02, v);
const derOID = (v: Uint8Array) => derTlv(0x06, v);

function tlsSerial(): Uint8Array {
  const b = crypto.getRandomValues(new Uint8Array(8));
  b[0]! &= 0x7f; // ensure positive
  return b;
}

function derUTCTime(d: Date): Uint8Array {
  const p = (n: number) => String(n).padStart(2, "0");
  const s =
    `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return derTlv(0x17, new TextEncoder().encode(s));
}

// Convert SubtleCrypto's raw IEEE P1363 signature (r||s) to DER ECDSA-Sig-Value.
function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const encodeInt = (b: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.slice(i);
    if (b[0]! & 0x80) b = derCat(new Uint8Array([0x00]), b);
    return derINT(b);
  };
  return derSEQ(derCat(encodeInt(raw.slice(0, half)), encodeInt(raw.slice(half))));
}

function derToPem(der: Uint8Array, label: string): string {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function encodePkcs8Pem(seed: Uint8Array): string {
  if (seed.length !== 32) {
    throw new Error("ed25519 seed must be 32 bytes");
  }
  const header = new Uint8Array([
    0x30, 0x2e, // SEQUENCE, 46
    0x02, 0x01, 0x00, // INTEGER 0 (version)
    0x30, 0x05, // SEQUENCE, 5
    0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (id-Ed25519)
    0x04, 0x22, // OCTET STRING, 34
    0x04, 0x20, // OCTET STRING, 32
  ]);
  const der = new Uint8Array(header.length + 32);
  der.set(header, 0);
  der.set(seed, header.length);
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}
