# mesh — Bun/TypeScript peer-to-peer git daemon

- One HTTP listener on `:7979` (plain HTTP by default; HTTPS opt-in).
- Routes: git smart-HTTP at `/<repo>.git/...`, `POST /mesh/frame` for signed
  notifications, `GET /status` for the browser dashboard.
- Push-only peer link with retry queue + exponential backoff.
- Full-mesh replication: every peer mirrors every repo any peer contributes.
- ed25519-signed frames; bincode-encoded payloads.
- Built-in CI/CD: distributed pipeline execution, cron scheduling, live log streaming.

## Why Bun Runtime

This was first built with Rust. But as an unsigned-compiled program, the company network security defense tooling and policy "dropped" inbound requests. Not technically dropped, but would essentially send "empty responses" back.

## Install

### From GitHub (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/kaizen-hq/mesh/main/install.sh | bash
```

Installs the latest source from `main`. Requires `bun`, `unzip`, and `curl`.

To install a specific release:

```sh
curl -fsSL https://raw.githubusercontent.com/kaizen-hq/mesh/main/install.sh | MESH_REF=v1.2.3 bash
```

After install, `mesh` is available at `~/.local/bin/mesh`. Make sure that directory is on your `PATH`:

```sh
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.zshrc or ~/.bashrc
```

### From a teammate on the local network

If a teammate already has mesh running, they can serve the installer directly:

```sh
# On the teammate's machine:
mesh serve-install-code     # prints a curl line for you to run
```

This serves the same install flow over plain HTTP — no GitHub needed. Useful when you're on the same network and want the exact version your teammate is running.

### From source

```sh
git clone git@github.com:kaizen-hq/mesh.git
cd mesh
bun install
```

Requires Bun 1.1+. `git` and `openssl` (only for HTTPS mode) must be on `PATH`.

Run directly without compiling:

```sh
bun src/main.ts start
```

Or compile to a standalone binary (no Bun required on the target machine):

```sh
bun run build       # writes ./mesh
./mesh --help
```

## Use

```sh
mesh init                              # generate identity, seed mesh.toml
mesh pubkey                            # print your public key (share with teammates)
mesh start                             # run the daemon in the foreground
mesh status                            # show peers, repos, divergences
mesh add-peer <name> <pubkey> [addr]   # manually add a peer
mesh add-repo <name> <path>            # contribute a working copy
mesh invite --addr HOST:PORT           # generate a one-time pairing token
mesh join <token>                      # accept a pairing token
mesh sync                              # force a reconciliation round

# CI/CD
mesh ci status [<repo>]                # show recent pipeline runs
mesh ci run <repo> <ref>               # manually trigger a pipeline
mesh ci logs <repo> <run_id>           # print build log
mesh ci cancel <run_id>                # cancel a running job
mesh ci runners                        # list peers and their CI capabilities
```

## CI/CD

Mesh includes a distributed CI/CD system. Pipelines are defined per-repo and
executed across peers. Any peer with `runner.enabled = true` in `cicd.toml`
can accept jobs.

> **Example repo:** [`kaizen-hq/hello-pipeline`](https://github.com/kaizen-hq/hello-pipeline)
> is a minimal working example — a Bun HTTP server with a `Dockerfile`,
> `docker-compose.yml`, and `.mesh/mesh-ci.yml` that runs shell and Docker jobs.
> Clone it to have something to test against while setting up CI on your mesh.

### Pipeline definition

Add `.mesh/mesh-ci.yml` to a repo to define its pipeline:

```yaml
pipeline:
  name: my-app

on:
  push:
    branches: [main, "release/*"]
  schedule:
    - cron: "0 2 * * *"   # daily at 02:00 UTC
      job: nightly
  manual: true             # allow mesh ci run

runner:
  labels: [docker]         # require a runner with this label
  fallback: any            # fall back to any capable peer if no labeled runner

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
    depends_on: [test]     # topological ordering; build waits for test

  nightly:
    mode: shell            # run commands directly (no Docker)
    commands:
      - bun run audit
```

Jobs run in Docker by default (`mode: docker`). Set `mode: shell` to run
commands in a subprocess on the runner host.

`depends_on` supports arbitrary DAGs. Cycles are rejected at parse time.
Jobs whose upstream failed are automatically marked `skipped`.

### Runner configuration

Each node that should accept jobs needs `~/.mesh/cicd.toml`:

```toml
[runner]
enabled             = true
labels              = ["docker", "linux-amd64"]
max_concurrent_jobs = 4
workdir             = "/tmp/mesh-ci"   # where worktrees are checked out
allow_shell         = true             # permit mode: shell jobs
allow_shell_secrets = false            # inject secrets into shell jobs

# Tuning
log_stream_interval_ms  = 500
max_worktree_age_minutes = 60
max_worktree_disk_mb     = 2048
log_retention_runs       = 50

[capabilities]
# Override auto-detected tools (docker, bun, node, python3, go, cargo)
# tools = ["docker", "bun"]

[secrets]
NPM_TOKEN = "..."
```

Nodes without `cicd.toml`, or with `enabled = false`, participate in runner
selection gossip (so they can assign jobs to others) but will not execute jobs
themselves.

### How it works

**Trigger → assignment.** When a push arrives on a branch that matches
`on.push.branches`, the receiving node selects the best available runner from
the capability gossip it has heard via heartbeats. It sends a `CiAssignment`
frame to that peer. If no peer has capacity, the job runs locally.

**Runner selection.** Dedicated runners (matching `labels`) are preferred.
Within a tier, the peer with the fewest running jobs and lowest CPU is chosen.
If `fallback: any`, any peer with capacity is eligible.

**Execution.** The runner checks out the commit into a git worktree under
`workdir`, then runs each job in topological order. Docker jobs pull the image
and exec commands inside a container. Shell jobs exec commands in a subprocess
on the host.

**Log streaming.** Stdout/stderr are captured in real time. Logs are stored
under `~/.mesh/ci/<repo>/<run_id>/log.txt` and streamed live to the browser
via SSE.

**Cron scheduling.** Each node runs a cron loop (every `--fetch-secs`). When a
cron slot fires, all eligible nodes broadcast a `CiCronClaim` frame. A
deterministic sha256-based election picks one winner to execute the job —
so the job runs exactly once across the mesh even with many peers online.

**Gossip.** `CiStarted`, `CiCompleted`, and `CiLog` frames propagate to all
peers so the browser dashboard stays in sync everywhere on the mesh.

### Web UI

The browser dashboard at `/status` links to per-repo views:

| URL | Description |
|-----|-------------|
| `/repos/:name` | Redirects to `/repos/:name/ci` |
| `/repos/:name/ci` | Pipeline run list with status badges, manual trigger form |
| `/repos/:name/ci/:run_id` | Run detail with per-job status and live log stream |
| `/repos/:name/issues` | Kanban issues board |

Both the pipelines page and the issues board have a shared nav bar:
**issues · pipelines**.

## Releasing

Releases follow semantic versioning with this convention:

| Change type     | Version part bumped | Example |
|-----------------|---------------------|---------|
| Breaking change | Major (first)       | 1.0.0 → 2.0.0 |
| Fix             | Minor (second)      | 1.0.0 → 1.1.0 |
| Regular build   | Patch (third)       | 1.0.0 → 1.0.1 |

### Commit message format

Use conventional commit prefixes so the release script can detect the bump type automatically:

```
fix: correct retry backoff after address change       → fix (minor bump)
fix!: change wire protocol frame encoding             → breaking (major bump)
feat!: drop support for legacy bincode format         → breaking (major bump)
add invite expiry warning to status output            → build (patch bump)
```

### Cutting a release

1. **Write commits** using the prefixes above.

2. **Run the release script:**
   ```sh
   bun run release
   ```
   This scans commits since the last tag, picks the bump type, updates `package.json`, commits `release vX.Y.Z`, and creates the git tag. Nothing is pushed yet.

   To preview without making any changes:
   ```sh
   bun run release --dry-run
   ```

   To override the auto-detected bump type:
   ```sh
   bun run release breaking
   bun run release fix
   bun run release build
   ```

3. **Review, then push:**
   ```sh
   git push && git push --tags
   ```
   Pushing the tag triggers the GitHub Actions release workflow, which validates the tag matches `package.json`, builds `mesh-src.zip`, and publishes a GitHub Release with it as a downloadable asset.

## Distributing source to teammates

```sh
# Serve the installer over the local network:
mesh serve-install-code                 # plain HTTP, prints the curl line

# Or just build the zip manually:
bun run package                         # writes mesh-src.zip to repo root
```

The `serve-install-code` handler serves:

- `GET /install.sh` — installs bun/unzip/git, downloads the zip, unpacks to
  `~/.local/share/mesh/`, runs `bun install`, and writes a shim at
  `~/.local/bin/mesh`.
- `GET /mesh-src.zip` — the source zip, rebuilt every 60 seconds so edits are
  picked up without restarting.
- `GET /mesh-src.zip.sig` — ed25519 signature of the zip (for `mesh update-code`).
- `GET /version` — JSON with version, sha256, and signature.

## License

MIT.
