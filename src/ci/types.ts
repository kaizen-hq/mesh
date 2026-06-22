// All CI-related TypeScript types and interfaces.

// ---------- pipeline config (parsed from mesh-ci.yml) ----------

export interface Pipeline {
  name: string;
  on: PipelineTriggers;
  runner: RunnerRequirements;
  jobs: Record<string, JobDefinition>;
}

export interface PipelineTriggers {
  push?: { branches: string[] };
  schedule?: Array<{ cron: string; job: string }>;
  manual: boolean;
}

export interface RunnerRequirements {
  labels: string[];
  fallback: "any" | "none";
}

export interface JobDefinition {
  mode: "docker" | "shell";
  image?: string;
  compose?: string;
  service?: string;
  commands: string[];
  depends_on: string[];
  secrets: string[];
}

// ---------- runtime run state ----------

export interface PipelineRun {
  run_id: string;
  repo: string;
  ref: string;
  sha: string;
  triggered_by: TriggerKind;
  runner: string;
  status: RunStatus;
  started_at: string;
  completed_at?: string;
  jobs: Record<string, JobRun>;
}

export type RunStatus = "pending" | "running" | "passed" | "failed" | "cancelled";
export type JobStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export type TriggerKind =
  | { type: "push"; pusher: string }
  | { type: "cron"; slot: string; job: string }
  | { type: "manual"; initiator: string };

export interface JobRun {
  job: string;
  status: JobStatus;
  exit_code?: number;
  started_at?: string;
  completed_at?: string;
  log_seq: number;
}

// ---------- capabilities ----------

export interface NodeCapabilities {
  os: string;
  arch: string;
  labels: string[];
  tools: string[];
  runner: boolean;
  load: {
    jobs_running: number;
    cpu_percent: number;
    mem_free_mb: number;
  };
}

// ---------- ci state ----------

export interface CiState {
  runs: Map<string, PipelineRun>;
  log_buffers: Map<string, LogBuffer>;
  cron_claims: Map<string, CronClaim>;
}

export interface LogBuffer {
  run_id: string;
  chunks: LogChunk[];
  next_seq: number;
  flush_timer?: ReturnType<typeof setTimeout>;
}

export interface LogChunk {
  seq: number;
  t: string;
  stream: "stdout" | "stderr";
  data: string;
}

export interface CronClaim {
  repo: string;
  job: string;
  slot: string;
  claims: Array<{ claimer: string; capability_hash: string }>;
  window_closes_at: number;
  started: boolean;
}

// ---------- node-level runner config (from mesh.toml [runner]) ----------

export interface RunnerConfig {
  enabled: boolean;
  execution_modes: string[];
  labels: string[];
  max_concurrent_jobs: number;
  workdir: string;
  tools: string[];
  env_passthrough: string[];
  log_stream_interval_ms: number;
  max_worktree_age_minutes: number;
  max_worktree_disk_mb: number;
  log_retention_runs: number;
}

export function emptyCiState(): CiState {
  return {
    runs: new Map(),
    log_buffers: new Map(),
    cron_claims: new Map(),
  };
}
