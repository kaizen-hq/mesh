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
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(run, null, 2), "utf8");
  await fs.rename(tmp, p);
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
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, JSON.stringify({ runs: filtered }, null, 2), "utf8");
  await fs.rename(tmp, p);
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
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, JSON.stringify({ runs: kept }, null, 2), "utf8");
  await fs.rename(tmp, p);
}
