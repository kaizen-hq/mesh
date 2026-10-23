// Direct push token — a long-lived credential for human `git push` from
// localhost when the CI runner is enabled. Distinct from per-run CI tokens,
// which are minted by the scheduler for each pipeline run and consumed once.
//
// Generated on demand via `mesh push-token`, which writes a SHA-256 hash to
// <root>/push-token-hash (mode 0o400) and prints the plaintext once. The
// plaintext is never stored on disk.
//
// In environments where human direct pushes are not needed (e.g. a CI-only
// runner in Kubernetes), leave directPushTokenHash empty — the daemon will
// log that direct push is disabled and accept only per-run CI tokens.
// If a direct push path is required in such environments, inject the hash via
// MESH_DIRECT_PUSH_TOKEN_HASH rather than writing a file.
//
// Security properties:
//   - The hash file is written read-only (0o400) so a shell job running as
//     the same uid cannot overwrite it with a hash of its own token.
//   - loadDirectPushTokenHash refuses to load a hash from a writable file —
//     defence-in-depth against misconfigured mounts or manual chmod 600.

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
 * Generate a new push token, write its SHA-256 hash to disk as a read-only
 * file (0o400), and return the plaintext token with the hash.
 *
 * Always generates a fresh token — calling this again rotates the previous
 * one. The old hash file is unlinked before the new one is created so that
 * writeFile never overwrites a read-only file.
 */
export async function generateDirectPushToken(
  root: string,
): Promise<{ token: string; hash: string }> {
  const file = path.join(root, PUSH_TOKEN_HASH_FILE);
  // Unlink first: writeFile cannot overwrite an existing 0o400 file.
  await fs.unlink(file).catch(() => {});
  const token = crypto.randomUUID();
  const hash = await hashToken(token);
  await fs.writeFile(file, hash + "\n", { mode: 0o600 });
  await fs.chmod(file, 0o400);
  return { token, hash };
}

/**
 * Load the stored push-token hash. Returns null if no token has been
 * generated yet (the user needs to run `mesh push-token`).
 *
 * Throws if the hash file is writable by this process: a writable file can
 * be overwritten by a shell job running as the same uid, which would let it
 * plant a push credential that survives daemon restarts.
 *
 * To bypass on-disk storage entirely (Kubernetes), set MESH_DIRECT_PUSH_TOKEN_HASH
 * to the hash value in a Secret and mount it as a read-only env var.
 */
export async function loadDirectPushTokenHash(root: string): Promise<string | null> {
  // Env var override: used when direct push is needed but on-disk storage is
  // not appropriate (e.g. the hash is injected from a read-only Secret).
  const envHash = process.env["MESH_DIRECT_PUSH_TOKEN_HASH"]?.trim();
  if (envHash) return envHash;

  const file = path.join(root, PUSH_TOKEN_HASH_FILE);

  let stored: string;
  try {
    stored = (await fs.readFile(file, "utf8")).trim();
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw e;
  }
  if (!stored) return null;

  // Security: if this process can write the hash file, a shell job running
  // as the same uid can overwrite it and plant a push credential that
  // survives restarts. Refuse to load from a writable file.
  let writable = false;
  try {
    await fs.access(file, fs.constants.W_OK);
    writable = true;
  } catch {
    // EACCES means not writable — expected for a 0o400 file.
  }
  if (writable) {
    const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
    throw new Error(
      `${file} is writable by this process (uid=${uid}). ` +
        `A shell job running as the same user can overwrite it and plant a push credential ` +
        `that survives daemon restarts. ` +
        `Fix: \`chmod 400 ${file}\`, ` +
        `or mount the hash via a read-only Kubernetes Secret and set MESH_DIRECT_PUSH_TOKEN_HASH.`,
    );
  }

  return stored;
}
