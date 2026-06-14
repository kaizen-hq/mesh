#!/usr/bin/env bun
// Cut a new mesh release with semantic versioning.
//
// Bump types (your convention):
//   breaking  →  MAJOR bump  (incompatible change)
//   fix       →  MINOR bump  (bug fix)
//   build     →  PATCH bump  (regular build, default)
//
// Usage:
//   bun run release              # auto-detect from commits since last tag
//   bun run release breaking     # force a major bump
//   bun run release fix          # force a minor bump
//   bun run release build        # force a patch bump
//   bun run release --dry-run    # print what would happen, change nothing
//   bun run release --force      # allow a dirty working tree
//
// Conventional commit prefixes used for auto-detection:
//   BREAKING CHANGE or ! suffix  →  breaking
//   fix:                         →  fix
//   anything else                →  build
//
// Steps (in order):
//   1. detect or confirm bump type from commits
//   2. bump package.json version
//   3. git add + commit "release vX.Y.Z"
//   4. git tag vX.Y.Z
//   5. bun run build      (compile the binary)
//   6. bun run package    (build mesh-src.zip)

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { meshRoot } from "../src/package_source.ts";

type BumpType = "breaking" | "fix" | "build";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const positional = args.filter((a) => !a.startsWith("--"));
const explicitBump = positional[0] as BumpType | undefined;

if (explicitBump && !["breaking", "fix", "build"].includes(explicitBump)) {
  console.error(`unknown bump type: ${explicitBump}`);
  console.error("want: breaking | fix | build");
  process.exit(1);
}

const root = meshRoot();
const pkgPath = path.join(root, "package.json");

if (!force && !dryRun) await assertCleanTree(root);

const pkgRaw = await fs.readFile(pkgPath, "utf8");
const pkg = JSON.parse(pkgRaw) as { version: string; [k: string]: unknown };
const oldVersion = pkg.version;

// ---------- determine bump type ----------

const lastTag = await lastReleaseTag(root);
const bump: BumpType = explicitBump ?? await detectBump(root, lastTag);

const bumpReason = explicitBump ? "forced" : `detected from commits since ${lastTag ?? "beginning"}`;
console.log(`bump type: ${bump}  (${bumpReason})`);

if (!explicitBump && lastTag) {
  const commits = await commitsSince(root, lastTag);
  if (commits.length > 0) {
    console.log(`\ncommits since ${lastTag}:`);
    for (const c of commits) console.log(`  ${c}`);
    console.log();
  }
}

// ---------- compute new version ----------

const newVersion = bumpVersion(oldVersion, bump);
const tag = `v${newVersion}`;

console.log(`version: ${oldVersion}  →  ${newVersion}  (tag: ${tag})`);

if (dryRun) {
  console.log("\n--dry-run: no changes made.");
  process.exit(0);
}

await assertTagFree(root, tag);

// ---------- write, commit, tag ----------

pkg.version = newVersion;
const nextRaw = JSON.stringify(pkg, null, 2) + (pkgRaw.endsWith("\n") ? "\n" : "");
await fs.writeFile(pkgPath, nextRaw, "utf8");

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

// ---------- bump logic ----------

function bumpVersion(v: string, kind: BumpType): string {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) throw new Error(`unparseable version: ${v}`);
  let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === "breaking") {
    maj += 1; min = 0; pat = 0;
  } else if (kind === "fix") {
    min += 1; pat = 0;
  } else {
    pat += 1;
  }
  return `${maj}.${min}.${pat}`;
}

// ---------- conventional commit detection ----------

async function detectBump(cwd: string, since: string | null): Promise<BumpType> {
  const commits = await commitsSince(cwd, since);
  if (commits.length === 0) return "build";

  let bump: BumpType = "build";
  for (const line of commits) {
    const msg = line.replace(/^[0-9a-f]+ /, "").trim();
    if (isBreaking(msg)) return "breaking"; // can't go higher, short-circuit
    if (isFix(msg) && bump !== "breaking") bump = "fix";
  }
  return bump;
}

function isBreaking(msg: string): boolean {
  // "feat!: ...", "fix!: ...", "BREAKING CHANGE: ..." or "BREAKING-CHANGE: ..."
  return /^[a-z]+(\([^)]+\))?!:/.test(msg) || /^BREAKING[- ]CHANGE/i.test(msg);
}

function isFix(msg: string): boolean {
  return /^fix(\([^)]+\))?:/.test(msg);
}

// ---------- git helpers ----------

async function commitsSince(cwd: string, since: string | null): Promise<string[]> {
  const range = since ? `${since}..HEAD` : "HEAD";
  const proc = Bun.spawn(["git", "log", "--oneline", range], {
    cwd, stdout: "pipe", stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out ? out.split("\n") : [];
}

async function lastReleaseTag(cwd: string): Promise<string | null> {
  const proc = Bun.spawn(
    ["git", "describe", "--tags", "--abbrev=0", "--match=v*"],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  const exit = await proc.exited;
  return exit === 0 && out ? out : null;
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
