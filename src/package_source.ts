// Build a zip of the mesh source tree for delivery to teammates who want to
// run from source (instead of the compiled binary). Shells out to the system
// `zip` because it's universally available on macOS / Linux and avoids
// pulling in a JS zip library.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

/** Files / directories included in the source zip. Paths are relative to
 *  the mesh root (the directory above this file's `src/`). */
export const SOURCE_FILES = [
  "src",
  "package.json",
  "tsconfig.json",
  "README.md",
  ".gitignore",
];

/** Patterns excluded from the zip when used with `zip -x`. */
export const EXCLUDED = [
  "node_modules/*",
  "bun.lock",
  "bun.lockb",
  "mesh",
  ".git/*",
  "**/.DS_Store",
];

/** Locate the mesh root (parent of `src/`). */
export function meshRoot(): string {
  // import.meta.dir is the directory of THIS file (src/), so root is one up.
  return path.dirname(import.meta.dir);
}

/** True when running from a `bun build --compile` binary. In that case the
 *  source tree lives in Bun's virtual FS (/$bunfs/...) and is invisible to
 *  external tools like the `zip` shell command. */
export function isCompiledBinary(): boolean {
  return import.meta.dir.startsWith("/$bunfs");
}

/** Build a zip on disk at `outPath`. Returns the absolute output path. */
export async function buildZip(outPath: string): Promise<string> {
  const root = meshRoot();
  const abs = path.resolve(outPath);

  // Make sure the target doesn't exist (zip appends otherwise).
  try {
    await fs.unlink(abs);
  } catch {
    // missing is fine
  }

  // Verify the files we plan to include actually exist; warn but don't fail
  // if optional ones (like .gitignore) are missing.
  const present: string[] = [];
  for (const f of SOURCE_FILES) {
    try {
      await fs.stat(path.join(root, f));
      present.push(f);
    } catch {
      // skip missing
    }
  }
  if (present.length === 0) {
    throw new Error(`no source files found under ${root}`);
  }

  const args = ["-rq", abs, ...present, "-x", ...EXCLUDED];
  const proc = Bun.spawn(["zip", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`zip failed (exit ${exit}): ${err.trim()}`);
  }
  return abs;
}

/** Build a zip in a tmp file, read it into memory, then delete the tmp.
 *  Use this when you want to hand out the bytes (e.g. from an HTTP handler). */
export async function buildZipBytes(): Promise<Uint8Array> {
  const tmpDir = os.tmpdir();
  const out = path.join(tmpDir, `mesh-src-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  try {
    await buildZip(out);
    const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
    return bytes;
  } finally {
    try {
      await fs.unlink(out);
    } catch {
      // best effort
    }
  }
}
