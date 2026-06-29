import { describe, it, expect, beforeEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  mirrorPath,
  scanMirrors,
  loadRepoMeta,
  saveRepoMeta,
  type RepoMeta,
} from "./repo_store.ts";

// ---------- helpers ----------

async function makeTmpRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-store-test-"));
  await fs.mkdir(path.join(root, "repos"), { recursive: true });
  return root;
}

async function makeBareMirror(root: string, name: string): Promise<string> {
  const dir = mirrorPath(root, name);
  await fs.mkdir(dir, { recursive: true });
  // Write a minimal HEAD to satisfy the "is a bare repo" check.
  await fs.writeFile(path.join(dir, "HEAD"), "ref: refs/heads/main\n");
  return dir;
}

// ---------- mirrorPath ----------

describe("mirrorPath()", () => {
  it("returns <root>/repos/<name>.git", () => {
    expect(mirrorPath("/home/user/.mesh", "myrepo")).toBe(
      "/home/user/.mesh/repos/myrepo.git",
    );
  });
});

// ---------- scanMirrors ----------

describe("scanMirrors()", () => {
  it("returns empty array when repos dir does not exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-scan-empty-"));
    const result = await scanMirrors(root);
    expect(result).toEqual([]);
  });

  it("returns empty array when repos dir is empty", async () => {
    const root = await makeTmpRoot();
    const result = await scanMirrors(root);
    expect(result).toEqual([]);
  });

  it("discovers a single bare mirror", async () => {
    const root = await makeTmpRoot();
    await makeBareMirror(root, "myrepo");
    const result = await scanMirrors(root);
    expect(result).toContain("myrepo");
  });

  it("discovers multiple bare mirrors", async () => {
    const root = await makeTmpRoot();
    await makeBareMirror(root, "repo-a");
    await makeBareMirror(root, "repo-b");
    const result = await scanMirrors(root);
    expect(result.sort()).toEqual(["repo-a", "repo-b"]);
  });

  it("ignores .meta.json files and non-.git directories", async () => {
    const root = await makeTmpRoot();
    await makeBareMirror(root, "myrepo");
    // Create a non-.git directory and a .meta.json file.
    await fs.mkdir(path.join(root, "repos", "not-a-repo"), { recursive: true });
    await fs.writeFile(path.join(root, "repos", "myrepo.meta.json"), "{}");
    const result = await scanMirrors(root);
    expect(result).toEqual(["myrepo"]);
  });

  it("strips the .git suffix from discovered names", async () => {
    const root = await makeTmpRoot();
    await makeBareMirror(root, "some-project");
    const result = await scanMirrors(root);
    expect(result[0]).toBe("some-project");
    expect(result[0]).not.toContain(".git");
  });
});

// ---------- RepoMeta persistence ----------

describe("saveRepoMeta() / loadRepoMeta()", () => {
  it("loadRepoMeta() returns null for unknown repo", async () => {
    const root = await makeTmpRoot();
    const meta = await loadRepoMeta(root, "nonexistent");
    expect(meta).toBeNull();
  });

  it("saves and reloads introduced_by and introduced_at", async () => {
    const root = await makeTmpRoot();
    const meta: RepoMeta = {
      introduced_by: "alice",
      introduced_at: "2025-01-01T00:00:00.000Z",
    };
    await saveRepoMeta(root, "myrepo", meta);
    const loaded = await loadRepoMeta(root, "myrepo");
    expect(loaded).toEqual(meta);
  });

  it("overwrites existing meta on second save", async () => {
    const root = await makeTmpRoot();
    await saveRepoMeta(root, "myrepo", {
      introduced_by: "alice",
      introduced_at: "2025-01-01T00:00:00.000Z",
    });
    await saveRepoMeta(root, "myrepo", {
      introduced_by: "bob",
      introduced_at: "2025-06-01T00:00:00.000Z",
    });
    const loaded = await loadRepoMeta(root, "myrepo");
    expect(loaded?.introduced_by).toBe("bob");
  });

  it("stores meta independently per repo name", async () => {
    const root = await makeTmpRoot();
    await saveRepoMeta(root, "repo-a", { introduced_by: "alice", introduced_at: "2025-01-01T00:00:00.000Z" });
    await saveRepoMeta(root, "repo-b", { introduced_by: "bob", introduced_at: "2025-02-01T00:00:00.000Z" });
    const a = await loadRepoMeta(root, "repo-a");
    const b = await loadRepoMeta(root, "repo-b");
    expect(a?.introduced_by).toBe("alice");
    expect(b?.introduced_by).toBe("bob");
  });
});
