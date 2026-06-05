// `mesh update-code` — refresh a source-paradigm install in place. The
// counterpart to `mesh update` (which swaps a compiled binary). Two modes:
//   local  (default): extract source from the local `mesh` bare mirror, write
//                     into the install dir, run `bun install`. Trust is git
//                     content-addressing — no signature.
//   remote: HTTP fetch /mesh-src.zip + /mesh-src.zip.sig from a peer's
//           `serve-install-code` endpoint, verify ed25519 sig against the
//           peer's pubkey in mesh.toml, unzip into the install dir, run
//           `bun install`.
//
// The shim at $BIN_DIR/mesh keeps pointing at $INSTALL_DIR/src/main.ts, so
// the next invocation picks up the new source.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as ed from "@noble/ed25519";
import { loadConfig, normalizePeerUrl, findRepo, loadAddressCache } from "./config.ts";
import type { Config, PeerEntry } from "./config.ts";
import { decodePubkey } from "./proto.ts";
import { mirrorPath } from "./repo_store.ts";
import pkg from "../package.json" with { type: "json" };

// Paths the installer (serve_install_code.ts INSTALL_SCRIPT) overwrites on
// each install. We wipe these before extracting so removed files don't linger.
const TRACKED_TOP_LEVEL = ["src", "package.json", "tsconfig.json", "README.md"];

export interface UpdateCodeOpts {
  root: string;
  from?: string | undefined;
  force?: boolean;
}

export async function runUpdateCode(opts: UpdateCodeOpts): Promise<void> {
  const installDir = resolveInstallDir();
  await assertNotDevCheckout(installDir);

  const cfg = await loadConfig(path.join(opts.root, "mesh.toml"));

  if (opts.from) {
    await updateFromPeer(opts.root, cfg, opts.from, installDir, opts.force ?? false);
    return;
  }

  try {
    await updateFromLocalMirror(opts.root, cfg, installDir, opts.force ?? false);
    return;
  } catch (e) {
    console.log(`local update unavailable: ${(e as Error).message}`);
    console.log("falling back to peer fetch...");
  }

  const tried: string[] = [];
  for (const peer of cfg.peers) {
    if (peer.name === cfg.self.name) continue;
    try {
      await updateFromPeer(opts.root, cfg, peer.name, installDir, opts.force ?? false);
      return;
    } catch (e) {
      tried.push(`${peer.name}: ${(e as Error).message}`);
    }
  }
  throw new Error(
    `no reachable update source. Tried:\n  ${tried.join("\n  ")}`,
  );
}

// ---------- install-dir resolution ----------

function resolveInstallDir(): string {
  // MESH_INSTALL_DIR matches the installer's $INSTALL_DIR override.
  const envDir = process.env["MESH_INSTALL_DIR"];
  if (envDir) return path.resolve(envDir);

  // The shim runs `exec bun "$INSTALL_DIR/src/main.ts" "$@"`, so when we're
  // invoked via the shim, argv[1] points at $INSTALL_DIR/src/main.ts.
  const entry = process.argv[1];
  if (entry && entry.endsWith(`${path.sep}src${path.sep}main.ts`)) {
    return path.dirname(path.dirname(entry));
  }

  return path.join(os.homedir(), ".local", "share", "mesh");
}

async function assertNotDevCheckout(installDir: string): Promise<void> {
  try {
    const s = await fs.stat(path.join(installDir, ".git"));
    if (s.isDirectory() || s.isFile()) {
      throw new Error(
        [
          `refusing to overwrite ${installDir}: looks like a git checkout (has .git).`,
          ``,
          `'mesh update-code' updates an installed source tree (typically`,
          `$HOME/.local/share/mesh). For a dev checkout, just 'git pull'.`,
        ].join("\n"),
      );
    }
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "ENOENT") return; // good, not a checkout
    throw e;
  }
}

// ---------- local mode ----------

async function updateFromLocalMirror(
  root: string,
  cfg: Config,
  installDir: string,
  force: boolean,
): Promise<void> {
  const repo = findRepo(cfg, "mesh");
  if (!repo) {
    throw new Error("no `mesh` repo configured; add it to mesh.toml or pass --from");
  }
  const bare = mirrorPath(root, "mesh");
  if (!(await pathExists(bare))) {
    throw new Error(`local mirror missing at ${bare}`);
  }

  const remoteVersion = await readVersionFromBare(bare);
  if (!force && remoteVersion === pkg.version) {
    console.log(`already at v${pkg.version}; nothing to do`);
    return;
  }
  console.log(`local mirror at v${remoteVersion}; refreshing ${installDir}...`);

  const work = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-code-update-"));
  try {
    await extractArchive(bare, work);
    await applySource(work, installDir);
    await runCmd(["bun", "install"], installDir);
    console.log(`updated to v${remoteVersion}; next 'mesh' invocation picks it up`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function readVersionFromBare(bare: string): Promise<string> {
  const proc = Bun.spawn(["git", "--git-dir", bare, "show", "HEAD:package.json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`git show HEAD:package.json in ${bare} failed`);
  }
  const json = JSON.parse(text) as { version?: string };
  if (!json.version) throw new Error("package.json at HEAD has no version");
  return json.version;
}

async function extractArchive(bare: string, dest: string): Promise<void> {
  const archive = Bun.spawn(["git", "--git-dir", bare, "archive", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const tar = Bun.spawn(["tar", "-x", "-C", dest], {
    stdin: archive.stdout,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [archiveExit, tarExit] = await Promise.all([archive.exited, tar.exited]);
  if (archiveExit !== 0 || tarExit !== 0) {
    throw new Error(`extracting archive from ${bare} failed`);
  }
}

// ---------- remote mode ----------

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
  const installerBase = installerUrlFor(baseUrl);

  console.log(`checking ${installerBase}/version ...`);
  const versionResp = await fetchJson(`${installerBase}/version`);
  const remoteVersion = String(versionResp.version ?? "");
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
  const ok = await ed.verifyAsync(sig, zip, peerKey);
  if (!ok) {
    throw new Error(`signature verification failed for ${peerName}`);
  }

  const work = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-code-update-"));
  try {
    const zipPath = path.join(work, "mesh-src.zip");
    await fs.writeFile(zipPath, zip);
    const extracted = path.join(work, "extracted");
    await fs.mkdir(extracted);
    await runCmd(["unzip", "-oq", zipPath, "-d", extracted], work);
    await applySource(extracted, installDir);
    await runCmd(["bun", "install"], installDir);
    console.log(
      `updated to v${remoteVersion} (signed by ${peerName}); next 'mesh' invocation picks it up`,
    );
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function resolvePeerAddress(root: string, peer: PeerEntry): Promise<string | null> {
  const cache = await loadAddressCache(root);
  return cache.addresses[peer.name] ?? peer.address ?? null;
}

// Peer addresses point at the gossip port (default 7979). serve-install-code
// listens on 8001 by default; swap when we see the default gossip port.
function installerUrlFor(baseUrl: string): string {
  return baseUrl.replace(/:(\d+)$/, (_m, p) => (p === "7979" ? ":8001" : `:${p}`));
}

// Installer endpoints may be served over https against a self-signed cert;
// identity here comes from the manifest signature + pubkey pinning in
// mesh.toml, not from TLS. See tls.ts for the rationale.
type FetchInit = RequestInit & { tls?: { rejectUnauthorized: boolean } };

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const init: FetchInit = {
    signal: AbortSignal.timeout(5000),
    tls: { rejectUnauthorized: false },
  };
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const init: FetchInit = {
    signal: AbortSignal.timeout(60000),
    tls: { rejectUnauthorized: false },
  };
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// ---------- apply ----------

async function applySource(src: string, installDir: string): Promise<void> {
  await fs.mkdir(installDir, { recursive: true });
  // Wipe the canonical top-level entries so deletions in the new source are
  // reflected. node_modules and any other extras are preserved.
  for (const name of TRACKED_TOP_LEVEL) {
    await fs.rm(path.join(installDir, name), { recursive: true, force: true });
  }
  // Copy each source entry into the install dir.
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(installDir, e.name);
    await fs.cp(from, to, { recursive: true, force: true });
  }
}

// ---------- helpers ----------

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function runCmd(argv: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(`${argv.join(" ")} failed (exit ${exit})`);
  }
}
