import { describe, it, expect, beforeEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { setConfigValue, getConfigValue } from "./config.ts";

// ---------- fixtures ----------

async function makeTmpCfg(content?: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-config-test-"));
  const file = path.join(dir, "mesh.toml");
  await fs.writeFile(
    file,
    content ??
      `[self]
name = "alice"

[runner]
enabled = true
execution_modes = ["docker"]
labels = []
`,
    "utf8",
  );
  return file;
}

// ---------- setConfigValue ----------

describe("setConfigValue()", () => {
  it("sets a string field", async () => {
    const file = await makeTmpCfg();
    await setConfigValue(file, "self.name", "my-pod");
    expect(await getConfigValue(file, "self.name")).toBe("my-pod");
  });

  it("sets a numeric field", async () => {
    const file = await makeTmpCfg();
    await setConfigValue(file, "self.peer_port", "8080");
    expect(await getConfigValue(file, "self.peer_port")).toBe(8080);
  });

  it("sets a boolean field to true", async () => {
    const file = await makeTmpCfg();
    await setConfigValue(file, "runner.enabled", "false");
    expect(await getConfigValue(file, "runner.enabled")).toBe(false);
    await setConfigValue(file, "runner.enabled", "true");
    expect(await getConfigValue(file, "runner.enabled")).toBe(true);
  });

  it("accepts 1/0 for booleans", async () => {
    const file = await makeTmpCfg();
    await setConfigValue(file, "transport.tls", "0");
    expect(await getConfigValue(file, "transport.tls")).toBe(false);
    await setConfigValue(file, "transport.tls", "1");
    expect(await getConfigValue(file, "transport.tls")).toBe(true);
  });

  it("accepts yes/no for booleans", async () => {
    const file = await makeTmpCfg();
    await setConfigValue(file, "runner.enabled", "no");
    expect(await getConfigValue(file, "runner.enabled")).toBe(false);
    await setConfigValue(file, "runner.enabled", "yes");
    expect(await getConfigValue(file, "runner.enabled")).toBe(true);
  });

  it("sets a string[] field from comma-separated input", async () => {
    const file = await makeTmpCfg();
    await setConfigValue(file, "runner.labels", "prod,gpu,arm64");
    expect(await getConfigValue(file, "runner.labels")).toEqual(["prod", "gpu", "arm64"]);
  });

  it("sets a string[] field from JSON array input", async () => {
    const file = await makeTmpCfg();
    await setConfigValue(file, "runner.labels", '["prod","gpu"]');
    expect(await getConfigValue(file, "runner.labels")).toEqual(["prod", "gpu"]);
  });

  it("sets a string[] field to empty when given empty string", async () => {
    const file = await makeTmpCfg();
    await setConfigValue(file, "runner.labels", "");
    expect(await getConfigValue(file, "runner.labels")).toEqual([]);
  });

  it("sets a string[] field to empty when given '[]'", async () => {
    const file = await makeTmpCfg();
    await setConfigValue(file, "runner.labels", "[]");
    expect(await getConfigValue(file, "runner.labels")).toEqual([]);
  });

  it("creates a section that does not yet exist in the file", async () => {
    const file = await makeTmpCfg(`[self]\nname = "alice"\n`);
    await setConfigValue(file, "transport.tls", "false");
    expect(await getConfigValue(file, "transport.tls")).toBe(false);
  });

  it("preserves other fields when updating one field", async () => {
    const file = await makeTmpCfg();
    await setConfigValue(file, "runner.labels", "prod");
    // execution_modes was in the seed — must still be there
    expect(await getConfigValue(file, "runner.execution_modes")).toEqual(["docker"]);
  });

  it("writes atomically (file is a complete TOML doc after set)", async () => {
    const file = await makeTmpCfg();
    await setConfigValue(file, "runner.labels", "prod,gpu");
    const raw = await fs.readFile(file, "utf8");
    expect(raw).toContain("[runner]");
    expect(raw).toContain("labels");
    // no leftover .tmp file
    await expect(fs.access(file + ".tmp")).rejects.toThrow();
  });

  it("throws on unknown section", async () => {
    const file = await makeTmpCfg();
    await expect(setConfigValue(file, "bogus.field", "x")).rejects.toThrow(/unknown config section/);
  });

  it("throws on unknown field within a known section", async () => {
    const file = await makeTmpCfg();
    await expect(setConfigValue(file, "runner.nonexistent", "x")).rejects.toThrow(/unknown field/);
  });

  it("throws when key has no dot separator", async () => {
    const file = await makeTmpCfg();
    await expect(setConfigValue(file, "runnerlabels", "x")).rejects.toThrow(/section\.field/);
  });

  it("throws on invalid boolean value", async () => {
    const file = await makeTmpCfg();
    await expect(setConfigValue(file, "runner.enabled", "maybe")).rejects.toThrow(/expected true\/false/);
  });

  it("throws on non-numeric value for a number field", async () => {
    const file = await makeTmpCfg();
    await expect(setConfigValue(file, "self.peer_port", "notanumber")).rejects.toThrow(/expected a number/);
  });
});

// ---------- getConfigValue ----------

describe("getConfigValue()", () => {
  it("returns the value for a present field", async () => {
    const file = await makeTmpCfg();
    expect(await getConfigValue(file, "self.name")).toBe("alice");
  });

  it("returns undefined for a field not present in the file", async () => {
    const file = await makeTmpCfg(`[self]\nname = "alice"\n`);
    expect(await getConfigValue(file, "runner.labels")).toBeUndefined();
  });

  it("returns undefined for a section not present in the file", async () => {
    const file = await makeTmpCfg(`[self]\nname = "alice"\n`);
    expect(await getConfigValue(file, "transport.tls")).toBeUndefined();
  });

  it("throws when key has no dot separator", async () => {
    const file = await makeTmpCfg();
    await expect(getConfigValue(file, "selfname")).rejects.toThrow(/section\.field/);
  });

  it("round-trips through setConfigValue", async () => {
    const file = await makeTmpCfg();
    await setConfigValue(file, "runner.env_passthrough", "AWS_REGION,DB_URL");
    expect(await getConfigValue(file, "runner.env_passthrough")).toEqual(["AWS_REGION", "DB_URL"]);
  });
});
