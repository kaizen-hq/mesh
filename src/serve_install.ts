// `mesh serve-install` — plain-HTTP one-shot serving this binary + an install
// script teammates can curl. Parity with `mesh serve-install` in the Rust impl.

import * as fs from "node:fs/promises";
import * as dgram from "node:dgram";
import * as ed from "./ed25519.ts";
import { loadOrCreate } from "./identity.ts";
import { sha256Hex, base64Encode } from "./proto.ts";
import pkg from "../package.json" with { type: "json" };

const INSTALL_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

ARCH="$(uname -m)"
OS="$(uname -s)"
if [[ "$OS" != "Darwin" ]]; then
  echo "This installer targets macOS." >&2
  exit 1
fi
if [[ "$ARCH" != "arm64" ]]; then
  echo "Expected arm64; got $ARCH" >&2
  exit 1
fi

INSTALL_DIR="\${INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$INSTALL_DIR"
TMP="$(mktemp -t mesh)"
curl -fsSL "http://__MESH_HOST__/mesh" -o "$TMP"
xattr -d com.apple.quarantine "$TMP" 2>/dev/null || true
chmod +x "$TMP"
mv "$TMP" "$INSTALL_DIR/mesh"

echo "installed: $INSTALL_DIR/mesh"
echo
echo "next steps:"
echo "  mesh init"
echo "  mesh pubkey   # share with the distributor"
echo "  mesh start"
`;

export async function run(listen: string, root: string): Promise<void> {
  const [host, portStr] = listen.includes(":")
    ? [listen.slice(0, listen.lastIndexOf(":")) || "0.0.0.0", listen.slice(listen.lastIndexOf(":") + 1)]
    : ["0.0.0.0", listen];
  const port = Number(portStr);

  // Find this binary on disk so we can serve it.
  const binaryPath = process.execPath; // for `bun src/main.ts`, this is bun's path
  // If we're being invoked via `bun src/main.ts`, serve the TypeScript entry
  // bundled as a single file. Otherwise serve `process.execPath`.
  // Easiest UX: build first with `bun build --compile` and serve that path.
  let binary: Uint8Array;
  try {
    const b = await fs.readFile(binaryPath);
    binary = new Uint8Array(b);
  } catch (e) {
    throw new Error(`could not read this binary at ${binaryPath}: ${(e as Error).message}`);
  }

  // Sign the binary with our identity key so `mesh update --from <us>` can
  // verify the bytes against our pubkey in mesh.toml. Computed once at boot.
  const identity = await loadOrCreate(root);
  const signature = await ed.signAsync(binary, identity.privateKey);
  const binarySha256 = sha256Hex(binary);
  const versionBody = JSON.stringify({
    version: pkg.version,
    sha256: binarySha256,
    pubkey: identity.pubkeyString,
    sig: base64Encode(signature),
  });

  // Detect our outbound IP for the prompt; same UDP-connect trick as Rust.
  const ip = await detectLocalIp();
  const printHost = `${ip}:${port}`;

  console.log(`mesh installer listening on http://${host}:${port}\n`);
  console.log(`teammates run:\n  curl -fsSL http://${printHost}/install.sh | bash`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = (Bun as any).serve({
    hostname: host,
    port,
    fetch(req: Request): Response {
      const url = new URL(req.url);
      const reqHost = req.headers.get("host") ?? printHost;
      if (url.pathname === "/install.sh") {
        const body = INSTALL_SCRIPT.replaceAll("__MESH_HOST__", reqHost);
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/x-shellscript" },
        });
      }
      if (url.pathname === "/mesh" || url.pathname === "/mesh") {
        return new Response(binary, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (url.pathname === "/mesh.sig") {
        return new Response(signature, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (url.pathname === "/version") {
        return new Response(versionBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/") {
        return new Response(
          `mesh installer\n\nteammates: curl -fsSL http://${reqHost}/install.sh | bash\n`,
          { status: 200, headers: { "content-type": "text/plain" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });

  await new Promise<void>((res) => {
    process.once("SIGINT", () => {
      console.log("\n^C, stopping installer.");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server as any).stop?.(true);
      res();
    });
  });
}

async function detectLocalIp(): Promise<string> {
  // Mirror the UDP-connect trick from the Rust version: bind a UDP socket,
  // ask the OS what local addr it would use to reach a public host, never
  // actually send any packets.
  return await new Promise<string>((resolve) => {
    const sock = dgram.createSocket("udp4");
    sock.once("error", () => {
      sock.close();
      resolve("0.0.0.0");
    });
    sock.connect(80, "8.8.8.8", () => {
      const { address } = sock.address() as { address: string };
      sock.close();
      resolve(address);
    });
  });
}
