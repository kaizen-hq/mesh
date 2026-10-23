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
  // Set to true to allow this job to push to the mesh daemon.
  // The runner will inject MESH_PUSH_TOKEN into the job's environment.
  push?: boolean;
  // Shell-mode only: set to true if the job needs outbound network access.
  // By default shell jobs run in an isolated network namespace on Linux.
  network?: boolean;
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
  // Whether to wrap shell jobs in `unshare --net` on Linux.
  // Set to false on hosts where unprivileged user namespaces are disabled
  // (e.g. hardened kernels, non-root runners without CAP_SYS_ADMIN).
  // The startup probe auto-disables this if unshare is unavailable.
  network_isolation: boolean;
  // uid/gid to run shell jobs as. 0 = disabled (jobs run as the daemon user).
  // Requires CAP_SETUID/CAP_SETGID on the daemon process.
  // Set to a dedicated low-privilege user (e.g. mesh-jobs, uid=65533) so that
  // shell jobs cannot read or write ~/.mesh even on the same host.
  jobs_uid: number;
  jobs_gid: number;
}

export function emptyCiState(): CiState {
  return {
    runs: new Map(),
    log_buffers: new Map(),
    cron_claims: new Map(),
  };
}
