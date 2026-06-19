# CI/CD Pipeline Support — Implementation Plan

## Goals

- Run pipelines triggered by git pushes, cron schedules, and manual commands
- Distribute job execution across peers using capability-aware scheduling
- Isolate execution via Docker (default) or bare shell (explicit opt-in)
- Share state between pipeline jobs via bind-mounted worktree workspace
- Replicate build results and logs across all peers using the existing frame gossip protocol
- Expose pipeline status in the existing `/status` dashboard

---

## New Files

| File | Purpose |
|---|---|
| `src/ci/types.ts` | All CI-related TypeScript types and interfaces |
| `src/ci/config.ts` | Parse and validate `~/.mesh/cicd.toml` and in-repo `mesh-ci.yml` |
| `src/ci/engine.ts` | Job execution: worktree setup, Docker and shell runners, job DAG |
| `src/ci/scheduler.ts` | Push-triggered scheduling, capability matching, assignment protocol |
| `src/ci/cron.ts` | Cron expression parsing, slot tracking, distributed claim protocol |
| `src/ci/log_stream.ts` | Subprocess log capture, batching, `CiLog` frame broadcast |
| `src/ci/store.ts` | Persist run results and assembled logs under `~/.mesh/ci/` |
| `src/ci/http.ts` | HTTP routes: `/ci/*` (status, log stream SSE, chunk pull) |

## Modified Files

| File | Change |
|---|---|
| `src/proto.ts` | Add seven new `Message` variants for CI frames |
| `src/state.ts` | Add `ci: CiState` to `DaemonState`; extend `PeerEntry` with `capabilities` |
| `src/peer_link.ts` | Dispatch inbound CI frames; broadcast capabilities on heartbeat |
| `src/http_server.ts` | Mount `src/ci/http.ts` routes |
| `src/main.ts` | Wire CI scheduler, cron loop, and log stream on daemon start |
| `src/config.ts` | Parse optional `[ci]` section in `mesh.toml` |

---

## Configuration

### Node-level: `~/.mesh/cicd.toml` (never committed)

```toml
[runner]
enabled = true               # this node accepts CI job assignments
labels = ["docker", "linux-amd64"]
max_concurrent_jobs = 3
workdir = "/var/mesh-ci/runs"  # where worktrees are created
allow_shell = false            # bare shell execution; false by default
allow_shell_secrets = false    # secrets available to shell jobs; false by default
log_stream_interval_ms = 500   # log batching interval; 0 = line-by-line
max_worktree_age_minutes = 60  # worktrees older than this are force-removed
max_worktree_disk_mb = 2048    # hard cap on total disk used by all worktrees
log_retention_runs = 50        # completed runs to keep per repo; oldest pruned first

[capabilities]
tools = ["docker", "bun", "node"]   # override auto-detection

[secrets]
DEPLOY_KEY = "..."     # injected into Docker containers as env vars; never logged
NPM_TOKEN  = "..."
```

Auto-detected tools on daemon startup: check `PATH` for `docker`, `bun`, `node`, `python3`, `go`, `cargo`. Store result in `DaemonState` alongside config.

### In-repo: `.mesh/mesh-ci.yml` (committed to the repo)

```yaml
pipeline:
  name: my-app

on:
  push:
    branches: [main, "release/*"]
  schedule:
    - cron: "0 2 * * *"
      job: nightly-build
  manual: true

runner:
  labels: [docker]       # require these node capabilities
  fallback: any          # run on any capable peer if no labeled runner found
                         # set to "none" to fail if no labeled runner is available

jobs:
  test:
    image: oven/bun:1.1
    commands:
      - bun install --frozen-lockfile
      - bun test

  build:
    image: oven/bun:1.1
    commands:
      - bun run build
    depends_on: [test]

  # Reference an existing compose service instead of defining inline
  integration:
    compose: docker-compose.test.yml
    service: integration-runner
    depends_on: [build]

  # Bare shell — only valid if runner has allow_shell = true
  nightly-build:
    mode: shell
    commands:
      - bun run build:full

  # Secrets available to this job (Docker only by default)
  deploy:
    image: alpine:3.19
    secrets: [DEPLOY_KEY]
    commands:
      - ./scripts/deploy.sh
    depends_on: [build]
```

---

## Types (`src/ci/types.ts`)

```ts
// Parsed from mesh-ci.yml
interface Pipeline {
  name: string
  on: PipelineTriggers
  runner: RunnerRequirements
  jobs: Record<string, JobDefinition>
}

interface PipelineTriggers {
  push?: { branches: string[] }
  schedule?: Array<{ cron: string; job: string }>
  manual: boolean
}

interface RunnerRequirements {
  labels: string[]
  fallback: "any" | "none"
}

interface JobDefinition {
  mode: "docker" | "shell"     // default: "docker"
  image?: string               // docker mode: inline image
  compose?: string             // docker mode: path to compose file
  service?: string             // docker mode: service name in compose file
  commands: string[]
  depends_on: string[]
  secrets: string[]            // names from cicd.toml [secrets]
}

// Runtime state for a single pipeline execution
interface PipelineRun {
  run_id: string               // uuid
  repo: string
  ref: string                  // git ref that triggered this run
  sha: string                  // resolved commit SHA
  triggered_by: TriggerKind
  runner: string               // peer name running the job
  status: "pending" | "running" | "passed" | "failed" | "cancelled"
  started_at: string           // ISO 8601
  completed_at?: string
  jobs: Record<string, JobRun>
}

type TriggerKind =
  | { type: "push"; pusher: string }
  | { type: "cron"; slot: string; job: string }
  | { type: "manual"; initiator: string }

interface JobRun {
  job: string
  status: "pending" | "running" | "passed" | "failed" | "skipped"
  exit_code?: number
  started_at?: string
  completed_at?: string
  log_seq: number              // highest log sequence number received
}

// Per-node runtime capabilities (broadcasted via Heartbeat)
interface NodeCapabilities {
  os: string                   // "darwin" | "linux" | "win32"
  arch: string                 // "arm64" | "x64"
  labels: string[]
  tools: string[]
  runner: boolean
  load: {
    jobs_running: number
    cpu_percent: number
    mem_free_mb: number
  }
}

// Stored in DaemonState
interface CiState {
  runs: Map<string, PipelineRun>        // run_id → run
  log_buffers: Map<string, LogBuffer>   // run_id → in-progress log chunks
  cron_claims: Map<string, CronClaim>   // slot_key → claim record
}

interface LogBuffer {
  run_id: string
  chunks: LogChunk[]
  next_seq: number
  flush_timer?: Timer
}

interface LogChunk {
  seq: number
  t: string
  stream: "stdout" | "stderr"
  data: string
}

interface CronClaim {
  repo: string
  job: string
  slot: string
  claims: Array<{ claimer: string; capability_hash: string }>
  window_closes_at: number     // epoch ms
  started: boolean
}
```

---

## Frame Protocol (`src/proto.ts`)

Seven new `Message` variants added to the existing union:

```ts
// Scheduler → runner: take this job
{ type: "CiAssignment"; run_id: string; repo: string; ref: string; sha: string; pipeline: Pipeline; triggered_by: TriggerKind }

// Runner → scheduler: accepted
{ type: "CiAccepted"; run_id: string; runner: string }

// Runner → scheduler: cannot run (missing capability, at capacity, etc.)
{ type: "CiDeclined"; run_id: string; runner: string; reason: string }

// Runner → all: job is running
{ type: "CiStarted"; run_id: string; repo: string; runner: string; started_at: string }

// Runner → all: batched log chunk
{ type: "CiLog"; run_id: string; repo: string; job: string; seq: number; t: string; stream: "stdout" | "stderr"; data: string }

// Runner → all: pipeline complete
{ type: "CiCompleted"; run_id: string; repo: string; status: "passed" | "failed"; duration_ms: number; log_hash: string }

// Any capable node → all: claiming a cron slot
{ type: "CiCronClaim"; repo: string; job: string; slot: string; claimer: string; capability_hash: string }
```

`capability_hash` in `CiCronClaim` is `sha256(sorted(labels).join(","))` — used as the deterministic tiebreaker in election.

---

## Execution Engine (`src/ci/engine.ts`)

### Workspace setup

```
1. git worktree add /var/mesh-ci/runs/<run_id> <sha>
2. Run jobs in DAG order (respect depends_on)
3. git worktree remove /var/mesh-ci/runs/<run_id> --force  (on complete or cancel)
```

All job containers bind-mount the worktree as `/workspace`. Jobs write outputs into `/workspace`; subsequent jobs read them from the same path on the host.

### Docker execution (default)

For inline image jobs, mesh generates an ephemeral `docker-compose.yml` in a temp directory:

```
docker compose -f /tmp/mesh-ci-<run_id>.yml run --rm <job_name>
```

For jobs referencing an existing compose file (`compose:` + `service:`):

```
docker compose -f <repo_root>/<compose_path> run --rm <service>
```

Secrets from `~/.mesh/cicd.toml` are passed via `--env` flags, not written to the compose file. They are omitted from all log output (post-process log lines to redact secret values).

### Shell execution (opt-in)

Runs commands sequentially in the worktree directory via `Bun.spawn`:

```
cd /var/mesh-ci/runs/<run_id> && <command>
```

Available only when the runner node has `allow_shell = true` in `cicd.toml`. If a shell job requests secrets, the runner also needs `allow_shell_secrets = true`.

### Job DAG

Build the DAG from `depends_on` declarations. Topological sort to determine execution order.

**Phase 1 (sequential):** Run one job at a time in topological order. If any job fails, skip all downstream dependents (mark as `"skipped"`).

The runner function signature should accept a job iterator abstraction so that parallel execution can be dropped in later without restructuring the DAG logic:

```ts
// Phase 1: sequential iterator — yields one job at a time
async function* sequentialJobs(dag: JobDAG): AsyncIterable<JobDefinition> { ... }

// Future: parallel iterator — yields independent jobs concurrently
async function* parallelJobs(dag: JobDAG, maxConcurrent: number): AsyncIterable<JobDefinition> { ... }

// Engine calls the same runJob() regardless of which iterator is used
for await (const job of sequentialJobs(dag)) {
  await runJob(run, job, workspace)
}

---

## Scheduler (`src/ci/scheduler.ts`)

### Push trigger

Hook into the existing `broadcastRefUpdate` in `peer_link.ts`. After a ref update is broadcast, also call `scheduler.onRefUpdate(state, repo, ref, sha)`.

```
1. Load .mesh/mesh-ci.yml from the repo's working copy
2. Check if the ref matches any on.push.branches pattern (glob match)
3. If match: select a runner
4. Send CiAssignment frame to selected runner
5. Start CiAccepted/CiDeclined timeout (5s)
6. On CiDeclined or timeout: try next candidate
7. On no candidates: run locally as final fallback
```

### Runner selection

```
candidates = peers where:
  - capabilities.runner = true           (prefer dedicated runners)
  - capabilities.labels ⊇ pipeline.runner.labels  (has required labels)
  - capabilities.load.jobs_running < max_concurrent_jobs

if no dedicated runners and pipeline.runner.fallback = "any":
  candidates = all peers with required labels

rank by: jobs_running ASC, then cpu_percent ASC
pick candidates[0]
```

### Inbound CiAssignment (on the runner side)

```
1. Verify capabilities match job requirements
2. Check capacity (jobs_running < max_concurrent_jobs)
3. If ok: send CiAccepted, start engine.runPipeline(...)
4. If not ok: send CiDeclined with reason
```

---

## Cron Scheduler (`src/ci/cron.ts`)

### Loop

Runs on the same cadence as `runFetchLoop` — every 60s, check all configured pipelines for cron jobs whose next slot falls within the current window.

### Claim protocol

```
slot_key = "<repo>/<job>/<slot_iso_timestamp>"

1. Compute next slot for each cron expression
2. If slot_key not already in cron_claims and slot is within ±5s of now:
   a. Add to cron_claims with window_closes_at = now + 2000ms
   b. Broadcast CiCronClaim frame to all peers

3. On receiving CiCronClaim from any peer:
   a. Add to cron_claims[slot_key].claims
   b. (do not restart your own window — first arrival sets the window)

4. After window_closes_at:
   a. Sort claims by sha256(claimer + slot_key) ascending
   b. Winner = claims[0].claimer
   c. If winner === self: start the job (CiAssignment to self, then CiStarted)
   d. If winner !== self: wait for CiStarted

5. If no CiStarted seen within claim_timeout (10s after window closes):
   a. Remove winner from claims list
   b. Re-run election with remaining claims
   c. New winner starts the job
```

---

## Log Streaming (`src/ci/log_stream.ts`)

### Capture

`Bun.spawn` with `stdout: "pipe"` and `stderr: "pipe"`. Read from each stream in a loop, appending to the `LogBuffer` for the run.

### Flushing

A timer fires every `log_stream_interval_ms`. On each tick:

```
1. Take all pending chunks from LogBuffer
2. Assign sequential seq numbers
3. Broadcast one CiLog frame per chunk (or batch into one frame if chunks are small)
4. Append chunks to ~/.mesh/ci/<repo>/<run_id>/log.txt
```

### On completion

1. Broadcast `CiCompleted` with `log_hash = sha256(full log file contents)`
2. Peers that have gaps in their log (missing seq numbers) can pull missing chunks:
   ```
   GET /ci/logs/<run_id>/chunks?from=<seq>
   ```

### Live view (pull-based, no frame traffic)

```
GET /ci/logs/<run_id>/stream
```

Returns SSE. The runner reads from its own `log.txt` file and tails it. Peers that receive this request proxy the SSE from the runner via a direct HTTP request to the runner's address — same pattern as git smart-HTTP proxying.

---

## Storage (`src/ci/store.ts`)

```
~/.mesh/ci/
  <repo>/
    <run_id>/
      run.json     # PipelineRun (status, jobs, timing)
      log.txt      # assembled log, appended as chunks arrive
    runs.json      # index: last N run_ids per repo, sorted by started_at
```

On heartbeat, include a `ci_hash` (sha256 of `runs.json` contents) alongside the existing `config_hash`. Peers with a different `ci_hash` trigger a full sync: `GET /ci/<repo>/runs` returns all run metadata; peers merge by `run_id` (last-writer-wins on status by `completed_at`).

---

## HTTP Routes

### Existing routes — changes

| Route | Change |
|---|---|
| `GET /repos/<name>/issues[/...]` | Unchanged — issues board still lives here |
| Repo link in `/status` table | Change from `/repos/<name>/issues` to `/repos/<name>` (the new hub) |

### New routes — per-repo hub (`src/http_server.ts`)

| Route | Description |
|---|---|
| `GET /repos/<name>` | Repo hub page — nav bar linking to issues and pipelines, defaults to showing pipelines tab |
| `GET /repos/<name>/ci` | Pipelines tab — recent runs list (HTML partial, also used for SSE refresh) |
| `GET /repos/<name>/ci/events` | SSE stream — pushes `run-changed` events for this repo |
| `GET /repos/<name>/ci/<run_id>` | Run detail page — job status table + live log viewer |
| `GET /repos/<name>/ci/<run_id>/log/stream` | SSE live log stream (used by the run detail page) |
| `POST /repos/<name>/ci/run` | Manual trigger form post — body: `{ ref }` |

### New routes — peer sync (`src/ci/http.ts`)

| Route | Description |
|---|---|
| `GET /mesh/ci/<repo>/runs` | JSON list of PipelineRuns — used by peers for full sync on heartbeat drift |
| `GET /ci/logs/<run_id>/chunks?from=<seq>` | Pull missing log chunks for gap repair |

---

## CLI Additions

| Command | Description |
|---|---|
| `mesh ci status [<repo>]` | Show recent runs (status, ref, sha, duration, runner) |
| `mesh ci run <repo> <ref>` | Manually trigger a pipeline for a ref |
| `mesh ci logs <repo> <run_id>` | Stream or print build log |
| `mesh ci cancel <run_id>` | Cancel a running job (sends signal to runner) |
| `mesh ci runners` | List peers and their current capabilities + load |

CLI commands route through the existing Unix socket control server (`src/control.ts`).

---

## UI Changes

### `/status` — repos table

Change the repo name link from `/repos/<name>/issues` to `/repos/<name>`. Add a **last build** column:

```
name        kind    head        last reconcile  sources  divergent  last build
─────────────────────────────────────────────────────────────────────────────
my-app      ours    a1b2c3d4    12s ago         peer-b   0          ✓ passed 2m ago
lib         mirror  e5f6a7b8    45s ago         peer-a   0          — (no pipeline)
```

The badge is server-rendered from `CiState.runs` — no extra fetch. It is included in the existing `GET /status/fragment` SSE refresh so it stays live without any new SSE machinery.

### `/repos/<name>` — repo hub page

A lightweight shell page with a nav bar:

```
my-app  /  issues  pipelines
```

Both tabs are links (`<a href="...">`), not JS-driven. The active tab is highlighted based on the current path. This keeps the page functional without JavaScript and avoids building a client-side router.

- `issues` links to `/repos/<name>/issues` (existing board, no changes)
- `pipelines` links to `/repos/<name>/ci`

The hub page itself (`GET /repos/<name>`) redirects to `/repos/<name>/ci` (pipelines is the landing tab, issues has its own direct URL that already worked before).

### `/repos/<name>/ci` — pipelines tab

A table of recent runs, newest first:

```
status   ref          sha       triggered by   runner    duration   started
────────────────────────────────────────────────────────────────────────────
✓ pass   main         a1b2c3d   push (me)      peer-b    1m 42s     3m ago
✗ fail   feature/x    b2c3d4e   push (peer-a)  peer-a    0m 12s     1h ago
● run    main         c3d4e5f   cron           peer-b    running    just now
```

Status cells use CSS classes (`pass`, `fail`, `running`) — same `.ok` / `.down` convention as the existing status page.

Each row links to `/repos/<name>/ci/<run_id>` for the detail view.

A **Run pipeline** button at the top opens an inline form for manual triggers:

```html
<form method="POST" action="/repos/<name>/ci/run">
  <input name="ref" placeholder="branch or SHA" required>
  <button type="submit">run</button>
</form>
```

SSE: the page subscribes to `GET /repos/<name>/ci/events`. On `run-changed`, it fetches `GET /repos/<name>/ci` and replaces the runs table — same pattern as the issue board's `board-changed` event.

### `/repos/<name>/ci/<run_id>` — run detail page

Three sections:

**1. Run header** — repo, ref, SHA, trigger, runner, overall status, wall-clock duration.

**2. Jobs table** — one row per job:

```
job        status    duration   exit code
─────────────────────────────────────────
test       ✓ pass    1m 10s     0
build      ✓ pass    0m 32s     0
deploy     ✗ fail    0m 02s     1
```

**3. Log viewer** — a `<pre>` block that streams log output live for running jobs, and shows the complete assembled log for completed jobs.

For a **running** job: the page opens an SSE connection to `GET /repos/<name>/ci/<run_id>/log/stream` and appends each chunk into the `<pre>` as it arrives. Auto-scrolls to the bottom unless the user has scrolled up (standard "follow tail" behaviour — track whether the user is near the bottom before each append).

For a **completed** job: the log is server-rendered into the page on initial load. No SSE needed.

Stdout and stderr are rendered in the same stream in arrival order (consistent with how terminals show interleaved output). A `stderr` CSS class can be applied to chunks so they can be visually distinguished (e.g. slightly red tint) without splitting them into separate panels.

The log viewer uses a monospace `<pre>` with horizontal scrolling rather than word-wrap — same aesthetic as the existing `<code>` blocks in the status page.

---

## Implementation Phases

### Phase 1 — Foundation
- `src/ci/types.ts` — all types
- `src/ci/config.ts` — parse `cicd.toml` and `mesh-ci.yml`
- Auto-detect tools on daemon startup; store in `DaemonState`
- Extend `Heartbeat` frame with `capabilities: NodeCapabilities`
- `src/ci/store.ts` — read/write run results and logs to `~/.mesh/ci/`
- Add `ci: CiState` to `DaemonState`

### Phase 2 — Execution Engine
- `src/ci/engine.ts` — worktree setup/teardown
- Docker execution path (inline image + compose file reference)
- Job DAG: topological sort, sequential execution, skip on upstream failure
- Bare shell execution path (gated by `allow_shell`)
- Secrets injection and log redaction

### Phase 3 — Push Scheduling
- Hook `scheduler.onRefUpdate` into `broadcastRefUpdate`
- `CiAssignment`, `CiAccepted`, `CiDeclined` frame types and dispatch
- Capability-based runner selection algorithm
- Inbound assignment handling on runner side
- `CiStarted`, `CiCompleted` broadcast on run finish

### Phase 4 — Log Streaming
- `src/ci/log_stream.ts` — capture, buffer, flush loop
- `CiLog` frame broadcast with configurable interval
- Log assembly and gap detection on receiving peers
- `GET /ci/logs/<run_id>/stream` SSE endpoint
- `GET /ci/logs/<run_id>/chunks` pull endpoint

### Phase 5 — Cron
- `src/ci/cron.ts` — cron expression parsing (implement or vendor a small parser)
- Slot tracking and claim window logic
- `CiCronClaim` frame broadcast and inbound handling
- Deterministic election algorithm
- Failure recovery (timeout → re-elect)

### Phase 6 — CLI and UI
- `mesh ci status`, `mesh ci run`, `mesh ci logs`, `mesh ci cancel`, `mesh ci runners`
- Control socket dispatch for CI commands
- Update `/status` repos table: change issue link to repo hub link, add last build column
- `GET /repos/<name>` hub page (redirect to `/repos/<name>/ci`)
- `GET /repos/<name>/ci` pipelines tab with SSE refresh
- `GET /repos/<name>/ci/<run_id>` run detail page with live log viewer
- `GET /repos/<name>/ci/events` SSE stream for run-changed notifications
- `POST /repos/<name>/ci/run` manual trigger route
- Include last build badge in `GET /status/fragment` partial (no new SSE channel needed)

---

## Decisions

1. **Cron expression parser** — implement from scratch using TDD. Write tests first covering the standard subset: `* * * * *`, numeric values, ranges (`1-5`), step values (`*/15`, `0-30/5`), and `@hourly`/`@daily`/`@weekly`/`@monthly` aliases. No vendored dependency.

2. **Parallel job concurrency** — Phase 1 is sequential-only. The job runner uses an async iterator interface so a parallel iterator can be swapped in later without changing the execution engine. See the Job DAG section above.

3. **Artifact size limit** — enforced via `max_worktree_age_minutes` and `max_worktree_disk_mb` in `~/.mesh/cicd.toml`. A cleanup task runs on the same cadence as `runFetchLoop`; worktrees exceeding age or contributing to an over-quota total are removed oldest-first.

4. **Log retention** — `log_retention_runs` in `~/.mesh/cicd.toml` (default: 50 runs per repo). Pruning runs after each `CiCompleted` event; oldest `run.json` + `log.txt` pairs are deleted first.