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

  // TLS cert generation is skipped here — generating an ECDSA P-256 cert in
  // pure JS without a heavy crypto package is out of scope. When the Bun
  // server runs in HTTPS mode, we'll generate the cert lazily using a small
  // subprocess shell-out to `openssl` if/when needed.
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
 * Shells out to `openssl req` because there's no good pure-JS option that
 * matches what macOS git's LibreSSL accepts. Idempotent.
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
  const proc = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "ec:<(openssl ecparam -name prime256v1)>",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "3650",
      "-nodes",
      "-subj",
      "/CN=mesh.local",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
  if (proc.exitCode !== 0) {
    // Fallback: simpler invocation without the process-substitution trick that
    // sh doesn't grok inside `argv`.
    const ec = await Bun.spawn(
      ["openssl", "ecparam", "-name", "prime256v1", "-out", path.join(root, "tls", "ec.params")],
      { stdout: "pipe", stderr: "pipe" },
    ).exited;
    if (ec !== 0) throw new Error("openssl ecparam failed");
    const ok = await Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        `ec:${path.join(root, "tls", "ec.params")}`,
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "3650",
        "-nodes",
        "-subj",
        "/CN=mesh.local",
      ],
      { stdout: "pipe", stderr: "pipe" },
    ).exited;
    if (ok !== 0) throw new Error("openssl req failed; install openssl");
  }
  await fs.chmod(keyPath, 0o600);
  const cert = (await fs.readFile(certPath)).toString("utf8");
  const key = (await fs.readFile(keyPath)).toString("utf8");
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
