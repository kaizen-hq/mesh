// Subprocess wrappers for git. Mirrors src/git.rs in the Rust mesh:
// shells out to git-upload-pack / git-receive-pack with --stateless-rpc, and
// wraps the smart-HTTP pkt-line framing ourselves (cleaner than git http-backend).

import * as path from "node:path";
import * as fs from "node:fs/promises";

export const CT_UPLOAD_PACK_ADV = "application/x-git-upload-pack-advertisement";
export const CT_UPLOAD_PACK_RESULT = "application/x-git-upload-pack-result";
export const CT_RECEIVE_PACK_ADV = "application/x-git-receive-pack-advertisement";
export const CT_RECEIVE_PACK_RESULT = "application/x-git-receive-pack-result";

export type GitService = "git-upload-pack" | "git-receive-pack";

export function advertisementContentType(svc: GitService): string {
  return svc === "git-upload-pack" ? CT_UPLOAD_PACK_ADV : CT_RECEIVE_PACK_ADV;
}

export function resultContentType(svc: GitService): string {
  return svc === "git-upload-pack" ? CT_UPLOAD_PACK_RESULT : CT_RECEIVE_PACK_RESULT;
}

function pktlinePrefix(svc: GitService): Uint8Array {
  const line = `# service=${svc}\n`;
  const lenHex = (line.length + 4).toString(16).padStart(4, "0");
  return new TextEncoder().encode(`${lenHex}${line}0000`);
}

/** Run `<svc> --stateless-rpc --advertise-refs <dir>` and return the smart-HTTP
 * advertisement body with the pkt-line prefix. */
export async function serveInfoRefs(dir: string, svc: GitService): Promise<Uint8Array> {
  const proc = Bun.spawn([svc, "--stateless-rpc", "--advertise-refs", dir], {
    stdin: null,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).arrayBuffer();
  const status = await proc.exited;
  if (status !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${svc} --advertise-refs failed (${status}): ${err}`);
  }
  const prefix = pktlinePrefix(svc);
  const buf = new Uint8Array(prefix.length + out.byteLength);
  buf.set(prefix, 0);
  buf.set(new Uint8Array(out), prefix.length);
  return buf;
}

/** Run `<svc> --stateless-rpc <dir>` with `body` on stdin; return stdout. */
export async function servePack(
  dir: string,
  svc: GitService,
  body: Uint8Array,
): Promise<Uint8Array> {
  const proc = Bun.spawn([svc, "--stateless-rpc", dir], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Write the request body, then close stdin so git-upload-pack returns.
  const writer = (async () => {
    const w = (proc.stdin as ReturnType<typeof Bun.spawn>["stdin"]) as unknown as WritableStreamDefaultWriter<Uint8Array> | { write: (b: Uint8Array) => Promise<unknown>; end: () => Promise<unknown> | void };
    // proc.stdin is a FileSink in Bun.
    const sink = proc.stdin as unknown as { write: (b: Uint8Array) => void | Promise<void>; end: () => Promise<void> | void; flush?: () => Promise<void> | void };
    await sink.write(body);
    await Promise.resolve(sink.flush?.());
    await Promise.resolve(sink.end());
    return null;
    void w;
  })();
  const out = await new Response(proc.stdout).arrayBuffer();
  await writer;
  const status = await proc.exited;
  if (status !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${svc} failed (${status}): ${err}`);
  }
  return new Uint8Array(out);
}

// ---------- repo / ref helpers ----------

export async function initBare(dir: string): Promise<void> {
  try {
    const stat = await fs.stat(path.join(dir, "HEAD"));
    if (stat.isFile()) return;
  } catch {
    // missing, proceed
  }
  await fs.mkdir(dir, { recursive: true });
  const exit = await Bun.spawn(["git", "init", "--bare", dir], {
    stdout: "pipe",
    stderr: "pipe",
  }).exited;
  if (exit !== 0) throw new Error(`git init --bare ${dir} failed`);
}

export async function fetchIntoBare(dir: string, src: string): Promise<void> {
  // Forceful refspecs (`+` prefix) so mirror branches and tags can move when
  // peers push amendments or re-tag. Without force, tag drift between peers
  // wedges the fetch loop with "would clobber existing tag" errors.
  const proc = Bun.spawn(
    [
      "git",
      "fetch",
      "--prune",
      src,
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*",
    ],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new Error(
      `git fetch from ${src} into ${dir} failed (exit ${exit})${err ? `: ${err}` : ""}`,
    );
  }
}

export async function headSha(dir: string): Promise<string | null> {
  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const status = await proc.exited;
  if (status !== 0) return null;
  const s = out.trim();
  return s.length ? s : null;
}

export async function listRefs(dir: string, prefix: string): Promise<Array<[string, string]>> {
  const proc = Bun.spawn(
    [
      "git",
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      prefix,
    ],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const status = await proc.exited;
  if (status !== 0) return [];
  const result: Array<[string, string]> = [];
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const full = parts[0]!;
    const sha = parts[1]!;
    const short = full.startsWith(prefix) ? full.slice(prefix.length) : full;
    result.push([short, sha]);
  }
  return result;
}

export async function branchHeads(dir: string): Promise<Array<[string, string]>> {
  return listRefs(dir, "refs/heads/");
}

export async function refSha(dir: string, refName: string): Promise<string | null> {
  const proc = Bun.spawn(
    ["git", "rev-parse", "--verify", "--quiet", refName],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const status = await proc.exited;
  if (status !== 0) return null;
  const s = out.trim();
  return s.length ? s : null;
}

export async function updateRef(dir: string, refName: string, sha: string): Promise<void> {
  const exit = await Bun.spawn(["git", "update-ref", refName, sha], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  }).exited;
  if (exit !== 0) throw new Error(`git update-ref ${refName} ${sha} failed`);
}

export async function deleteRef(dir: string, refName: string): Promise<void> {
  // Best-effort; missing-ref deletes return non-zero, which we swallow.
  await Bun.spawn(["git", "update-ref", "-d", refName], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  }).exited;
}

export async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
  const exit = await Bun.spawn(
    ["git", "merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  ).exited;
  return exit === 0;
}
