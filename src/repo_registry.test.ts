import { describe, it, expect } from "bun:test";
import { RepoRegistry } from "./repo_registry.ts";
import { RepoLocal } from "./repo_registry.ts";
import type { Config } from "./config.ts";
import { DEFAULT_RUNNER } from "./config.ts";

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

// ---------- create ----------

describe("RepoRegistry.create()", () => {
  it("initializes repos from config", () => {
    const config = makeConfig({
      repos: [{ name: "myrepo", path: "/tmp/r", branches: ["main"] }],
    });
    const registry = RepoRegistry.create(config);
    expect(registry.has("myrepo")).toBe(true);
    expect(registry.get("myrepo")).toBeInstanceOf(RepoLocal);
  });

  it("initializes multiple repos", () => {
    const config = makeConfig({
      repos: [
        { name: "repo-a", path: "/tmp/a", branches: ["main"] },
        { name: "repo-b", path: "/tmp/b", branches: ["main"] },
      ],
    });
    const registry = RepoRegistry.create(config);
    expect(registry.has("repo-a")).toBe(true);
    expect(registry.has("repo-b")).toBe(true);
  });

  it("starts empty when config has no repos", () => {
    const registry = RepoRegistry.create(makeConfig());
    expect([...registry.keys()]).toHaveLength(0);
  });
});

// ---------- get / has / keys / entries ----------

describe("RepoRegistry read methods", () => {
  it("get() returns undefined for unknown repo", () => {
    const registry = RepoRegistry.create(makeConfig());
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("has() returns false for unknown repo", () => {
    const registry = RepoRegistry.create(makeConfig());
    expect(registry.has("unknown")).toBe(false);
  });

  it("keys() yields all repo names", () => {
    const config = makeConfig({
      repos: [
        { name: "repo-a", path: "/tmp/a", branches: [] },
        { name: "repo-b", path: "/tmp/b", branches: [] },
      ],
    });
    const registry = RepoRegistry.create(config);
    expect([...registry.keys()].sort()).toEqual(["repo-a", "repo-b"]);
  });

  it("entries() yields all [name, RepoLocal] pairs", () => {
    const config = makeConfig({
      repos: [
        { name: "repo-a", path: "/tmp/a", branches: [] },
        { name: "repo-b", path: "/tmp/b", branches: [] },
      ],
    });
    const registry = RepoRegistry.create(config);
    const pairs = [...registry.entries()];
    expect(pairs).toHaveLength(2);
    expect(pairs.every(([, v]) => v instanceof RepoLocal)).toBe(true);
  });

  it("get() returns the same RepoLocal object on repeated calls", () => {
    const config = makeConfig({
      repos: [{ name: "myrepo", path: "/tmp/r", branches: [] }],
    });
    const registry = RepoRegistry.create(config);
    expect(registry.get("myrepo")).toBe(registry.get("myrepo"));
  });

  it("mutations on the returned RepoLocal are visible on next get()", () => {
    const config = makeConfig({
      repos: [{ name: "myrepo", path: "/tmp/r", branches: [] }],
    });
    const registry = RepoRegistry.create(config);
    registry.get("myrepo")!.noteSource("bob");
    expect(registry.get("myrepo")!.sourceList()).toContain("bob");
  });
});

// ---------- ensure ----------

describe("RepoRegistry.ensure()", () => {
  it("returns the existing entry for a known repo", () => {
    const config = makeConfig({
      repos: [{ name: "myrepo", path: "/tmp/r", branches: [] }],
    });
    const registry = RepoRegistry.create(config);
    const r1 = registry.ensure("myrepo");
    const r2 = registry.ensure("myrepo");
    expect(r1).toBe(r2);
  });

  it("creates and returns a new RepoLocal for an unknown repo", () => {
    const registry = RepoRegistry.create(makeConfig());
    const r = registry.ensure("newrepo");
    expect(r).toBeInstanceOf(RepoLocal);
  });

  it("makes a newly created repo visible via get()", () => {
    const registry = RepoRegistry.create(makeConfig());
    registry.ensure("newrepo");
    expect(registry.has("newrepo")).toBe(true);
    expect(registry.get("newrepo")).toBeInstanceOf(RepoLocal);
  });

  it("newly ensured repo appears in keys()", () => {
    const registry = RepoRegistry.create(makeConfig());
    registry.ensure("newrepo");
    expect([...registry.keys()]).toContain("newrepo");
  });

  it("mutations on an ensured entry persist", () => {
    const registry = RepoRegistry.create(makeConfig());
    const r = registry.ensure("newrepo");
    r.lastFetch = 12345;
    expect(registry.get("newrepo")!.lastFetch).toBe(12345);
  });
});
