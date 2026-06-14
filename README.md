# mesh — Bun/TypeScript peer-to-peer git daemon

- One HTTP listener on `:7979` (plain HTTP by default; HTTPS opt-in).
- Routes: git smart-HTTP at `/<repo>.git/...`, `POST /mesh/frame` for signed
  notifications, `GET /status` for the browser dashboard.
- Push-only peer link with retry queue + exponential backoff.
- Full-mesh replication: every peer mirrors every repo any peer contributes.
- ed25519-signed frames; bincode-encoded payloads.

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
```

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
