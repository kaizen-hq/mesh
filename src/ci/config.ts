// Parse and validate ~/.mesh/cicd.toml and in-repo .mesh/mesh-ci.yml.
// Also provides tool auto-detection.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as toml from "../toml.ts";
import { parse as parseYaml } from "./yaml.ts";
import type { Pipeline, JobDefinition, RunnerConfig, CicdConfig } from "./types.ts";

export const defaultRunnerConfig: RunnerConfig = {
  enabled: false,
  labels: [],
  max_concurrent_jobs: 2,
  workdir: path.join(os.homedir(), ".mesh", "ci", "runs"),
  allow_shell: false,
  allow_shell_secrets: false,
  log_stream_interval_ms: 500,
  max_worktree_age_minutes: 60,
  max_worktree_disk_mb: 2048,
  log_retention_runs: 50,
};

// ---------- mesh-ci.yml parser ----------

export function parsePipeline(src: string): Pipeline {
  const doc = parseYaml(src) as Record<string, unknown>;

  const pipelineSec = (doc.pipeline ?? {}) as Record<string, unknown>;
  const name = typeof pipelineSec.name === "string" ? pipelineSec.name.trim() : "";
  if (!name) throw new Error("pipeline.name is required");

  const onSec = (doc.on ?? {}) as Record<string, unknown>;
  const pushSec = onSec.push as Record<string, unknown> | undefined;
  const branches: string[] = Array.isArray(pushSec?.branches)
    ? (pushSec.branches as unknown[]).map(String)
    : [];
  const scheduleSec = onSec.schedule as Array<Record<string, unknown>> | undefined;
  const schedule = Array.isArray(scheduleSec)
    ? scheduleSec.map((s) => ({ cron: String(s.cron ?? ""), job: String(s.job ?? "") }))
    : undefined;
  const manual = onSec.manual === true;

  const runnerSec = (doc.runner ?? {}) as Record<string, unknown>;
  const labels: string[] = Array.isArray(runnerSec.labels)
    ? (runnerSec.labels as unknown[]).map(String)
    : [];
  const fallbackRaw = typeof runnerSec.fallback === "string" ? runnerSec.fallback : "any";
  const fallback: "any" | "none" = fallbackRaw === "none" ? "none" : "any";

  if (!doc.jobs) throw new Error("jobs section is required");
  const jobsSec = doc.jobs as Record<string, Record<string, unknown>>;
  const jobs: Record<string, JobDefinition> = {};
  for (const [jobName, raw] of Object.entries(jobsSec)) {
    const commands: string[] = Array.isArray(raw.commands)
      ? (raw.commands as unknown[]).map(String)
      : [];
    const depends_on: string[] = Array.isArray(raw.depends_on)
      ? (raw.depends_on as unknown[]).map(String)
      : [];
    const secrets: string[] = Array.isArray(raw.secrets)
      ? (raw.secrets as unknown[]).map(String)
      : [];
    const modeRaw = typeof raw.mode === "string" ? raw.mode : "docker";
    const mode: "docker" | "shell" = modeRaw === "shell" ? "shell" : "docker";

    jobs[jobName] = {
      mode,
      image: typeof raw.image === "string" ? raw.image : undefined,
      compose: typeof raw.compose === "string" ? raw.compose : undefined,
      service: typeof raw.service === "string" ? raw.service : undefined,
      commands,
      depends_on,
      secrets,
    };
  }

  return {
    name,
    on: {
      push: branches.length > 0 ? { branches } : undefined,
      schedule,
      manual,
    },
    runner: { labels, fallback },
    jobs,
  };
}

// ---------- cicd.toml parser ----------

export function parseCicdConfig(src: string): CicdConfig {
  const doc = (src.trim() ? toml.parse(src) : {}) as Record<string, unknown>;

  const runnerRaw = (doc.runner ?? {}) as Record<string, unknown>;
  const runner: RunnerConfig = {
    enabled: runnerRaw.enabled === true,
    labels: Array.isArray(runnerRaw.labels) ? (runnerRaw.labels as string[]) : defaultRunnerConfig.labels,
    max_concurrent_jobs:
      typeof runnerRaw.max_concurrent_jobs === "number"
        ? runnerRaw.max_concurrent_jobs
        : defaultRunnerConfig.max_concurrent_jobs,
    workdir:
      typeof runnerRaw.workdir === "string" ? runnerRaw.workdir : defaultRunnerConfig.workdir,
    allow_shell: runnerRaw.allow_shell === true,
    allow_shell_secrets: runnerRaw.allow_shell_secrets === true,
    log_stream_interval_ms:
      typeof runnerRaw.log_stream_interval_ms === "number"
        ? runnerRaw.log_stream_interval_ms
        : defaultRunnerConfig.log_stream_interval_ms,
    max_worktree_age_minutes:
      typeof runnerRaw.max_worktree_age_minutes === "number"
        ? runnerRaw.max_worktree_age_minutes
        : defaultRunnerConfig.max_worktree_age_minutes,
    max_worktree_disk_mb:
      typeof runnerRaw.max_worktree_disk_mb === "number"
        ? runnerRaw.max_worktree_disk_mb
        : defaultRunnerConfig.max_worktree_disk_mb,
    log_retention_runs:
      typeof runnerRaw.log_retention_runs === "number"
        ? runnerRaw.log_retention_runs
        : defaultRunnerConfig.log_retention_runs,
  };

  const capRaw = (doc.capabilities ?? {}) as Record<string, unknown>;
  const capabilities = {
    tools: Array.isArray(capRaw.tools) ? (capRaw.tools as string[]) : undefined,
  };

  const secretsRaw = (doc.secrets ?? {}) as Record<string, unknown>;
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(secretsRaw)) {
    if (typeof v === "string") secrets[k] = v;
  }

  return { runner, capabilities, secrets };
}

// ---------- load helpers ----------

export async function loadCicdConfig(root: string): Promise<CicdConfig> {
  const p = path.join(root, "cicd.toml");
  try {
    const src = await fs.readFile(p, "utf8");
    return parseCicdConfig(src);
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "ENOENT") return parseCicdConfig("");
    throw e;
  }
}

export async function loadPipeline(repoPath: string): Promise<Pipeline | null> {
  const p = path.join(repoPath, ".mesh", "mesh-ci.yml");
  try {
    const src = await fs.readFile(p, "utf8");
    return parsePipeline(src);
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw e;
  }
}

// ---------- tool auto-detection ----------

const KNOWN_TOOLS = ["docker", "bun", "node", "python3", "go", "cargo"];

async function toolExists(name: string): Promise<boolean> {
  const which = Bun.which(name);
  return which !== null;
}

export async function detectTools(override?: string[]): Promise<string[]> {
  if (override && override.length > 0) return [...override];
  const results = await Promise.all(KNOWN_TOOLS.map(async (t) => ({ t, ok: await toolExists(t) })));
  return results.filter((r) => r.ok).map((r) => r.t);
}
