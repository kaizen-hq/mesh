import { describe, it, expect } from "bun:test";
import { RepoRegistry } from "./repo_registry.ts";
import { RepoLocal } from "./repo_registry.ts";

// ---------- create ----------

describe("RepoRegistry.create()", () => {
  it("starts empty", () => {
    const registry = RepoRegistry.create();
    expect([...registry.keys()]).toHaveLength(0);
  });
});

// ---------- get / has / keys / entries ----------

describe("RepoRegistry read methods", () => {
  it("get() returns undefined for unknown repo", () => {
    const registry = RepoRegistry.create();
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("has() returns false for unknown repo", () => {
    const registry = RepoRegistry.create();
    expect(registry.has("unknown")).toBe(false);
  });

  it("keys() yields all repo names after ensure", () => {
    const registry = RepoRegistry.create();
    registry.ensure("repo-a");
    registry.ensure("repo-b");
    expect([...registry.keys()].sort()).toEqual(["repo-a", "repo-b"]);
  });

  it("entries() yields all [name, RepoLocal] pairs after ensure", () => {
    const registry = RepoRegistry.create();
    registry.ensure("repo-a");
    registry.ensure("repo-b");
    const pairs = [...registry.entries()];
    expect(pairs).toHaveLength(2);
    expect(pairs.every(([, v]) => v instanceof RepoLocal)).toBe(true);
  });

  it("get() returns the same RepoLocal object on repeated calls", () => {
    const registry = RepoRegistry.create();
    registry.ensure("myrepo");
    expect(registry.get("myrepo")).toBe(registry.get("myrepo"));
  });

  it("mutations on the returned RepoLocal are visible on next get()", () => {
    const registry = RepoRegistry.create();
    registry.ensure("myrepo");
    registry.get("myrepo")!.noteSource("bob");
    expect(registry.get("myrepo")!.sourceList()).toContain("bob");
  });
});

// ---------- ensure ----------

describe("RepoRegistry.ensure()", () => {
  it("returns the existing entry for a known repo", () => {
    const registry = RepoRegistry.create();
    const r1 = registry.ensure("myrepo");
    const r2 = registry.ensure("myrepo");
    expect(r1).toBe(r2);
  });

  it("creates and returns a new RepoLocal for an unknown repo", () => {
    const registry = RepoRegistry.create();
    const r = registry.ensure("newrepo");
    expect(r).toBeInstanceOf(RepoLocal);
  });

  it("makes a newly created repo visible via get()", () => {
    const registry = RepoRegistry.create();
    registry.ensure("newrepo");
    expect(registry.has("newrepo")).toBe(true);
    expect(registry.get("newrepo")).toBeInstanceOf(RepoLocal);
  });

  it("newly ensured repo appears in keys()", () => {
    const registry = RepoRegistry.create();
    registry.ensure("newrepo");
    expect([...registry.keys()]).toContain("newrepo");
  });

  it("mutations on an ensured entry persist", () => {
    const registry = RepoRegistry.create();
    const r = registry.ensure("newrepo");
    r.lastFetch = 12345;
    expect(registry.get("newrepo")!.lastFetch).toBe(12345);
  });
});

// ---------- noteSource / sourceList ----------

describe("RepoLocal source tracking", () => {
  it("sourceList() is empty initially", () => {
    const registry = RepoRegistry.create();
    const r = registry.ensure("repo");
    expect(r.sourceList()).toHaveLength(0);
  });

  it("noteSource() adds a peer and it appears in sourceList()", () => {
    const registry = RepoRegistry.create();
    const r = registry.ensure("repo");
    r.noteSource("alice");
    expect(r.sourceList()).toContain("alice");
  });

  it("noteSource() deduplicates peers", () => {
    const registry = RepoRegistry.create();
    const r = registry.ensure("repo");
    r.noteSource("alice");
    r.noteSource("alice");
    expect(r.sourceList()).toHaveLength(1);
  });

  it("noteSource() tracks multiple distinct peers", () => {
    const registry = RepoRegistry.create();
    const r = registry.ensure("repo");
    r.noteSource("alice");
    r.noteSource("bob");
    expect(r.sourceList().sort()).toEqual(["alice", "bob"]);
  });
});
