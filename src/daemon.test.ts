import { describe, it, expect } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Daemon } from "./daemon.ts";
import { PeerRegistry } from "./peer_registry.ts";
import { RepoRegistry } from "./repo_registry.ts";
import { OutboundQueues } from "./outbound_queues.ts";
import { CiDomain } from "./ci/ci_domain.ts";
import type { Config } from "./config.ts";
import { DEFAULT_RUNNER } from "./config.ts";
import type { Identity } from "./identity.ts";

// ---------- fixtures ----------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    self: { name: "alice", peer_port: 7979 },
    peers: [],
    repos: [],
    transport: { tls: false, poll_secs: 10 },
    runner: DEFAULT_RUNNER,
    raw_hash: "abc123",
    source_path: "/tmp/mesh.toml",
    ...overrides,
  };
}

function makeIdentity(): Identity {
  return {
    privateKey: new Uint8Array(32),
    publicKey: new Uint8Array(32),
    pubkeyString: "ed25519:AAAA",
    certPem: null,
    keyPem: null,
  };
}

async function makeTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mesh-daemon-test-"));
}

// ---------- create ----------

describe("Daemon.create()", () => {
  it("exposes a PeerRegistry", async () => {
    const daemon = await Daemon.create(await makeTmpRoot(), makeConfig(), makeIdentity());
    expect(daemon.peers).toBeInstanceOf(PeerRegistry);
  });

  it("exposes a RepoRegistry", async () => {
    const daemon = await Daemon.create(await makeTmpRoot(), makeConfig(), makeIdentity());
    expect(daemon.repos).toBeInstanceOf(RepoRegistry);
  });

  it("exposes an OutboundQueues", async () => {
    const daemon = await Daemon.create(await makeTmpRoot(), makeConfig(), makeIdentity());
    expect(daemon.outbound).toBeInstanceOf(OutboundQueues);
  });

  it("exposes a CiDomain", async () => {
    const daemon = await Daemon.create(await makeTmpRoot(), makeConfig(), makeIdentity());
    expect(daemon.ci).toBeInstanceOf(CiDomain);
  });

  it("initializes peers from config, skipping self", async () => {
    const config = makeConfig({
      peers: [
        { name: "alice", pubkey: "ed25519:AAA", addresses: [] },
        { name: "bob", pubkey: "ed25519:BBB", addresses: [] },
      ],
    });
    const daemon = await Daemon.create(await makeTmpRoot(), config, makeIdentity());
    expect(daemon.peers.has("alice")).toBe(false);
    expect(daemon.peers.has("bob")).toBe(true);
  });

  it("initializes repos from config", async () => {
    const config = makeConfig({
      repos: [{ name: "myrepo", path: "/tmp/r", branches: ["main"] }],
    });
    const daemon = await Daemon.create(await makeTmpRoot(), config, makeIdentity());
    expect(daemon.repos.has("myrepo")).toBe(true);
  });

  it("sets root, config, and identity", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig();
    const identity = makeIdentity();
    const daemon = await Daemon.create(root, config, identity);
    expect(daemon.root).toBe(root);
    expect(daemon.config).toBe(config);
    expect(daemon.identity).toBe(identity);
  });

  it("listenAddr is null initially", async () => {
    const daemon = await Daemon.create(await makeTmpRoot(), makeConfig(), makeIdentity());
    expect(daemon.listenAddr).toBeNull();
  });

  it("pendingInvites is empty when no file exists", async () => {
    const daemon = await Daemon.create(await makeTmpRoot(), makeConfig(), makeIdentity());
    expect(daemon.pendingInvites.size).toBe(0);
  });
});

// ---------- reloadConfig ----------

describe("Daemon.reloadConfig()", () => {
  it("updates config", async () => {
    const daemon = await Daemon.create(await makeTmpRoot(), makeConfig({ raw_hash: "old" }), makeIdentity());
    const next = makeConfig({ raw_hash: "new" });
    daemon.reloadConfig(next);
    expect(daemon.config.raw_hash).toBe("new");
  });

  it("refreshes peers from the new config", async () => {
    const daemon = await Daemon.create(await makeTmpRoot(), makeConfig(), makeIdentity());
    expect(daemon.peers.has("bob")).toBe(false);
    const next = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: [] }],
    });
    daemon.reloadConfig(next);
    expect(daemon.peers.has("bob")).toBe(true);
  });

  it("does not replace existing peer entries on reload", async () => {
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: [] }],
    });
    const daemon = await Daemon.create(await makeTmpRoot(), config, makeIdentity());
    const original = daemon.peers.get("bob")!;
    original.notePostOk();
    daemon.reloadConfig(config);
    expect(daemon.peers.get("bob")).toBe(original);
  });
});

// ---------- recordPeerAddress ----------

describe("Daemon.recordPeerAddress()", () => {
  it("returns false for unknown peer", async () => {
    const daemon = await Daemon.create(await makeTmpRoot(), makeConfig(), makeIdentity());
    expect(await daemon.recordPeerAddress("unknown", "http://x:7979")).toBe(false);
  });

  it("returns true and updates peer addresses", async () => {
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: [] }],
    });
    const daemon = await Daemon.create(await makeTmpRoot(), config, makeIdentity());
    const changed = await daemon.recordPeerAddress("bob", "http://bob:7979");
    expect(changed).toBe(true);
    expect(daemon.peers.get("bob")!.addresses[0]).toBe("http://bob:7979");
  });

  it("persists the address to disk", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: [] }],
    });
    const daemon = await Daemon.create(root, config, makeIdentity());
    await daemon.recordPeerAddress("bob", "http://bob:7979");
    const raw = await fs.readFile(path.join(root, "peer_addresses.toml"), "utf8");
    expect(raw).toContain("http://bob:7979");
  });
});

// ---------- notifications ----------

describe("Daemon notifications", () => {
  it("notifyIssueChanged() calls all registered callbacks with repo name", async () => {
    const daemon = await Daemon.create(await makeTmpRoot(), makeConfig(), makeIdentity());
    const calls: string[] = [];
    daemon.issueChangedCallbacks.push((r) => calls.push(r));
    daemon.issueChangedCallbacks.push((r) => calls.push(`2:${r}`));
    daemon.notifyIssueChanged("repo-x");
    expect(calls).toEqual(["repo-x", "2:repo-x"]);
  });

  it("notifyStatusChanged() calls all registered callbacks", async () => {
    const daemon = await Daemon.create(await makeTmpRoot(), makeConfig(), makeIdentity());
    let count = 0;
    daemon.statusChangedCallbacks.push(() => count++);
    daemon.statusChangedCallbacks.push(() => count++);
    daemon.notifyStatusChanged();
    expect(count).toBe(2);
  });

  it("notifyCiRunChanged() calls all registered callbacks with repo name", async () => {
    const daemon = await Daemon.create(await makeTmpRoot(), makeConfig(), makeIdentity());
    const calls: string[] = [];
    daemon.ciRunChangedCallbacks.push((r) => calls.push(r));
    daemon.notifyCiRunChanged("ci-repo");
    expect(calls).toEqual(["ci-repo"]);
  });

  it("notifications with no registered callbacks do not throw", async () => {
    const daemon = await Daemon.create(await makeTmpRoot(), makeConfig(), makeIdentity());
    expect(() => daemon.notifyIssueChanged("repo")).not.toThrow();
    expect(() => daemon.notifyStatusChanged()).not.toThrow();
    expect(() => daemon.notifyCiRunChanged("repo")).not.toThrow();
  });
});

// ---------- savePendingInvites ----------

describe("Daemon.savePendingInvites()", () => {
  it("writes pendingInvites to disk", async () => {
    const root = await makeTmpRoot();
    const daemon = await Daemon.create(root, makeConfig(), makeIdentity());
    daemon.pendingInvites.set("nonce-abc", { expiryMs: Date.now() + 60_000, address: "http://x:7979" });
    await daemon.savePendingInvites();
    const raw = await fs.readFile(path.join(root, "pending_invites.json"), "utf8");
    expect(raw).toContain("nonce-abc");
  });
});

// ---------- lifecycle ----------

describe("Daemon lifecycle", () => {
  it("onShutdown() resolves after signalShutdown()", async () => {
    const daemon = await Daemon.create(await makeTmpRoot(), makeConfig(), makeIdentity());
    let resolved = false;
    const p = daemon.onShutdown().then(() => { resolved = true; });
    expect(resolved).toBe(false);
    daemon.signalShutdown();
    await p;
    expect(resolved).toBe(true);
  });

  it("signalShutdown() is idempotent", async () => {
    const daemon = await Daemon.create(await makeTmpRoot(), makeConfig(), makeIdentity());
    daemon.signalShutdown();
    daemon.signalShutdown();
    await daemon.onShutdown();
  });
});
