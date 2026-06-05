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

```sh
cd mesh
bun install
```

Requires Bun 1.1+. `git` and `openssl` (only for HTTPS mode) must be on `PATH`.

## Use

Identical commands to the Rust mesh:

```sh
bun src/main.ts init                       # generate identity, seed mesh.toml
bun src/main.ts pubkey                     # share with teammates
bun src/main.ts start                      # foreground server
bun src/main.ts status                     # peers + repos + divergences
bun src/main.ts add-address kyle 10.0.1.42:7979
bun src/main.ts url webapp           # http://127.0.0.1:7979/webapp.git
```

Compile to a single binary so teammates don't need Bun installed at all:

```sh
bun build src/main.ts --compile --outfile mesh
./mesh --help
```

## Distributing source instead of a binary

For teammates who'd rather run from source (more debuggable, hackable):

```sh
# package the source tree into mesh-src.zip in the repo root
bun run package
# or to a custom path:
bun scripts/package.ts dist/mesh-src.zip

# the same logic from the running CLI:
mesh package                            # writes mesh-src.zip
mesh package /tmp/build.zip             # custom output
```

The zip excludes `node_modules/`, `bun.lock`, the compiled `mesh` binary,
and `.git/` — just source + `package.json` + `tsconfig.json` + `README.md` +
`.gitignore`.

To hand it out over HTTP (parity with `serve-install` but for source):

```sh
mesh serve-install-code                 # plain HTTP on 0.0.0.0:8001
# prints the curl line teammates run.
```

The handler:

- `GET /install.sh` — installer script. Verifies bun/unzip/git, downloads
  `mesh-src.zip`, unpacks to `~/.local/share/mesh/`, runs `bun install`,
  and writes a shim at `~/.local/bin/mesh` that does
  `exec bun ~/.local/share/mesh/src/main.ts "$@"`.
- `GET /mesh-src.zip` — the zip. Rebuilt every 60 seconds while the server
  runs, so source edits get picked up without restarting.
- `GET /` — friendly index that prints the curl line.

After install, teammates run `mesh init && mesh pubkey && mesh start`
exactly as if they had the compiled binary.

## License

MIT.
