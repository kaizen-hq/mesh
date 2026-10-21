// Long-lived direct push token — generated once at first daemon start,
// persisted to <root>/push-token, and used to authenticate human git pushes
// from localhost when the CI runner is enabled.

import * as path from "node:path";
import * as fs from "node:fs/promises";

export const PUSH_TOKEN_FILE = "push-token";

export async function loadOrCreateDirectPushToken(root: string): Promise<string> {
  const file = path.join(root, PUSH_TOKEN_FILE);
  try {
    const existing = (await fs.readFile(file, "utf8")).trim();
    if (existing) return existing;
  } catch { /* not yet created */ }
  const token = crypto.randomUUID();
  await fs.writeFile(file, token + "\n", { mode: 0o600 });
  return token;
}
