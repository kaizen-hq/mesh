#!/usr/bin/env bun
// CLI dispatch.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as toml from "smol-toml";
import { defaultRoot, DaemonState } from "./state.ts";
import { loadConfig, seedConfig } from "./config.ts";
import { loadOrCreate } from "./identity.ts";
import * as control from "./control.ts";
import * as httpServer from "./http_server.ts";
import * as peerLink from "./peer_link.ts";
import * as repoStore from "./repo_store.ts";
import * as serveInstall from "./serve_install.ts";
import * as serveInstallCode from "./serve_install_code.ts";
import { buildZip, meshRoot, isCompiledBinary } from "./package_source.ts";
import { runUpdate } from "./update.ts";
import { runUpdateCode } from "./update_code.ts";
import { runAddRepos } from "./add_repos.ts";
import pkg from "../package.json" with { type: "json" };

// Source-paradigm commands need the mesh source tree on the real filesystem,
// so they're hidden (and refuse to run) inside a `bun build --compile` binary.
const SOURCE_ONLY_USAGE = `  package [out-path]                Build mesh-src.zip for delivery
  serve-install-code [--listen ADDR] Serve source zip + bun-based installer
`;

const USAGE_HEAD = `Usage: mesh <command> [args]

Commands:
  version, --version, -v            Print mesh version
  init                              Generate identity + seed mesh.toml
  pubkey                            Print our ed25519 pubkey
  url <repo>                        Print canonical local URL for a repo
  serve-install [--listen ADDR]     Serve compiled binary to teammates over HTTP
`;

const USAGE_TAIL = `  start [flags]                     Run the foreground server
  stop                              Ask the running server to shut down
  status                            self, peers, repos, freshness
  peers                             list configured peers + reachability
  repos                             list repos + freshness
  sync [--repo NAME]                force one reconcile round
  reload                            re-read mesh.toml
  reset-repo <name>                 hard-reset a mirror
  add-address <peer> <addr>         bootstrap a peer's address
  add-peer <name> <pubkey> [addr]   add a peer to mesh.toml
  add-repo <name> <path> [--branch B ...]  add a contributed repo to mesh.toml
  add-repos <parent-dir>            scan dir for git working copies, append to mesh.toml
  invite [--addr HOST:PORT] [--ttl SECS]   print a pairing token for a teammate
  join <token>                      accept a teammate's pairing token
  update [--from PEER] [--force]    fetch + swap a newer mesh binary
  update-code [--from PEER] [--force]  refresh a source-paradigm install

\`start\` flags:
  --listen ADDR                     HTTP bind (default 0.0.0.0:7979)
  --heartbeat-secs N                heartbeat interval (default 15)
  --fetch-secs N                    reconcile interval (default 60)
  --peer-tls                        listen on HTTPS instead of HTTP

Global flag:
  --root PATH                       override ~/.mesh (rarely needed)
`;

const USAGE = USAGE_HEAD + (isCompiledBinary() ? "" : SOURCE_ONLY_USAGE) + USAGE_TAIL;

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cmd: "", positional: [], flags: {} };
  if (argv.length === 0) return args;
  // Walk argv twice. First pass: pull off global flags (`--root` etc.) that
  // may precede the subcommand. Anything else is treated as a positional
  // candidate; the first positional becomes the command name.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key.includes("=")) {
        const [k, v] = key.split("=", 2);
        args.flags[k!] = v ?? "";
      } else if (key === "peer-tls" || key === "help") {
        args.flags[key] = true;
      } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        args.flags[key] = argv[i + 1]!;
        i += 1;
      } else {
        args.flags[key] = true;
      }
    } else if (!args.cmd) {
      args.cmd = a;
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const root = (args.flags["root"] as string) || defaultRoot();

  try {
    switch (args.cmd) {
      case "":
        if (args.flags["version"]) {
          console.log(pkg.version);
          return;
        }
        console.log(USAGE);
        return;
      case "help":
      case "--help":
      case "-h":
        console.log(USAGE);
        return;
      case "version":
      case "--version":
      case "-v":
        console.log(pkg.version);
        return;
      case "init":
        return await cmdInit(root);
      case "pubkey":
        return await cmdPubkey(root);
      case "url":
        return cmdUrl(args.positional[0]);
      case "serve-install":
        return await serveInstall.run((args.flags["listen"] as string) || "0.0.0.0:8000", root);
      case "serve-install-code":
        return await serveInstallCode.run(
          (args.flags["listen"] as string) || "0.0.0.0:8001",
          root,
        );
      case "package": {
        if (isCompiledBinary()) {
          throw new Error(
            "package is a source-paradigm command and cannot run from a compiled binary; run via 'bun src/main.ts package' from a checkout.",
          );
        }
        const out = args.positional[0] ?? `${meshRoot()}/mesh-src.zip`;
        const written = await buildZip(out);
        const size = await Bun.file(written).size;
        const human =
          size < 1024
            ? `${size} B`
            : size < 1024 * 1024
              ? `${(size / 1024).toFixed(1)} KB`
              : `${(size / (1024 * 1024)).toFixed(2)} MB`;
        console.log(`wrote ${written} (${human})`);
        return;
      }
      case "start":
        return await cmdStart(root, args);
      case "stop":
        return await sendAndPrint(root, { type: "stop" });
      case "status":
        return await sendAndPrint(root, { type: "status" });
      case "peers":
        return await sendAndPrint(root, { type: "peers" });
      case "repos":
        return await sendAndPrint(root, { type: "repos" });
      case "sync":
        return await sendAndPrint(root, {
          type: "sync",
          repo: (args.flags["repo"] as string) ?? null,
        });
      case "reload":
        return await sendAndPrint(root, { type: "reload" });
      case "reset-repo": {
        const name = args.positional[0];
        if (!name) {
          console.error("usage: mesh reset-repo <name>");
          process.exit(1);
        }
        return await sendAndPrint(root, { type: "reset_repo", name });
      }
      case "add-address": {
        const peer = args.positional[0];
        const address = args.positional[1];
        if (!peer || !address) {
          console.error("usage: mesh add-address <peer> <host:port>");
          process.exit(1);
        }
        return await sendAndPrint(root, { type: "add_address", peer, address });
      }
      case "add-peer": {
        const name = args.positional[0];
        const pubkey = args.positional[1];
        const address = args.positional[2];
        if (!name || !pubkey) {
          console.error("usage: mesh add-peer <name> <pubkey> [host:port]");
          process.exit(1);
        }
        return await sendAndPrint(root, { type: "add_peer", name, pubkey, address });
      }
      case "add-repo": {
        const name = args.positional[0];
        const repoPath = args.positional[1];
        if (!name || !repoPath) {
          console.error("usage: mesh add-repo <name> <path> [--branch B ...]");
          process.exit(1);
        }
        const branchesFlag = args.flags["branch"];
        const branches =
          typeof branchesFlag === "string"
            ? branchesFlag.split(",").map((s) => s.trim()).filter(Boolean)
            : [];
        return await sendAndPrint(root, {
          type: "add_repo",
          name,
          path: repoPath,
          branches,
        });
      }
      case "add-repos": {
        const parentDir = args.positional[0];
        if (!parentDir) {
          console.error("usage: mesh add-repos <parent-dir>");
          process.exit(1);
        }
        return await runAddRepos(root, parentDir);
      }
      case "invite": {
        const ttlSecs = Number(args.flags["ttl"] ?? 600);
        const address = (args.flags["addr"] as string) || "";
        return await sendAndPrint(root, {
          type: "invite",
          ttl_secs: ttlSecs,
          address,
        });
      }
      case "join": {
        const token = args.positional[0];
        if (!token) {
          console.error("usage: mesh join <token>");
          process.exit(1);
        }
        return await sendAndPrint(root, { type: "join", token });
      }
      case "update":
        return await runUpdate({
          root,
          from: (args.flags["from"] as string) || undefined,
          force: !!args.flags["force"],
        });
      case "update-code":
        return await runUpdateCode({
          root,
          from: (args.flags["from"] as string) || undefined,
          force: !!args.flags["force"],
        });
      default:
        console.error(`unknown command: ${args.cmd}\n\n${USAGE}`);
        process.exit(2);
    }
  } catch (e) {
    console.error("error:", (e as Error).message);
    process.exit(1);
  }
}

async function ensureDirs(root: string) {
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, "keys"), { recursive: true });
  await fs.mkdir(path.join(root, "tls"), { recursive: true });
  await fs.mkdir(path.join(root, "repos"), { recursive: true });
}

async function cmdInit(root: string) {
  await ensureDirs(root);
  const id = await loadOrCreate(root);
  const cfgPath = path.join(root, "mesh.toml");
  if (!(await fileExists(cfgPath))) {
    const name = process.env.USER ?? "me";
    await fs.writeFile(cfgPath, seedConfig(name, id.pubkeyString), "utf8");
    console.log(`wrote seed mesh.toml at ${cfgPath}`);
  }
  console.log("mesh identity:");
  console.log(`  pubkey: ${id.pubkeyString}`);
  console.log(`  root:   ${root}`);
  console.log(`  config: ${cfgPath}`);
}

async function cmdPubkey(root: string) {
  await ensureDirs(root);
  const id = await loadOrCreate(root);
  console.log(id.pubkeyString);
}

function cmdUrl(repo: string | undefined) {
  if (!repo) {
    console.error("usage: mesh url <repo>");
    process.exit(1);
  }
  console.log(`http://127.0.0.1:7979/${repo}.git`);
}

async function cmdStart(root: string, args: Args) {
  await ensureDirs(root);
  const id = await loadOrCreate(root);
  console.log(`loaded identity: ${id.pubkeyString}`);

  const cfg = await loadConfig(path.join(root, "mesh.toml"));
  if (args.flags["peer-tls"]) cfg.transport.tls = true;
  console.log(
    `loaded config: self=${cfg.self.name} peers=${cfg.peers.length} repos=${cfg.repos.length} tls=${cfg.transport.tls}`,
  );

  const state = await DaemonState.create(root, cfg, id);
  await repoStore.ensureMirrors(state);

  const listen = (args.flags["listen"] as string) || "0.0.0.0:7979";
  const heartbeatSecs = Number(args.flags["heartbeat-secs"] ?? 15);
  const fetchSecs = Number(args.flags["fetch-secs"] ?? 60);
  state.listenAddr = listen;

  // Spawn background tasks.
  const server = await httpServer.run(state, listen);
  const controlServer = await control.run(state);

  void peerLink.runInitialHello(state);
  void peerLink.runHeartbeat(state, heartbeatSecs);
  void peerLink.runRetryLoop(state);
  void repoStore.runFetchLoop(state, fetchSecs);

  console.log("mesh up; press Ctrl-C to stop");

  const sigint = new Promise<void>((res) => {
    process.once("SIGINT", () => {
      console.log("Ctrl-C received, shutting down");
      res();
    });
  });
  await Promise.race([sigint, state.onShutdown()]);

  controlServer.close();
  await server.stop();
}

async function sendAndPrint(root: string, req: control.ControlRequest) {
  const resp = await control.sendRequest(root, req);
  printResponse(resp);
}

function printResponse(resp: control.ControlResponse) {
  switch (resp.type) {
    case "ok":
      console.log("ok");
      return;
    case "error":
      console.error("error:", resp.message);
      process.exit(1);
    case "invite": {
      const expires = new Date(Number(resp.expires_at_ms)).toISOString();
      console.log("share this token with your teammate (expires " + expires + "):");
      console.log();
      console.log("  " + resp.token);
      console.log();
      console.log(`address: ${resp.address}`);
      console.log("teammate runs:  mesh join <token>");
      return;
    }
    case "join":
      console.log(`joined: inviter=${resp.inviter_name} address=${resp.inviter_address}`);
      console.log(`inviter pubkey: ${resp.inviter_pubkey}`);
      console.log("both sides now have each other in mesh.toml; heartbeats will sync the rest.");
      return;
    case "status":
      console.log(`self:        ${resp.name}`);
      console.log(`https:       ${resp.listen}`);
      console.log(`config hash: ${resp.config_hash}`);
      console.log();
      printPeers(resp.peers as unknown[]);
      console.log();
      printRepos(resp.repos as unknown[]);
      return;
    case "peers":
      printPeers(resp.peers as unknown[]);
      return;
    case "repos":
      printRepos(resp.repos as unknown[]);
      return;
    default:
      console.log(JSON.stringify(resp, null, 2));
  }
}

function printPeers(peers: unknown[]) {
  if (peers.length === 0) {
    console.log("(no peers configured)");
    return;
  }
  console.log("peers:");
  for (const p of peers as Array<{ name: string; address: string | null; reachable: boolean; last_heartbeat_secs: number | null; config_hash_match: boolean | null }>) {
    const hb = p.last_heartbeat_secs == null ? "never" : `${p.last_heartbeat_secs}s ago`;
    const addr = p.address ?? "(no address)";
    const reach = p.reachable ? "up" : "down";
    const drift =
      p.config_hash_match == null
        ? "config: ?"
        : p.config_hash_match
          ? "config: ok"
          : "config: DRIFT";
    console.log(
      `  ${p.name.padEnd(14)} ${reach.padEnd(4)} ${addr.padEnd(22)} hb ${hb.padEnd(10)} ${drift}`,
    );
  }
}

function printRepos(repos: unknown[]) {
  if (repos.length === 0) {
    console.log("(no repos)");
    return;
  }
  console.log("repos:");
  for (const r of repos as Array<{
    name: string;
    contributed: boolean;
    sources: string[];
    local_head: string | null;
    last_fetch_secs: number | null;
    divergences: Array<{ peer: string; branch: string; replica_ref: string; their_sha: string }>;
  }>) {
    const head = r.local_head ?? "(empty)";
    const lf = r.last_fetch_secs == null ? "never" : `${r.last_fetch_secs}s ago`;
    const kind = r.contributed ? "ours" : "mirror";
    const sources = r.sources.length > 0 ? r.sources.join(",") : "(no sources)";
    const divTag = r.divergences.length > 0 ? ` divergent=${r.divergences.length}` : "";
    console.log(
      `  ${r.name.padEnd(24)} ${kind.padEnd(6)} head=${head.slice(0, 10).padEnd(10)} last_fetch=${lf.padEnd(10)} sources=${sources}${divTag}`,
    );
    for (const d of r.divergences) {
      console.log(`      ! diverged: ${d.peer}/${d.branch} -> ${d.their_sha.slice(0, 10)} (${d.replica_ref})`);
    }
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// silence unused import in some toolchains
void toml;
void os;

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
