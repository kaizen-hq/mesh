# Setting up a new repo

There are two supported flows: a pairing handshake (preferred for new
teammates) and direct CLI mutations (preferred when you already know each
other's pubkey).

## A. Pairing flow (no out-of-band pubkey exchange)

On the inviter's node (must be running `mesh start` and reachable):

```sh
mesh invite --addr 10.0.1.42:7979           # prints a short signed token
```

The token embeds the inviter's pubkey, name, address, a random nonce, and a
10-minute expiry. Share it with the teammate (Slack, in-person — anything).

On the joining node:

```sh
mesh start                                   # in another terminal
mesh join <token>                            # paste the token
```

After `join`, both `mesh.toml` files contain each other's peer entries and
heartbeats start flowing automatically.

## B. Direct flow (when you already have the pubkey)

```sh
# on every node:
mesh start
mesh add-peer <name> <pubkey> [host:port]    # writes mesh.toml + reloads
```

## Adding a repo

On the node where the working copy lives:

```sh
mesh add-repo <name> <path-from-$HOME> [--branch main]
```

That writes `mesh.toml`, reloads the daemon, and initializes the bare mirror
at `~/.mesh/repos/<name>.git`. The next heartbeat advertises the repo to
peers; they fetch automatically and you can `git clone` from any of them.
