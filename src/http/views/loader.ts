// Loads all HTML templates from disk at daemon startup.
// import.meta.dir resolves relative to this source file, so paths
// are correct regardless of where the process is launched from.

import * as fs from "node:fs/promises";
import * as path from "node:path";

const DIR = import.meta.dir;

export interface Views {
  css: string;
  status: string;
  issues: string;
  ciPipelines: string;
  ciRunDetail: string;
}

export async function loadViews(): Promise<Views> {
  const [css, status, issues, ciPipelines, ciRunDetail] = await Promise.all([
    fs.readFile(path.join(DIR, "shared.css"), "utf8"),
    fs.readFile(path.join(DIR, "status.html"), "utf8"),
    fs.readFile(path.join(DIR, "issues.html"), "utf8"),
    fs.readFile(path.join(DIR, "ci_pipelines.html"), "utf8"),
    fs.readFile(path.join(DIR, "ci_run_detail.html"), "utf8"),
  ]);
  return { css, status, issues, ciPipelines, ciRunDetail };
}
