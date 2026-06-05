#!/usr/bin/env bun
// Cut a new mesh release.
//
// Usage:
//   bun run release           # patch bump (default)
//   bun run release minor
//   bun run release major
//   bun run release --force   # allow a dirty working tree
//
// Steps (in order):
//   1. bump package.json version
//   2. git add + commit "release vX.Y.Z"
//   3. git tag vX.Y.Z
//   4. bun run build      (compile the binary)
//   5. bun run package    (build mesh-src.zip)

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { meshRoot } from "../src/package_source.ts";

type Bump = "major" | "minor" | "patch";

const args = process.argv.slice(2);
const force = args.includes("--force");
const positional = args.filter((a) => !a.startsWith("--"));
const bump: Bump = (positional[0] as Bump) || "patch";
if (!["major", "minor", "patch"].includes(bump)) {
  console.error(`unknown bump: ${bump}; want major|minor|patch`);
  process.exit(1);
}

const root = meshRoot();
const pkgPath = path.join(root, "package.json");

if (!force) await assertCleanTree(root);

const pkgRaw = await fs.readFile(pkgPath, "utf8");
const pkg = JSON.parse(pkgRaw) as { version: string; [k: string]: unknown };
const oldVersion = pkg.version;
const newVersion = bumpVersion(oldVersion, bump);
const tag = `v${newVersion}`;

await assertTagFree(root, tag);

pkg.version = newVersion;
const nextRaw = JSON.stringify(pkg, null, 2) + (pkgRaw.endsWith("\n") ? "\n" : "");
await fs.writeFile(pkgPath, nextRaw, "utf8");
console.log(`bumped ${oldVersion} -> ${newVersion}`);

await git(root, ["add", "package.json"]);
await git(root, ["commit", "-m", `release ${tag}`]);
await git(root, ["tag", tag]);
console.log(`committed and tagged ${tag}`);

await bun(root, ["run", "build"]);
console.log("built binary");

await bun(root, ["run", "package"]);
console.log("built source zip");

console.log(`\nrelease ${tag} ready. Push when you're satisfied:`);
console.log(`  git push && git push --tags`);

// ---------- helpers ----------

function bumpVersion(v: string, kind: Bump): string {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) throw new Error(`unparseable version: ${v}`);
  let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === "major") {
    maj += 1; min = 0; pat = 0;
  } else if (kind === "minor") {
    min += 1; pat = 0;
  } else {
    pat += 1;
  }
  return `${maj}.${min}.${pat}`;
}

async function assertCleanTree(cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", "status", "--porcelain"], {
    cwd, stdout: "pipe", stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (out.length > 0) {
    console.error("working tree is dirty:");
    console.error(out);
    console.error("commit or stash first, or pass --force");
    process.exit(1);
  }
}

async function assertTagFree(cwd: string, tag: string): Promise<void> {
  const proc = Bun.spawn(["git", "rev-parse", "--verify", `refs/tags/${tag}`], {
    cwd, stdout: "ignore", stderr: "ignore",
  });
  const exit = await proc.exited;
  if (exit === 0) {
    console.error(`tag ${tag} already exists`);
    process.exit(1);
  }
}

async function git(cwd: string, argv: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...argv], { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`git ${argv.join(" ")} failed`);
}

async function bun(cwd: string, argv: string[]): Promise<void> {
  const proc = Bun.spawn(["bun", ...argv], { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`bun ${argv.join(" ")} failed`);
}
