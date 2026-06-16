// Ed25519 signing via SubtleCrypto — drop-in replacement for @noble/ed25519.
// All three functions match the noble v2 async API surface.

// PKCS#8 v1 DER header for an Ed25519 private key (seed goes in the last 32 bytes).
// Layout mirrors identity.ts encodePkcs8Pem().
const PKCS8_HEADER = new Uint8Array([
  0x30, 0x2e,                    // SEQUENCE, 46
  0x02, 0x01, 0x00,              // INTEGER 0 (version)
  0x30, 0x05,                    // SEQUENCE, 5
    0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (id-Ed25519)
  0x04, 0x22,                    // OCTET STRING, 34
    0x04, 0x20,                  // OCTET STRING, 32 (seed)
]);

// SubjectPublicKeyInfo DER header for an Ed25519 public key (32 bytes follow).
const SPKI_HEADER = new Uint8Array([
  0x30, 0x2a,                    // SEQUENCE, 42
  0x30, 0x05,                    // AlgorithmIdentifier SEQUENCE, 5
    0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (id-Ed25519)
  0x03, 0x21,                    // BIT STRING, 33
    0x00,                        // 0 unused bits
]);

function seedToPkcs8(seed: Uint8Array): ArrayBuffer {
  const der = new Uint8Array(PKCS8_HEADER.length + 32);
  der.set(PKCS8_HEADER);
  der.set(seed, PKCS8_HEADER.length);
  return der.buffer as ArrayBuffer;
}

function pubkeyToSpki(pubkey: Uint8Array): ArrayBuffer {
  const der = new Uint8Array(SPKI_HEADER.length + 32);
  der.set(SPKI_HEADER);
  der.set(pubkey, SPKI_HEADER.length);
  return der.buffer as ArrayBuffer;
}

// crypto.subtle.sign/verify requires ArrayBuffer, not Uint8Array<ArrayBufferLike>.
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u.byteLength);
  new Uint8Array(ab).set(u);
  return ab;
}

function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
  return new Uint8Array(Buffer.from(padded, "base64"));
}

export async function getPublicKeyAsync(seed: Uint8Array): Promise<Uint8Array> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", seedToPkcs8(seed), { name: "Ed25519" }, true, ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", privateKey) as { x?: string };
  if (!jwk.x) throw new Error("JWK missing public key field x");
  return base64urlToBytes(jwk.x);
}

export async function signAsync(message: Uint8Array, seed: Uint8Array): Promise<Uint8Array> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", seedToPkcs8(seed), { name: "Ed25519" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, toArrayBuffer(message));
  return new Uint8Array(sig);
}

export async function verifyAsync(
  sig: Uint8Array,
  message: Uint8Array,
  pubkey: Uint8Array,
): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey(
    "spki", pubkeyToSpki(pubkey), { name: "Ed25519" }, false, ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" }, publicKey, toArrayBuffer(sig), toArrayBuffer(message),
  );
}
