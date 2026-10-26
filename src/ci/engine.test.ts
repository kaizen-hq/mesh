import { describe, it, expect } from "bun:test";
import {
  buildDag,
  topologicalOrder,
  collectSkipped,
  validateComposeFile,
  buildJobSecrets,
  type JobDAG,
} from "./engine.ts";
import type { JobDefinition } from "./types.ts";

function makeJob(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
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

  it("rejects absolute host-path volume mounts", () => {
    const yaml = `
services:
  app:
    image: node:20
    volumes:
      - /home/mesh/.mesh:/steal
`;
    expect(() => validateComposeFile(yaml, "exfil")).toThrow(/host-path volume/);
  });

  it("rejects host-path mount targeting a different path", () => {
    const yaml = `
services:
  app:
    volumes:
      - /etc/passwd:/etc/passwd:ro
`;
    expect(() => validateComposeFile(yaml, "exfil")).toThrow(/host-path volume/);
  });

  it("accepts named volume mounts (no leading slash on source)", () => {
    const yaml = `
services:
  app:
    image: node:20
    volumes:
      - node_cache:/root/.npm
`;
    expect(() => validateComposeFile(yaml, "build")).not.toThrow();
  });

  it("accepts anonymous volume mounts", () => {
    const yaml = `
services:
  app:
    image: node:20
    volumes:
      - /workspace
`;
    expect(() => validateComposeFile(yaml, "build")).not.toThrow();
  });

  // --- short syntax: tilde, env-var, traversal ---

  it("rejects short-syntax tilde source (~/path:/container)", () => {
    const yaml = `
services:
  app:
    volumes:
      - ~/.mesh:/steal
`;
    expect(() => validateComposeFile(yaml, "exfil")).toThrow(/host-path volume/);
  });

  it("rejects short-syntax braced env-var source (${HOME}/path:/container)", () => {
    const yaml = `
services:
  app:
    volumes:
      - \${HOME}/.mesh:/steal
`;
    expect(() => validateComposeFile(yaml, "exfil")).toThrow(/host-path volume/);
  });

  it("rejects short-syntax unbraced env-var source ($HOME:/container)", () => {
    const yaml = `
services:
  app:
    volumes:
      - $HOME/.mesh:/steal
`;
    expect(() => validateComposeFile(yaml, "exfil")).toThrow(/host-path volume/);
  });

  it("rejects short-syntax path traversal out of worktree (../../..:/container)", () => {
    const yaml = `
services:
  app:
    volumes:
      - ../../etc/passwd:/steal
`;
    expect(() => validateComposeFile(yaml, "exfil")).toThrow(/host-path volume/);
  });

  // --- long syntax (type: bind / source:) ---

  it("rejects long-syntax absolute source", () => {
    const yaml = `
services:
  app:
    volumes:
      - type: bind
        source: /home/mesh/.mesh
        target: /steal
`;
    expect(() => validateComposeFile(yaml, "exfil")).toThrow(/host-path volume/);
  });

  it("rejects long-syntax tilde source", () => {
    const yaml = `
services:
  app:
    volumes:
      - type: bind
        source: ~/.mesh
        target: /steal
`;
    expect(() => validateComposeFile(yaml, "exfil")).toThrow(/host-path volume/);
  });

  it("rejects long-syntax braced env-var source", () => {
    const yaml = `
services:
  app:
    volumes:
      - type: bind
        source: \${HOME}/.mesh
        target: /steal
`;
    expect(() => validateComposeFile(yaml, "exfil")).toThrow(/host-path volume/);
  });

  it("rejects long-syntax traversal source", () => {
    const yaml = `
services:
  app:
    volumes:
      - type: bind
        source: ../../etc
        target: /steal
`;
    expect(() => validateComposeFile(yaml, "exfil")).toThrow(/host-path volume/);
  });

  it("accepts long-syntax named volume source", () => {
    const yaml = `
services:
  app:
    volumes:
      - type: volume
        source: node_cache
        target: /root/.npm
`;
    expect(() => validateComposeFile(yaml, "build")).not.toThrow();
  });

  // --- flow-style list ---

  it("rejects flow-style absolute host-path volume", () => {
    const yaml = `
services:
  app:
    image: node:20
    volumes: ["/home/mesh/.mesh:/steal"]
`;
    expect(() => validateComposeFile(yaml, "exfil")).toThrow(/host-path volume/);
  });

  it("rejects flow-style tilde host-path volume", () => {
    const yaml = `
services:
  app:
    volumes: ["~/.mesh:/steal"]
`;
    expect(() => validateComposeFile(yaml, "exfil")).toThrow(/host-path volume/);
  });

  it("accepts flow-style named volume", () => {
    const yaml = `
services:
  app:
    image: node:20
    volumes: ["node_cache:/root/.npm"]
`;
    expect(() => validateComposeFile(yaml, "build")).not.toThrow();
  });

  it("accepts flow-style anonymous volume", () => {
    const yaml = `
services:
  app:
    image: node:20
    volumes: ["/workspace"]
`;
    expect(() => validateComposeFile(yaml, "build")).not.toThrow();
  });
});

// ---------- buildJobSecrets ----------

describe("buildJobSecrets", () => {
  it("returns only secrets declared by the job", () => {
    const result = buildJobSecrets({ DB_URL: "postgres://...", API_KEY: "secret" }, makeJob({ secrets: ["DB_URL"] }));
    expect(result["DB_URL"]).toBe("postgres://...");
    expect(result["API_KEY"]).toBeUndefined();
  });

  it("returns empty object when job declares no secrets", () => {
    const result = buildJobSecrets({ DB_URL: "postgres://..." }, makeJob({ secrets: [] }));
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("omits secrets declared by job but absent from run-level secrets", () => {
    const result = buildJobSecrets({}, makeJob({ secrets: ["MISSING_SECRET"] }));
    expect(result["MISSING_SECRET"]).toBeUndefined();
  });

  it("does not mutate the run-level secrets dict", () => {
    const runSecrets = { A: "1" };
    buildJobSecrets(runSecrets, makeJob({ secrets: ["A"] }));
    expect(Object.keys(runSecrets)).toHaveLength(1);
  });
});
