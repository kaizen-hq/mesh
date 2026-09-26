import { describe, it, expect } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { PeerRegistry } from "./peer_registry.ts";
import { PeerEntry } from "./peer_registry.ts";
import type { Config } from "./config.ts";
import { DEFAULT_RUNNER } from "./config.ts";

// ---------- fixtures ----------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    self: { name: "alice", peer_port: 7979 },
    peers: [],
    transport: { tls: false, poll_secs: 10 },
    runner: DEFAULT_RUNNER,
    source_path: "/tmp/mesh.toml",
    ...overrides,
  };
}

async function makeTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mesh-peers-test-"));
}

// ---------- create ----------

describe("PeerRegistry.create()", () => {
  it("initializes a peer from config", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: ["http://bob:7979"] }],
    });
    const registry = await PeerRegistry.create(root, config);
    expect(registry.has("bob")).toBe(true);
    expect(registry.get("bob")).toBeInstanceOf(PeerEntry);
  });

  it("skips self from config.peers", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [
        { name: "alice", pubkey: "ed25519:AAA", addresses: [] },
        { name: "bob", pubkey: "ed25519:BBB", addresses: [] },
      ],
    });
    const registry = await PeerRegistry.create(root, config);
    expect(registry.has("alice")).toBe(false);
    expect(registry.has("bob")).toBe(true);
  });

  it("initializes peer addresses from config", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: ["http://bob:7979"] }],
    });
    const registry = await PeerRegistry.create(root, config);
    expect(registry.get("bob")!.addresses).toContain("http://bob:7979");
  });

  it("places static config addresses before cached addresses", async () => {
    const root = await makeTmpRoot();
    await fs.writeFile(
      path.join(root, "peer_addresses.toml"),
      `[addresses]\nbob = ["http://bob-cached:7979"]\n`,
      "utf8",
    );
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: ["http://bob-static:7979"] }],
    });
    const registry = await PeerRegistry.create(root, config);
    const addrs = registry.get("bob")!.addresses;
    expect(addrs[0]).toBe("http://bob-static:7979");
    expect(addrs).toContain("http://bob-cached:7979");
  });

  it("does not duplicate addresses present in both cache and static config", async () => {
    const root = await makeTmpRoot();
    await fs.writeFile(
      path.join(root, "peer_addresses.toml"),
      `[addresses]\nbob = ["http://bob:7979"]\n`,
      "utf8",
    );
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: ["http://bob:7979"] }],
    });
    const registry = await PeerRegistry.create(root, config);
    const addrs = registry.get("bob")!.addresses;
    expect(addrs.filter((a) => a === "http://bob:7979")).toHaveLength(1);
  });

  it("starts with empty peer list when config has no peers", async () => {
    const root = await makeTmpRoot();
    const registry = await PeerRegistry.create(root, makeConfig());
    expect([...registry.entries()]).toHaveLength(0);
  });
});

// ---------- get / has / entries ----------

describe("PeerRegistry read methods", () => {
  it("get() returns undefined for unknown peer", async () => {
    const root = await makeTmpRoot();
    const registry = await PeerRegistry.create(root, makeConfig());
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("has() returns false for unknown peer", async () => {
    const root = await makeTmpRoot();
    const registry = await PeerRegistry.create(root, makeConfig());
    expect(registry.has("unknown")).toBe(false);
  });

  it("entries() yields all tracked peers", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [
        { name: "bob", pubkey: "ed25519:BBB", addresses: [] },
        { name: "carol", pubkey: "ed25519:CCC", addresses: [] },
      ],
    });
    const registry = await PeerRegistry.create(root, config);
    const names = [...registry.entries()].map(([name]) => name).sort();
    expect(names).toEqual(["bob", "carol"]);
  });

  it("get() returns the same PeerEntry object on repeated calls", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: [] }],
    });
    const registry = await PeerRegistry.create(root, config);
    expect(registry.get("bob")).toBe(registry.get("bob"));
  });

  it("mutations on the returned PeerEntry are visible on next get()", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: [] }],
    });
    const registry = await PeerRegistry.create(root, config);
    registry.get("bob")!.notePostOk();
    expect(registry.get("bob")!.isConnected()).toBe(true);
  });
});

// ---------- refresh ----------

describe("PeerRegistry.refresh()", () => {
  it("adds a new peer from config that was not in the original config", async () => {
    const root = await makeTmpRoot();
    const registry = await PeerRegistry.create(root, makeConfig());
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: ["http://bob:7979"] }],
    });
    registry.refresh(config);
    expect(registry.has("bob")).toBe(true);
  });

  it("does not replace an existing peer entry", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: [] }],
    });
    const registry = await PeerRegistry.create(root, config);
    const original = registry.get("bob")!;
    original.notePostOk();

    registry.refresh(config);
    expect(registry.get("bob")).toBe(original);
  });

  it("skips self when refreshing", async () => {
    const root = await makeTmpRoot();
    const registry = await PeerRegistry.create(root, makeConfig());
    const config = makeConfig({
      peers: [{ name: "alice", pubkey: "ed25519:AAA", addresses: [] }],
    });
    registry.refresh(config);
    expect(registry.has("alice")).toBe(false);
  });

  it("adds multiple new peers in one refresh", async () => {
    const root = await makeTmpRoot();
    const registry = await PeerRegistry.create(root, makeConfig());
    const config = makeConfig({
      peers: [
        { name: "bob", pubkey: "ed25519:BBB", addresses: [] },
        { name: "carol", pubkey: "ed25519:CCC", addresses: [] },
      ],
    });
    registry.refresh(config);
    expect(registry.has("bob")).toBe(true);
    expect(registry.has("carol")).toBe(true);
  });
});

// ---------- recordAddress ----------

describe("PeerRegistry.recordAddress()", () => {
  it("returns false for an unknown peer", async () => {
    const root = await makeTmpRoot();
    const registry = await PeerRegistry.create(root, makeConfig());
    expect(await registry.recordAddress("unknown", "http://x:7979")).toBe(false);
  });

  it("returns false when the address is already first", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: ["http://bob:7979"] }],
    });
    const registry = await PeerRegistry.create(root, config);
    expect(await registry.recordAddress("bob", "http://bob:7979")).toBe(false);
  });

  it("returns true and updates addresses when address is new", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: [] }],
    });
    const registry = await PeerRegistry.create(root, config);
    const changed = await registry.recordAddress("bob", "http://bob:7979");
    expect(changed).toBe(true);
    expect(registry.get("bob")!.addresses[0]).toBe("http://bob:7979");
  });

  it("persists the updated address to disk", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: [] }],
    });
    const registry = await PeerRegistry.create(root, config);
    await registry.recordAddress("bob", "http://bob:7979");
    const raw = await fs.readFile(path.join(root, "peer_addresses.toml"), "utf8");
    expect(raw).toContain("bob");
    expect(raw).toContain("http://bob:7979");
  });

  it("currentAddressCache() reflects the updated address after recordAddress()", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: [] }],
    });
    const registry = await PeerRegistry.create(root, config);
    await registry.recordAddress("bob", "http://bob:7979");
    expect(registry.currentAddressCache().addresses["bob"]).toContain("http://bob:7979");
  });
});

// ---------- getPubkey ----------

describe("PeerRegistry.getPubkey()", () => {
  it("returns the pubkey for a config peer", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: [] }],
    });
    const registry = await PeerRegistry.create(root, config);
    expect(registry.getPubkey("bob")).toBe("ed25519:BBB");
  });

  it("returns undefined for an unknown peer", async () => {
    const root = await makeTmpRoot();
    const registry = await PeerRegistry.create(root, makeConfig());
    expect(registry.getPubkey("nobody")).toBeUndefined();
  });

  it("returns undefined for self (self is excluded from the peer map)", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [{ name: "alice", pubkey: "ed25519:AAA", addresses: [] }],
    });
    const registry = await PeerRegistry.create(root, config);
    expect(registry.getPubkey("alice")).toBeUndefined();
  });
});

// ---------- addIntroduced ----------

describe("PeerRegistry.addIntroduced()", () => {
  it("adds an introduced peer to the registry", async () => {
    const root = await makeTmpRoot();
    const registry = await PeerRegistry.create(root, makeConfig());
    registry.addIntroduced("carol", "ed25519:CCC", ["http://carol:7979"], "bob");
    expect(registry.has("carol")).toBe(true);
    expect(registry.getPubkey("carol")).toBe("ed25519:CCC");
    expect(registry.get("carol")!.addresses).toContain("http://carol:7979");
  });

  it("does not overwrite an existing config peer's pubkey", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: [] }],
    });
    const registry = await PeerRegistry.create(root, config);
    registry.addIntroduced("bob", "ed25519:EVIL", ["http://evil:7979"], "attacker");
    expect(registry.getPubkey("bob")).toBe("ed25519:BBB");
  });

  it("updates addresses when the peer is already known", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [{ name: "bob", pubkey: "ed25519:BBB", addresses: [] }],
    });
    const registry = await PeerRegistry.create(root, config);
    registry.addIntroduced("bob", "ed25519:BBB", ["http://bob-new:7979"], "carol");
    expect(registry.get("bob")!.addresses).toContain("http://bob-new:7979");
  });
});

// ---------- allPeers ----------

describe("PeerRegistry.allPeers()", () => {
  it("returns all peers with their pubkeys and addresses", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [
        { name: "bob", pubkey: "ed25519:BBB", addresses: ["http://bob:7979"] },
        { name: "carol", pubkey: "ed25519:CCC", addresses: [] },
      ],
    });
    const registry = await PeerRegistry.create(root, config);
    const all = registry.allPeers("alice");
    expect(all).toHaveLength(2);
    expect(all.find((p) => p.name === "bob")?.pubkey).toBe("ed25519:BBB");
  });

  it("excludes the named peer from the result", async () => {
    const root = await makeTmpRoot();
    const config = makeConfig({
      peers: [
        { name: "bob", pubkey: "ed25519:BBB", addresses: [] },
        { name: "carol", pubkey: "ed25519:CCC", addresses: [] },
      ],
    });
    const registry = await PeerRegistry.create(root, config);
    const all = registry.allPeers("bob");
    expect(all.find((p) => p.name === "bob")).toBeUndefined();
    expect(all.find((p) => p.name === "carol")).toBeDefined();
  });

  it("includes introduced peers", async () => {
    const root = await makeTmpRoot();
    const registry = await PeerRegistry.create(root, makeConfig());
    registry.addIntroduced("carol", "ed25519:CCC", ["http://carol:7979"], "bob");
    const all = registry.allPeers("alice");
    expect(all.find((p) => p.name === "carol")?.pubkey).toBe("ed25519:CCC");
  });
});
