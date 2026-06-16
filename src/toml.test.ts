import { describe, it, expect } from "bun:test";
import { parse, stringify } from "./toml.ts";

// ── parse ────────────────────────────────────────────────────────────────────
describe("parse", () => {
  it("parses scalars", () => {
    const doc = parse(`name = "alice"\nport = 7979\ntls = true\n`) as Record<string, unknown>;
    expect(doc.name).toBe("alice");
    expect(doc.port).toBe(7979);
    expect(doc.tls).toBe(true);
  });

  it("parses a [table] section", () => {
    const doc = parse(`[self]\nname = "alice"\npeer_port = 7979\n`) as Record<string, unknown>;
    expect((doc.self as Record<string, unknown>).name).toBe("alice");
    expect((doc.self as Record<string, unknown>).peer_port).toBe(7979);
  });

  it("parses [[array-of-tables]]", () => {
    const raw = `[[peers]]\nname = "alice"\npubkey = "abc"\n\n[[peers]]\nname = "bob"\npubkey = "def"\n`;
    const doc = parse(raw) as { peers: { name: string; pubkey: string }[] };
    expect(doc.peers).toHaveLength(2);
    expect(doc.peers[0].name).toBe("alice");
    expect(doc.peers[1].name).toBe("bob");
  });

  it("parses inline arrays", () => {
    const doc = parse(`branches = ["main", "dev"]\n`) as { branches: string[] };
    expect(doc.branches).toEqual(["main", "dev"]);
  });

  it("parses an empty inline array", () => {
    const doc = parse(`repos = []\n`) as { repos: unknown[] };
    expect(doc.repos).toEqual([]);
  });

  it("throws on invalid TOML", () => {
    expect(() => parse("not valid = = toml")).toThrow();
  });
});

// ── stringify ────────────────────────────────────────────────────────────────

describe("stringify", () => {
  it("round-trips a seed config", () => {
    const doc = {
      self: { name: "alice" },
      peers: [{ name: "alice", pubkey: "abc123" }],
      repos: [] as unknown[],
    };
    const out = stringify(doc as Record<string, unknown>);
    const back = parse(out) as typeof doc;
    expect(back.self.name).toBe("alice");
    expect(back.peers[0].pubkey).toBe("abc123");
    expect(back.repos).toEqual([]);
  });

  it("round-trips a full mesh.toml", () => {
    const doc = {
      self: { name: "alice", peer_port: 7979 },
      peers: [
        { name: "alice", pubkey: "aaa", addresses: ["10.0.0.1:7979"] },
        { name: "bob",   pubkey: "bbb", addresses: ["10.0.0.2:7979", "10.0.0.3:7979"] },
      ],
      repos: [
        { name: "mesh", path: "src/mesh", branches: ["main"] },
        { name: "core", path: "src/core", branches: ["main", "dev"] },
      ],
      transport: { tls: false, poll_secs: 1 },
    };
    const out = stringify(doc as unknown as Record<string, unknown>);
    const back = parse(out) as typeof doc;
    expect(back.self.name).toBe("alice");
    expect(back.self.peer_port).toBe(7979);
    expect(back.peers).toHaveLength(2);
    expect(back.peers[1].addresses).toEqual(["10.0.0.2:7979", "10.0.0.3:7979"]);
    expect(back.repos).toHaveLength(2);
    expect(back.repos[1].branches).toEqual(["main", "dev"]);
    expect(back.transport.tls).toBe(false);
    expect(back.transport.poll_secs).toBe(1);
  });

  it("round-trips a peer_addresses.toml", () => {
    const doc = { addresses: { alice: ["10.0.0.1:7979"], bob: ["10.0.0.2:7979"] } };
    const out = stringify(doc as unknown as Record<string, unknown>);
    const back = parse(out) as typeof doc;
    expect(back.addresses.alice).toEqual(["10.0.0.1:7979"]);
    expect(back.addresses.bob).toEqual(["10.0.0.2:7979"]);
  });

  it("emits top-level scalars before table headers", () => {
    const doc = { repos: [] as unknown[], self: { name: "alice" } };
    const out = stringify(doc as Record<string, unknown>);
    const reposPos = out.indexOf("repos");
    const selfPos = out.indexOf("[self]");
    expect(reposPos).toBeLessThan(selfPos);
  });

  it("handles strings with special characters", () => {
    const doc = { self: { name: 'al"ice\ntest' } };
    const out = stringify(doc as Record<string, unknown>);
    const back = parse(out) as typeof doc;
    expect(back.self.name).toBe('al"ice\ntest');
  });

  it("handles peer names that require quoted keys", () => {
    const doc = { addresses: { "alice.local": ["10.0.0.1:7979"] } };
    const out = stringify(doc as unknown as Record<string, unknown>);
    expect(out).toContain('"alice.local"');
    const back = parse(out) as typeof doc;
    expect(back.addresses["alice.local"]).toEqual(["10.0.0.1:7979"]);
  });

  it("produces a trailing newline", () => {
    const out = stringify({ self: { name: "alice" } } as Record<string, unknown>);
    expect(out.endsWith("\n")).toBe(true);
  });
});
