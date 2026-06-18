import { describe, it, expect } from "bun:test";
import {
  buildDag,
  topologicalOrder,
  collectSkipped,
  type JobDAG,
} from "./engine.ts";
import type { JobDefinition } from "./types.ts";

function makeJob(depends_on: string[] = []): JobDefinition {
  return {
    mode: "docker",
    commands: ["echo ok"],
    depends_on,
    secrets: [],
  };
}

describe("buildDag", () => {
  it("builds a dag from job definitions", () => {
    const jobs: Record<string, JobDefinition> = {
      test: makeJob([]),
      build: makeJob(["test"]),
      deploy: makeJob(["build"]),
    };
    const dag = buildDag(jobs);
    expect(dag.nodes.has("test")).toBe(true);
    expect(dag.nodes.has("build")).toBe(true);
    expect(dag.nodes.has("deploy")).toBe(true);
  });

  it("throws on unknown dependency", () => {
    const jobs: Record<string, JobDefinition> = {
      build: makeJob(["missing"]),
    };
    expect(() => buildDag(jobs)).toThrow(/missing/);
  });

  it("throws on direct cycle", () => {
    const jobs: Record<string, JobDefinition> = {
      a: makeJob(["b"]),
      b: makeJob(["a"]),
    };
    expect(() => buildDag(jobs)).toThrow(/cycle/i);
  });

  it("throws on transitive cycle", () => {
    const jobs: Record<string, JobDefinition> = {
      a: makeJob(["c"]),
      b: makeJob(["a"]),
      c: makeJob(["b"]),
    };
    expect(() => buildDag(jobs)).toThrow(/cycle/i);
  });
});

describe("topologicalOrder", () => {
  it("returns a single job in order", () => {
    const jobs: Record<string, JobDefinition> = {
      test: makeJob([]),
    };
    const dag = buildDag(jobs);
    const order = topologicalOrder(dag);
    expect(order).toEqual(["test"]);
  });

  it("returns jobs in dependency order", () => {
    const jobs: Record<string, JobDefinition> = {
      deploy: makeJob(["build"]),
      test: makeJob([]),
      build: makeJob(["test"]),
    };
    const dag = buildDag(jobs);
    const order = topologicalOrder(dag);
    const testIdx = order.indexOf("test");
    const buildIdx = order.indexOf("build");
    const deployIdx = order.indexOf("deploy");
    expect(testIdx).toBeLessThan(buildIdx);
    expect(buildIdx).toBeLessThan(deployIdx);
  });

  it("handles independent parallel jobs", () => {
    const jobs: Record<string, JobDefinition> = {
      lint: makeJob([]),
      test: makeJob([]),
      build: makeJob(["lint", "test"]),
    };
    const dag = buildDag(jobs);
    const order = topologicalOrder(dag);
    expect(order).toHaveLength(3);
    const buildIdx = order.indexOf("build");
    expect(order.indexOf("lint")).toBeLessThan(buildIdx);
    expect(order.indexOf("test")).toBeLessThan(buildIdx);
  });

  it("handles multiple root jobs", () => {
    const jobs: Record<string, JobDefinition> = {
      a: makeJob([]),
      b: makeJob([]),
      c: makeJob([]),
    };
    const dag = buildDag(jobs);
    const order = topologicalOrder(dag);
    expect(order).toHaveLength(3);
    expect(order.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("collectSkipped", () => {
  it("marks no jobs skipped if nothing failed", () => {
    const jobs: Record<string, JobDefinition> = {
      test: makeJob([]),
      build: makeJob(["test"]),
    };
    const dag = buildDag(jobs);
    const skipped = collectSkipped(dag, new Set());
    expect(skipped.size).toBe(0);
  });

  it("marks direct dependents of a failed job as skipped", () => {
    const jobs: Record<string, JobDefinition> = {
      test: makeJob([]),
      build: makeJob(["test"]),
      deploy: makeJob(["build"]),
    };
    const dag = buildDag(jobs);
    const skipped = collectSkipped(dag, new Set(["test"]));
    expect(skipped.has("build")).toBe(true);
    expect(skipped.has("deploy")).toBe(true);
    expect(skipped.has("test")).toBe(false);
  });

  it("does not skip jobs whose deps all passed", () => {
    const jobs: Record<string, JobDefinition> = {
      lint: makeJob([]),
      test: makeJob([]),
      build: makeJob(["lint", "test"]),
    };
    const dag = buildDag(jobs);
    // only lint failed
    const skipped = collectSkipped(dag, new Set(["lint"]));
    expect(skipped.has("build")).toBe(true);
  });

  it("handles diamond dependency skip", () => {
    // test → lint → build, test → unit → build
    const jobs: Record<string, JobDefinition> = {
      lint: makeJob([]),
      unit: makeJob([]),
      build: makeJob(["lint", "unit"]),
      deploy: makeJob(["build"]),
    };
    const dag = buildDag(jobs);
    const skipped = collectSkipped(dag, new Set(["lint"]));
    expect(skipped.has("build")).toBe(true);
    expect(skipped.has("deploy")).toBe(true);
    expect(skipped.has("unit")).toBe(false);
  });
});

describe("sequential job iterator interface", () => {
  it("yields jobs in topological order via sequentialJobs", async () => {
    const { sequentialJobs } = await import("./engine.ts");
    const jobs: Record<string, JobDefinition> = {
      test: makeJob([]),
      build: makeJob(["test"]),
    };
    const dag = buildDag(jobs);
    const order: string[] = [];
    for await (const job of sequentialJobs(dag)) {
      order.push(job);
    }
    expect(order.indexOf("test")).toBeLessThan(order.indexOf("build"));
  });
});
