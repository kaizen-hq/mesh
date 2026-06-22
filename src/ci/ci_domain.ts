// CiDomain: owns in-memory CI state — runs, log buffers, cron claims,
// secrets, and node capabilities. All three maps are mutated by callers
// through method wrappers so the internal structure stays behind a boundary.

import type {
  CiState,
  PipelineRun,
  LogBuffer,
  CronClaim,
  NodeCapabilities,
} from "./types.ts";
import { emptyCiState } from "./types.ts";

export class CiDomain {
  private state: CiState = emptyCiState();
  secrets: Record<string, string> = {};
  capabilities: NodeCapabilities | null = null;

  // ---------- runs ----------

  getRun(id: string): PipelineRun | undefined {
    return this.state.runs.get(id);
  }

  setRun(run: PipelineRun): void {
    this.state.runs.set(run.run_id, run);
  }

  allRuns(): PipelineRun[] {
    return [...this.state.runs.values()];
  }

  // ---------- log buffers ----------

  getLogBuffer(runId: string): LogBuffer | undefined {
    return this.state.log_buffers.get(runId);
  }

  setLogBuffer(buf: LogBuffer): void {
    this.state.log_buffers.set(buf.run_id, buf);
  }

  deleteLogBuffer(runId: string): void {
    this.state.log_buffers.delete(runId);
  }

  // ---------- cron claims ----------

  getCronClaim(slot: string): CronClaim | undefined {
    return this.state.cron_claims.get(slot);
  }

  // ---------- capabilities ----------

  /** Update mutable capability fields after a config reload. */
  updateCapabilities(labels: string[], runner: boolean, tools: string[]): void {
    if (!this.capabilities) return;
    this.capabilities.labels = labels;
    this.capabilities.runner = runner;
    this.capabilities.tools = tools;
  }

  // ---------- compatibility ----------

  /** Returns the raw CiState for callers that take it directly (e.g. checkCronSlots). */
  asCiState(): CiState {
    return this.state;
  }
}
