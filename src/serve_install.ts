// `mesh serve-install` — plain-HTTP one-shot serving the mesh source
// tree as a zip, plus an install script that unzips + bun-installs +
// installs a shim at ~/.local/bin/mesh.

import * as dgram from "node:dgram";
import * as ed from "./ed25519.ts";
import { buildZipBytes, isCompiledBinary } from "./package_source.ts";
import { loadOrCreate } from "./identity.ts";
import { sha256Hex, base64Encode } from "./proto.ts";
import pkg from "../package.json" with { type: "json" };

const INSTALL_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required: https://bun.sh/docs/installation" >&2
  exit 1
fi
if ! command -v unzip >/dev/null 2>&1; then
  echo "unzip is required (try: brew install unzip)" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

INSTALL_DIR="\${INSTALL_DIR:-$HOME/.local/share/mesh}"
BIN_DIR="\${BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$INSTALL_DIR" "$BIN_DIR"

TMP="$(mktemp -d -t mesh-src)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "http://__MESH_HOST__/mesh-src.zip" -o "$TMP/mesh-src.zip"

# Wipe any prior installation under INSTALL_DIR/src so removed files don't
# linger across upgrades.
rm -rf "$INSTALL_DIR/src" "$INSTALL_DIR/package.json" "$INSTALL_DIR/tsconfig.json" "$INSTALL_DIR/README.md"
unzip -oq "$TMP/mesh-src.zip" -d "$INSTALL_DIR"

(cd "$INSTALL_DIR" && bun install >/dev/null)

cat > "$BIN_DIR/mesh" <<EOF
#!/usr/bin/env bash
exec bun "$INSTALL_DIR/src/main.ts" "\\$@"
EOF
chmod +x "$BIN_DIR/mesh"

echo "installed mesh source at $INSTALL_DIR"
echo "shim:                     $BIN_DIR/mesh"
echo
echo "next steps:"
echo "  mesh init"
echo "  mesh pubkey      # share with the distributor"
echo "  mesh start"
`;

export async function run(listen: string, root: string): Promise<void> {
  if (isCompiledBinary()) {
    throw new Error(
      [
        "serve-install is a source-paradigm command and cannot run from a",
        "compiled binary: the source tree lives inside the binary's virtual FS",
        "and is invisible to the `zip` tool.",
        "",
        "To share source with teammates: run mesh from a checkout via",
        "  bun src/main.ts serve-install",
      ].join("\n"),
    );
  }

  const [host, portStr] = listen.includes(":")
    ? [
        listen.slice(0, listen.lastIndexOf(":")) || "0.0.0.0",
        listen.slice(listen.lastIndexOf(":") + 1),
      ]
    : ["0.0.0.0", listen];
  const port = Number(portStr);

  // Sign each rebuild with our identity key so `mesh update-code --from <us>`
  // can verify against our pubkey in mesh.toml.
  const identity = await loadOrCreate(root);

  // Build the zip up front so the first teammate to hit /mesh-src.zip
  // doesn't pay the zip-build latency.
  console.log("building mesh-src.zip in memory...");
  let zip = await buildZipBytes();
  let zipBuiltAt = Date.now();
  let signature = await ed.signAsync(zip, identity.privateKey);
  let versionBody = buildVersionBody(zip, signature, identity.pubkeyString);
  console.log(`zip ready (${(zip.length / 1024).toFixed(1)} KB)`);

  // Re-zip every 60s while the listener is up so source edits get picked up.
  const REBUILD_MS = 60_000;
  const rebuildIfStale = async () => {
    if (Date.now() - zipBuiltAt > REBUILD_MS) {
      try {
        const next = await buildZipBytes();
        zip = next;
        zipBuiltAt = Date.now();
        signature = await ed.signAsync(zip, identity.privateKey);
        versionBody = buildVersionBody(zip, signature, identity.pubkeyString);
        console.log(`zip refreshed (${(zip.length / 1024).toFixed(1)} KB)`);
      } catch (e) {
        console.warn("rebuild zip failed:", (e as Error).message);
      }
    }
  };

  const ip = await detectLocalIp();
  const printHost = `${ip}:${port}`;

  console.log(`\nmesh code installer listening on http://${host}:${port}\n`);
  console.log(
    `teammates run:\n  curl -fsSL http://${printHost}/install.sh | bash\n`,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = (Bun as any).serve({
    hostname: host,
    port,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const reqHost = req.headers.get("host") ?? printHost;
      if (url.pathname === "/install.sh") {
        const body = INSTALL_SCRIPT.replaceAll("__MESH_HOST__", reqHost);
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/x-shellscript" },
        });
      }
      if (url.pathname === "/mesh-src.zip") {
        await rebuildIfStale();
        return new Response(zip, {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": 'attachment; filename="mesh-src.zip"',
            "content-length": String(zip.length),
          },
        });
      }
      if (url.pathname === "/mesh-src.zip.sig") {
        await rebuildIfStale();
        return new Response(signature, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (url.pathname === "/version") {
        await rebuildIfStale();
        return new Response(versionBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/") {
        return new Response(
          `mesh source installer\n\nteammates: curl -fsSL http://${reqHost}/install.sh | bash\n`,
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

function buildVersionBody(
  zip: Uint8Array,
  sig: Uint8Array,
  pubkey: string,
): string {
  return JSON.stringify({
    version: pkg.version,
    sha256: sha256Hex(zip),
    pubkey,
    sig: base64Encode(sig),
  });
}

async function detectLocalIp(): Promise<string> {
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
