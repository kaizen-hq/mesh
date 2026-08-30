// Persist run results and assembled logs under ~/.mesh/ci/.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PipelineRun } from "./types.ts";

// ---------- path helpers ----------

export function ciRunDir(root: string, repo: string, runId: string): string {
  return path.join(root, "ci", repo, runId);
}

function runsIndexPath(root: string, repo: string): string {
  return path.join(root, "ci", repo, "runs.json");
}

function runJsonPath(root: string, repo: string, runId: string): string {
  return path.join(ciRunDir(root, repo, runId), "run.json");
}

function logPath(root: string, repo: string, runId: string): string {
  return path.join(ciRunDir(root, repo, runId), "log.txt");
}

// ---------- run.json ----------

export async function saveRun(root: string, run: PipelineRun): Promise<void> {
  const dir = ciRunDir(root, run.repo, run.run_id);
  await fs.mkdir(dir, { recursive: true });
  const p = runJsonPath(root, run.repo, run.run_id);
  await fs.writeFile(p, JSON.stringify(run, null, 2), "utf8");
  await updateRunsIndex(root, run);
}

export async function loadRun(
  root: string,
  repo: string,
  runId: string,
): Promise<PipelineRun | null> {
  try {
    const src = await fs.readFile(runJsonPath(root, repo, runId), "utf8");
    return JSON.parse(src) as PipelineRun;
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw e;
  }
}

// ---------- runs.json index ----------

interface RunIndex {
  runs: Array<{ run_id: string; started_at: string }>;
}

async function loadRunsIndex(root: string, repo: string): Promise<RunIndex> {
  try {
    const src = await fs.readFile(runsIndexPath(root, repo), "utf8");
    return JSON.parse(src) as RunIndex;
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "ENOENT") return { runs: [] };
    throw e;
  }
}

async function updateRunsIndex(root: string, run: PipelineRun): Promise<void> {
  const idx = await loadRunsIndex(root, run.repo);
  const filtered = idx.runs.filter((r) => r.run_id !== run.run_id);
  filtered.push({ run_id: run.run_id, started_at: run.started_at });
  // Sort descending by started_at
  filtered.sort((a, b) => (a.started_at > b.started_at ? -1 : a.started_at < b.started_at ? 1 : 0));
  const p = runsIndexPath(root, run.repo);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify({ runs: filtered }, null, 2), "utf8");
}

export async function listRuns(
  root: string,
  repo: string,
): Promise<Array<{ run_id: string; started_at: string }>> {
  const idx = await loadRunsIndex(root, repo);
  return idx.runs;
}

// ---------- log.txt ----------

export async function appendLogChunk(
  root: string,
  repo: string,
  runId: string,
  data: string,
): Promise<void> {
  const p = logPath(root, repo, runId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.appendFile(p, data, "utf8");
}

export async function readLog(root: string, repo: string, runId: string): Promise<string> {
  try {
    return await fs.readFile(logPath(root, repo, runId), "utf8");
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "ENOENT") return "";
    throw e;
  }
}

// ---------- log streaming (tail) ----------

export async function* tailLog(
  root: string,
  repo: string,
  runId: string,
  pollMs = 200,
  isDone?: () => boolean,
): AsyncGenerator<string> {
  const p = logPath(root, repo, runId);
  let offset = 0;
  while (true) {
    let content = "";
    try {
      content = await fs.readFile(p, "utf8");
    } catch {
      if (isDone?.()) return;
      await sleep(pollMs);
      continue;
    }
    if (content.length > offset) {
      yield content.slice(offset);
      offset = content.length;
    }
    if (isDone?.()) return;
    await sleep(pollMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- startup cleanup ----------

// On daemon restart, any run that was "pending" or "running" will never
// receive a CiCompleted frame — mark them "failed" so the UI doesn't show
// them stuck as "running" forever.
export async function abandonStaleRuns(root: string): Promise<void> {
  const ciDir = path.join(root, "ci");
  let repos: string[];
  try {
    const entries = await fs.readdir(ciDir, { withFileTypes: true });
    repos = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "ENOENT") return;
    throw e;
  }

  for (const repo of repos) {
    const idx = await loadRunsIndex(root, repo);
    for (const entry of idx.runs) {
      const run = await loadRun(root, repo, entry.run_id);
      if (!run) continue;
      if (run.status === "pending" || run.status === "running") {
        run.status = "failed";
        run.completed_at = run.completed_at ?? new Date().toISOString();
        await saveRun(root, run);
        console.log(`[ci] marked abandoned run ${run.run_id} (${repo}) as failed`);
      }
    }
  }
}

// ---------- pruning ----------

export async function pruneRuns(root: string, repo: string, maxRuns: number): Promise<void> {
  const idx = await loadRunsIndex(root, repo);
  if (idx.runs.length <= maxRuns) return;

  const toRemove = idx.runs.slice(maxRuns);
  for (const entry of toRemove) {
    const dir = ciRunDir(root, repo, entry.run_id);
    await fs.rm(dir, { recursive: true, force: true });
  }

  const kept = idx.runs.slice(0, maxRuns);
  const p = runsIndexPath(root, repo);
  await fs.writeFile(p, JSON.stringify({ runs: kept }, null, 2), "utf8");
}
