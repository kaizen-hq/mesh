import { describe, it, expect } from "bun:test";
import * as ed from "./ed25519.ts";

const seed = crypto.getRandomValues(new Uint8Array(32));
const message = new TextEncoder().encode("mesh test message");

describe("ed25519 (crypto.subtle)", () => {
  it("sign → verify round-trip", async () => {
    const pubkey = await ed.getPublicKeyAsync(seed);
    const sig    = await ed.signAsync(message, seed);
    const ok     = await ed.verifyAsync(sig, message, pubkey);
    expect(ok).toBe(true);
  });

  it("rejects a tampered signature", async () => {
    const pubkey = await ed.getPublicKeyAsync(seed);
    const sig    = await ed.signAsync(message, seed);
    sig[0] ^= 0xff;
    expect(await ed.verifyAsync(sig, message, pubkey)).toBe(false);
  });

  it("rejects a tampered message", async () => {
    const pubkey   = await ed.getPublicKeyAsync(seed);
    const sig      = await ed.signAsync(message, seed);
    const tampered = new Uint8Array(message);
    tampered[0] ^= 0x01;
    expect(await ed.verifyAsync(sig, tampered, pubkey)).toBe(false);
  });

  it("rejects a wrong public key", async () => {
    const sig      = await ed.signAsync(message, seed);
    const wrongKey = await ed.getPublicKeyAsync(crypto.getRandomValues(new Uint8Array(32)));
    expect(await ed.verifyAsync(sig, message, wrongKey)).toBe(false);
  });

  it("getPublicKeyAsync is deterministic for the same seed", async () => {
    const a = await ed.getPublicKeyAsync(seed);
    const b = await ed.getPublicKeyAsync(seed);
    expect(a).toEqual(b);
  });
});
