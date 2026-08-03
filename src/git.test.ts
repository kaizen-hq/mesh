import { describe, it, expect, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { $ } from "bun";
import { ensureValidHead, readableHeadRef } from "./git.ts";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

// Reproduces how mesh actually populates mirrors in production: `git init
// --bare` (HEAD defaults to whatever this host's git considers the default
// branch — not necessarily "main"), then a branch is written directly via
// update-ref rather than a normal push/fetch that would repoint HEAD.
async function makeDanglingHeadMirror(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-git-test-"));
  tmpDirs.push(dir);
  await $`git -C ${dir} init --bare --initial-branch=does-not-exist`.quiet();

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-git-test-work-"));
  tmpDirs.push(workDir);
  await $`git clone ${dir} ${workDir}`.quiet();
  await $`git -C ${workDir} config user.email ci@test`.quiet();
  await $`git -C ${workDir} config user.name CI`.quiet();
  await $`git -C ${workDir} commit --allow-empty -m init`.quiet();
  await $`git -C ${workDir} push origin HEAD:refs/heads/main`.quiet();
  return dir;
}

describe("ensureValidHead", () => {
  it("repoints a dangling HEAD at the main branch", async () => {
    const dir = await makeDanglingHeadMirror();
    expect((await $`git -C ${dir} rev-parse --verify --quiet HEAD`.quiet().nothrow()).exitCode).not.toBe(0);

    await ensureValidHead(dir);

    const symref = (await $`git -C ${dir} symbolic-ref HEAD`.quiet()).stdout.toString().trim();
    expect(symref).toBe("refs/heads/main");
    expect((await $`git -C ${dir} rev-parse --verify --quiet HEAD`.quiet()).exitCode).toBe(0);
  });

  it("leaves an already-valid HEAD alone", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-git-test-"));
    tmpDirs.push(dir);
    await $`git -C ${dir} init --bare --initial-branch=main`.quiet();
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-git-test-work-"));
    tmpDirs.push(workDir);
    await $`git clone ${dir} ${workDir}`.quiet();
    await $`git -C ${workDir} config user.email ci@test`.quiet();
    await $`git -C ${workDir} config user.name CI`.quiet();
    await $`git -C ${workDir} commit --allow-empty -m init`.quiet();
    await $`git -C ${workDir} push origin HEAD:refs/heads/main`.quiet();

    await ensureValidHead(dir);

    const symref = (await $`git -C ${dir} symbolic-ref HEAD`.quiet()).stdout.toString().trim();
    expect(symref).toBe("refs/heads/main");
  });

  it("does nothing to a mirror with no branches yet", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-git-test-"));
    tmpDirs.push(dir);
    await $`git -C ${dir} init --bare`.quiet();
    await expect(ensureValidHead(dir)).resolves.toBeUndefined();
  });
});

describe("readableHeadRef", () => {
  it("falls back to the default branch without mutating the mirror", async () => {
    const dir = await makeDanglingHeadMirror();

    const ref = await readableHeadRef(dir);
    expect(ref).toBe("refs/heads/main");

    // Read-only: HEAD itself should still be dangling afterwards.
    expect((await $`git -C ${dir} symbolic-ref HEAD`.quiet()).stdout.toString().trim())
      .toBe("refs/heads/does-not-exist");
  });

  it("returns HEAD directly when it already resolves", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-git-test-"));
    tmpDirs.push(dir);
    await $`git -C ${dir} init --bare --initial-branch=main`.quiet();
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-git-test-work-"));
    tmpDirs.push(workDir);
    await $`git clone ${dir} ${workDir}`.quiet();
    await $`git -C ${workDir} config user.email ci@test`.quiet();
    await $`git -C ${workDir} config user.name CI`.quiet();
    await $`git -C ${workDir} commit --allow-empty -m init`.quiet();
    await $`git -C ${workDir} push origin HEAD:refs/heads/main`.quiet();

    expect(await readableHeadRef(dir)).toBe("HEAD");
  });

  it("returns null for an empty mirror", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-git-test-"));
    tmpDirs.push(dir);
    await $`git -C ${dir} init --bare`.quiet();
    expect(await readableHeadRef(dir)).toBeNull();
  });
});
