import { describe, it, expect } from "bun:test";
import { CiDomain } from "./ci_domain.ts";
import type { PipelineRun, LogBuffer, NodeCapabilities } from "./types.ts";

// ---------- fixtures ----------

function makeRun(id: string, repo = "myrepo", status: PipelineRun["status"] = "running"): PipelineRun {
  return {
    run_id: id,
    repo,
    ref: "refs/heads/main",
    sha: "abc1234",
    triggered_by: { type: "push", pusher: "alice" },
    runner: "alice",
    status,
    started_at: new Date().toISOString(),
    jobs: {},
  };
}

function makeLogBuffer(runId: string): LogBuffer {
  return {
    run_id: runId,
    chunks: [],
    next_seq: 0,
  };
}

function makeCapabilities(overrides: Partial<NodeCapabilities> = {}): NodeCapabilities {
  return {
    os: "linux",
    arch: "x64",
    labels: ["docker"],
    tools: ["bun"],
    runner: true,
    load: { jobs_running: 0, cpu_percent: 10, mem_free_mb: 4096 },
    ...overrides,
  };
}

// ---------- runs ----------

describe("CiDomain runs", () => {
  it("getRun() returns undefined for unknown id", () => {
    expect(new CiDomain().getRun("unknown")).toBeUndefined();
  });

  it("setRun() stores a run retrievable by getRun()", () => {
    const ci = new CiDomain();
    const run = makeRun("run-1");
    ci.setRun(run);
    expect(ci.getRun("run-1")).toBe(run);
  });

  it("setRun() uses run.run_id as the key", () => {
    const ci = new CiDomain();
    ci.setRun(makeRun("run-abc"));
    expect(ci.getRun("run-abc")).toBeDefined();
  });

  it("setRun() overwrites an existing run with the same id", () => {
    const ci = new CiDomain();
    ci.setRun(makeRun("run-1", "repo-a", "running"));
    ci.setRun(makeRun("run-1", "repo-a", "passed"));
    expect(ci.getRun("run-1")!.status).toBe("passed");
  });

  it("allRuns() returns empty array initially", () => {
    expect(new CiDomain().allRuns()).toEqual([]);
  });

  it("allRuns() returns all stored runs", () => {
    const ci = new CiDomain();
    ci.setRun(makeRun("run-1"));
    ci.setRun(makeRun("run-2"));
    const ids = ci.allRuns().map((r) => r.run_id).sort();
    expect(ids).toEqual(["run-1", "run-2"]);
  });

  it("allRuns() can be filtered by repo", () => {
    const ci = new CiDomain();
    ci.setRun(makeRun("run-1", "repo-a"));
    ci.setRun(makeRun("run-2", "repo-b"));
    const filtered = ci.allRuns().filter((r) => r.repo === "repo-a");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.run_id).toBe("run-1");
  });

  it("allRuns() can be filtered by status", () => {
    const ci = new CiDomain();
    ci.setRun(makeRun("run-1", "repo", "running"));
    ci.setRun(makeRun("run-2", "repo", "passed"));
    ci.setRun(makeRun("run-3", "repo", "running"));
    const running = ci.allRuns().filter((r) => r.status === "running");
    expect(running).toHaveLength(2);
  });

  it("mutations on a returned run are visible on next getRun()", () => {
    const ci = new CiDomain();
    ci.setRun(makeRun("run-1"));
    ci.getRun("run-1")!.status = "passed";
    expect(ci.getRun("run-1")!.status).toBe("passed");
  });
});

// ---------- log buffers ----------

describe("CiDomain log buffers", () => {
  it("getLogBuffer() returns undefined for unknown id", () => {
    expect(new CiDomain().getLogBuffer("unknown")).toBeUndefined();
  });

  it("setLogBuffer() stores a buffer retrievable by getLogBuffer()", () => {
    const ci = new CiDomain();
    const buf = makeLogBuffer("run-1");
    ci.setLogBuffer(buf);
    expect(ci.getLogBuffer("run-1")).toBe(buf);
  });

  it("setLogBuffer() uses buf.run_id as the key", () => {
    const ci = new CiDomain();
    ci.setLogBuffer(makeLogBuffer("run-xyz"));
    expect(ci.getLogBuffer("run-xyz")).toBeDefined();
  });

  it("deleteLogBuffer() removes a buffer", () => {
    const ci = new CiDomain();
    ci.setLogBuffer(makeLogBuffer("run-1"));
    ci.deleteLogBuffer("run-1");
    expect(ci.getLogBuffer("run-1")).toBeUndefined();
  });

  it("deleteLogBuffer() is a no-op for unknown id", () => {
    const ci = new CiDomain();
    expect(() => ci.deleteLogBuffer("unknown")).not.toThrow();
  });

  it("mutations on a returned buffer are visible on next getLogBuffer()", () => {
    const ci = new CiDomain();
    ci.setLogBuffer(makeLogBuffer("run-1"));
    ci.getLogBuffer("run-1")!.next_seq = 5;
    expect(ci.getLogBuffer("run-1")!.next_seq).toBe(5);
  });
});

// ---------- cron claims ----------

describe("CiDomain cron claims", () => {
  it("getCronClaim() returns undefined for unknown slot", () => {
    expect(new CiDomain().getCronClaim("slot-1")).toBeUndefined();
  });

  it("getCronClaim() returns a claim inserted via asCiState()", () => {
    const ci = new CiDomain();
    const claim = {
      repo: "myrepo",
      job: "build",
      slot: "slot-1",
      claims: [],
      window_closes_at: Date.now() + 60_000,
      started: false,
    };
    ci.asCiState().cron_claims.set("slot-1", claim);
    expect(ci.getCronClaim("slot-1")).toBe(claim);
  });
});

// ---------- secrets ----------

describe("CiDomain secrets", () => {
  it("secrets is empty by default", () => {
    expect(new CiDomain().secrets).toEqual({});
  });

  it("secrets can be set and read back", () => {
    const ci = new CiDomain();
    ci.secrets = { TOKEN: "abc123" };
    expect(ci.secrets["TOKEN"]).toBe("abc123");
  });
});

// ---------- capabilities ----------

describe("CiDomain capabilities", () => {
  it("capabilities is null by default", () => {
    expect(new CiDomain().capabilities).toBeNull();
  });

  it("capabilities can be set and read back", () => {
    const ci = new CiDomain();
    ci.capabilities = makeCapabilities();
    expect(ci.capabilities).not.toBeNull();
    expect(ci.capabilities!.runner).toBe(true);
  });

  it("updateCapabilities() is a no-op when capabilities is null", () => {
    const ci = new CiDomain();
    expect(() => ci.updateCapabilities(["docker"], true, ["bun"])).not.toThrow();
    expect(ci.capabilities).toBeNull();
  });

  it("updateCapabilities() updates labels, runner flag, and tools", () => {
    const ci = new CiDomain();
    ci.capabilities = makeCapabilities({ labels: ["old"], runner: false, tools: [] });
    ci.updateCapabilities(["new-label"], true, ["bun", "docker"]);
    expect(ci.capabilities!.labels).toEqual(["new-label"]);
    expect(ci.capabilities!.runner).toBe(true);
    expect(ci.capabilities!.tools).toEqual(["bun", "docker"]);
  });

  it("updateCapabilities() does not affect os, arch, or load", () => {
    const ci = new CiDomain();
    ci.capabilities = makeCapabilities({ os: "darwin", arch: "arm64" });
    ci.updateCapabilities([], false, []);
    expect(ci.capabilities!.os).toBe("darwin");
    expect(ci.capabilities!.arch).toBe("arm64");
  });
});

// ---------- asCiState ----------

describe("CiDomain.asCiState()", () => {
  it("returns an object with runs, log_buffers, and cron_claims", () => {
    const state = new CiDomain().asCiState();
    expect(state.runs).toBeDefined();
    expect(state.log_buffers).toBeDefined();
    expect(state.cron_claims).toBeDefined();
  });

  it("runs set via setRun() are visible in asCiState().runs", () => {
    const ci = new CiDomain();
    ci.setRun(makeRun("run-1"));
    expect(ci.asCiState().runs.has("run-1")).toBe(true);
  });

  it("runs set via asCiState().runs.set() are visible via getRun()", () => {
    const ci = new CiDomain();
    const run = makeRun("run-2");
    ci.asCiState().runs.set("run-2", run);
    expect(ci.getRun("run-2")).toBe(run);
  });
});
