import { describe, it, expect } from "bun:test";
import {
  buildDag,
  topologicalOrder,
  collectSkipped,
  validateComposeFile,
  buildShellCmdArgs,
  buildJobSecrets,
  type JobDAG,
} from "./engine.ts";
import type { JobDefinition } from "./types.ts";

function makeJob(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    mode: "docker",
    commands: ["echo ok"],
    depends_on: [],
    secrets: [],
    ...overrides,
  };
}

describe("buildDag", () => {
  it("builds a dag from job definitions", () => {
    const jobs: Record<string, JobDefinition> = {
      test: makeJob({ depends_on: [] }),
      build: makeJob({ depends_on: ["test"] }),
      deploy: makeJob({ depends_on: ["build"] }),
    };
    const dag = buildDag(jobs);
    expect(dag.nodes.has("test")).toBe(true);
    expect(dag.nodes.has("build")).toBe(true);
    expect(dag.nodes.has("deploy")).toBe(true);
  });

  it("throws on unknown dependency", () => {
    const jobs: Record<string, JobDefinition> = {
      build: makeJob({ depends_on: ["missing"] }),
    };
    expect(() => buildDag(jobs)).toThrow(/missing/);
  });

  it("throws on direct cycle", () => {
    const jobs: Record<string, JobDefinition> = {
      a: makeJob({ depends_on: ["b"] }),
      b: makeJob({ depends_on: ["a"] }),
    };
    expect(() => buildDag(jobs)).toThrow(/cycle/i);
  });

  it("throws on transitive cycle", () => {
    const jobs: Record<string, JobDefinition> = {
      a: makeJob({ depends_on: ["c"] }),
      b: makeJob({ depends_on: ["a"] }),
      c: makeJob({ depends_on: ["b"] }),
    };
    expect(() => buildDag(jobs)).toThrow(/cycle/i);
  });
});

describe("topologicalOrder", () => {
  it("returns a single job in order", () => {
    const jobs: Record<string, JobDefinition> = {
      test: makeJob({ depends_on: [] }),
    };
    const dag = buildDag(jobs);
    const order = topologicalOrder(dag);
    expect(order).toEqual(["test"]);
  });

  it("returns jobs in dependency order", () => {
    const jobs: Record<string, JobDefinition> = {
      deploy: makeJob({ depends_on: ["build"] }),
      test: makeJob({ depends_on: [] }),
      build: makeJob({ depends_on: ["test"] }),
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
      lint: makeJob({ depends_on: [] }),
      test: makeJob({ depends_on: [] }),
      build: makeJob({ depends_on: ["lint", "test"] }),
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
      a: makeJob({ depends_on: [] }),
      b: makeJob({ depends_on: [] }),
      c: makeJob({ depends_on: [] }),
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
      test: makeJob({ depends_on: [] }),
      build: makeJob({ depends_on: ["test"] }),
    };
    const dag = buildDag(jobs);
    const skipped = collectSkipped(dag, new Set());
    expect(skipped.size).toBe(0);
  });

  it("marks direct dependents of a failed job as skipped", () => {
    const jobs: Record<string, JobDefinition> = {
      test: makeJob({ depends_on: [] }),
      build: makeJob({ depends_on: ["test"] }),
      deploy: makeJob({ depends_on: ["build"] }),
    };
    const dag = buildDag(jobs);
    const skipped = collectSkipped(dag, new Set(["test"]));
    expect(skipped.has("build")).toBe(true);
    expect(skipped.has("deploy")).toBe(true);
    expect(skipped.has("test")).toBe(false);
  });

  it("does not skip jobs whose deps all passed", () => {
    const jobs: Record<string, JobDefinition> = {
      lint: makeJob({ depends_on: [] }),
      test: makeJob({ depends_on: [] }),
      build: makeJob({ depends_on: ["lint", "test"] }),
    };
    const dag = buildDag(jobs);
    // only lint failed
    const skipped = collectSkipped(dag, new Set(["lint"]));
    expect(skipped.has("build")).toBe(true);
  });

  it("handles diamond dependency skip", () => {
    // test → lint → build, test → unit → build
    const jobs: Record<string, JobDefinition> = {
      lint: makeJob({ depends_on: [] }),
      unit: makeJob({ depends_on: [] }),
      build: makeJob({ depends_on: ["lint", "unit"] }),
      deploy: makeJob({ depends_on: ["build"] }),
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
      test: makeJob({ depends_on: [] }),
      build: makeJob({ depends_on: ["test"] }),
    };
    const dag = buildDag(jobs);
    const order: string[] = [];
    for await (const job of sequentialJobs(dag)) {
      order.push(job);
    }
    expect(order.indexOf("test")).toBeLessThan(order.indexOf("build"));
  });
});

// ---------- validateComposeFile ----------

describe("validateComposeFile", () => {
  it("accepts a plain compose file with no unsafe options", () => {
    const yaml = `
version: "3"
services:
  app:
    image: node:20
    command: ["node", "index.js"]
`;
    expect(() => validateComposeFile(yaml, "build")).not.toThrow();
  });

  it("rejects network_mode: host (unquoted)", () => {
    const yaml = `
services:
  app:
    image: node:20
    network_mode: host
`;
    expect(() => validateComposeFile(yaml, "build")).toThrow(/network_mode: host/);
  });

  it("rejects network_mode: 'host' (single-quoted)", () => {
    const yaml = `
services:
  app:
    network_mode: 'host'
`;
    expect(() => validateComposeFile(yaml, "deploy")).toThrow(/network_mode: host/);
  });

  it("rejects network_mode: \"host\" (double-quoted)", () => {
    const yaml = `
services:
  app:
    network_mode: "host"
`;
    expect(() => validateComposeFile(yaml, "deploy")).toThrow(/network_mode: host/);
  });

  it("rejects privileged: true", () => {
    const yaml = `
services:
  app:
    image: node:20
    privileged: true
`;
    expect(() => validateComposeFile(yaml, "test")).toThrow(/privileged: true/);
  });

  it("error message includes the job name", () => {
    const yaml = `services:\n  app:\n    network_mode: host\n`;
    expect(() => validateComposeFile(yaml, "my-job")).toThrow(/my-job/);
  });

  it("rejects on the first violation when both are present", () => {
    const yaml = `
services:
  app:
    network_mode: host
    privileged: true
`;
    expect(() => validateComposeFile(yaml, "bad-job")).toThrow();
  });
});

// ---------- buildShellCmdArgs ----------

describe("buildShellCmdArgs", () => {
  it("returns plain sh argv when netIsolate is false", () => {
    expect(buildShellCmdArgs("echo hello", false)).toEqual(["sh", "-c", "echo hello"]);
  });

  it("prepends unshare --net when netIsolate is true", () => {
    expect(buildShellCmdArgs("echo hello", true)).toEqual([
      "unshare", "--net", "sh", "-c", "echo hello",
    ]);
  });

  it("preserves the full command string including spaces and quotes", () => {
    const cmd = `bun install && bun run build`;
    expect(buildShellCmdArgs(cmd, false)).toEqual(["sh", "-c", cmd]);
    expect(buildShellCmdArgs(cmd, true)).toEqual(["unshare", "--net", "sh", "-c", cmd]);
  });
});

// ---------- buildJobSecrets ----------

describe("buildJobSecrets", () => {
  it("returns run-level secrets when job has no push flag", () => {
    const result = buildJobSecrets({ DB_URL: "postgres://..." }, makeJob(), "tok-123");
    expect(result["DB_URL"]).toBe("postgres://...");
    expect(result["MESH_PUSH_TOKEN"]).toBeUndefined();
  });

  it("does not inject MESH_PUSH_TOKEN when push is false", () => {
    const result = buildJobSecrets({}, makeJob({ push: false }), "tok-123");
    expect(result["MESH_PUSH_TOKEN"]).toBeUndefined();
  });

  it("does not inject MESH_PUSH_TOKEN when push is true but no token is provided", () => {
    const result = buildJobSecrets({}, makeJob({ push: true }), undefined);
    expect(result["MESH_PUSH_TOKEN"]).toBeUndefined();
  });

  it("injects MESH_PUSH_TOKEN when push is true and a token is provided", () => {
    const result = buildJobSecrets({}, makeJob({ push: true }), "tok-abc");
    expect(result["MESH_PUSH_TOKEN"]).toBe("tok-abc");
  });

  it("includes both run-level secrets and MESH_PUSH_TOKEN for push: true jobs", () => {
    const result = buildJobSecrets(
      { API_KEY: "secret" },
      makeJob({ push: true }),
      "tok-xyz",
    );
    expect(result["API_KEY"]).toBe("secret");
    expect(result["MESH_PUSH_TOKEN"]).toBe("tok-xyz");
  });

  it("does not mutate the original run-level secrets dict", () => {
    const runSecrets = { A: "1" };
    buildJobSecrets(runSecrets, makeJob({ push: true }), "tok");
    expect(runSecrets["MESH_PUSH_TOKEN" as keyof typeof runSecrets]).toBeUndefined();
  });

  it("run-level secret named MESH_PUSH_TOKEN is overwritten for push: true jobs", () => {
    // The injected token wins — a run-level secret with this name would be anomalous.
    const result = buildJobSecrets(
      { MESH_PUSH_TOKEN: "stale" },
      makeJob({ push: true }),
      "fresh-tok",
    );
    expect(result["MESH_PUSH_TOKEN"]).toBe("fresh-tok");
  });
});
