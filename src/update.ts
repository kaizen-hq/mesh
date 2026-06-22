// `mesh update` — refresh the source install in place.
//
// Two modes:
//   github (default): download mesh-src.zip from the latest GitHub release,
//                     or a pinned tag with --ref vX.Y.Z.
//   peer (--from PEER): fetch from a teammate running `mesh serve-install-code`,
//                     verify ed25519 signature against their pubkey in mesh.toml.
//
// The install directory is detected from argv[1] (the shim points at
// $INSTALL_DIR/src/main.ts). Tracked top-level entries are wiped and refilled
// so deleted files don't linger; node_modules and any extras are preserved.
// `bun install` re-runs after each apply. The shim at ~/.local/bin/mesh keeps
// pointing at the same path, so the next invocation picks up the new source.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as ed from "./ed25519.ts";
import { loadConfig, normalizePeerUrl, loadAddressCache } from "./config.ts";
import type { Config, PeerEntry } from "./config.ts";
import { decodePubkey } from "./proto.ts";
import pkg from "../package.json" with { type: "json" };

const MESH_REPO = "kaizen-hq/mesh";

// Paths the installer (install.sh) owns. Wipe before extracting so deletions
// in the new release don't leave orphans behind.
const TRACKED_TOP_LEVEL = ["src", "package.json", "tsconfig.json", "README.md"];

export interface UpdateOpts {
  root: string;
  from?: string;   // peer name (→ peer mode); omit for GitHub mode
  ref?: string;    // pin a specific release tag, e.g. "v3.4.0" (GitHub mode only)
  force?: boolean; // update even if already at target version
}

export async function runUpdate(opts: UpdateOpts): Promise<void> {
  const installDir = resolveInstallDir();
  await assertNotDevCheckout(installDir);

  const cfg = await loadConfig(path.join(opts.root, "mesh.toml"));

  if (opts.from) {
    await updateFromPeer(opts.root, cfg, opts.from, installDir, opts.force ?? false);
  } else {
    await updateFromGitHub(installDir, opts.ref, opts.force ?? false);
  }
}

// ---------- install-dir resolution ----------

function resolveInstallDir(): string {
  if (process.env["MESH_INSTALL_DIR"]) {
    return path.resolve(process.env["MESH_INSTALL_DIR"]);
  }

  // The shim written by install.sh is: exec bun "$INSTALL_DIR/src/main.ts" "$@"
  // So argv[1] == $INSTALL_DIR/src/main.ts when running through the shim.
  const entry = process.argv[1];
  if (entry?.endsWith(`${path.sep}src${path.sep}main.ts`)) {
    return path.dirname(path.dirname(entry));
  }

  throw new Error(
    [
      `cannot determine install directory.`,
      ``,
      `'mesh update' updates a source install created by install.sh.`,
      `Set MESH_INSTALL_DIR if you installed to a custom path, or reinstall:`,
      `  curl -fsSL https://raw.githubusercontent.com/${MESH_REPO}/main/install.sh | bash`,
    ].join("\n"),
  );
}

async function assertNotDevCheckout(installDir: string): Promise<void> {
  try {
    const s = await fs.stat(path.join(installDir, ".git"));
    if (s.isDirectory() || s.isFile()) {
      throw new Error(
        [
          `refusing to update ${installDir}: looks like a git checkout (has .git).`,
          ``,
          `'mesh update' updates a source install (typically ~/.local/share/mesh).`,
          `For a dev checkout, use 'git pull'.`,
        ].join("\n"),
      );
    }
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "ENOENT") return; // not a checkout, good
    throw e;
  }
}

// ---------- GitHub release mode (default) ----------

async function updateFromGitHub(
  installDir: string,
  ref: string | undefined,
  force: boolean,
): Promise<void> {
  const tag = ref ?? await resolveLatestGitHubTag();
  const remoteVersion = tag.startsWith("v") ? tag.slice(1) : tag;

  if (!force && remoteVersion === pkg.version) {
    console.log(`already at v${pkg.version}; nothing to do (pass --force to reinstall)`);
    return;
  }

  const zipUrl = `https://github.com/${MESH_REPO}/releases/download/${tag}/mesh-src.zip`;
  console.log(`downloading ${tag} from GitHub...`);
  const zip = await fetchBytes(zipUrl);

  await extractAndApply(zip, installDir);
  console.log(`updated to v${remoteVersion}; next 'mesh' invocation picks it up`);
}

async function resolveLatestGitHubTag(): Promise<string> {
  console.log("checking latest release...");
  const resp = await fetchJson(`https://api.github.com/repos/${MESH_REPO}/releases/latest`);
  const tag = String(resp["tag_name"] ?? "");
  if (!tag) throw new Error("could not determine latest release from GitHub API");
  console.log(`latest release: ${tag}`);
  return tag;
}

// ---------- peer mode (--from PEER) ----------

async function updateFromPeer(
  root: string,
  cfg: Config,
  peerName: string,
  installDir: string,
  force: boolean,
): Promise<void> {
  const peer = cfg.peers.find((p) => p.name === peerName);
  if (!peer) throw new Error(`peer ${peerName} not in mesh.toml`);
  const address = await resolvePeerAddress(root, peer);
  if (!address) throw new Error(`no address known for peer ${peerName}`);

  const { baseUrl } = normalizePeerUrl(address, cfg.transport.tls);
  // serve-install-code listens on 8001 by default; swap when we see port 7979.
  const installerBase = baseUrl.replace(/:(\d+)$/, (_m, p) => (p === "7979" ? ":8001" : `:${p}`));

  console.log(`checking ${installerBase}/version ...`);
  const versionResp = await fetchJson(`${installerBase}/version`);
  const remoteVersion = String(versionResp["version"] ?? "");
  if (!remoteVersion) throw new Error(`peer ${peerName} did not advertise a version`);
  if (!force && remoteVersion === pkg.version) {
    console.log(`already at v${pkg.version}; nothing to do`);
    return;
  }
  console.log(`peer ${peerName} at v${remoteVersion}; downloading...`);

  const [zip, sig] = await Promise.all([
    fetchBytes(`${installerBase}/mesh-src.zip`),
    fetchBytes(`${installerBase}/mesh-src.zip.sig`),
  ]);

  if (sig.length !== 64) {
    throw new Error(`unexpected signature length ${sig.length}, want 64`);
  }
  const peerKey = decodePubkey(peer.pubkey);
  if (!await ed.verifyAsync(sig, zip, peerKey)) {
    throw new Error(`signature verification failed for ${peerName}`);
  }

  await extractAndApply(zip, installDir);
  console.log(`updated to v${remoteVersion} (signed by ${peerName}); next 'mesh' invocation picks it up`);
}

async function resolvePeerAddress(root: string, peer: PeerEntry): Promise<string | null> {
  const cache = await loadAddressCache(root);
  return cache.addresses[peer.name]?.[0] ?? peer.addresses[0] ?? null;
}

// ---------- extract + apply ----------

async function extractAndApply(zip: Uint8Array, installDir: string): Promise<void> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-update-"));
  try {
    const zipPath = path.join(work, "mesh-src.zip");
    await fs.writeFile(zipPath, zip);
    const extracted = path.join(work, "extracted");
    await fs.mkdir(extracted);
    await runCmd(["unzip", "-oq", zipPath, "-d", extracted], work);
    await applySource(extracted, installDir);
    await runCmd(["bun", "install", "--frozen-lockfile"], installDir);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function applySource(src: string, installDir: string): Promise<void> {
  await fs.mkdir(installDir, { recursive: true });
  for (const name of TRACKED_TOP_LEVEL) {
    await fs.rm(path.join(installDir, name), { recursive: true, force: true });
  }
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    await fs.cp(path.join(src, e.name), path.join(installDir, e.name), {
      recursive: true,
      force: true,
    });
  }
}

// ---------- fetch helpers ----------

type FetchInit = RequestInit & { tls?: { rejectUnauthorized: boolean } };

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) } as FetchInit);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) } as FetchInit);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// ---------- process helper ----------

async function runCmd(argv: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(`${argv.join(" ")} failed (exit ${exit})`);
}
