import { describe, it, expect } from "bun:test";
import { parsePipeline, parseCicdConfig, defaultRunnerConfig } from "./config.ts";

const MINIMAL_YAML = `
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
      - bun install
      - bun test
`;

const FULL_YAML = `
pipeline:
  name: full-app

on:
  push:
    branches: [main, "release/*"]
  schedule:
    - cron: "0 2 * * *"
      job: nightly-build
  manual: true

runner:
  labels: [docker, linux]
  fallback: none

jobs:
  test:
    image: oven/bun:1.1
    commands:
      - bun install --frozen-lockfile
      - bun test
    depends_on: []
    secrets: []

  build:
    image: oven/bun:1.1
    commands:
      - bun run build
    depends_on: [test]

  integration:
    compose: docker-compose.test.yml
    service: integration-runner
    depends_on: [build]

  nightly-build:
    mode: shell
    commands:
      - bun run build:full

  deploy:
    image: alpine:3.19
    secrets: [DEPLOY_KEY]
    commands:
      - ./scripts/deploy.sh
    depends_on: [build]
`;

describe("parsePipeline", () => {
  it("parses a minimal pipeline", () => {
    const p = parsePipeline(MINIMAL_YAML);
    expect(p.name).toBe("my-app");
    expect(p.on.push?.branches).toEqual(["main"]);
    expect(p.on.manual).toBe(true);
    expect(p.runner.labels).toEqual(["docker"]);
    expect(p.runner.fallback).toBe("any");
  });

  it("parses job commands", () => {
    const p = parsePipeline(MINIMAL_YAML);
    expect(p.jobs.test.commands).toEqual(["bun install", "bun test"]);
  });

  it("defaults job mode to docker", () => {
    const p = parsePipeline(MINIMAL_YAML);
    expect(p.jobs.test.mode).toBe("docker");
  });

  it("defaults depends_on to empty", () => {
    const p = parsePipeline(MINIMAL_YAML);
    expect(p.jobs.test.depends_on).toEqual([]);
  });

  it("defaults secrets to empty", () => {
    const p = parsePipeline(MINIMAL_YAML);
    expect(p.jobs.test.secrets).toEqual([]);
  });

  it("parses full pipeline with schedule", () => {
    const p = parsePipeline(FULL_YAML);
    expect(p.name).toBe("full-app");
    expect(p.on.schedule).toHaveLength(1);
    expect(p.on.schedule![0].cron).toBe("0 2 * * *");
    expect(p.on.schedule![0].job).toBe("nightly-build");
  });

  it("parses fallback: none", () => {
    const p = parsePipeline(FULL_YAML);
    expect(p.runner.fallback).toBe("none");
  });

  it("parses multiple runner labels", () => {
    const p = parsePipeline(FULL_YAML);
    expect(p.runner.labels).toEqual(["docker", "linux"]);
  });

  it("parses depends_on", () => {
    const p = parsePipeline(FULL_YAML);
    expect(p.jobs.build.depends_on).toEqual(["test"]);
  });

  it("parses shell mode", () => {
    const p = parsePipeline(FULL_YAML);
    expect(p.jobs["nightly-build"].mode).toBe("shell");
  });

  it("parses compose job", () => {
    const p = parsePipeline(FULL_YAML);
    expect(p.jobs.integration.compose).toBe("docker-compose.test.yml");
    expect(p.jobs.integration.service).toBe("integration-runner");
  });

  it("parses secrets", () => {
    const p = parsePipeline(FULL_YAML);
    expect(p.jobs.deploy.secrets).toEqual(["DEPLOY_KEY"]);
  });

  it("throws on missing pipeline.name", () => {
    expect(() => parsePipeline("pipeline:\n  name:\njobs: {}\n")).toThrow();
  });

  it("throws on missing jobs section", () => {
    expect(() =>
      parsePipeline("pipeline:\n  name: foo\non:\n  manual: true\nrunner:\n  labels: []\n  fallback: any\n"),
    ).toThrow();
  });
});

describe("parseCicdConfig", () => {
  it("parses runner section", () => {
    const toml = `
[runner]
enabled = true
labels = ["docker", "linux-amd64"]
max_concurrent_jobs = 3
workdir = "/var/mesh-ci/runs"
allow_shell = false
allow_shell_secrets = false
log_stream_interval_ms = 500
max_worktree_age_minutes = 60
max_worktree_disk_mb = 2048
log_retention_runs = 50
`;
    const cfg = parseCicdConfig(toml);
    expect(cfg.runner.enabled).toBe(true);
    expect(cfg.runner.labels).toEqual(["docker", "linux-amd64"]);
    expect(cfg.runner.max_concurrent_jobs).toBe(3);
    expect(cfg.runner.allow_shell).toBe(false);
    expect(cfg.runner.log_stream_interval_ms).toBe(500);
  });

  it("applies defaults for missing runner fields", () => {
    const cfg = parseCicdConfig("[runner]\nenabled = true\n");
    expect(cfg.runner.max_concurrent_jobs).toBe(defaultRunnerConfig.max_concurrent_jobs);
    expect(cfg.runner.log_stream_interval_ms).toBe(defaultRunnerConfig.log_stream_interval_ms);
  });

  it("parses secrets section", () => {
    const toml = "[secrets]\nDEPLOY_KEY = \"abc123\"\nNPM_TOKEN = \"xyz\"\n";
    const cfg = parseCicdConfig(toml);
    expect(cfg.secrets.DEPLOY_KEY).toBe("abc123");
    expect(cfg.secrets.NPM_TOKEN).toBe("xyz");
  });

  it("parses capabilities.tools override", () => {
    const toml = "[capabilities]\ntools = [\"docker\", \"bun\"]\n";
    const cfg = parseCicdConfig(toml);
    expect(cfg.capabilities.tools).toEqual(["docker", "bun"]);
  });

  it("returns empty config from empty string", () => {
    const cfg = parseCicdConfig("");
    expect(cfg.runner.enabled).toBe(defaultRunnerConfig.enabled);
    expect(cfg.secrets).toEqual({});
  });
});
