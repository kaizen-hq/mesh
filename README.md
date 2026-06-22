# mesh — Bun/TypeScript peer-to-peer git daemon

- One HTTPS listener on `:7979` (HTTPS by default; HTTP opt-in via `transport.tls = false`).
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

Requires Bun 1.1+. `git` must be on `PATH`.

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
mesh init                                     # generate identity, seed mesh.toml
mesh pubkey                                   # print your public key (share with teammates)
mesh start                                    # run the daemon in the foreground
mesh stop                                     # stop the running daemon
mesh status                                   # show peers, repos, divergences
mesh peers                                    # list configured peers + reachability
mesh repos                                    # list repos + sync freshness
mesh reload                                   # re-read mesh.toml and secrets.yml without restarting
mesh sync                                     # force a reconciliation round
mesh add-peer <name> <pubkey> [addr]          # manually add a peer
mesh add-repo <name> <path> [--branch B ...]  # contribute a working copy
mesh add-repos <parent-dir>                   # scan a directory and add all git repos
mesh add-address <peer> <addr>                # bootstrap a known address for a peer
mesh invite --addr HOST:PORT [--ttl SECS]     # generate a one-time pairing token (default TTL: 600s)
mesh join <token>                             # accept a pairing token
mesh url <repo>                               # print the local git URL for a repo
mesh update                                   # update mesh binary from current serve-install peer
mesh update-code                              # update mesh source from current serve-install-code peer

# CI/CD
mesh ci status [<repo>]                # show recent pipeline runs
mesh ci run <repo> <ref>               # manually trigger a pipeline
mesh ci logs <repo> <run_id>           # print build log
mesh ci cancel <run_id>                # cancel a running job
mesh ci runners                        # list peers and their CI capabilities
```

## CI/CD

Mesh includes a distributed CI/CD system. Pipelines are defined per-repo and
executed across peers. Every node is a runner by default — runner configuration
lives in the `[runner]` section of `~/.mesh/mesh.toml`.

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
    secrets: [NPM_TOKEN]   # injected from ~/.mesh/secrets.yml on the runner node

  build:
    image: oven/bun:1.1
    commands:
      - bun run build
    depends_on: [test]     # topological ordering; build waits for test

  nightly:
    mode: shell            # run commands directly on the runner host (no Docker)
    commands:
      - bun run audit
```

Jobs run in Docker by default (`mode: docker`). Set `mode: shell` to run
commands in a subprocess on the runner host.

`depends_on` supports arbitrary DAGs. Cycles are rejected at parse time.
Jobs whose upstream failed are automatically marked `skipped`.

### Runner routing (`runner.labels` and `runner.fallback`)

The `runner:` section in `mesh-ci.yml` controls which nodes in the mesh are
eligible to run the pipeline's jobs.

**`labels`** is matched against the `labels` list each node advertises in its
`~/.mesh/mesh.toml [runner]` section. A pipeline with `labels: [docker]` will
only be assigned to nodes that include `"docker"` in their runner labels.
An empty list `[]` means no label requirement — every enabled runner is eligible.

Use labels to route pipelines to dedicated build machines:

```toml
# On the dedicated build box — ~/.mesh/mesh.toml
[runner]
labels = ["docker", "linux"]
```

```yaml
# In the repo — .mesh/mesh-ci.yml
runner:
  labels: [docker]   # only runs on nodes advertising "docker"
```

**`fallback`** defines what happens when no labeled runner is currently
available (offline, at capacity, or no nodes match the label):

| Value | Behavior |
|-------|----------|
| `any` | Fall back to any enabled runner in the mesh, regardless of labels |
| `none` | Do not run — the assignment is dropped; the pipeline will not execute until manually triggered again |

`fallback: none` is appropriate for jobs that must not run on general-purpose
machines (e.g. a deployment job that requires specific credentials or network
access). `fallback: any` is safe for most CI pipelines where any capable node
is fine.

### Runner configuration

Runner configuration lives in the `[runner]` section of `~/.mesh/mesh.toml`,
seeded by `mesh init`:

```toml
[runner]
enabled             = true
execution_modes     = ["docker"]       # permit "docker", "shell", or both
labels              = []               # empty = matches any job; set for dedicated runners
max_concurrent_jobs = 2
workdir             = "~/.mesh/ci/runs"   # where worktrees are checked out

# Host environment variables that shell jobs are allowed to read.
# Shell jobs run in an isolated environment; only vars listed here (plus
# PATH, HOME, TMPDIR, LANG, LC_ALL) are passed through from the host.
# env_passthrough = ["GOPATH", "SSH_AUTH_SOCK", "DOCKER_HOST"]

# Tool auto-detection (docker, bun, node, python3, go, cargo)
# Override if auto-detect is wrong for your setup:
# tools = ["docker", "bun"]

# Tuning
log_stream_interval_ms   = 500
max_worktree_age_minutes = 60
max_worktree_disk_mb     = 2048
log_retention_runs       = 50
```

To permit shell jobs (commands run directly on the host, not in Docker):

```toml
[runner]
execution_modes = ["docker", "shell"]
```

To opt a node out of running jobs entirely (it will still participate in
runner selection and assign jobs to others):

```toml
[runner]
enabled = false
```

### Registering repos on runner nodes

Every node that will **execute** jobs for a repo must have the repo registered
in its `mesh.toml`:

```sh
mesh add-repo my-app ~/src/my-app --branch main
mesh reload
```

`mesh add-repo` writes the entry to `mesh.toml`. `mesh reload` makes the
running daemon pick it up immediately without a restart.

A local working copy at the registered path is **not required**. Mesh creates
each run's worktree from the bare mirror at `~/.mesh/repos/<name>.git`, which
is populated automatically via peer sync. The registered path is only used as a
bootstrap source to seed the mirror if it is empty when the first run arrives —
and even then, failure is non-fatal if the mirror has already synced from peers.

Nodes that are not runners (or have `enabled = false`) do not need the repo
registered — they participate in assignment and show run history in the
dashboard without executing anything locally.

### Secrets

Node-local secrets (environment variables injected into jobs) live in
`~/.mesh/secrets.yml` — a separate file kept off version control:

```yaml
secrets:
  NPM_TOKEN: "${NPM_TOKEN}"   # resolved from the daemon's environment at load time
  DEPLOY_KEY: "literal-value"
```

Values can be literal strings or `${ENV_VAR}` references — mesh reads the
named variable from the daemon's environment when `secrets.yml` is loaded (or
reloaded). This keeps plaintext secrets out of the file: only the variable
name is stored on disk; the value lives solely in the environment.

`mesh reload` picks up both `mesh.toml` and `secrets.yml` without restarting
the daemon.

**Environment isolation.** Shell jobs run with a minimal environment: only
`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, variables listed in
`[runner] env_passthrough`, and the job's declared secrets. Docker jobs pass
the same limited set to the `docker` CLI so that compose variable substitution
only resolves declared secrets, not arbitrary host variables.

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
| `/repos/:name/issues` | Issues board |

Both the pipelines page and the issues board have a shared nav bar:
**issues · pipelines**.

## Troubleshooting

### Peers not connecting

**Check reachability first.**
```sh
mesh peers          # shows each peer's last-seen time and address
mesh status         # shows divergence count per peer
```

If a peer shows `never` or a stale timestamp:
- Confirm the address is correct: `mesh add-address <peer> <host:port>` to add or correct it.
- Verify the target node is running: `curl -k https://HOST:7979/status` should return HTML.
- If TLS is disabled on one side but not the other, the connection will fail silently. Both nodes must agree: either both use `transport.tls = true` (default) or both set `false`.
- Self-signed certificates are used by default. TLS verification is intentionally disabled between peers — this is expected behavior.

**Check the peer's public key.**
Frames are ed25519-signed and rejected if the signature doesn't match the configured pubkey. If you recently re-initialized a peer (`mesh init` on an existing node), its pubkey changes. Update it:
```sh
mesh add-peer <name> <new-pubkey>
mesh reload
```

---

### Pipeline doesn't trigger on push

1. **Branch filter.** Check `on.push.branches` in `mesh-ci.yml` matches the branch you pushed to. Glob patterns like `"release/*"` must be quoted in YAML.
2. **No eligible runner.** Run `mesh ci runners` to see which nodes are online and their capabilities. If the list is empty or all nodes have `enabled = false`, no assignment will be made.
3. **Label mismatch.** If `runner.labels` in `mesh-ci.yml` specifies a label that no online node advertises, and `fallback` is `none`, the pipeline is silently dropped. Change to `fallback: any` or add the label to a node's `mesh.toml`.
4. **`mesh-ci.yml` not found.** The file must be at `.mesh/mesh-ci.yml` relative to the repo root and committed — mesh reads it from the git object store, not the working tree.

---

### Pipeline triggered but jobs never start / run stays `pending`

- **Repo not registered on the runner.** The runner needs the repo cloned locally and registered in its `mesh.toml`. Without it, mesh logs `no reachable source for <repo>` and the run stays `pending`. Fix: clone the repo on the runner node and run `mesh add-repo <name> <path> --branch main && mesh reload`.
- `mesh ci status <repo>` — if the run shows `pending` indefinitely, the runner received the assignment but hasn't started. Check the runner node's daemon logs.
- `mesh ci runners` — verify the assigned runner shows `runner: true` and `jobs_running` below `max_concurrent_jobs`.
- If `execution_modes` on the runner doesn't include the mode the job requires (`docker` or `shell`), the job will fail immediately with a log line like `job "X" requires shell mode but "shell" is not in execution_modes`.

---

### Job fails immediately / exit code 1 with no output

- **Docker not found.** For `mode: docker` jobs, `docker` must be on `PATH` on the runner node. Check with `mesh ci runners` — the `tools` list shows what was auto-detected.
- **Image pull failure.** The runner must have internet access (or registry access) to pull the image. Check the job log: `mesh ci logs <repo> <run_id>`.
- **Shell env missing a tool.** Shell jobs run with a minimal environment. If a command depends on a host tool or env var that isn't in the baseline (`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`), add it to `env_passthrough` in `mesh.toml` and run `mesh reload`.

---

### Secrets not injected / empty in job

- The secret must be declared in the job's `secrets:` list in `mesh-ci.yml` and defined in `~/.mesh/secrets.yml` on the runner node (not the triggering node).
- If using `${ENV_VAR}` interpolation in `secrets.yml`, the variable must be set in the environment of the mesh daemon process itself — not just in your shell. Restart or reload after setting it: `mesh reload`.
- Run `mesh ci logs <repo> <run_id>` and look for `WARN secrets.yml: env var "${X}" is not set` lines emitted at daemon startup or reload.

---

### Worktree left behind / disk fills up

Worktrees are created under `workdir` (default `~/.mesh/ci/runs`) and removed when a run completes. If the daemon crashed mid-run, orphaned worktrees may remain.

```sh
ls ~/.mesh/ci/runs          # list worktrees
git worktree list           # from inside the repo, see all registered worktrees
git worktree prune          # remove stale registrations
```

`max_worktree_age_minutes` and `max_worktree_disk_mb` in `mesh.toml` control automatic cleanup of old runs. Lower these values on space-constrained nodes.

---

### Config changes not taking effect

`mesh reload` re-reads `mesh.toml` and `secrets.yml` without restarting the daemon. It does **not** re-read `mesh-ci.yml` — that file lives in the repo and is read fresh on each pipeline trigger.

If `mesh reload` reports no error but behavior doesn't change, check that you edited the correct file. With multiple instances (`--root`), each instance has its own `mesh.toml`.

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
