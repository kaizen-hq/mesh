// Long-lived direct push token — generated on demand via `mesh push-token`,
// which writes a SHA-256 hash to <root>/push-token-hash and prints the
// plaintext once. The plaintext is never stored on disk, so a process running
// in the same container cannot read the file and use it to push.
//
// At daemon startup the hash is loaded into memory. Each incoming push is
// validated by hashing the presented token and comparing to the stored hash.

import * as path from "node:path";
import * as fs from "node:fs/promises";

export const PUSH_TOKEN_HASH_FILE = "push-token-hash";

/** Return the SHA-256 hex digest of a token string. */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a new push token, write its SHA-256 hash to disk (0o600), and
 * return the plaintext token together with the hash. Always generates a fresh
 * token — calling this again rotates the previous one.
 */
export async function generateDirectPushToken(
  root: string,
): Promise<{ token: string; hash: string }> {
  const file = path.join(root, PUSH_TOKEN_HASH_FILE);
  const token = crypto.randomUUID();
  const hash = await hashToken(token);
  await fs.writeFile(file, hash + "\n", { mode: 0o600 });
  return { token, hash };
}

/**
 * Load the stored push-token hash from disk. Returns null if no token has
 * been generated yet (the user needs to run `mesh push-token`).
 */
export async function loadDirectPushTokenHash(root: string): Promise<string | null> {
  const file = path.join(root, PUSH_TOKEN_HASH_FILE);
  try {
    const stored = (await fs.readFile(file, "utf8")).trim();
    return stored || null;
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw e;
  }
}
