import { describe, it, expect } from "bun:test";
import { parse, parseScalar, parseFlowSeq } from "./yaml.ts";

describe("parseScalar", () => {
  it("parses booleans", () => {
    expect(parseScalar("true")).toBe(true);
    expect(parseScalar("false")).toBe(false);
  });
  it("parses null", () => {
    expect(parseScalar("null")).toBeNull();
    expect(parseScalar("~")).toBeNull();
  });
  it("parses integers", () => {
    expect(parseScalar("42")).toBe(42);
    expect(parseScalar("0")).toBe(0);
  });
  it("parses unquoted strings", () => {
    expect(parseScalar("any")).toBe("any");
    expect(parseScalar("oven/bun:1.1")).toBe("oven/bun:1.1");
  });
  it("parses double-quoted strings", () => {
    expect(parseScalar('"hello world"')).toBe("hello world");
    expect(parseScalar('"0 2 * * *"')).toBe("0 2 * * *");
  });
  it("parses single-quoted strings", () => {
    expect(parseScalar("'release/*'")).toBe("release/*");
  });
  it("handles escape sequences in double-quoted strings", () => {
    expect(parseScalar('"line\\none"')).toBe("line\none");
  });
});

describe("parseFlowSeq", () => {
  it("parses empty sequence", () => {
    expect(parseFlowSeq("[]")).toEqual([]);
  });
  it("parses unquoted strings", () => {
    expect(parseFlowSeq("[main, dev]")).toEqual(["main", "dev"]);
  });
  it("parses quoted strings", () => {
    expect(parseFlowSeq('[main, "release/*"]')).toEqual(["main", "release/*"]);
  });
  it("parses booleans", () => {
    expect(parseFlowSeq("[true, false]")).toEqual([true, false]);
  });
  it("parses single element", () => {
    expect(parseFlowSeq("[docker]")).toEqual(["docker"]);
  });
});

describe("parse", () => {
  it("parses simple key-value pairs", () => {
    const doc = parse("name: my-app\nversion: 1\nenabled: true\n");
    expect(doc.name).toBe("my-app");
    expect(doc.version).toBe(1);
    expect(doc.enabled).toBe(true);
  });

  it("parses nested mappings", () => {
    const doc = parse("pipeline:\n  name: my-app\n");
    expect((doc.pipeline as Record<string, unknown>).name).toBe("my-app");
  });

  it("parses flow sequences as values", () => {
    const doc = parse("labels: [docker, linux-amd64]\n");
    expect(doc.labels).toEqual(["docker", "linux-amd64"]);
  });

  it("parses block sequences of scalars", () => {
    const doc = parse("commands:\n  - bun install\n  - bun test\n") as Record<string, string[]>;
    expect(doc.commands).toEqual(["bun install", "bun test"]);
  });

  it("parses block sequence of mappings", () => {
    const doc = parse("schedule:\n  - cron: \"0 2 * * *\"\n    job: nightly\n");
    const sched = doc.schedule as Array<Record<string, unknown>>;
    expect(sched).toHaveLength(1);
    expect(sched[0].cron).toBe("0 2 * * *");
    expect(sched[0].job).toBe("nightly");
  });

  it("ignores comments and blank lines", () => {
    const doc = parse("# top comment\nname: foo\n\n# another\nport: 80\n");
    expect(doc.name).toBe("foo");
    expect(doc.port).toBe(80);
  });

  it("parses deeply nested structures", () => {
    const yaml = `
on:
  push:
    branches: [main, "release/*"]
  manual: true
`;
    const doc = parse(yaml) as Record<string, Record<string, unknown>>;
    const on = doc.on;
    expect((on.push as Record<string, unknown>).branches).toEqual(["main", "release/*"]);
    expect(on.manual).toBe(true);
  });

  it("parses a full mesh-ci.yml structure", () => {
    const yaml = `
pipeline:
  name: my-app

on:
  push:
    branches: [main]
  manual: true

runner:
  labels: [docker]
  fallback: any

jobs:
  test:
    image: oven/bun:1.1
    commands:
      - bun install --frozen-lockfile
      - bun test
  build:
    image: oven/bun:1.1
    commands:
      - bun run build
    depends_on: [test]
`;
    const doc = parse(yaml) as Record<string, unknown>;
    const pipeline = doc.pipeline as Record<string, unknown>;
    expect(pipeline.name).toBe("my-app");

    const on = doc.on as Record<string, unknown>;
    expect((on.push as Record<string, unknown>).branches).toEqual(["main"]);
    expect(on.manual).toBe(true);

    const runner = doc.runner as Record<string, unknown>;
    expect(runner.labels).toEqual(["docker"]);
    expect(runner.fallback).toBe("any");

    const jobs = doc.jobs as Record<string, Record<string, unknown>>;
    expect(jobs.test.image).toBe("oven/bun:1.1");
    expect(jobs.test.commands).toEqual(["bun install --frozen-lockfile", "bun test"]);
    expect(jobs.build.depends_on).toEqual(["test"]);
  });

  it("handles null values for keys without values", () => {
    const doc = parse("key:\n");
    expect(doc.key).toBeNull();
  });
});
