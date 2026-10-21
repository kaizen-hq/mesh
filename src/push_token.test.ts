import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadOrCreateDirectPushToken, PUSH_TOKEN_FILE } from "./push_token.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-push-token-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("loadOrCreateDirectPushToken", () => {
  it("creates a new token file when none exists", async () => {
    const token = await loadOrCreateDirectPushToken(tmpDir);
    const file = path.join(tmpDir, PUSH_TOKEN_FILE);
    expect(await Bun.file(file).exists()).toBe(true);
    expect(token).toBeTruthy();
  });

  it("returns a valid UUID", async () => {
    const token = await loadOrCreateDirectPushToken(tmpDir);
    expect(UUID_RE.test(token)).toBe(true);
  });

  it("returns the same token on subsequent calls", async () => {
    const first = await loadOrCreateDirectPushToken(tmpDir);
    const second = await loadOrCreateDirectPushToken(tmpDir);
    expect(first).toBe(second);
  });

  it("does not regenerate when the file already exists", async () => {
    const first = await loadOrCreateDirectPushToken(tmpDir);
    // Tamper with nothing — just call again
    const second = await loadOrCreateDirectPushToken(tmpDir);
    expect(second).toBe(first);
  });

  it("reads a token written externally without overwriting it", async () => {
    const known = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await fs.writeFile(path.join(tmpDir, PUSH_TOKEN_FILE), known + "\n");
    const token = await loadOrCreateDirectPushToken(tmpDir);
    expect(token).toBe(known);
  });

  it("trims whitespace from an existing token file", async () => {
    const known = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await fs.writeFile(path.join(tmpDir, PUSH_TOKEN_FILE), `  ${known}  \n`);
    const token = await loadOrCreateDirectPushToken(tmpDir);
    expect(token).toBe(known);
  });

  it("creates a new token if the file exists but is empty", async () => {
    await fs.writeFile(path.join(tmpDir, PUSH_TOKEN_FILE), "");
    const token = await loadOrCreateDirectPushToken(tmpDir);
    expect(UUID_RE.test(token)).toBe(true);
  });

  it("creates a new token if the file exists but contains only whitespace", async () => {
    await fs.writeFile(path.join(tmpDir, PUSH_TOKEN_FILE), "   \n");
    const token = await loadOrCreateDirectPushToken(tmpDir);
    expect(UUID_RE.test(token)).toBe(true);
  });

  it("two different roots get independent tokens", async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-push-token-other-"));
    try {
      const a = await loadOrCreateDirectPushToken(tmpDir);
      const b = await loadOrCreateDirectPushToken(otherDir);
      expect(a).not.toBe(b);
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });
});
