// `mesh add-repos <parent-dir>` — walk a directory tree for git working
// copies, append each as a `[[repos]]` entry to mesh.toml. Stops descending
// once a `.git/` directory is found.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as toml from "./toml.ts";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

interface Discovered {
  name: string;
  path: string; // path stored in mesh.toml (relative to $HOME, or absolute)
  absPath: string;
}

export async function runAddRepos(root: string, parentDir: string): Promise<void> {
  const absParent = path.resolve(parentDir);
  const stat = await fs.stat(absParent).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`not a directory: ${absParent}`);
  }

  const cfgPath = path.join(root, "mesh.toml");
  const raw = await fs.readFile(cfgPath, "utf8");
  const doc = toml.parse(raw) as Record<string, unknown>;
  const existing = ((doc["repos"] as unknown[]) ?? []).map((r) => {
    const o = r as Record<string, unknown>;
    return { name: String(o.name), path: String(o.path) };
  });
  const home = os.homedir();
  const existingNames = new Set(existing.map((r) => r.name));
  const existingPathsCanonical = new Set(
    await Promise.all(
      existing.map((r) =>
        canonicalize(path.isAbsolute(r.path) ? r.path : path.resolve(home, r.path)),
      ),
    ),
  );

  const found: Discovered[] = [];
  await walk(absParent, found);

  const toAdd: Discovered[] = [];
  const skipped: string[] = [];
  for (const r of found) {
    const canonAbs = await canonicalize(r.absPath);
    const rel = path.relative(home, canonAbs);
    const storedPath = rel.startsWith("..") || path.isAbsolute(rel) ? canonAbs : rel;
    const entry: Discovered = { name: r.name, path: storedPath, absPath: canonAbs };
    if (existingNames.has(entry.name)) {
      skipped.push(`${entry.name} (name already in mesh.toml)`);
      continue;
    }
    if (existingPathsCanonical.has(entry.absPath)) {
      skipped.push(`${entry.name} (path already in mesh.toml)`);
      continue;
    }
    toAdd.push(entry);
  }

  if (toAdd.length === 0) {
    console.log(`no new repos found under ${absParent}`);
    for (const s of skipped) console.log(`  skipped: ${s}`);
    return;
  }

  console.log(`adding ${toAdd.length} repo(s) to ${cfgPath}:`);
  for (const r of toAdd) {
    console.log(`  ${r.name}  (${r.path})`);
  }
  for (const s of skipped) console.log(`  skipped: ${s}`);

  const reposOut = [
    ...existing,
    ...toAdd.map((r) => ({ name: r.name, path: r.path, branches: [] as string[] })),
  ];
  doc["repos"] = reposOut;
  const next = toml.stringify(doc);
  const tmp = `${cfgPath}.tmp`;
  await fs.writeFile(tmp, next, "utf8");
  await fs.rename(tmp, cfgPath);

  console.log(`wrote ${cfgPath}; run 'mesh reload' to pick up the changes`);
}

async function walk(dir: string, out: Discovered[]): Promise<void> {
  // If `dir` itself is a working copy, record it and stop.
  if (await isWorkingCopy(dir)) {
    out.push({ name: path.basename(dir), path: dir, absPath: dir });
    return;
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    await walk(path.join(dir, e.name), out);
  }
}

async function isWorkingCopy(dir: string): Promise<boolean> {
  try {
    const s = await fs.stat(path.join(dir, ".git"));
    return s.isDirectory() || s.isFile(); // .git can be a file for worktrees
  } catch {
    return false;
  }
}

// Resolve symlinks and normalize `.`/`..` so dedup detects different spellings
// of the same path. Falls back to lexical resolve if the path doesn't exist.
async function canonicalize(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}
