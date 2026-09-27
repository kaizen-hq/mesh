// Integration tests for the CI log stream SSE endpoint.
//
// Verifies:
//   1. A completed/failed run's stream ends with "event: done" so the browser
//      EventSource closes instead of auto-reconnecting (which caused duplicate
//      log output).
//   2. All log content is delivered before the done event — nothing is lost.

import { describe, it, expect, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Daemon } from "../daemon.ts";
import * as httpServer from "../http_server.ts";
import * as ed from "../ed25519.ts";
import { encodePubkey } from "../proto.ts";
import type { Config } from "../config.ts";
import { DEFAULT_RUNNER } from "../config.ts";
import type { Identity } from "../identity.ts";
import { appendLogChunk, saveRun } from "./store.ts";
import type { PipelineRun } from "./types.ts";

// ---------- helpers ----------

async function makeIdentity(): Promise<Identity> {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, pubkeyString: encodePubkey(publicKey), certPem: null, keyPem: null };
}

interface TestNode {
  daemon: Daemon;
  server: httpServer.ServerHandle;
  baseUrl: string;
  root: string;
}

async function startNode(name: string, identity: Identity): Promise<TestNode> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `mesh-ci-sse-test-`));
  const config: Config = {
    self: { name, peer_port: 0 },
    peers: [{ name, pubkey: identity.pubkeyString, addresses: [] }],
    transport: { tls: false, poll_secs: 10 },
    runner: DEFAULT_RUNNER,
    source_path: "/tmp/mesh.toml",
  };
  const daemon = await Daemon.create(root, config, identity);
  const server = await httpServer.run(daemon, "127.0.0.1:0");
  daemon.listenAddr = `127.0.0.1:${server.port}`;
  return { daemon, server, baseUrl: `http://127.0.0.1:${server.port}`, root };
}

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    run_id: "run-sse-test",
    repo: "my-app",
    ref: "refs/heads/main",
    sha: "abc1234",
    triggered_by: { type: "push", pusher: "alice" },
    runner: "local",
    status: "running",
    started_at: new Date().toISOString(),
    jobs: {},
    ...overrides,
  };
}

/** Read an SSE stream until the `done` event or until `maxEvents` have been collected. */
async function collectSseEvents(
  url: string,
  maxEvents = 20,
  timeoutMs = 3000,
): Promise<Array<{ event: string; data: string }>> {
  const events: Array<{ event: string; data: string }> = [];
  const res = await fetch(url);
  if (!res.body) return events;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const deadline = Date.now() + timeoutMs;

  outer: while (Date.now() < deadline && events.length < maxEvents) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
      ),
    ]);
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE message blocks (separated by blank lines)
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      if (!block.trim()) continue;
      let eventName = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) eventName = line.slice(7).trim();
        else if (line.startsWith("data: ")) data = line.slice(6);
      }
      events.push({ event: eventName, data });
      if (eventName === "done") {
        reader.cancel();
        break outer;
      }
    }
  }

  reader.cancel();
  return events;
}

// ---------- teardown ----------

const nodes: TestNode[] = [];
afterEach(async () => {
  for (const n of nodes.splice(0)) {
    await n.server.stop();
    await fs.rm(n.root, { recursive: true, force: true });
  }
});

// ---------- tests ----------

describe("CI log stream SSE — done event", () => {
  it("emits event: done after streaming a completed (failed) run", async () => {
    const identity = await makeIdentity();
    const node = await startNode("alice", identity);
    nodes.push(node);

    const run = makeRun({ status: "failed", completed_at: new Date().toISOString() });
    // Persist the run to disk so the detail handler can load it
    await saveRun(node.root, run);
    await appendLogChunk(node.root, run.repo, run.run_id, "step 1 output\n");
    await appendLogChunk(node.root, run.repo, run.run_id, "step 2 output\n");

    // Register the run in-memory so isDone() can check its status
    node.daemon.ci.setRun(run);

    const url = `${node.baseUrl}/repos/${run.repo}/ci/${run.run_id}/log/stream`;
    const events = await collectSseEvents(url);

    const eventNames = events.map((e) => e.event);
    expect(eventNames).toContain("done");
  });

  it("delivers all log content before the done event with no duplicates", async () => {
    const identity = await makeIdentity();
    const node = await startNode("bob", identity);
    nodes.push(node);

    const run = makeRun({ run_id: "run-no-dup", status: "failed", completed_at: new Date().toISOString() });
    await saveRun(node.root, run);
    await appendLogChunk(node.root, run.repo, run.run_id, "alpha\nbeta\ngamma\n");
    node.daemon.ci.setRun(run);

    const url = `${node.baseUrl}/repos/${run.repo}/ci/${run.run_id}/log/stream`;
    const events = await collectSseEvents(url);

    const logChunks = events.filter((e) => e.event === "log-chunk");
    const fullOutput = logChunks.map((e) => JSON.parse(e.data).data as string).join("");

    // Every expected line appears exactly once
    expect(fullOutput.split("alpha").length - 1).toBe(1);
    expect(fullOutput.split("beta").length - 1).toBe(1);
    expect(fullOutput.split("gamma").length - 1).toBe(1);

    // done event is the last event received
    expect(events.at(-1)?.event).toBe("done");
  });

  it("emits done even when the log file is empty", async () => {
    const identity = await makeIdentity();
    const node = await startNode("carol", identity);
    nodes.push(node);

    const run = makeRun({ run_id: "run-empty-log", status: "failed", completed_at: new Date().toISOString() });
    await saveRun(node.root, run);
    // No log chunks written — log file does not exist
    node.daemon.ci.setRun(run);

    const url = `${node.baseUrl}/repos/${run.repo}/ci/${run.run_id}/log/stream`;
    const events = await collectSseEvents(url);

    expect(events.map((e) => e.event)).toContain("done");
  });
});
