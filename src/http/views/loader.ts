// Static imports so Bun embeds these files into the compiled binary.
// fs.readFile against import.meta.dir doesn't work inside a Bun single-file
// executable because /$bunfs/root/ is a virtual FS, not a real path.

import css from "./shared.css" with { type: "text" };
import status from "./status.html" with { type: "text" };
import issues from "./issues.html" with { type: "text" };
import ciPipelines from "./ci_pipelines.html" with { type: "text" };
import ciRunDetail from "./ci_run_detail.html" with { type: "text" };

export interface Views {
  css: string;
  status: string;
  issues: string;
  ciPipelines: string;
  ciRunDetail: string;
}

export async function loadViews(): Promise<Views> {
  return { css, status, issues, ciPipelines, ciRunDetail };
}
