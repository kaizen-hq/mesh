#!/usr/bin/env bun
// Build a deliverable zip of the mesh source tree.
//
// Usage:
//   bun scripts/package.ts                  → writes mesh-src.zip to repo root
//   bun scripts/package.ts dist/foo.zip     → custom output path
//
// Excludes node_modules, the compiled binary, bun lockfiles, and .git.

import * as path from "node:path";
import { buildZip, meshRoot, SOURCE_FILES, EXCLUDED } from "../src/package_source.ts";

const args = process.argv.slice(2);
const out = args[0] ?? path.join(meshRoot(), "mesh-src.zip");

const written = await buildZip(out);
const stat = await Bun.file(written).size;
console.log(`wrote ${written} (${formatBytes(stat)})`);
console.log("included:");
for (const f of SOURCE_FILES) console.log(`  ${f}`);
console.log("excluded:");
for (const e of EXCLUDED) console.log(`  ${e}`);

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
