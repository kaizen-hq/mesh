// Unified HTTP server. Mirrors src/http_server.rs:
//   - git smart-HTTP at /<repo>.git/{info/refs, git-upload-pack, git-receive-pack}
//   - POST /mesh/frame to receive signed frames
//   - GET /status and GET / for a browser-loadable status page

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import type { Daemon } from "./daemon.ts";
import * as repoStore from "./repo_store.ts";
import * as gitp from "./git.ts";
import * as peerLink from "./peer_link.ts";
import { loadViews, type Views } from "./http/views/loader.ts";
import { renderStatusData, renderStatusPageFull } from "./http/views/status_view.ts";
import { renderBoardGridForRepo, renderBoardPage } from "./http/views/issues_view.ts";
import { renderCiPipelinesPage, renderCiRunDetailPage } from "./http/views/ci_view.ts";
import { parsePage, parseSize, renderPagination } from "./http/views/helpers.ts";
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
import { addPeerToConfig, loadConfig, savePendingInvites } from "./config.ts";
import { ensureSelfSignedCert, defaultSanConfig } from "./tls.ts";
import * as issues from "./issues.ts";
import type { IssueEvent } from "./proto.ts";
import * as ciHttp from "./ci/http.ts";
import { loadRun, listRuns, readLog, tailLog } from "./ci/store.ts";
import * as scheduler from "./ci/scheduler.ts";
import { loadPipeline } from "./ci/config.ts";

// ---------- security helpers ----------

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost";
}

// Replay protection: reject any frame whose signature was already seen within
// the last 5 minutes. The 64-byte ed25519 signature is unique per frame, so
// it's a fine dedup key without needing a dedicated nonce field.
const seenFrameSigs = new Map<string, number>(); // sig_hex → expiry_ms
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

function isReplay(sig: Uint8Array): boolean {
  const now = Date.now();
  const hex = Buffer.from(sig).toString("hex");
  for (const [h, exp] of seenFrameSigs) {
    if (exp < now) seenFrameSigs.delete(h);
  }
  if (seenFrameSigs.has(hex)) return true;
  seenFrameSigs.set(hex, now + REPLAY_WINDOW_MS);
  return false;
}

// ---------- SSE client registries ----------

// repo name → set of send-functions for active issue SSE connections
const issueSseClients = new Map<string, Set<() => void>>();

function subscribeIssueEvents(repo: string, send: () => void): () => void {
  let clients = issueSseClients.get(repo);
  if (!clients) { clients = new Set(); issueSseClients.set(repo, clients); }
  clients.add(send);
  return () => clients!.delete(send);
}

function notifyIssueChanged(repo: string): void {
  const clients = issueSseClients.get(repo);
  if (!clients) return;
  for (const send of clients) send();
}

// status SSE clients
const statusSseClients = new Set<() => void>();

function notifyStatusChanged(): void {
  for (const send of statusSseClients) send();
}

// CI run SSE clients: repo → set of send-functions
const ciRunSseClients = new Map<string, Set<() => void>>();

function subscribeCiRunEvents(repo: string, send: () => void): () => void {
  let clients = ciRunSseClients.get(repo);
  if (!clients) { clients = new Set(); ciRunSseClients.set(repo, clients); }
  clients.add(send);
  return () => clients!.delete(send);
}

function notifyCiRunChanged(repo: string): void {
  const clients = ciRunSseClients.get(repo);
  if (!clients) return;
  for (const send of clients) send();
}

export interface ServerHandle {
  port: number;
  stop(): Promise<void>;
}

export async function run(state: Daemon, listen: string): Promise<ServerHandle> {
  const [host, portStr] = parseListen(listen);
  const port = Number(portStr);
  if (Number.isNaN(port)) throw new Error(`invalid listen address: ${listen}`);

  const views = await loadViews();

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
  const handler = (req: Request, srv: any) => routeRequest(state, views, req, srv);

  // Bun.serve types differ between versions; cast through unknown to silence.
  const serveOpts: Record<string, unknown> = {
    hostname: host,
    port,
    fetch: handler,
    idleTimeout: 0,
    error(err: Error) {
      console.error("server error:", err);
      return new Response(`error: ${err.message}`, { status: 500 });
    },
  };
  if (tlsOpts) serveOpts.tls = tlsOpts;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = (Bun as any).serve(serveOpts);
  console.log(
    `mesh HTTP server listening at ${useTls ? "https" : "http"}://${host === '0.0.0.0' ? 'localhost' : host }:${port}`,
  );

  // Wire SSE notifications so incoming frames trigger live updates
  state.issueChangedCallbacks.push((repo) => notifyIssueChanged(repo));
  state.statusChangedCallbacks.push(() => notifyStatusChanged());
  state.ciRunChangedCallbacks.push((repo) => notifyCiRunChanged(repo));

  return {
    port: (server as any).port as number,
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
async function routeRequest(state: Daemon, views: Views, req: Request, server: any): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/static/mesh.css") {
    return new Response(views.css, { status: 200, headers: { "content-type": "text/css; charset=utf-8" } });
  }
  if (path === "/status" || path === "/") {
    return handleStatus(state, views);
  }
  if (path === "/status/events" && req.method === "GET") {
    return handleStatusEvents();
  }
  if (path === "/status/fragment" && req.method === "GET") {
    return handleStatusFragment(state);
  }
  if (path === "/mesh/frame" && req.method === "POST") {
    return handleFramePost(state, req);
  }
  if (path === "/mesh/join" && req.method === "POST") {
    return handleJoinPost(state, req);
  }
  // Issue sync endpoint: /mesh/issues/:repo/all
  const issueSyncMatch = /^\/mesh\/issues\/([^/]+)\/all$/.exec(path);
  if (issueSyncMatch && req.method === "GET") {
    return handleIssueAll(state, issueSyncMatch[1]!);
  }
  // CI peer-sync and log-chunk routes
  const ciRoute = await ciHttp.route(state, req, path);
  if (ciRoute) return ciRoute;

  // Repo hub: /repos/:name → redirect to /repos/:name/ci
  const repoHubMatch = /^\/repos\/([^/]+)$/.exec(path);
  if (repoHubMatch && req.method === "GET") {
    const repo = decodeURIComponent(repoHubMatch[1]!);
    return new Response("", { status: 302, headers: { Location: `/repos/${encodeURIComponent(repo)}/ci` } });
  }

  // CI routes: /repos/:name/ci[/...]
  const ciMatch = /^\/repos\/([^/]+)\/ci(\/.*)?$/.exec(path);
  if (ciMatch) {
    return handleCi(state, views, req, decodeURIComponent(ciMatch[1]!), ciMatch[2] ?? "");
  }

  // Issues board: /repos/:name/issues[/...]
  const issueMatch = /^\/repos\/([^/]+)\/issues(\/.*)?$/.exec(path);
  if (issueMatch) {
    return handleIssues(state, views, req, decodeURIComponent(issueMatch[1]!), issueMatch[2] ?? "");
  }
  // git smart-HTTP
  return handleGit(state, req, url, server);
}

// ---------- POST /mesh/join ----------

async function handleJoinPost(state: Daemon, req: Request): Promise<Response> {
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
  void savePendingInvites(state.root, state.pendingInvites).catch(() => {});

  const cfgPath = path.join(state.root, "mesh.toml");
  try {
    await addPeerToConfig(cfgPath, {
      name: verified.joinerName,
      pubkey: encodePubkey(verified.joinerPubkey),
      addresses: [],
    });
    const next = await loadConfig(cfgPath);
    state.reloadConfig(next);
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

async function handleFramePost(state: Daemon, req: Request): Promise<Response> {
  const body = new Uint8Array(await req.arrayBuffer());
  let frame: Frame;
  try {
    frame = decodeFrame(body);
  } catch (e) {
    return textResponse(400, `frame decode: ${(e as Error).message}`);
  }
  if (isReplay(frame.signature)) {
    return textResponse(400, "duplicate frame (replay rejected)");
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

  return new Response("", { status: 202 });
}

// ---------- CI routes ----------

async function handleCi(
  state: Daemon,
  views: Views,
  req: Request,
  repo: string,
  tail: string,
): Promise<Response> {
  const method = req.method;

  // GET /repos/:name/ci → pipelines tab (run list)
  if (tail === "" || tail === "/") {
    if (method === "GET") return handleCiPipelinesTab(state, views, req, repo);
    return textResponse(405, "method not allowed");
  }

  // GET /repos/:name/ci/events → SSE for run-changed
  if (tail === "/events" && method === "GET") {
    return handleCiEvents(repo);
  }

  // POST /repos/:name/ci/run → manual trigger
  if (tail === "/run" && method === "POST") {
    return handleCiManualRun(state, req, repo);
  }

  // /repos/:name/ci/:runId[/...]
  const runMatch = /^\/([^/]+)(\/.*)?$/.exec(tail);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1]!);
    const runTail = runMatch[2] ?? "";

    if (runTail === "" && method === "GET") return handleCiRunDetail(state, views, repo, runId);
    if (runTail === "/log/stream" && method === "GET") return handleCiLogStream(state, repo, runId);
  }

  return textResponse(404, "not found");
}

async function handleCiPipelinesTab(state: Daemon, views: Views, req: Request, repo: string): Promise<Response> {
  const url = new URL(req.url);
  const page = parsePage(url.searchParams.get("page"));
  const size = parseSize(url.searchParams.get("size"));

  const repoCfg = state.config.repos.find((r) => r.name === repo);
  const repoAbsPath = repoCfg
    ? (path.isAbsolute(repoCfg.path) ? repoCfg.path : path.join(os.homedir(), repoCfg.path))
    : null;
  const pipeline = repoAbsPath ? await loadPipeline(repoAbsPath).catch(() => null) : null;

  // Merge in-memory runs (current session) with persisted runs from disk so the
  // list survives daemon restarts and is visible on peers that don't have the
  // repo checked out locally. In-memory takes precedence for live status.
  const inMemRuns = state.ci.allRuns().filter((r) => r.repo === repo);
  const inMemIds = new Set(inMemRuns.map((r) => r.run_id));
  const diskIndex = await listRuns(state.root, repo);
  const diskRuns = (
    await Promise.all(
      diskIndex
        .filter((e) => !inMemIds.has(e.run_id))
        .map((e) => loadRun(state.root, repo, e.run_id)),
    )
  ).filter((r): r is import("./ci/types.ts").PipelineRun => r !== null);

  const allRuns = [...inMemRuns, ...diskRuns]
    .sort((a, b) => (a.started_at > b.started_at ? -1 : 1));

  // Show the runs table whenever runs exist, even if this node doesn't have the
  // repo checked out locally (e.g. a peer that received gossiped run state).
  const hasPipeline = pipeline !== null || allRuns.length > 0;
  const me = state.config.self.name;

  const pageRuns = allRuns.slice(page * size, (page + 1) * size);
  const baseUrl = `/repos/${encodeURIComponent(repo)}/ci`;
  const pagination = renderPagination(page, size, allRuns.length, baseUrl);

  return new Response(renderCiPipelinesPage(views.ciPipelines, me, repo, pageRuns, hasPipeline, pagination), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleCiRunDetail(state: Daemon, views: Views, repo: string, runId: string): Promise<Response> {
  const run = await loadRun(state.root, repo, runId);
  if (!run) return textResponse(404, "run not found");
  const log = run.status !== "running" ? await readLog(state.root, repo, runId) : "";
  const me = state.config.self.name;
  return new Response(renderCiRunDetailPage(views.ciRunDetail, me, repo, run, log), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleCiManualRun(state: Daemon, req: Request, repo: string): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let form: any;
  try { form = await req.formData(); } catch {
    return textResponse(400, "expected form body");
  }
  const ref = (form.get("ref") ?? "").toString().trim();
  if (!ref) return textResponse(400, "ref is required");

  // Resolve the ref to a real commit SHA from the local mirror.
  const mirrorDir = repoStore.mirrorPath(state.root, repo);
  const fullRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
  const sha = (await gitp.refSha(mirrorDir, fullRef)) ?? (await gitp.refSha(mirrorDir, ref)) ?? ref;

  void scheduler.onManualRun(state, repo, fullRef, sha).catch(() => {});
  return new Response("", { status: 303, headers: { Location: `/repos/${encodeURIComponent(repo)}/ci` } });
}

function handleCiLogStream(state: Daemon, repo: string, runId: string): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  const isDone = () => {
    if (cancelled) return true;
    const run = state.ci.getRun(runId);
    return run != null && run.status !== "running" && run.status !== "pending";
  };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of tailLog(state.root, repo, runId, 200, isDone)) {
          const data = JSON.stringify({ data: chunk });
          controller.enqueue(encoder.encode(`event: log-chunk\ndata: ${data}\n\n`));
        }
      } catch { /* stream ended */ } finally {
        controller.close();
      }
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function handleCiEvents(repo: string): Response {
  const encoder = new TextEncoder();
  let unsub: (() => void) | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        try { controller.enqueue(encoder.encode("event: run-changed\ndata: {}\n\n")); }
        catch { /* disconnected */ }
      };
      unsub = subscribeCiRunEvents(repo, send);
      pingTimer = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); }
        catch { clearInterval(pingTimer); }
      }, 25_000);
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() { unsub?.(); clearInterval(pingTimer); },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleGit(state: Daemon, req: Request, url: URL, server: any): Promise<Response> {
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

  // git-receive-pack (push) is restricted to localhost — peers replicate by
  // fetching (git-upload-pack), not by pushing.  Blocking remote pushes closes
  // the unauthenticated-push → malicious-pipeline → RCE chain.
  if (service === "git-receive-pack") {
    const remoteIp = server?.requestIP?.(req)?.address ?? "";
    if (!isLoopback(remoteIp)) {
      return textResponse(403, "git push is only permitted from localhost");
    }
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
      const local = state.repos.ensure(parsed.repo);
      const head = await gitp.headSha(dir);
      if (head) local.lastHead = head;
      peerLink.broadcastRefUpdate(state, parsed.repo, changes, null);
    }
  }
  return resp;
}

// ---------- GET /status ----------

function handleStatus(state: Daemon, views: Views): Response {
  const cfg = state.config;
  const myPub = state.identity.pubkeyString;
  const pubShort = myPub.startsWith("ed25519:") ? myPub.slice(8, 20) : myPub.slice(0, 12);
  const cfgShort = cfg.raw_hash.slice(0, 10);
  const ctx = { config: cfg, peers: state.peers, repos: state.repos, ci: state.ci };
  return new Response(renderStatusPageFull(views.status, ctx, pubShort, cfgShort), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function handleStatusFragment(state: Daemon): Response {
  const ctx = { config: state.config, peers: state.peers, repos: state.repos, ci: state.ci };
  return new Response(renderStatusData(ctx), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function handleStatusEvents(): Response {
  const encoder = new TextEncoder();
  let unsub: (() => void) | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        try { controller.enqueue(encoder.encode("event: status-changed\ndata: {}\n\n")); }
        catch { /* client disconnected */ }
      };
      statusSseClients.add(send);
      unsub = () => statusSseClients.delete(send);
      pingTimer = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); }
        catch { clearInterval(pingTimer); }
      }, 25_000);
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() {
      unsub?.();
      clearInterval(pingTimer);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

// ---------- Issues ----------

function authorShort(state: Daemon): string {
  const pub = state.identity.pubkeyString;
  return pub.startsWith("ed25519:") ? pub.slice(8, 14) : pub.slice(0, 6);
}

async function handleIssues(
  state: Daemon,
  views: Views,
  req: Request,
  repo: string,
  tail: string,
): Promise<Response> {
  const method = req.method;

  if (tail === "" || tail === "/") {
    if (method === "GET") return handleIssueBoard(state, views, req, repo);
    if (method === "POST") return handleIssueCreate(state, req, repo);
  }
  if (tail === "/events" && method === "GET") {
    return handleIssueEvents(repo);
  }
  if (tail === "/board" && method === "GET") {
    return handleIssueBoardFragment(state, req, repo);
  }
  const actionMatch = /^\/([^/]+)\/(comment|status|order)$/.exec(tail);
  if (actionMatch && method === "POST") {
    const id = decodeURIComponent(actionMatch[1]!);
    const action = actionMatch[2] as "comment" | "status" | "order";
    if (action === "comment") return handleIssueComment(state, req, repo, id);
    if (action === "status") return handleIssueStatus(state, req, repo, id);
    return handleIssueOrder(state, req, repo, id);
  }
  return textResponse(404, "not found");
}

async function handleIssueAll(state: Daemon, repo: string): Promise<Response> {
  const wire = await issues.listIssuesAsWire(state.root, repo);
  return new Response(JSON.stringify(wire), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleIssueBoard(state: Daemon, views: Views, req: Request, repo: string): Promise<Response> {
  const url = new URL(req.url);
  const page = parsePage(url.searchParams.get("page"));
  const size = parseSize(url.searchParams.get("size"));
  const all = await issues.listIssues(state.root, repo);
  const pageIssues = all.slice(page * size, (page + 1) * size);
  const baseUrl = `/repos/${encodeURIComponent(repo)}/issues`;
  const pagination = renderPagination(page, size, all.length, baseUrl);
  const me = state.config.self.name;
  return new Response(renderBoardPage(views.issues, me, repo, pageIssues, pagination), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleIssueBoardFragment(state: Daemon, req: Request, repo: string): Promise<Response> {
  const url = new URL(req.url);
  const page = parsePage(url.searchParams.get("page"));
  const size = parseSize(url.searchParams.get("size"));
  const all = await issues.listIssues(state.root, repo);
  const pageIssues = all.slice(page * size, (page + 1) * size);
  return new Response(renderBoardGridForRepo(pageIssues, repo), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleIssueCreate(
  state: Daemon,
  req: Request,
  repo: string,
): Promise<Response> {
  let form;
  try { form = await req.formData(); } catch {
    return textResponse(400, "expected form body");
  }
  const title = (form.get("title") ?? "").toString().trim();
  if (!title) return textResponse(400, "title is required");
  const body = (form.get("body") ?? "").toString().trim();
  const labelsRaw = (form.get("labels") ?? "").toString();
  const labels = labelsRaw.split(",").map((l) => l.trim()).filter(Boolean);
  const author = authorShort(state);

  const issue = await issues.createIssue(state.root, repo, author, title, body, labels);
  const event: IssueEvent = {
    type: "IssueCreated",
    repo,
    id: issue.meta.id,
    title: issue.meta.title,
    body: issue.body,
    labels: issue.meta.labels,
    author: issue.meta.author,
    created: issue.meta.created,
  };
  peerLink.broadcastIssueEvent(state, event);
  notifyIssueChanged(repo);
  return new Response("", { status: 303, headers: { Location: `/repos/${repo}/issues` } });
}

async function handleIssueComment(
  state: Daemon,
  req: Request,
  repo: string,
  id: string,
): Promise<Response> {
  let form;
  try { form = await req.formData(); } catch {
    return textResponse(400, "expected form body");
  }
  const body = (form.get("body") ?? "").toString().trim();
  if (!body) return new Response("", { status: 303, headers: { Location: `/repos/${repo}/issues#${id}` } });
  const author = authorShort(state);

  let result: { created: string };
  try {
    result = await issues.addComment(state.root, repo, id, author, body);
  } catch (e) {
    return textResponse(404, (e as Error).message);
  }
  const event: IssueEvent = { type: "IssueCommented", repo, id, author, created: result.created, body };
  peerLink.broadcastIssueEvent(state, event);
  notifyIssueChanged(repo);
  return new Response("", { status: 303, headers: { Location: `/repos/${repo}/issues#${id}` } });
}

async function handleIssueStatus(
  state: Daemon,
  req: Request,
  repo: string,
  id: string,
): Promise<Response> {
  let form;
  try { form = await req.formData(); } catch {
    return textResponse(400, "expected form body");
  }
  const status = (form.get("status") ?? "").toString() as issues.IssueStatus;
  if (status !== "open" && status !== "closed" && status !== "trashed") return textResponse(400, "invalid status");
  const author = authorShort(state);
  const updated = new Date().toISOString();

  try {
    await issues.setStatus(state.root, repo, id, status, updated);
  } catch (e) {
    return textResponse(404, (e as Error).message);
  }
  const event: IssueEvent = { type: "IssueStatusChanged", repo, id, status, author, updated };
  peerLink.broadcastIssueEvent(state, event);
  notifyIssueChanged(repo);
  // Trash uses fetch (no page reload); done/reopen use a plain form POST (redirect back).
  if (status === "trashed") return new Response("", { status: 200 });
  return new Response("", { status: 303, headers: { Location: `/repos/${repo}/issues` } });
}

async function handleIssueOrder(
  state: Daemon,
  req: Request,
  repo: string,
  id: string,
): Promise<Response> {
  let form;
  try { form = await req.formData(); } catch {
    return textResponse(400, "expected form body");
  }
  const order = parseFloat((form.get("order") ?? "").toString());
  if (isNaN(order)) return textResponse(400, "invalid order");

  try {
    await issues.setOrder(state.root, repo, id, order);
  } catch (e) {
    return textResponse(404, (e as Error).message);
  }
  const event: IssueEvent = { type: "IssueReordered", repo, id, order };
  peerLink.broadcastIssueEvent(state, event);
  notifyIssueChanged(repo);
  return new Response("", { status: 200 });
}

function handleIssueEvents(repo: string): Response {
  const encoder = new TextEncoder();
  let unsub: (() => void) | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        try {
          controller.enqueue(encoder.encode("event: board-changed\ndata: {}\n\n"));
        } catch { /* client disconnected */ }
      };
      unsub = subscribeIssueEvents(repo, send);
      // keep-alive ping every 25s to prevent proxy timeouts
      pingTimer = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { clearInterval(pingTimer); }
      }, 25_000);
      // initial confirmation
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() {
      unsub?.();
      clearInterval(pingTimer);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
