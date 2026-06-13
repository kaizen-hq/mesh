// `mesh update` — pull a newer mesh binary and atomically replace the running
// one. Two modes:
//   local  (default): extract source from the local `mesh` bare mirror, run
//                     `bun install` + `bun build --compile`, swap. Trust is git
//                     content-addressing — no signature.
//   remote: HTTP fetch /mesh + /mesh.sig from a peer's `serve-install`
//           endpoint, verify ed25519 sig against the peer's pubkey in
//           mesh.toml, swap.
//
// On success, the new binary is in place; the running daemon keeps the old
// inode open until exit. The user restarts mesh when ready.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as ed from "@noble/ed25519";
import { loadConfig, normalizePeerUrl, findRepo, loadAddressCache } from "./config.ts";
import type { Config, PeerEntry } from "./config.ts";
import { decodePubkey } from "./proto.ts";
import { mirrorPath } from "./repo_store.ts";
import pkg from "../package.json" with { type: "json" };

export interface UpdateOpts {
  root: string;
  from?: string | undefined;
  force?: boolean;
}

export async function runUpdate(opts: UpdateOpts): Promise<void> {
  const target = process.execPath;
  const targetBase = path.basename(target);
  if (targetBase !== "mesh") {
    throw new Error(
      [
        `refusing to overwrite ${target}: mesh is running via 'bun src/main.ts',`,
        `so process.execPath points at the Bun binary, not an installed mesh.`,
        ``,
        `'mesh update' only swaps an installed compiled binary. Either:`,
        `  - install a compiled binary and rerun update from it:`,
        `      bun run build && cp mesh ~/.local/bin/mesh`,
        `      ~/.local/bin/mesh update`,
        `  - or, if you prefer to stay on source, just 'git pull' this repo`,
        `    (no in-place update path for source checkouts).`,
      ].join("\n"),
    );
  }

  const cfg = await loadConfig(path.join(opts.root, "mesh.toml"));

  if (opts.from) {
    await updateFromPeer(opts.root, cfg, opts.from, target, opts.force ?? false);
    return;
  }

  try {
    await updateFromLocalMirror(opts.root, cfg, target, opts.force ?? false);
    return;
  } catch (e) {
    console.log(`local update unavailable: ${(e as Error).message}`);
    console.log("falling back to peer fetch...");
  }

  const tried: string[] = [];
  for (const peer of cfg.peers) {
    if (peer.name === cfg.self.name) continue;
    try {
      await updateFromPeer(opts.root, cfg, peer.name, target, opts.force ?? false);
      return;
    } catch (e) {
      tried.push(`${peer.name}: ${(e as Error).message}`);
    }
  }
  throw new Error(
    `no reachable update source. Tried:\n  ${tried.join("\n  ")}`,
  );
}

// ---------- local mode ----------

async function updateFromLocalMirror(
  root: string,
  cfg: Config,
  target: string,
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
  console.log(`local mirror at v${remoteVersion}; building...`);

  const work = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-update-"));
  try {
    await extractArchive(bare, work);
    await run(["bun", "install"], work);
    const outBin = path.join(work, "mesh.new");
    await run(["bun", "build", "src/main.ts", "--compile", "--outfile", outBin], work);
    await atomicSwap(outBin, target);
    console.log(`updated to v${remoteVersion}; restart mesh to apply`);
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
  // `git archive HEAD | tar -x -C dest`
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
  target: string,
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

  const [binary, sig] = await Promise.all([
    fetchBytes(`${installerBase}/mesh`),
    fetchBytes(`${installerBase}/mesh.sig`),
  ]);

  if (sig.length !== 64) {
    throw new Error(`unexpected signature length ${sig.length}, want 64`);
  }
  const peerKey = decodePubkey(peer.pubkey);
  const ok = await ed.verifyAsync(sig, binary, peerKey);
  if (!ok) {
    throw new Error(`signature verification failed for ${peerName}`);
  }

  const work = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-update-"));
  try {
    const tmpBin = path.join(work, "mesh.new");
    await fs.writeFile(tmpBin, binary);
    await atomicSwap(tmpBin, target);
    console.log(`updated to v${remoteVersion} (signed by ${peerName}); restart mesh to apply`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function resolvePeerAddress(root: string, peer: PeerEntry): Promise<string | null> {
  const cache = await loadAddressCache(root);
  return cache.addresses[peer.name]?.[0] ?? peer.addresses[0] ?? null;
}

// Peer addresses point at the gossip port (e.g. 7979). The installer listens on
// 8000 by default; honor that convention by swapping the port when the peer
// address has the default gossip port. If users run a non-default installer
// port, they should pass --from with an explicit URL via mesh.toml.
function installerUrlFor(baseUrl: string): string {
  return baseUrl.replace(/:(\d+)$/, (_m, p) => (p === "7979" ? ":8000" : `:${p}`));
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

// ---------- atomic swap ----------

async function atomicSwap(newPath: string, target: string): Promise<void> {
  await fs.chmod(newPath, 0o755);
  // Strip macOS quarantine attribute; best-effort.
  await Bun.spawn(["xattr", "-d", "com.apple.quarantine", newPath], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  // rename(2) is atomic when src and dst are on the same filesystem. Stage
  // alongside the target so we're on the same device.
  const staged = `${target}.new`;
  await fs.copyFile(newPath, staged);
  await fs.chmod(staged, 0o755);
  await fs.rename(staged, target);
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

async function run(argv: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(`${argv.join(" ")} failed (exit ${exit})`);
  }
}
