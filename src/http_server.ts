// Unified HTTP server. Mirrors src/http_server.rs:
//   - git smart-HTTP at /<repo>.git/{info/refs, git-upload-pack, git-receive-pack}
//   - POST /mesh/frame to receive signed frames
//   - GET /status and GET / for a browser-loadable status page

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { DaemonState } from "./state.ts";
import * as repoStore from "./repo_store.ts";
import * as gitp from "./git.ts";
import * as peerLink from "./peer_link.ts";
import {
  decodeFrame,
  decodePubkey,
  encodePubkey,
  verifyFrame,
  type Frame,
} from "./proto.ts";
import {
  verifyJoinRequest,
  nonceHex,
  type JoinRequest,
  type JoinResponse,
} from "./invite.ts";
import { addPeerToConfig, loadConfig } from "./config.ts";
import { ensureSelfSignedCert, defaultSanConfig } from "./tls.ts";

export interface ServerHandle {
  stop(): Promise<void>;
}

export async function run(state: DaemonState, listen: string): Promise<ServerHandle> {
  const [host, portStr] = parseListen(listen);
  const port = Number(portStr);
  if (Number.isNaN(port)) throw new Error(`invalid listen address: ${listen}`);

  const useTls = state.config.transport.tls;
  let tlsOpts: { cert: string; key: string } | undefined;
  if (useTls) {
    const paths = await ensureSelfSignedCert(
      state.root,
      defaultSanConfig(state.config.self.name),
    );
    if (paths.generated) {
      console.log(`tls: generated self-signed cert at ${paths.certPath}`);
    }
    const cert = await fs.readFile(paths.certPath, "utf8");
    const key = await fs.readFile(paths.keyPath, "utf8");
    tlsOpts = { cert, key };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (req: Request, srv: any) => routeRequest(state, req, srv);

  // Bun.serve types differ between versions; cast through unknown to silence.
  const serveOpts: Record<string, unknown> = {
    hostname: host,
    port,
    fetch: handler,
    error(err: Error) {
      console.error("server error:", err);
      return new Response(`error: ${err.message}`, { status: 500 });
    },
  };
  if (tlsOpts) serveOpts.tls = tlsOpts;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = (Bun as any).serve(serveOpts);
  console.log(
    `mesh HTTP server listening at ${useTls ? "https" : "http"}://${host}:${port}`,
  );

  return {
    async stop() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server as any).stop?.(true);
    },
  };
}

function parseListen(listen: string): [string, string] {
  // Accept forms: "0.0.0.0:7979", "127.0.0.1:7979", ":7979", "7979"
  if (!listen.includes(":")) return ["0.0.0.0", listen];
  const idx = listen.lastIndexOf(":");
  const host = listen.slice(0, idx) || "0.0.0.0";
  const port = listen.slice(idx + 1);
  return [host, port];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function routeRequest(state: DaemonState, req: Request, server: any): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/status" || path === "/") {
    return handleStatus(state);
  }
  if (path === "/mesh/frame" && req.method === "POST") {
    return handleFramePost(state, req, server);
  }
  if (path === "/mesh/join" && req.method === "POST") {
    return handleJoinPost(state, req);
  }
  // git smart-HTTP
  return handleGit(state, req, url);
}

// ---------- POST /mesh/join ----------

async function handleJoinPost(state: DaemonState, req: Request): Promise<Response> {
  let body: JoinRequest;
  try {
    body = (await req.json()) as JoinRequest;
  } catch (e) {
    return jsonResponse(400, { ok: false, error: `bad JSON: ${(e as Error).message}` });
  }

  let verified;
  try {
    verified = await verifyJoinRequest(body);
  } catch (e) {
    return jsonResponse(401, { ok: false, error: (e as Error).message });
  }

  const hex = nonceHex(verified.nonce);
  const pending = state.pendingInvites.get(hex);
  if (!pending) {
    return jsonResponse(401, { ok: false, error: "unknown or already-used invite nonce" });
  }
  if (pending.expiryMs < Date.now()) {
    state.pendingInvites.delete(hex);
    return jsonResponse(401, { ok: false, error: "invite expired" });
  }
  if (verified.joinerName === state.config.self.name) {
    return jsonResponse(400, { ok: false, error: "joiner name collides with inviter self.name" });
  }

  // Burn the nonce regardless of whether we successfully persist; a retry
  // with the same token must not succeed.
  state.pendingInvites.delete(hex);

  const cfgPath = path.join(state.root, "mesh.toml");
  try {
    await addPeerToConfig(cfgPath, {
      name: verified.joinerName,
      pubkey: encodePubkey(verified.joinerPubkey),
      addresses: [],
    });
    const next = await loadConfig(cfgPath);
    state.config = next;
    state.refreshPeers();
  } catch (e) {
    return jsonResponse(500, { ok: false, error: `failed to update mesh.toml: ${(e as Error).message}` });
  }

  const resp: JoinResponse = {
    ok: true,
    inviter_name: state.config.self.name,
    inviter_pubkey: state.identity.pubkeyString,
  };
  return jsonResponse(200, resp);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------- POST /mesh/frame ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleFramePost(state: DaemonState, req: Request, server: any): Promise<Response> {
  const body = new Uint8Array(await req.arrayBuffer());
  let frame: Frame;
  try {
    frame = decodeFrame(body);
  } catch (e) {
    return textResponse(400, `frame decode: ${(e as Error).message}`);
  }
  if (frame.dest !== state.config.self.name) {
    return textResponse(400, "frame.dest does not match this peer");
  }
  const peerEntry = state.config.peers.find((p) => p.name === frame.sender);
  if (!peerEntry) {
    return textResponse(401, "unknown sender");
  }
  let pubkey: Uint8Array;
  try {
    pubkey = decodePubkey(peerEntry.pubkey);
  } catch {
    return textResponse(401, "unknown sender pubkey");
  }
  let msg;
  try {
    msg = await verifyFrame(frame, pubkey);
  } catch {
    return textResponse(401, "bad signature");
  }

  await peerLink.handleInboundFrame(state, frame.sender, msg);

  // After verifying the frame is genuinely from `frame.sender`, record their
  // source IP so we can reach them if all cached addresses have gone stale
  // (e.g. they moved to a different network).
  const sourceIp: string | undefined = server?.requestIP?.(req)?.address;
  if (sourceIp) {
    const peerAddresses = state.peers.get(frame.sender)?.addresses ?? [];
    // Re-use the port from their most recently known address, falling back to
    // the default peer port.  The TCP source port is ephemeral; what we want
    // is the port they're listening on.
    const fallbackPort = String(state.config.self.peer_port);
    const knownPort =
      peerAddresses.length > 0
        ? (peerAddresses[0]!.split(":").at(-1) ?? fallbackPort)
        : fallbackPort;
    // Bracket IPv6 addresses so the result is a valid host:port string.
    const host = sourceIp.includes(":") ? `[${sourceIp}]` : sourceIp;
    const discovered = `${host}:${knownPort}`;
    await state.recordPeerAddress(frame.sender, discovered);
  }

  return new Response("", { status: 202 });
}

// ---------- git smart-HTTP ----------

interface ParsedPath {
  repo: string;
  tail: string;
}

function parseGitPath(p: string): ParsedPath | null {
  const stripped = p.startsWith("/") ? p.slice(1) : p;
  const slash = stripped.indexOf("/");
  if (slash <= 0) return null;
  const head = stripped.slice(0, slash);
  const rest = stripped.slice(slash + 1);
  if (!head.endsWith(".git")) return null;
  return { repo: head.slice(0, -4), tail: rest };
}

async function handleGit(state: DaemonState, req: Request, url: URL): Promise<Response> {
  const parsed = parseGitPath(url.pathname);
  if (!parsed) return textResponse(404, "not a mesh route");

  const method = req.method;
  let service: gitp.GitService;
  let op: "info" | "pack";
  if (method === "GET" && parsed.tail === "info/refs") {
    const q = url.searchParams.get("service") as gitp.GitService | null;
    if (q !== "git-upload-pack" && q !== "git-receive-pack") {
      return textResponse(400, "missing/unknown service");
    }
    service = q;
    op = "info";
  } else if (method === "POST" && parsed.tail === "git-upload-pack") {
    service = "git-upload-pack";
    op = "pack";
  } else if (method === "POST" && parsed.tail === "git-receive-pack") {
    service = "git-receive-pack";
    op = "pack";
  } else {
    return textResponse(404, "no such mesh route");
  }

  const dir = repoStore.mirrorPath(state.root, parsed.repo);
  try {
    await fs.access(dir);
  } catch {
    return textResponse(404, "repo not in local mirror store");
  }

  if (op === "info") {
    const body = await gitp.serveInfoRefs(dir, service);
    return new Response(body, {
      status: 200,
      headers: { "content-type": gitp.advertisementContentType(service) },
    });
  }

  // pack
  const bodyBuf = new Uint8Array(await req.arrayBuffer());
  const before = service === "git-receive-pack" ? await gitp.branchHeads(dir) : [];
  let body: Uint8Array;
  try {
    body = await gitp.servePack(dir, service, bodyBuf);
  } catch (e) {
    return textResponse(500, (e as Error).message);
  }
  const resp = new Response(body, {
    status: 200,
    headers: { "content-type": gitp.resultContentType(service) },
  });

  if (service === "git-receive-pack") {
    const after = await gitp.branchHeads(dir);
    const changes = repoStore.diffRefSnapshots(before, after);
    if (changes.length > 0) {
      const local = state.ensureRepo(parsed.repo);
      const head = await gitp.headSha(dir);
      if (head) local.lastHead = head;
      peerLink.broadcastRefUpdate(state, parsed.repo, changes, null);
    }
  }
  return resp;
}

// ---------- GET /status ----------

function handleStatus(state: DaemonState): Response {
  const cfg = state.config;
  const me = cfg.self.name;
  const myPub = state.identity.pubkeyString;
  const scheme = cfg.transport.tls ? "https" : "http";
  const now = Date.now();

  let peerRows = "";
  for (const p of cfg.peers) {
    if (p.name === me) continue;
    const entry = state.peers.get(p.name);
    const addr = entry?.addresses[0] ?? "(no address)";
    const reachable = entry?.isConnected() ?? false;
    const hb = entry?.lastHeartbeat ? `${Math.floor((now - entry.lastHeartbeat) / 1000)}s ago` : "never";
    const drift =
      entry?.lastConfigHash == null
        ? "?"
        : entry.lastConfigHash === cfg.raw_hash
          ? "ok"
          : "DRIFT";
    const cls = reachable ? "ok" : "down";
    const lbl = reachable ? "up" : "down";
    peerRows += `<tr><td>${esc(p.name)}</td><td>${esc(addr)}</td><td><span class="${cls}">${lbl}</span></td><td>${esc(hb)}</td><td>${drift}</td></tr>`;
  }
  if (!peerRows) {
    peerRows = `<tr><td colspan="5"><em>(no peers configured)</em></td></tr>`;
  }

  const contributed = new Set(cfg.repos.map((r) => r.name));
  const allNames = new Set<string>([...contributed]);
  for (const k of state.repos.keys()) allNames.add(k);
  const sortedNames = [...allNames].sort();
  let repoRows = "";
  for (const name of sortedNames) {
    const local = state.repos.get(name);
    const head = local?.lastHead?.slice(0, 10) ?? "(empty)";
    const lf = local?.lastFetch ? `${Math.floor((now - local.lastFetch) / 1000)}s ago` : "never";
    const sources = local?.sourceList().join(",") ?? "";
    const kind = contributed.has(name) ? "ours" : "mirror";
    const divCount = local?.divergenceList().length ?? 0;
    const divCell = divCount > 0 ? `<span class="down">${divCount}</span>` : "0";
    repoRows += `<tr><td>${esc(name)}</td><td>${kind}</td><td><code>${esc(head)}</code></td><td>${esc(lf)}</td><td>${esc(sources)}</td><td>${divCell}</td></tr>`;
  }
  if (!repoRows) {
    repoRows = `<tr><td colspan="6"><em>(no repos)</em></td></tr>`;
  }

  const pubShort = myPub.startsWith("ed25519:") ? myPub.slice(8, 20) : myPub.slice(0, 12);
  const cfgShort = cfg.raw_hash.slice(0, 10);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="refresh" content="5" />
<title>mesh status — ${esc(me)}</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; max-width: 920px; margin: 2rem auto; padding: 0 1rem; color: #1d1f22; }
  h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
  h2 { font-size: 1.05rem; margin: 1.75rem 0 .5rem; }
  .summary { color: #666; margin-bottom: 1.5rem; }
  .summary code { background: #f4f5f7; padding: 1px 5px; border-radius: 3px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #eaecef; }
  th { background: #f8f9fa; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: #555; }
  td code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  .ok { color: #1a7f37; font-weight: 600; }
  .down { color: #cf222e; font-weight: 600; }
  footer { margin-top: 2rem; color: #888; font-size: 12px; }
</style>
</head>
<body>
<h1>mesh — <code>${esc(me)}</code></h1>
<div class="summary">
  pubkey <code>ed25519:${esc(pubShort)}…</code> &middot; listening <code>${scheme}</code> &middot; config hash <code>${esc(cfgShort)}</code>
</div>

<h2>peers</h2>
<table>
  <thead><tr><th>name</th><th>address</th><th>status</th><th>last heartbeat</th><th>config</th></tr></thead>
  <tbody>${peerRows}</tbody>
</table>

<h2>repos</h2>
<table>
  <thead><tr><th>name</th><th>kind</th><th>head</th><th>last reconcile</th><th>sources</th><th>divergent</th></tr></thead>
  <tbody>${repoRows}</tbody>
</table>

<footer>auto-refresh every 5s — <code>GET /status</code> &middot; built on Bun</footer>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}
