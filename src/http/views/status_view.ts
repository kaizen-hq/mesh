// Status page rendering — no Daemon dependency.
// The handler in http_server.ts extracts data from state and calls these.

import { esc, fill, relativeAge, ciStatusBadge } from "./helpers.ts";
import type { Config } from "../../config.ts";
import type { PeerRegistry } from "../../peer_registry.ts";
import type { RepoRegistry } from "../../repo_registry.ts";
import type { CiDomain } from "../../ci/ci_domain.ts";

export interface StatusViewCtx {
  config: Config;
  peers: PeerRegistry;
  repos: RepoRegistry;
  ci: CiDomain;
}

// ---------- status data fragment (also used for SSE refresh) ----------

export function renderStatusData(ctx: StatusViewCtx): string {
  const { config: cfg, peers, repos, ci } = ctx;
  const me = cfg.self.name;
  const now = Date.now();

  let peerRows = "";
  for (const p of cfg.peers) {
    if (p.name === me) continue;
    const entry = peers.get(p.name);
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
  for (const k of repos.keys()) allNames.add(k);

  let repoRows = "";
  for (const name of [...allNames].sort()) {
    const local = repos.get(name);
    const head = local?.lastHead?.slice(0, 10) ?? "(empty)";
    const lf = local?.lastFetch ? `${Math.floor((now - local.lastFetch) / 1000)}s ago` : "never";
    const sources = local?.sourceList().join(",") ?? "";
    const kind = contributed.has(name) ? "ours" : "mirror";
    const divCount = local?.divergenceList().length ?? 0;
    const divCell = divCount > 0 ? `<span class="down">${divCount}</span>` : "0";
    const lastBuild = latestRunBadge(ci, name, now);
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

function latestRunBadge(ci: CiDomain, repo: string, now: number): string {
  let latest: import("../../ci/types.ts").PipelineRun | null = null;
  for (const run of ci.allRuns()) {
    if (run.repo !== repo) continue;
    if (!latest || run.started_at > latest.started_at) latest = run;
  }
  if (!latest) return `<span style="color:#999">&mdash;</span>`;
  const age = latest.completed_at
    ? `${Math.floor((now - new Date(latest.completed_at).getTime()) / 60000)}m ago`
    : "running";
  return `${ciStatusBadge(latest.status)} <a href="/repos/${esc(repo)}/ci/${esc(latest.run_id)}" style="font-size:11px;color:#666">${esc(age)}</a>`;
}

// ---------- full status page ----------

/** pubkeyShort and cfgShort come from identity — the handler passes them in. */
export function renderStatusPageFull(
  template: string,
  ctx: StatusViewCtx,
  pubkeyShort: string,
  cfgShort: string,
): string {
  const cfg = ctx.config;
  const me = cfg.self.name;
  const scheme = cfg.transport.tls ? "https" : "http";
  return fill(template, {
    me: esc(me),
    scheme: esc(scheme),
    pubkey_short: esc(pubkeyShort),
    cfg_short: esc(cfgShort),
    status_data: renderStatusData(ctx),
  });
}
