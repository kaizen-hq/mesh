// Parse and validate in-repo .mesh/mesh-ci.yml and ~/.mesh/secrets.yml.
// Also provides tool auto-detection. YAML parsing via Bun.YAML.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Pipeline, JobDefinition } from "./types.ts";

// ---------- mesh-ci.yml parser ----------

export function parsePipeline(src: string): Pipeline {
  const doc = Bun.YAML.parse(src) as Record<string, unknown>;

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

// ---------- secrets.yml parser ----------

const KNOWN_SECRETS_KEYS = new Set(["secrets"]);

// Interpolate ${VAR_NAME} references from the process environment.
// Values that are env var references (e.g. "${NPM_TOKEN}") are never stored
// in the file — only the variable name is, so plaintext secrets stay in the
// environment rather than on disk.
function interpolateEnv(value: string, file?: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const val = process.env[name];
    if (val === undefined) {
      console.warn(`WARN ${file ?? "secrets.yml"}: env var "\${${name}}" is not set`);
    }
    return val ?? "";
  });
}

export function parseSecretsYaml(src: string, file?: string): Record<string, string> {
  if (!src.trim()) return {};
  const parsed = Bun.YAML.parse(src);
  if (parsed == null || typeof parsed !== "object") return {};
  const doc = parsed as Record<string, unknown>;
  if (file) {
    for (const key of Object.keys(doc)) {
      if (!KNOWN_SECRETS_KEYS.has(key)) {
        console.warn(`WARN ${file}: unknown field "${key}"`);
      }
    }
  }
  const secretsRaw = (doc.secrets ?? {}) as Record<string, unknown>;
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(secretsRaw)) {
    if (typeof v === "string") secrets[k] = interpolateEnv(v, file);
  }
  return secrets;
}

// ---------- load helpers ----------

export async function loadSecretsConfig(root: string): Promise<Record<string, string>> {
  const p = path.join(root, "secrets.yml");
  try {
    const src = await fs.readFile(p, "utf8");
    return parseSecretsYaml(src, p);
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "ENOENT") return {};
    throw new Error(`${path.join(root, "secrets.yml")}: ${(e as Error).message}`);
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
