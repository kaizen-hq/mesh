import { describe, it, expect } from "bun:test";
import { parsePipeline, parseSecretsYaml } from "./config.ts";

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

describe("parseSecretsYaml", () => {
  it("parses secrets section", () => {
    const yaml = "secrets:\n  DEPLOY_KEY: \"abc123\"\n  NPM_TOKEN: \"xyz\"\n";
    const secrets = parseSecretsYaml(yaml);
    expect(secrets.DEPLOY_KEY).toBe("abc123");
    expect(secrets.NPM_TOKEN).toBe("xyz");
  });

  it("returns empty object from empty string", () => {
    expect(parseSecretsYaml("")).toEqual({});
  });

  it("returns empty object when secrets section is absent", () => {
    expect(parseSecretsYaml("# no secrets here\n")).toEqual({});
  });

  it("ignores non-string secret values", () => {
    const yaml = "secrets:\n  VALID: \"abc\"\n";
    const secrets = parseSecretsYaml(yaml);
    expect(secrets.VALID).toBe("abc");
  });
});
