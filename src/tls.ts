// Self-signed cert generation for mesh's HTTPS listener.
//
// Identity in mesh is established by ed25519 signatures inside each Frame
// (see proto.ts), so TLS here is "encrypt the bytes on the wire" — not an
// authentication layer. Clients on the mesh skip verification (see
// peer_link.ts, control.ts, repo_store.ts). For that reason the cert details
// (CN, SANs) are cosmetic: they help curl/browsers but are not trusted.
//
// We avoid shelling out to openssl by hand-rolling the minimum X.509 v3
// structure on top of node:crypto's RSA keypair generator. RSA-2048 +
// sha256WithRSAEncryption was chosen because libcurl (git's transport) and
// every TLS stack we care about accept it without coaxing.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as crypto from "node:crypto";

export interface CertConfig {
  commonName: string;
  dnsNames: string[];
  ipAddresses: string[];
  validityDays: number;
}

export interface CertPaths {
  certPath: string;
  keyPath: string;
  generated: boolean;
}

export async function ensureSelfSignedCert(
  root: string,
  cfg: CertConfig,
): Promise<CertPaths> {
  const tlsDir = path.join(root, "tls");
  await fs.mkdir(tlsDir, { recursive: true });
  const certPath = path.join(tlsDir, "cert.pem");
  const keyPath = path.join(tlsDir, "key.pem");

  const haveCert = await fileExists(certPath);
  const haveKey = await fileExists(keyPath);
  if (haveCert && haveKey) {
    return { certPath, keyPath, generated: false };
  }
  if (haveCert !== haveKey) {
    throw new Error(
      `tls: exactly one of ${certPath} / ${keyPath} exists; refusing to regenerate. Delete both or supply both.`,
    );
  }

  const { cert, key } = generateSelfSignedCert(cfg);
  await writeAtomic(certPath, cert, 0o644);
  await writeAtomic(keyPath, key, 0o600);
  return { certPath, keyPath, generated: true };
}

/** Sensible default SAN set derived from the config + local hostname. */
export function defaultSanConfig(selfName: string): CertConfig {
  const host = os.hostname();
  const dns = uniq([selfName, "localhost", host].filter(Boolean));
  return {
    commonName: selfName,
    dnsNames: dns,
    ipAddresses: ["127.0.0.1"],
    validityDays: 3650,
  };
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(file: string, content: string, mode: number): Promise<void> {
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, content, { encoding: "utf8", mode });
  await fs.rename(tmp, file);
}

// ---------- cert + key generation ----------

function generateSelfSignedCert(cfg: CertConfig): { cert: string; key: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const tbsDer = buildTbsCertificate(cfg, spkiDer);
  const signature = crypto.sign("sha256", tbsDer, privateKey);

  const certDer = derSeq([
    tbsDer,
    derSeq([oid(OID.sha256WithRSAEncryption), derNull()]),
    derBitString(signature, 0),
  ]);

  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const certPem = toPem(certDer, "CERTIFICATE");
  return { cert: certPem, key: keyPem };
}

function buildTbsCertificate(cfg: CertConfig, spkiDer: Buffer): Buffer {
  // version [0] EXPLICIT v3 (INTEGER 2)
  const version = derExplicit(0, derInteger(2));

  // serialNumber: 16 random bytes, force MSB=0 to keep INTEGER positive
  const serial = Buffer.from(crypto.randomBytes(16));
  serial[0] = (serial[0]! & 0x7f) | 0x40;
  const serialNumber = derIntegerRaw(serial);

  const sigAlg = derSeq([oid(OID.sha256WithRSAEncryption), derNull()]);
  const name = encodeName(cfg.commonName);

  const now = Date.now() - 5 * 60 * 1000;
  const notBefore = derGeneralizedTime(new Date(now));
  const notAfter = derGeneralizedTime(new Date(now + cfg.validityDays * 86_400_000));
  const validity = derSeq([notBefore, notAfter]);

  const extensions = encodeExtensions(cfg);

  return derSeq([
    version,
    serialNumber,
    sigAlg,
    name, // issuer
    validity,
    name, // subject
    spkiDer,
    extensions,
  ]);
}

const OID = {
  sha256WithRSAEncryption: [1, 2, 840, 113549, 1, 1, 11],
  commonName: [2, 5, 4, 3],
  keyUsage: [2, 5, 29, 15],
  subjectAltName: [2, 5, 29, 17],
  basicConstraints: [2, 5, 29, 19],
  extKeyUsage: [2, 5, 29, 37],
  serverAuth: [1, 3, 6, 1, 5, 5, 7, 3, 1],
} as const;

function encodeName(commonName: string): Buffer {
  const attr = derSeq([oid(OID.commonName), derUtf8String(commonName)]);
  return derSeq([derSet([attr])]);
}

function encodeExtensions(cfg: CertConfig): Buffer {
  const exts: Buffer[] = [];

  // basicConstraints, critical, CA=FALSE (empty SEQUENCE)
  exts.push(derSeq([
    oid(OID.basicConstraints),
    derBoolean(true),
    derOctetString(derSeq([])),
  ]));

  // keyUsage, critical: digitalSignature(0) + keyEncipherment(2)
  // BIT STRING bits indexed left-to-right from MSB; bits 0 and 2 set →
  // first octet 0b10100000 = 0xA0, with 5 unused trailing bits.
  exts.push(derSeq([
    oid(OID.keyUsage),
    derBoolean(true),
    derOctetString(derBitString(Buffer.from([0xa0]), 5)),
  ]));

  // extKeyUsage: serverAuth
  exts.push(derSeq([
    oid(OID.extKeyUsage),
    derOctetString(derSeq([oid(OID.serverAuth)])),
  ]));

  // subjectAltName
  if (cfg.dnsNames.length || cfg.ipAddresses.length) {
    const gns: Buffer[] = [];
    for (const d of cfg.dnsNames) {
      gns.push(derContextPrimitive(2, Buffer.from(d, "ascii"))); // dNSName
    }
    for (const ip of cfg.ipAddresses) {
      const bytes = parseIpv4(ip);
      if (bytes) gns.push(derContextPrimitive(7, bytes)); // iPAddress
    }
    exts.push(derSeq([
      oid(OID.subjectAltName),
      derOctetString(derSeq(gns)),
    ]));
  }

  return derExplicit(3, derSeq(exts));
}

function parseIpv4(s: string): Buffer | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const bytes = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

// ---------- DER primitives ----------

function derLength(len: number): Buffer {
  if (len < 128) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derWrap(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derSeq(parts: Buffer[]): Buffer {
  return derWrap(0x30, Buffer.concat(parts));
}

function derSet(parts: Buffer[]): Buffer {
  return derWrap(0x31, Buffer.concat(parts));
}

function derInteger(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  if (v === 0) bytes.push(0);
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }
  if ((bytes[0]! & 0x80) !== 0) bytes.unshift(0);
  return derWrap(0x02, Buffer.from(bytes));
}

function derIntegerRaw(raw: Buffer): Buffer {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0 && (raw[start + 1]! & 0x80) === 0) {
    start++;
  }
  let b: Buffer = Buffer.from(raw.subarray(start));
  if ((b[0]! & 0x80) !== 0) {
    b = Buffer.concat([Buffer.from([0]), b]);
  }
  return derWrap(0x02, b);
}

function derNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

function derBoolean(v: boolean): Buffer {
  return Buffer.from([0x01, 0x01, v ? 0xff : 0x00]);
}

function derOctetString(content: Buffer): Buffer {
  return derWrap(0x04, content);
}

function derBitString(bytes: Buffer, unusedBits: number): Buffer {
  return derWrap(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));
}

function derUtf8String(s: string): Buffer {
  return derWrap(0x0c, Buffer.from(s, "utf8"));
}

function derGeneralizedTime(d: Date): Buffer {
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  const s =
    pad(d.getUTCFullYear(), 4) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z";
  return derWrap(0x18, Buffer.from(s, "ascii"));
}

function derExplicit(tag: number, content: Buffer): Buffer {
  // context-specific, constructed
  return derWrap(0xa0 | tag, content);
}

function derContextPrimitive(tag: number, content: Buffer): Buffer {
  return derWrap(0x80 | tag, content);
}

function oid(arcs: readonly number[]): Buffer {
  if (arcs.length < 2) throw new Error("oid: need at least two arcs");
  const out: number[] = [40 * arcs[0]! + arcs[1]!];
  for (let i = 2; i < arcs.length; i++) {
    let a = arcs[i]!;
    const stack: number[] = [];
    do {
      stack.unshift(a & 0x7f);
      a >>>= 7;
    } while (a > 0);
    for (let j = 0; j < stack.length - 1; j++) stack[j]! |= 0x80;
    out.push(...stack);
  }
  return derWrap(0x06, Buffer.from(out));
}

// ---------- PEM ----------

function toPem(der: Buffer, label: string): string {
  const b64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
