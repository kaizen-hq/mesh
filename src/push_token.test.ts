import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateDirectPushToken,
  loadDirectPushTokenHash,
  hashToken,
  PUSH_TOKEN_HASH_FILE,
} from "./push_token.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-push-token-test-"));
});

afterEach(async () => {
  // Hash file is 0o400 — chmod before rm so cleanup always works.
  const file = path.join(tmpDir, PUSH_TOKEN_HASH_FILE);
  await fs.chmod(file, 0o600).catch(() => {});
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("hashToken", () => {
  it("returns a 64-character hex string", async () => {
    const h = await hashToken("some-token");
    expect(HEX64_RE.test(h)).toBe(true);
  });

  it("is deterministic", async () => {
    expect(await hashToken("abc")).toBe(await hashToken("abc"));
  });

  it("different tokens produce different hashes", async () => {
    expect(await hashToken("a")).not.toBe(await hashToken("b"));
  });
});

describe("generateDirectPushToken", () => {
  it("returns a valid UUID plaintext token", async () => {
    const { token } = await generateDirectPushToken(tmpDir);
    expect(UUID_RE.test(token)).toBe(true);
  });

  it("returns a 64-char hex hash", async () => {
    const { hash } = await generateDirectPushToken(tmpDir);
    expect(HEX64_RE.test(hash)).toBe(true);
  });

  it("hash matches hashToken(token)", async () => {
    const { token, hash } = await generateDirectPushToken(tmpDir);
    expect(await hashToken(token)).toBe(hash);
  });

  it("writes the hash (not the plaintext token) to disk", async () => {
    const { token, hash } = await generateDirectPushToken(tmpDir);
    const onDisk = (await fs.readFile(path.join(tmpDir, PUSH_TOKEN_HASH_FILE), "utf8")).trim();
    expect(onDisk).toBe(hash);
    expect(onDisk).not.toContain(token);
  });

  it("writes the hash file with mode 0o400 (read-only)", async () => {
    await generateDirectPushToken(tmpDir);
    const stat = await fs.stat(path.join(tmpDir, PUSH_TOKEN_HASH_FILE));
    expect(stat.mode & 0o777).toBe(0o400);
  });

  it("calling again rotates — produces a new token and hash each time", async () => {
    const first = await generateDirectPushToken(tmpDir);
    const second = await generateDirectPushToken(tmpDir);
    expect(first.token).not.toBe(second.token);
    expect(first.hash).not.toBe(second.hash);
  });

  it("rotation succeeds even though the old file is 0o400", async () => {
    await generateDirectPushToken(tmpDir);
    await expect(generateDirectPushToken(tmpDir)).resolves.toBeTruthy();
  });

  it("two different roots get independent tokens", async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-push-token-other-"));
    const otherFile = path.join(otherDir, PUSH_TOKEN_HASH_FILE);
    try {
      const a = await generateDirectPushToken(tmpDir);
      const b = await generateDirectPushToken(otherDir);
      expect(a.token).not.toBe(b.token);
    } finally {
      await fs.chmod(otherFile, 0o600).catch(() => {});
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });
});

describe("loadDirectPushTokenHash", () => {
  it("returns null when no hash file exists", async () => {
    expect(await loadDirectPushTokenHash(tmpDir)).toBeNull();
  });

  it("returns the stored hash after generate", async () => {
    const { hash } = await generateDirectPushToken(tmpDir);
    expect(await loadDirectPushTokenHash(tmpDir)).toBe(hash);
  });

  it("returns null for an empty hash file", async () => {
    const file = path.join(tmpDir, PUSH_TOKEN_HASH_FILE);
    await fs.writeFile(file, "", { mode: 0o400 });
    expect(await loadDirectPushTokenHash(tmpDir)).toBeNull();
  });

  it("trims whitespace from the stored hash", async () => {
    const { hash } = await generateDirectPushToken(tmpDir);
    const file = path.join(tmpDir, PUSH_TOKEN_HASH_FILE);
    await fs.chmod(file, 0o600);
    await fs.writeFile(file, `  ${hash}  \n`, { mode: 0o600 });
    await fs.chmod(file, 0o400);
    expect(await loadDirectPushTokenHash(tmpDir)).toBe(hash);
  });

  it("throws when the hash file is writable (same-uid shell job attack vector)", async () => {
    const { hash } = await generateDirectPushToken(tmpDir);
    const file = path.join(tmpDir, PUSH_TOKEN_HASH_FILE);
    // Simulate a shell job having written/chmoded the file back to writable.
    await fs.chmod(file, 0o600);
    await expect(loadDirectPushTokenHash(tmpDir)).rejects.toThrow("writable by this process");
  });

  it("reads from MESH_DIRECT_PUSH_TOKEN_HASH env var (K8s Secret injection)", async () => {
    const fakeHash = "a".repeat(64);
    const original = process.env["MESH_DIRECT_PUSH_TOKEN_HASH"];
    process.env["MESH_DIRECT_PUSH_TOKEN_HASH"] = fakeHash;
    try {
      // No file needed — env var takes precedence.
      expect(await loadDirectPushTokenHash(tmpDir)).toBe(fakeHash);
    } finally {
      if (original === undefined) {
        delete process.env["MESH_DIRECT_PUSH_TOKEN_HASH"];
      } else {
        process.env["MESH_DIRECT_PUSH_TOKEN_HASH"] = original;
      }
    }
  });

  it("env var takes precedence over a hash file on disk", async () => {
    const { hash: diskHash } = await generateDirectPushToken(tmpDir);
    const envHash = "b".repeat(64);
    const original = process.env["MESH_DIRECT_PUSH_TOKEN_HASH"];
    process.env["MESH_DIRECT_PUSH_TOKEN_HASH"] = envHash;
    try {
      expect(await loadDirectPushTokenHash(tmpDir)).toBe(envHash);
      expect(await loadDirectPushTokenHash(tmpDir)).not.toBe(diskHash);
    } finally {
      if (original === undefined) {
        delete process.env["MESH_DIRECT_PUSH_TOKEN_HASH"];
      } else {
        process.env["MESH_DIRECT_PUSH_TOKEN_HASH"] = original;
      }
    }
  });
});
