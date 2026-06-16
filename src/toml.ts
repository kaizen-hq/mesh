// Thin TOML shim: parse delegates to Bun.TOML; stringify is a minimal
// implementation covering the data shapes used by mesh (flat scalars,
// [table], [[array-of-tables]], and inline arrays of scalars).

import { TOML } from "bun";

export function parse(str: string): unknown {
  return TOML.parse(str);
}

export function stringify(doc: Record<string, unknown>): string {
  const lines: string[] = [];

  // ── pass 1: top-level scalars and inline arrays (must precede any header) ──
  for (const [key, val] of Object.entries(doc)) {
    if (val === null || val === undefined) continue;
    if (isTableObject(val)) continue; // deferred
    if (Array.isArray(val) && val.length > 0 && isTableObject(val[0])) continue; // deferred
    lines.push(`${tomlKey(key)} = ${tomlValue(val)}`);
  }

  // ── pass 2: [table] sections ──
  for (const [key, val] of Object.entries(doc)) {
    if (!isTableObject(val)) continue;
    if (lines.length > 0) lines.push("");
    lines.push(`[${tomlKey(key)}]`);
    emitKV(val as Record<string, unknown>, lines);
  }

  // ── pass 3: [[array-of-tables]] sections ──
  for (const [key, val] of Object.entries(doc)) {
    if (!Array.isArray(val) || val.length === 0) continue;
    if (!isTableObject(val[0])) continue;
    for (const item of val as Record<string, unknown>[]) {
      if (lines.length > 0) lines.push("");
      lines.push(`[[${tomlKey(key)}]]`);
      emitKV(item, lines);
    }
  }

  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

// ---------------------------------------------------------------------------

function emitKV(obj: Record<string, unknown>, out: string[]): void {
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    out.push(`${tomlKey(k)} = ${tomlValue(v)}`);
  }
}

function isTableObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tomlKey(key: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(key) ? key : `"${escStr(key)}"`;
}

function tomlValue(val: unknown): string {
  if (typeof val === "string") return `"${escStr(val)}"`;
  if (typeof val === "number") return String(val);
  if (typeof val === "boolean") return val ? "true" : "false";
  if (Array.isArray(val)) return `[${val.map(tomlValue).join(", ")}]`;
  throw new Error(`toml.stringify: unsupported type: ${typeof val}`);
}

function escStr(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}
