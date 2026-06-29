// CI page rendering — pure functions, no Daemon dependency.

import { esc, fill, relativeAge, formatDateTime, ciStatusBadge, renderPagination } from "./helpers.ts";
import type { PipelineRun } from "../../ci/types.ts";

// ---------- pipelines list page ----------

function renderRunRows(runs: PipelineRun[], repo: string): string {
  let rows = "";
  for (const run of runs) {
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
      <td><a href="/repos/${esc(repo)}/ci/${esc(run.run_id)}" title="${esc(relativeAge(run.started_at))} ago">${esc(formatDateTime(run.started_at))}</a></td>
    </tr>`;
  }
  if (!rows) rows = `<tr><td colspan="7"><em>(no runs yet)</em></td></tr>`;
  return rows;
}

function renderNoPipelineBlock(repo: string): string {
  return `<div class="no-pipeline">
  <p>No pipeline configured for this repo.</p>
  <p>Create <code>.mesh/mesh-ci.yml</code> in the repo root and commit it:</p>
  <pre>pipeline:
  name: ${esc(repo)}

on:
  push:
    branches: [main]
  manual: true             # allow mesh ci run

runner:
  labels: []               # empty = any runner; set e.g. [docker] for dedicated nodes
  fallback: any

jobs:
  test:
    image: oven/bun:1.1    # docker mode (default)
    commands:
      - bun install --frozen-lockfile
      - bun test
    secrets: [NPM_TOKEN]   # injected from ~/.mesh/secrets.yml

  build:
    image: oven/bun:1.1
    commands:
      - bun run build
    depends_on: [test]     # runs after test passes

  lint:
    mode: shell            # runs directly on the runner host (no Docker)
    commands:
      - bun run lint</pre>
  <p>Runner configuration lives in <code>~/.mesh/mesh.toml</code> on each node:</p>
  <pre>[runner]
enabled             = true
execution_modes     = ["docker", "shell"]   # permit docker, shell, or both
labels              = []
max_concurrent_jobs = 2
# env_passthrough = ["GOPATH", "SSH_AUTH_SOCK"]  # host vars shell jobs may read</pre>
  <p>Node-local secrets live in <code>~/.mesh/secrets.yml</code> (never committed):</p>
  <pre>secrets:
  NPM_TOKEN: "\${NPM_TOKEN}"   # interpolated from the daemon's environment
  DEPLOY_KEY: "literal-value"</pre>
</div>`;
}

export function renderCiPipelinesPage(
  template: string,
  me: string,
  repo: string,
  runs: PipelineRun[],
  hasPipeline: boolean,
  pagination: string,
): string {
  const content = hasPipeline
    ? `<form class="run-form" method="POST" action="/repos/${esc(repo)}/ci/run">
  <input name="ref" placeholder="branch or SHA" required>
  <button class="run-btn" type="submit">run pipeline</button>
</form>

<div id="runs-table">
<table>
  <thead><tr><th>status</th><th>ref</th><th>sha</th><th>triggered by</th><th>runner</th><th>duration</th><th>started</th></tr></thead>
  <tbody>${renderRunRows(runs, repo)}</tbody>
</table>
${pagination}
</div>`
    : renderNoPipelineBlock(repo);

  return fill(template, {
    me: esc(me),
    repo: esc(repo),
    repo_enc: encodeURIComponent(repo),
    content,
  });
}

// ---------- run detail page ----------

export function renderCiRunDetailPage(
  template: string,
  me: string,
  repo: string,
  run: PipelineRun,
  log: string,
): string {
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
  if (!jobRows) jobRows = `<tr><td colspan="4"><em>(no jobs)</em></td></tr>`;

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

  return fill(template, {
    me: esc(me),
    repo: esc(repo),
    repo_enc: encodeURIComponent(repo),
    run_id_short: esc(run.run_id.slice(0, 8)),
    status_badge: ciStatusBadge(run.status),
    ref: esc(ref),
    sha7: esc(sha7),
    trigger,
    runner: esc(run.runner),
    duration: esc(dur),
    started_at: `<span title="${esc(relativeAge(run.started_at))} ago">${esc(formatDateTime(run.started_at))}</span>`,
    job_rows: jobRows,
    log_block: logBlock,
  });
}
