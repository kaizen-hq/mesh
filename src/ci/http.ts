// CI HTTP routes: peer sync + log chunk pull.

import type { CiDomain } from "./ci_domain.ts";
import type { Config } from "../config.ts";
import { loadRun, listRuns, readLog } from "./store.ts";
import type { PipelineRun } from "./types.ts";

export interface CiHttpCtx {
  ci: CiDomain;
  config: Config;
  root: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

// ---------- GET /mesh/ci/:repo/runs ----------
// Returns all PipelineRun records for a repo. Used by peers for full sync.

export async function handleCiRunsList(state: CiHttpCtx, repo: string): Promise<Response> {
  const index = await listRuns(state.root, repo);
  const runs: PipelineRun[] = [];
  for (const entry of index) {
    const run = await loadRun(state.root, repo, entry.run_id);
    if (run) runs.push(run);
  }
  return json(200, runs);
}

// ---------- GET /ci/logs/:runId/chunks?from=N ----------
// Returns log chunks starting from seq N for gap repair.

export async function handleLogChunks(
  state: CiHttpCtx,
  runId: string,
  fromSeq: number,
): Promise<Response> {
  // Find which repo owns this runId
  let repo: string | null = null;
  for (const run of state.ci.allRuns()) {
    if (run.run_id === runId) { repo = run.repo; break; }
  }
  if (!repo) {
    // Try scanning store
    for (const r of state.config.repos) {
      const run = await loadRun(state.root, r.name, runId);
      if (run) { repo = r.name; break; }
    }
  }
  if (!repo) return text(404, "run not found");

  const buf = state.ci.getLogBuffer(runId);
  const fromBuffer = buf ? buf.chunks.filter((c) => c.seq >= fromSeq) : [];
  return json(200, fromBuffer);
}

// ---------- route dispatcher ----------

export async function route(state: CiHttpCtx, req: Request, urlPath: string): Promise<Response | null> {
  // GET /mesh/ci/:repo/runs
  const syncMatch = /^\/mesh\/ci\/([^/]+)\/runs$/.exec(urlPath);
  if (syncMatch && req.method === "GET") {
    return handleCiRunsList(state, decodeURIComponent(syncMatch[1]!));
  }

  // GET /ci/logs/:runId/chunks?from=N
  const chunksMatch = /^\/ci\/logs\/([^/]+)\/chunks$/.exec(urlPath);
  if (chunksMatch && req.method === "GET") {
    const url = new URL(req.url);
    const from = parseInt(url.searchParams.get("from") ?? "0", 10);
    return handleLogChunks(state, decodeURIComponent(chunksMatch[1]!), isNaN(from) ? 0 : from);
  }

  return null;
}
