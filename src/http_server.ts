// Unified HTTP server. Mirrors src/http_server.rs:
//   - git smart-HTTP at /<repo>.git/{info/refs, git-upload-pack, git-receive-pack}
//   - POST /mesh/frame to receive signed frames
//   - GET /status and GET / for a browser-loadable status page

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
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
import * as issues from "./issues.ts";
import type { IssueEvent } from "./proto.ts";
import * as ciHttp from "./ci/http.ts";
import { loadRun, listRuns, readLog, tailLog } from "./ci/store.ts";
import * as scheduler from "./ci/scheduler.ts";
import { loadPipeline } from "./ci/config.ts";

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
    `mesh HTTP server listening at ${useTls ? "https" : "http"}://${host}:${port}`,
  );

  // Wire SSE notifications so incoming frames trigger live updates
  state.issueChangedCallbacks.push((repo) => notifyIssueChanged(repo));
  state.statusChangedCallbacks.push(() => notifyStatusChanged());
  state.ciRunChangedCallbacks.push((repo) => notifyCiRunChanged(repo));

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
  if (path === "/status/events" && req.method === "GET") {
    return handleStatusEvents();
  }
  if (path === "/status/fragment" && req.method === "GET") {
    return handleStatusFragment(state);
  }
  if (path === "/mesh/frame" && req.method === "POST") {
    return handleFramePost(state, req, server);
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
    return handleCi(state, req, decodeURIComponent(ciMatch[1]!), ciMatch[2] ?? "");
  }

  // Issues board: /repos/:name/issues[/...]
  const issueMatch = /^\/repos\/([^/]+)\/issues(\/.*)?$/.exec(path);
  if (issueMatch) {
    return handleIssues(state, req, decodeURIComponent(issueMatch[1]!), issueMatch[2] ?? "");
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

// ---------- CI routes ----------

async function handleCi(
  state: DaemonState,
  req: Request,
  repo: string,
  tail: string,
): Promise<Response> {
  const method = req.method;

  // GET /repos/:name/ci → pipelines tab (run list)
  if (tail === "" || tail === "/") {
    if (method === "GET") return handleCiPipelinesTab(state, repo);
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

    if (runTail === "" && method === "GET") return handleCiRunDetail(state, repo, runId);
    if (runTail === "/log/stream" && method === "GET") return handleCiLogStream(state, repo, runId);
  }

  return textResponse(404, "not found");
}

async function handleCiPipelinesTab(state: DaemonState, repo: string): Promise<Response> {
  const repoCfg = state.config.repos.find((r) => r.name === repo);
  const repoAbsPath = repoCfg
    ? (path.isAbsolute(repoCfg.path) ? repoCfg.path : path.join(os.homedir(), repoCfg.path))
    : null;
  const pipeline = repoAbsPath ? await loadPipeline(repoAbsPath).catch(() => null) : null;

  // Merge in-memory runs (current session) with persisted runs from disk so the
  // list survives daemon restarts. In-memory takes precedence for live status.
  const inMemRuns = [...state.ci.runs.values()].filter((r) => r.repo === repo);
  const inMemIds = new Set(inMemRuns.map((r) => r.run_id));
  const diskIndex = pipeline ? await listRuns(state.root, repo) : [];
  const diskRuns = (
    await Promise.all(
      diskIndex
        .filter((e) => !inMemIds.has(e.run_id))
        .map((e) => loadRun(state.root, repo, e.run_id)),
    )
  ).filter((r): r is import("./ci/types.ts").PipelineRun => r !== null);

  const allRuns = [...inMemRuns, ...diskRuns]
    .sort((a, b) => (a.started_at > b.started_at ? -1 : 1));

  return new Response(renderCiPipelinesPage(state, repo, allRuns, pipeline !== null), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleCiRunDetail(state: DaemonState, repo: string, runId: string): Promise<Response> {
  const run = await loadRun(state.root, repo, runId);
  if (!run) return textResponse(404, "run not found");
  const log = run.status !== "running" ? await readLog(state.root, repo, runId) : "";
  return new Response(renderCiRunDetailPage(state, repo, run, log), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleCiManualRun(state: DaemonState, req: Request, repo: string): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let form: any;
  try { form = await req.formData(); } catch {
    return textResponse(400, "expected form body");
  }
  const ref = (form.get("ref") ?? "").toString().trim();
  if (!ref) return textResponse(400, "ref is required");

  void scheduler.onRefUpdate(state, repo, ref, ref).catch(() => {});
  return new Response("", { status: 303, headers: { Location: `/repos/${encodeURIComponent(repo)}/ci` } });
}

function handleCiLogStream(state: DaemonState, repo: string, runId: string): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  const isDone = () => {
    if (cancelled) return true;
    const run = state.ci.runs.get(runId);
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

// ---------- CI HTML rendering ----------

function ciStatusBadge(status: string): string {
  switch (status) {
    case "passed": return `<span class="ok">✓ pass</span>`;
    case "failed": return `<span class="down">✗ fail</span>`;
    case "running": return `<span class="running">● run</span>`;
    case "cancelled": return `<span class="down">✕ cancelled</span>`;
    default: return `<span>${esc(status)}</span>`;
  }
}

function renderCiPipelinesPage(
  state: DaemonState,
  repo: string,
  runs: import("./ci/types.ts").PipelineRun[],
  hasPipeline: boolean,
): string {
  const me = state.config.self.name;

  let rows = "";
  for (const run of runs.slice(0, 50)) {
    const sha7 = run.sha.slice(0, 7);
    const ref = run.ref.replace("refs/heads/", "");
    const trigger = run.triggered_by.type === "push"
      ? `push (${esc(run.triggered_by.pusher)})`
      : run.triggered_by.type === "cron"
        ? "cron"
        : `manual (${esc((run.triggered_by as { initiator: string }).initiator)})`;
    const dur = run.completed_at
      ? `${Math.floor((new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 1000)}s`
      : "running";
    rows += `<tr>
      <td>${ciStatusBadge(run.status)}</td>
      <td><code>${esc(ref)}</code></td>
      <td><code>${esc(sha7)}</code></td>
      <td>${esc(trigger)}</td>
      <td>${esc(run.runner)}</td>
      <td>${esc(dur)}</td>
      <td><a href="/repos/${esc(repo)}/ci/${esc(run.run_id)}">${relativeAge(run.started_at)}</a></td>
    </tr>`;
  }
  if (!rows) rows = `<tr><td colspan="7"><em>(no runs yet)</em></td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pipelines — ${esc(repo)} — ${esc(me)}</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; max-width: 1080px; margin: 2rem auto; padding: 0 1rem; color: #1d1f22; }
  a { color: inherit; }
  h1 { margin: 0 0 1rem; font-size: 1.1rem; font-weight: 400; }
  h1 strong { font-weight: 700; }
  nav { margin-bottom: 1.5rem; display: flex; gap: 1rem; }
  nav a { padding: .3rem .6rem; border-radius: 3px; text-decoration: none; font-size: 13px; color: #555; }
  nav a.active { background: #1d1f22; color: #fff; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #eaecef; font-size: 13px; }
  th { background: #f8f9fa; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: #555; }
  td code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .ok { color: #1a7f37; font-weight: 600; }
  .down { color: #cf222e; font-weight: 600; }
  .running { color: #9a6700; font-weight: 600; }
  .run-btn { background: none; border: 1px solid #ddd; border-radius: 3px; padding: .3rem .7rem; font-size: 12px; cursor: pointer; font-family: inherit; color: #555; }
  .run-btn:hover { background: #f0f0f0; }
  .run-form { display: flex; gap: .5rem; align-items: center; margin-bottom: 1rem; }
  .run-form input { font-family: inherit; font-size: 13px; border: 1px solid #ddd; border-radius: 3px; padding: .3rem .6rem; }
  .no-pipeline { margin-top: 1rem; color: #555; }
  .no-pipeline p { margin: 0 0 .6rem; }
  .no-pipeline pre { background: #f4f5f7; border: 1px solid #eaecef; border-radius: 4px; padding: .75rem 1rem; font-size: 12.5px; line-height: 1.6; overflow-x: auto; margin: 0 0 1rem; }
  .no-pipeline code { background: #f4f5f7; padding: 1px 5px; border-radius: 3px; font-size: 12.5px; }
  footer { margin-top: 2rem; color: #888; font-size: 12px; }
</style>
</head>
<body>
<h1><a href="/status">${esc(me)}</a> / <strong>${esc(repo)}</strong></h1>
<nav>
  <a href="/repos/${esc(repo)}/issues">issues</a>
  <a href="/repos/${esc(repo)}/ci" class="active">pipelines</a>
</nav>

${hasPipeline ? `
<form class="run-form" method="POST" action="/repos/${esc(repo)}/ci/run">
  <input name="ref" placeholder="branch or SHA" required>
  <button class="run-btn" type="submit">run pipeline</button>
</form>

<div id="runs-table">
<table>
  <thead><tr><th>status</th><th>ref</th><th>sha</th><th>triggered by</th><th>runner</th><th>duration</th><th>started</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</div>` : `
<div class="no-pipeline">
  <p>No pipeline configured for this repo.</p>
  <p>Create <code>.mesh/mesh-ci.yml</code> and commit it to get started:</p>
  <pre>pipeline:
  name: ${esc(repo)}

on:
  push:
    branches: [main]
  manual: true

jobs:
  test:
    mode: shell
    commands:
      - bun test</pre>
  <p>Then enable shell execution on this node in <code>~/.mesh/cicd.toml</code>:</p>
  <pre>[runner]
enabled = true
allow_shell = true</pre>
</div>`}

<footer><a href="/status">mesh status</a></footer>

<script>
const es = new EventSource(location.pathname + '/events');
es.addEventListener('run-changed', async () => {
  try {
    const html = await fetch(location.pathname).then(r => r.text());
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const next = tmp.querySelector('#runs-table');
    if (next) document.getElementById('runs-table').replaceWith(next);
  } catch {}
});
</script>
</body>
</html>`;
}

function renderCiRunDetailPage(
  state: DaemonState,
  repo: string,
  run: import("./ci/types.ts").PipelineRun,
  log: string,
): string {
  const me = state.config.self.name;
  const ref = run.ref.replace("refs/heads/", "");
  const sha7 = run.sha.slice(0, 7);
  const trigger = run.triggered_by.type === "push"
    ? `push by ${esc(run.triggered_by.pusher)}`
    : run.triggered_by.type === "cron"
      ? `cron (${esc(run.triggered_by.slot)})`
      : `manual by ${esc((run.triggered_by as { initiator: string }).initiator)}`;
  const dur = run.completed_at
    ? `${Math.floor((new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 1000)}s`
    : "running";

  let jobRows = "";
  for (const [jobName, job] of Object.entries(run.jobs)) {
    const d = job.completed_at && job.started_at
      ? `${Math.floor((new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 1000)}s`
      : "";
    jobRows += `<tr><td>${esc(jobName)}</td><td>${ciStatusBadge(job.status)}</td><td>${esc(d)}</td><td>${job.exit_code ?? ""}</td></tr>`;
  }

  const logBlock = run.status === "running"
    ? `<pre id="log-viewer" class="log-viewer"></pre>
<script>
const es = new EventSource('/repos/${esc(repo)}/ci/${esc(run.run_id)}/log/stream');
const pre = document.getElementById('log-viewer');
let follow = true;
pre.addEventListener('scroll', () => { follow = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40; });
es.addEventListener('log-chunk', e => {
  const d = JSON.parse(e.data);
  pre.textContent += d.data;
  if (follow) pre.scrollTop = pre.scrollHeight;
});
</script>`
    : `<pre class="log-viewer">${esc(log)}</pre>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>run ${esc(run.run_id.slice(0, 8))} — ${esc(repo)}</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; max-width: 1080px; margin: 2rem auto; padding: 0 1rem; color: #1d1f22; }
  a { color: inherit; }
  h1 { margin: 0 0 .5rem; font-size: 1.1rem; font-weight: 400; }
  h2 { font-size: .95rem; margin: 1.5rem 0 .4rem; }
  .meta { color: #666; font-size: 13px; margin-bottom: 1rem; }
  .meta code { background: #f4f5f7; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #eaecef; font-size: 13px; }
  th { background: #f8f9fa; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: #555; }
  .ok { color: #1a7f37; font-weight: 600; }
  .down { color: #cf222e; font-weight: 600; }
  .running { color: #9a6700; font-weight: 600; }
  .log-viewer { background: #1d1f22; color: #d1d5db; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; padding: 1rem; border-radius: 3px; overflow: auto; max-height: 600px; white-space: pre; }
  footer { margin-top: 2rem; color: #888; font-size: 12px; }
</style>
</head>
<body>
<h1><a href="/status">${esc(me)}</a> / <a href="/repos/${esc(repo)}/ci">${esc(repo)} pipelines</a> / run <code>${esc(run.run_id.slice(0, 8))}</code></h1>
<div class="meta">
  ${ciStatusBadge(run.status)} &middot;
  ref <code>${esc(ref)}</code> &middot;
  sha <code>${esc(sha7)}</code> &middot;
  ${esc(trigger)} &middot;
  runner <code>${esc(run.runner)}</code> &middot;
  ${esc(dur)}
</div>

<h2>jobs</h2>
<table>
  <thead><tr><th>job</th><th>status</th><th>duration</th><th>exit code</th></tr></thead>
  <tbody>${jobRows || `<tr><td colspan="4"><em>(no jobs)</em></td></tr>`}</tbody>
</table>

<h2>log</h2>
${logBlock}

<footer><a href="/repos/${esc(repo)}/ci">← back to pipelines</a></footer>
</body>
</html>`;
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

function latestRunBadge(state: DaemonState, repo: string, now: number): string {
  // Find the most recently completed run for this repo
  let latest: import("./ci/types.ts").PipelineRun | null = null;
  for (const run of state.ci.runs.values()) {
    if (run.repo !== repo) continue;
    if (!latest || run.started_at > latest.started_at) latest = run;
  }
  if (!latest) return `<span style="color:#999">—</span>`;
  const age = latest.completed_at
    ? `${Math.floor((now - new Date(latest.completed_at).getTime()) / 60000)}m ago`
    : "running";
  return `${ciStatusBadge(latest.status)} <a href="/repos/${esc(repo)}/ci/${esc(latest.run_id)}" style="font-size:11px;color:#666">${esc(age)}</a>`;
}

function renderStatusData(state: DaemonState): string {
  const cfg = state.config;
  const me = cfg.self.name;
  const now = Date.now();

  let peerRows = "";
  for (const p of cfg.peers) {
    if (p.name === me) continue;
    const entry = state.peers.get(p.name);
    const addr = entry?.addresses[0] ?? "(no address)";
    const reachable = entry?.isConnected() ?? false;
    const hb = entry?.lastHeartbeat ? `${Math.floor((now - entry.lastHeartbeat) / 1000)}s ago` : "never";
    const drift =
      entry?.lastConfigHash == null ? "?"
      : entry.lastConfigHash === cfg.raw_hash ? "ok"
      : "DRIFT";
    const cls = reachable ? "ok" : "down";
    const lbl = reachable ? "up" : "down";
    peerRows += `<tr><td>${esc(p.name)}</td><td>${esc(addr)}</td><td><span class="${cls}">${lbl}</span></td><td>${esc(hb)}</td><td>${drift}</td></tr>`;
  }
  if (!peerRows) peerRows = `<tr><td colspan="5"><em>(no peers configured)</em></td></tr>`;

  const contributed = new Set(cfg.repos.map((r) => r.name));
  const allNames = new Set<string>([...contributed]);
  for (const k of state.repos.keys()) allNames.add(k);
  let repoRows = "";
  for (const name of [...allNames].sort()) {
    const local = state.repos.get(name);
    const head = local?.lastHead?.slice(0, 10) ?? "(empty)";
    const lf = local?.lastFetch ? `${Math.floor((now - local.lastFetch) / 1000)}s ago` : "never";
    const sources = local?.sourceList().join(",") ?? "";
    const kind = contributed.has(name) ? "ours" : "mirror";
    const divCount = local?.divergenceList().length ?? 0;
    const divCell = divCount > 0 ? `<span class="down">${divCount}</span>` : "0";
    // Last build badge
    const lastBuild = latestRunBadge(state, name, now);
    repoRows += `<tr><td><a href="/repos/${esc(name)}">${esc(name)}</a></td><td>${kind}</td><td><code>${esc(head)}</code></td><td>${esc(lf)}</td><td>${esc(sources)}</td><td>${divCell}</td><td>${lastBuild}</td></tr>`;
  }
  if (!repoRows) repoRows = `<tr><td colspan="7"><em>(no repos)</em></td></tr>`;

  return `<div id="status-data">
<h2>peers</h2>
<table>
  <thead><tr><th>name</th><th>address</th><th>status</th><th>last heartbeat</th><th>config</th></tr></thead>
  <tbody>${peerRows}</tbody>
</table>
<h2>repos</h2>
<table>
  <thead><tr><th>name</th><th>kind</th><th>head</th><th>last reconcile</th><th>sources</th><th>divergent</th><th>last build</th></tr></thead>
  <tbody>${repoRows}</tbody>
</table>
</div>`;
}

function handleStatusFragment(state: DaemonState): Response {
  return new Response(renderStatusData(state), {
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

function handleStatus(state: DaemonState): Response {
  const cfg = state.config;
  const me = cfg.self.name;
  const myPub = state.identity.pubkeyString;
  const scheme = cfg.transport.tls ? "https" : "http";
  const pubShort = myPub.startsWith("ed25519:") ? myPub.slice(8, 20) : myPub.slice(0, 12);
  const cfgShort = cfg.raw_hash.slice(0, 10);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
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

${renderStatusData(state)}

<footer><code>GET /status</code> &middot; built on Bun</footer>

<script>
const es = new EventSource('/status/events');
es.addEventListener('status-changed', async () => {
  try {
    const html = await fetch('/status/fragment').then(r => r.text());
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    document.getElementById('status-data').replaceWith(tmp.firstElementChild);
  } catch {}
});
</script>
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

// ---------- Issues ----------

function authorShort(state: DaemonState): string {
  const pub = state.identity.pubkeyString;
  return pub.startsWith("ed25519:") ? pub.slice(8, 14) : pub.slice(0, 6);
}

async function handleIssues(
  state: DaemonState,
  req: Request,
  repo: string,
  tail: string,
): Promise<Response> {
  const method = req.method;

  if (tail === "" || tail === "/") {
    if (method === "GET") return handleIssueBoard(state, repo);
    if (method === "POST") return handleIssueCreate(state, req, repo);
  }
  if (tail === "/events" && method === "GET") {
    return handleIssueEvents(repo);
  }
  if (tail === "/board" && method === "GET") {
    return handleIssueBoardFragment(state, repo);
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

async function handleIssueAll(state: DaemonState, repo: string): Promise<Response> {
  const wire = await issues.listIssuesAsWire(state.root, repo);
  return new Response(JSON.stringify(wire), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleIssueBoard(state: DaemonState, repo: string): Promise<Response> {
  const all = await issues.listIssues(state.root, repo);
  return new Response(renderBoardPage(state, repo, all), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleIssueBoardFragment(state: DaemonState, repo: string): Promise<Response> {
  const all = await issues.listIssues(state.root, repo);
  return new Response(renderBoardGridForRepo(all, repo), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleIssueCreate(
  state: DaemonState,
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
  state: DaemonState,
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
  state: DaemonState,
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
  state: DaemonState,
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

// ---------- Board HTML rendering ----------

const LABEL_COLORS = [
  { bg: "#dbeafe", dot: "#2563eb" }, // blue
  { bg: "#fce7f3", dot: "#db2777" }, // pink
  { bg: "#d1fae5", dot: "#059669" }, // green
  { bg: "#fef3c7", dot: "#d97706" }, // yellow
  { bg: "#ede9fe", dot: "#7c3aed" }, // purple
  { bg: "#fee2e2", dot: "#dc2626" }, // red
  { bg: "#e0f2fe", dot: "#0284c7" }, // sky
];

function labelColor(label: string): { bg: string; dot: string } {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (Math.imul(h, 31) + label.charCodeAt(i)) | 0;
  return LABEL_COLORS[Math.abs(h) % LABEL_COLORS.length]!;
}

function relativeAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(diff / 3_600_000);
  if (h < 24) return `${h}h`;
  const d = Math.floor(diff / 86_400_000);
  if (d < 14) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

function isStale(iso: string): boolean {
  return Date.now() - new Date(iso).getTime() > 14 * 86_400_000;
}

function textPreview(md: string, max = 140): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`[^`]+`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, " ")
    .trim()
    .slice(0, max);
}

function renderMarkdown(md: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bunMd = (Bun as any).markdown;
  if (bunMd?.html) {
    try {
      return bunMd.html(md, { tables: true, strikethrough: true, tasklists: true }) as string;
    } catch { /* fall through */ }
  }
  // Fallback: paragraph-split and HTML-escape
  return md.split(/\n\n+/).map((p) => `<p>${esc(p.trim())}</p>`).join("\n");
}

function renderLabelDots(labels: string[]): string {
  if (!labels.length) return "";
  return labels
    .map((l) => {
      const c = labelColor(l);
      return `<span class="dot" style="background:${c.dot}"></span><span>${esc(l)}</span>`;
    })
    .join(" ");
}

function renderCard(issue: issues.Issue, repo: string): string {
  const { meta, body, comments } = issue;
  const firstLabel = meta.labels[0];
  const cardBg = firstLabel ? labelColor(firstLabel).bg : "#f8f9fa";
  const staleClass = isStale(meta.created) ? " stale" : "";
  const age = relativeAge(meta.created);
  const replyText =
    comments.length === 0 ? "" :
    comments.length === 1 ? " &middot; 1 reply" :
    ` &middot; ${comments.length} replies`;
  const statusVal = meta.status === "open" ? "closed" : "open";
  const actionLabel = meta.status === "open" ? "done" : "reopen";
  const preview = esc(textPreview(body));

  const commentsHtml = comments.length
    ? `<div class="comments">${comments.map((c) => `
        <div class="comment">
          <div class="comment-meta">${esc(c.author)} &middot; ${relativeAge(c.created)}</div>
          <div class="comment-body">${renderMarkdown(c.body)}</div>
        </div>`).join("")}
      </div>`
    : "";

  return `
<article class="card${staleClass}" draggable="true" data-id="${esc(meta.id)}" data-status="${meta.status}" data-labels="${esc(meta.labels.join(","))}" data-order="${meta.order}" style="--card-tint:${cardBg}" id="${esc(meta.id)}">
  <header class="card-header" onclick="toggleCard('${esc(meta.id)}')">
    <div class="card-labels">${renderLabelDots(meta.labels)}</div>
    <h3 class="card-title">${esc(meta.title)}</h3>
    ${preview ? `<p class="card-preview">${preview}</p>` : ""}
  </header>
  <footer class="card-footer">
    <span class="card-meta">${age}${replyText}</span>
    <form method="POST" action="/repos/${esc(repo)}/issues/${esc(meta.id)}/status">
      <input type="hidden" name="status" value="${statusVal}">
      <button class="btn-action" type="submit">${actionLabel}</button>
    </form>
  </footer>
  <div class="card-detail" hidden>
    <div class="card-body">${renderMarkdown(body)}</div>
    ${commentsHtml}
    <form class="reply-form" method="POST" action="/repos/${esc(repo)}/issues/${esc(meta.id)}/comment">
      <textarea name="body" placeholder="add a reply..." rows="3"></textarea>
      <button class="btn-action" type="submit">reply</button>
    </form>
    <div class="card-danger">
      <button class="btn-trash" type="button" onclick="trashCard('${esc(meta.id)}', '${esc(repo)}')">trash</button>
    </div>
  </div>
</article>`;
}

function renderBoardGridForRepo(all: issues.Issue[], repo: string): string {
  const cards = all.map((issue) => renderCard(issue, repo)).join("\n");
  return `<div id="board" class="board">
${cards}
<article class="card card-new">
  <form method="POST" action="/repos/${esc(repo)}/issues">
    <input type="text" name="title" placeholder="title" required autocomplete="off">
    <textarea name="body" placeholder="describe the issue..." rows="3"></textarea>
    <div class="new-footer">
      <input type="text" name="labels" placeholder="labels, comma-separated" class="new-labels">
      <button class="btn-action" type="submit">post</button>
    </div>
  </form>
</article>
</div>`;
}

function collectLabels(all: issues.Issue[]): string[] {
  const seen = new Set<string>();
  for (const issue of all) for (const l of issue.meta.labels) seen.add(l);
  return [...seen].sort();
}

function renderBoardPage(state: DaemonState, repo: string, all: issues.Issue[]): string {
  const me = state.config.self.name;
  const labels = collectLabels(all);

  const chipHtml = labels.map((l) => {
    const c = labelColor(l);
    return `<button class="chip" data-label-chip="${esc(l)}" onclick="toggleLabel('${esc(l)}')" type="button"><span class="dot" style="background:${c.dot}"></span>${esc(l)}</button>`;
  }).join("\n");

  const filterRow = labels.length
    ? `<div class="board-filters">\n${chipHtml}\n</div>`
    : "";

  const boardGrid = renderBoardGridForRepo(all, repo);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>issues — ${esc(repo)} — ${esc(me)}</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; max-width: 1080px; margin: 2rem auto; padding: 0 1rem; color: #1d1f22; }
  a { color: inherit; }
  h1 { margin: 0 0 1.5rem; font-size: 1.1rem; font-weight: 400; }
  h1 strong { font-weight: 700; }

  /* filters */
  .board-filters { display: flex; gap: .4rem; flex-wrap: wrap; margin-bottom: 1rem; align-items: center; }
  .chip { background: #f0f0f0; border: 1px solid #ddd; border-radius: 12px; padding: 2px 10px; font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; color: #555; font-family: inherit; }
  .chip.active { background: #1d1f22; color: #fff; border-color: #1d1f22; }
  .chip .dot { flex-shrink: 0; }
  #show-closed-btn { margin-left: auto; }

  /* board grid */
  .board { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: .75rem; align-items: start; }

  /* cards */
  .card { background: var(--card-tint, #f8f9fa); border: 1px solid rgba(0,0,0,0.1); border-radius: 3px; display: flex; flex-direction: column; overflow: hidden; transition: opacity .2s; }
  .card.stale { opacity: .7; }
  .card[data-status="closed"] { opacity: .4; border-style: dashed; }
  .card-header { padding: .75rem .75rem .5rem; cursor: pointer; flex: 1; }
  .card-header:hover { background: rgba(0,0,0,0.03); }
  .card-labels { display: flex; align-items: center; gap: .4rem; font-size: 11px; color: #555; margin-bottom: .4rem; flex-wrap: wrap; min-height: 1rem; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .card-title { margin: 0 0 .35rem; font-size: .9rem; font-weight: 600; line-height: 1.3; }
  .card-preview { margin: 0; font-size: 12px; color: #666; line-height: 1.4; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .card-footer { display: flex; align-items: center; justify-content: space-between; padding: .4rem .75rem; border-top: 1px solid rgba(0,0,0,0.07); background: rgba(0,0,0,0.02); }
  .card-meta { font-size: 11px; color: #999; }
  .btn-action { background: none; border: 1px solid #ddd; border-radius: 3px; padding: 2px 8px; font-size: 11px; cursor: pointer; color: #666; font-family: inherit; }
  .btn-action:hover { background: rgba(0,0,0,0.05); border-color: #bbb; }

  /* expanded detail */
  .card-detail { padding: .75rem; border-top: 1px solid rgba(0,0,0,0.08); font-size: 13px; }
  .card-body { line-height: 1.6; }
  .card-body p { margin: 0 0 .5rem; }
  .card-body p:last-child { margin-bottom: 0; }
  .comments { margin-top: .75rem; }
  .comment { border-top: 1px solid rgba(0,0,0,0.07); padding-top: .5rem; margin-top: .5rem; }
  .comment-meta { font-size: 11px; color: #999; margin-bottom: .25rem; }
  .comment-body { font-size: 12.5px; line-height: 1.5; }
  .comment-body p { margin: 0 0 .35rem; }
  .reply-form { margin-top: .75rem; display: flex; flex-direction: column; gap: .4rem; }
  .reply-form textarea { font-family: inherit; font-size: 12.5px; padding: .4rem; border: 1px solid #ddd; border-radius: 3px; resize: vertical; width: 100%; box-sizing: border-box; }
  .reply-form button { align-self: flex-end; }

  /* new issue card */
  .card-new { background: #fff; border: 1px dashed #ccc; }
  .card-new form { padding: .75rem; display: flex; flex-direction: column; gap: .5rem; }
  .card-new input, .card-new textarea { font-family: inherit; font-size: 13px; border: none; border-bottom: 1px solid #eee; padding: .3rem 0; outline: none; background: transparent; width: 100%; box-sizing: border-box; }
  .card-new input:focus, .card-new textarea:focus { border-bottom-color: #aaa; }
  .card-new input::placeholder, .card-new textarea::placeholder { color: #ccc; }
  .card-new textarea { resize: none; }
  .new-footer { display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
  .new-labels { font-size: 11px !important; }

  /* trash */
  .card-danger { margin-top: .75rem; padding-top: .5rem; border-top: 1px solid rgba(0,0,0,0.07); display: flex; justify-content: flex-end; }
  .btn-trash { background: none; border: 1px solid #f5c2c2; border-radius: 3px; padding: 2px 8px; font-size: 11px; cursor: pointer; color: #c0392b; font-family: inherit; }
  .btn-trash:hover { background: #fdf2f2; border-color: #c0392b; }

  /* drag-and-drop reorder */
  .card[draggable="true"] { cursor: grab; }
  .card[draggable="true"]:active { cursor: grabbing; }
  .card.drag-over { outline: 2px solid #1d1f22; outline-offset: 2px; }
  .card.dragging { opacity: .35; }

  footer { margin-top: 2rem; color: #888; font-size: 12px; }

  /* repo nav */
  nav { margin-bottom: 1.5rem; display: flex; gap: 1rem; }
  nav a { padding: .3rem .6rem; border-radius: 3px; text-decoration: none; font-size: 13px; color: #555; }
  nav a.active { background: #1d1f22; color: #fff; }
</style>
</head>
<body>
<h1><a href="/status">${esc(me)}</a> / <a href="/repos/${esc(repo)}/issues"><strong>${esc(repo)}</strong></a></h1>

<nav>
  <a href="/repos/${esc(repo)}/issues" class="active">issues</a>
  <a href="/repos/${esc(repo)}/ci">pipelines</a>
</nav>

<div class="board-filters">
${chipHtml}
<button class="chip" id="show-closed-btn" onclick="toggleClosed()" type="button">show closed</button>
</div>

${boardGrid}

<footer><a href="/status">mesh status</a> &middot; built on Bun</footer>

<script>
const active = new Set();
let showClosed = localStorage.getItem('showClosed') === 'true';
let opened = null;

function applyFilters() {
  document.querySelectorAll('.card[data-id]').forEach(c => {
    const labels = c.dataset.labels ? c.dataset.labels.split(',').filter(Boolean) : [];
    const trashed = c.dataset.status === 'trashed';
    const statusOk = !trashed && (showClosed || c.dataset.status !== 'closed');
    const labelOk = active.size === 0 || labels.some(l => active.has(l));
    c.style.display = (statusOk && labelOk) ? '' : 'none';
  });
}

function toggleLabel(l) {
  active.has(l) ? active.delete(l) : active.add(l);
  document.querySelectorAll('[data-label-chip]').forEach(c => {
    c.classList.toggle('active', active.has(c.dataset.labelChip));
  });
  applyFilters();
}

function toggleClosed() {
  showClosed = !showClosed;
  localStorage.setItem('showClosed', showClosed);
  document.getElementById('show-closed-btn').classList.toggle('active', showClosed);
  applyFilters();
}

async function trashCard(id, repo) {
  const form = new FormData();
  form.set('status', 'trashed');
  try {
    await fetch('/repos/' + encodeURIComponent(repo) + '/issues/' + encodeURIComponent(id) + '/status', {
      method: 'POST', body: form
    });
    const card = document.getElementById(id);
    if (card) card.style.display = 'none';
  } catch {}
}

function toggleCard(id) {
  const prev = opened;
  if (prev) {
    const prevDetail = document.querySelector('[data-id="' + prev + '"] .card-detail');
    if (prevDetail) prevDetail.hidden = true;
    opened = null;
  }
  if (prev !== id) {
    const detail = document.querySelector('[data-id="' + id + '"] .card-detail');
    if (detail) { detail.hidden = false; opened = id; }
  }
}

// Restore show-closed state on load
document.getElementById('show-closed-btn').classList.toggle('active', showClosed);
applyFilters();

// Auto-expand card from URL hash (e.g. after adding a comment)
if (location.hash) toggleCard(location.hash.slice(1));

// SSE: refresh board grid when issues change
const es = new EventSource(location.pathname + '/events');
es.addEventListener('board-changed', async () => {
  try {
    const html = await fetch(location.pathname + '/board').then(r => r.text());
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const next = tmp.firstElementChild;
    if (next) document.getElementById('board').replaceWith(next);
    if (opened) {
      const d = document.querySelector('[data-id="' + opened + '"] .card-detail');
      if (d) d.hidden = false;
    }
    applyFilters();
  } catch {}
});

// Drag-and-drop priority reorder
let dragSrc = null;

document.addEventListener('dragstart', e => {
  const card = e.target.closest('.card[data-id]');
  if (!card) return;
  dragSrc = card;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

document.addEventListener('dragend', e => {
  const card = e.target.closest('.card[data-id]');
  if (card) card.classList.remove('dragging');
  document.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
  dragSrc = null;
});

document.addEventListener('dragover', e => {
  const card = e.target.closest('.card[data-id]');
  if (!card || card === dragSrc) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
  card.classList.add('drag-over');
});

document.addEventListener('dragleave', e => {
  const card = e.target.closest('.card[data-id]');
  if (card) card.classList.remove('drag-over');
});

document.addEventListener('drop', async e => {
  const target = e.target.closest('.card[data-id]');
  if (!target || !dragSrc || target === dragSrc) return;
  e.preventDefault();
  target.classList.remove('drag-over');

  const board = document.getElementById('board');
  const allCards = [...board.querySelectorAll('.card[data-id]')];
  const srcIdx = allCards.indexOf(dragSrc);
  const tgtIdx = allCards.indexOf(target);

  // Dragging forward → insert after target; dragging backward → insert before
  const insertAfter = srcIdx < tgtIdx;

  // Cards without dragSrc, in their current order
  const cards = allCards.filter(c => c !== dragSrc);
  const ti = cards.indexOf(target);

  let prevOrder, nextOrder, newOrder;
  if (insertAfter) {
    prevOrder = parseFloat(target.dataset.order || '0');
    const nextCard = cards[ti + 1];
    nextOrder = nextCard ? parseFloat(nextCard.dataset.order || String(Date.now() + 1e9)) : prevOrder + 1e9;
    newOrder = (prevOrder + nextOrder) / 2;
    const anchor = nextCard || board.querySelector('.card-new') || null;
    board.insertBefore(dragSrc, anchor);
  } else {
    nextOrder = parseFloat(target.dataset.order || String(Date.now() + 1e9));
    const prevCard = cards[ti - 1];
    prevOrder = prevCard ? parseFloat(prevCard.dataset.order || '0') : nextOrder - 1e9;
    newOrder = (prevOrder + nextOrder) / 2;
    board.insertBefore(dragSrc, target);
  }

  dragSrc.dataset.order = String(newOrder);

  // Persist to server
  const id = dragSrc.dataset.id;
  const form = new FormData();
  form.set('order', String(newOrder));
  try {
    await fetch(location.pathname + '/' + encodeURIComponent(id) + '/order', {
      method: 'POST', body: form
    });
  } catch {}
});
</script>
</body>
</html>`;
}
