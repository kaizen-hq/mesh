import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  saveRun,
  loadRun,
  listRuns,
  appendLogChunk,
  readLog,
  tailLog,
  pruneRuns,
  ciRunDir,
} from "./store.ts";
import type { PipelineRun } from "./types.ts";

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    run_id: "run-001",
    repo: "my-app",
    ref: "refs/heads/main",
    sha: "abc123",
    triggered_by: { type: "push", pusher: "alice" },
    runner: "peer-b",
    status: "passed",
    started_at: "2024-01-15T10:00:00Z",
    completed_at: "2024-01-15T10:02:00Z",
    jobs: {
      test: {
        job: "test",
        status: "passed",
        exit_code: 0,
        started_at: "2024-01-15T10:00:00Z",
        completed_at: "2024-01-15T10:01:30Z",
        log_seq: 3,
      },
    },
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-ci-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("saveRun / loadRun", () => {
  it("round-trips a PipelineRun", async () => {
    const run = makeRun();
    await saveRun(tmpDir, run);
    const loaded = await loadRun(tmpDir, run.repo, run.run_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.run_id).toBe("run-001");
    expect(loaded!.status).toBe("passed");
    expect(loaded!.jobs.test.exit_code).toBe(0);
  });

  it("returns null for missing run", async () => {
    const r = await loadRun(tmpDir, "my-app", "nonexistent");
    expect(r).toBeNull();
  });

  it("overwrites an existing run", async () => {
    const run = makeRun({ status: "running" });
    await saveRun(tmpDir, run);
    await saveRun(tmpDir, { ...run, status: "passed" });
    const loaded = await loadRun(tmpDir, run.repo, run.run_id);
    expect(loaded!.status).toBe("passed");
  });
});

describe("listRuns", () => {
  it("returns empty array when no runs exist", async () => {
    const runs = await listRuns(tmpDir, "my-app");
    expect(runs).toEqual([]);
  });

  it("lists all run IDs sorted by started_at descending", async () => {
    await saveRun(tmpDir, makeRun({ run_id: "run-001", started_at: "2024-01-15T10:00:00Z" }));
    await saveRun(tmpDir, makeRun({ run_id: "run-002", started_at: "2024-01-15T11:00:00Z" }));
    await saveRun(tmpDir, makeRun({ run_id: "run-003", started_at: "2024-01-15T09:00:00Z" }));
    const runs = await listRuns(tmpDir, "my-app");
    expect(runs.map((r) => r.run_id)).toEqual(["run-002", "run-001", "run-003"]);
  });
});

describe("appendLogChunk / readLog", () => {
  it("appends chunks to log.txt and reads them back", async () => {
    const run = makeRun();
    await saveRun(tmpDir, run);
    await appendLogChunk(tmpDir, run.repo, run.run_id, "hello from stdout\n");
    await appendLogChunk(tmpDir, run.repo, run.run_id, "error line\n");
    const log = await readLog(tmpDir, run.repo, run.run_id);
    expect(log).toContain("hello from stdout");
    expect(log).toContain("error line");
  });

  it("returns empty string for missing log", async () => {
    const log = await readLog(tmpDir, "my-app", "nonexistent");
    expect(log).toBe("");
  });
});

describe("pruneRuns", () => {
  it("removes oldest runs beyond retention limit", async () => {
    for (let i = 1; i <= 5; i++) {
      const runId = `run-00${i}`;
      const started = `2024-01-${String(i).padStart(2, "0")}T00:00:00Z`;
      await saveRun(tmpDir, makeRun({ run_id: runId, started_at: started }));
    }
    await pruneRuns(tmpDir, "my-app", 3);
    const remaining = await listRuns(tmpDir, "my-app");
    expect(remaining).toHaveLength(3);
    // Most recent 3 should be kept
    const ids = remaining.map((r) => r.run_id);
    expect(ids).toContain("run-005");
    expect(ids).toContain("run-004");
    expect(ids).toContain("run-003");
  });

  it("does nothing if under retention limit", async () => {
    await saveRun(tmpDir, makeRun({ run_id: "run-001" }));
    await pruneRuns(tmpDir, "my-app", 50);
    const remaining = await listRuns(tmpDir, "my-app");
    expect(remaining).toHaveLength(1);
  });
});

describe("ciRunDir", () => {
  it("returns expected path", () => {
    const d = ciRunDir("/home/user/.mesh", "my-app", "run-001");
    expect(d).toBe("/home/user/.mesh/ci/my-app/run-001");
  });
});

describe("tailLog", () => {
  it("yields existing log content then stops when isDone returns true", async () => {
    const run = makeRun();
    await saveRun(tmpDir, run);
    await appendLogChunk(tmpDir, run.repo, run.run_id, "line 1\nline 2\n");

    const chunks: string[] = [];
    for await (const chunk of tailLog(tmpDir, run.repo, run.run_id, 0, () => true)) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toBe("line 1\nline 2\n");
  });

  it("does not re-emit content already yielded within the same call", async () => {
    const run = makeRun();
    await saveRun(tmpDir, run);
    await appendLogChunk(tmpDir, run.repo, run.run_id, "first chunk\n");

    let calls = 0;
    const chunks: string[] = [];
    // isDone returns false on the first check (so the loop continues), true on the second
    for await (const chunk of tailLog(tmpDir, run.repo, run.run_id, 0, () => ++calls >= 2)) {
      chunks.push(chunk);
    }
    const output = chunks.join("");
    // "first chunk" must appear exactly once — offset tracking must prevent re-emission
    expect(output.split("first chunk").length - 1).toBe(1);
  });

  it("yields all chunks written before isDone triggers, across multiple appends", async () => {
    const run = makeRun();
    await saveRun(tmpDir, run);
    // Write two separate chunks up front (simulates log growing during a run)
    await appendLogChunk(tmpDir, run.repo, run.run_id, "step-one\n");
    await appendLogChunk(tmpDir, run.repo, run.run_id, "step-two\n");

    const chunks: string[] = [];
    // isDone is true immediately — all content should still be yielded before stopping
    for await (const chunk of tailLog(tmpDir, run.repo, run.run_id, 0, () => true)) {
      chunks.push(chunk);
    }
    const output = chunks.join("");
    expect(output).toContain("step-one");
    expect(output).toContain("step-two");
  });

  it("yields nothing and stops immediately when log is missing and isDone is true", async () => {
    const chunks: string[] = [];
    for await (const chunk of tailLog(tmpDir, "no-repo", "no-run", 0, () => true)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });
});
