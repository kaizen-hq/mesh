// End-to-end tests: spin up real Daemon instances with real HTTP servers
// and exercise the critical paths — status, frame verification, and
// heartbeat delivery between two nodes.

import { describe, it, expect, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Daemon } from "./daemon.ts";
import * as httpServer from "./http_server.ts";
import * as ed from "./ed25519.ts";
import { signFrame, encodeFrame, encodePubkey } from "./proto.ts";
import type { Config } from "./config.ts";
import { DEFAULT_RUNNER } from "./config.ts";
import type { Identity } from "./identity.ts";

// ---------- helpers ----------

interface TestNode {
  name: string;
  daemon: Daemon;
  identity: Identity;
  server: httpServer.ServerHandle;
  baseUrl: string;
  root: string;
}

async function makeIdentity(): Promise<Identity> {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, pubkeyString: encodePubkey(publicKey), certPem: null, keyPem: null };
}

async function startNode(
  name: string,
  identity: Identity,
  peers: Config["peers"],
): Promise<TestNode> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `mesh-e2e-${name}-`));
  const config: Config = {
    self: { name, peer_port: 0 },
    peers: [{ name, pubkey: identity.pubkeyString, addresses: [] }, ...peers],
    repos: [],
    transport: { tls: false, poll_secs: 10 },
    runner: DEFAULT_RUNNER,
    raw_hash: "e2e-test",
    source_path: "/tmp/mesh.toml",
  };
  const daemon = await Daemon.create(root, config, identity);
  const server = await httpServer.run(daemon, "127.0.0.1:0");
  daemon.listenAddr = `127.0.0.1:${server.port}`;
  return { name, daemon, identity, server, baseUrl: `http://127.0.0.1:${server.port}`, root };
}

async function postFrame(baseUrl: string, frame: Awaited<ReturnType<typeof signFrame>>): Promise<Response> {
  return fetch(`${baseUrl}/mesh/frame`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: encodeFrame(frame),
  });
}

// ---------- teardown ----------

const nodes: TestNode[] = [];
afterEach(async () => {
  for (const n of nodes.splice(0)) {
    await n.server.stop();
    await fs.rm(n.root, { recursive: true, force: true });
  }
});

// ---------- status endpoint ----------

describe("GET /status", () => {
  it("returns 200 for a running node", async () => {
    const id = await makeIdentity();
    const node = await startNode("alice", id, []);
    nodes.push(node);
    const res = await fetch(`${node.baseUrl}/status`);
    expect(res.status).toBe(200);
  });

  it("response body contains the node name", async () => {
    const id = await makeIdentity();
    const node = await startNode("alice", id, []);
    nodes.push(node);
    const body = await fetch(`${node.baseUrl}/status`).then((r) => r.text());
    expect(body).toContain("alice");
  });
});

// ---------- frame endpoint — rejection cases ----------

describe("POST /mesh/frame — rejection", () => {
  it("returns 400 for a malformed body", async () => {
    const id = await makeIdentity();
    const node = await startNode("alice", id, []);
    nodes.push(node);
    const res = await fetch(`${node.baseUrl}/mesh/frame`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([0x01, 0x02, 0x03]),
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 for a frame from an unknown sender", async () => {
    const aliceId = await makeIdentity();
    const strangerIdId = await makeIdentity();
    // alice's config does not include "stranger"
    const alice = await startNode("alice", aliceId, []);
    nodes.push(alice);

    const frame = await signFrame("stranger", "alice", { kind: "Heartbeat", name: "stranger", config_hash: "x", repos: [] }, strangerIdId.privateKey);
    const res = await postFrame(alice.baseUrl, frame);
    expect(res.status).toBe(401);
  });

  it("returns 400 for a frame destined for a different peer", async () => {
    const aliceId = await makeIdentity();
    const bobId = await makeIdentity();
    // alice knows bob
    const alice = await startNode("alice", aliceId, [
      { name: "bob", pubkey: bobId.pubkeyString, addresses: [] },
    ]);
    nodes.push(alice);

    // bob sends a frame addressed to "carol", not "alice"
    const frame = await signFrame("bob", "carol", { kind: "Heartbeat", name: "bob", config_hash: "x", repos: [] }, bobId.privateKey);
    const res = await postFrame(alice.baseUrl, frame);
    expect(res.status).toBe(400);
  });

  it("returns 401 for a frame with a tampered signature", async () => {
    const aliceId = await makeIdentity();
    const bobId = await makeIdentity();
    const alice = await startNode("alice", aliceId, [
      { name: "bob", pubkey: bobId.pubkeyString, addresses: [] },
    ]);
    nodes.push(alice);

    const frame = await signFrame("bob", "alice", { kind: "Heartbeat", name: "bob", config_hash: "x", repos: [] }, bobId.privateKey);
    // Tamper the signature
    frame.signature[0] ^= 0xff;
    const res = await postFrame(alice.baseUrl, frame);
    expect(res.status).toBe(401);
  });
});

// ---------- frame endpoint — acceptance ----------

describe("POST /mesh/frame — acceptance", () => {
  it("returns 202 for a valid signed heartbeat from a known peer", async () => {
    const aliceId = await makeIdentity();
    const bobId = await makeIdentity();
    const alice = await startNode("alice", aliceId, [
      { name: "bob", pubkey: bobId.pubkeyString, addresses: [] },
    ]);
    nodes.push(alice);

    const frame = await signFrame("bob", "alice", { kind: "Heartbeat", name: "bob", config_hash: "x", repos: [] }, bobId.privateKey);
    const res = await postFrame(alice.baseUrl, frame);
    expect(res.status).toBe(202);
  });

  it("marks the sender as connected after receiving a valid frame", async () => {
    const aliceId = await makeIdentity();
    const bobId = await makeIdentity();
    const alice = await startNode("alice", aliceId, [
      { name: "bob", pubkey: bobId.pubkeyString, addresses: [] },
    ]);
    nodes.push(alice);

    expect(alice.daemon.peers.get("bob")!.isConnected()).toBe(false);

    const frame = await signFrame("bob", "alice", { kind: "Heartbeat", name: "bob", config_hash: "x", repos: [] }, bobId.privateKey);
    await postFrame(alice.baseUrl, frame);

    expect(alice.daemon.peers.get("bob")!.isConnected()).toBe(true);
  });
});

// ---------- replay protection ----------

describe("replay protection", () => {
  it("rejects a frame posted twice", async () => {
    const aliceId = await makeIdentity();
    const bobId = await makeIdentity();
    const alice = await startNode("alice", aliceId, [
      { name: "bob", pubkey: bobId.pubkeyString, addresses: [] },
    ]);
    nodes.push(alice);

    const frame = await signFrame("bob", "alice", { kind: "Heartbeat", name: "bob", config_hash: "x", repos: [] }, bobId.privateKey);
    const first = await postFrame(alice.baseUrl, frame);
    expect(first.status).toBe(202);

    const second = await postFrame(alice.baseUrl, frame);
    expect(second.status).toBe(400);
  });
});

// ---------- two-node heartbeat exchange ----------

describe("two-node heartbeat exchange", () => {
  it("bob receives alice's heartbeat and marks her as connected", async () => {
    const aliceId = await makeIdentity();
    const bobId = await makeIdentity();

    // Both nodes know each other
    const alice = await startNode("alice", aliceId, [
      { name: "bob", pubkey: bobId.pubkeyString, addresses: [`127.0.0.1:0`] },
    ]);
    const bob = await startNode("bob", bobId, [
      { name: "alice", pubkey: aliceId.pubkeyString, addresses: [alice.baseUrl.replace("http://", "")] },
    ]);
    nodes.push(alice, bob);

    // Alice signs a heartbeat to bob and posts it directly
    const frame = await signFrame("alice", "bob", {
      kind: "Heartbeat",
      name: "alice",
      config_hash: alice.daemon.config.raw_hash,
      repos: [],
    }, aliceId.privateKey);

    const res = await postFrame(bob.baseUrl, frame);
    expect(res.status).toBe(202);
    expect(bob.daemon.peers.get("alice")!.isConnected()).toBe(true);
  });

  it("bidirectional: both nodes mark each other as connected after exchanging heartbeats", async () => {
    const aliceId = await makeIdentity();
    const bobId = await makeIdentity();

    const alice = await startNode("alice", aliceId, [
      { name: "bob", pubkey: bobId.pubkeyString, addresses: [] },
    ]);
    const bob = await startNode("bob", bobId, [
      { name: "alice", pubkey: aliceId.pubkeyString, addresses: [] },
    ]);
    nodes.push(alice, bob);

    await postFrame(bob.baseUrl, await signFrame("alice", "bob", { kind: "Heartbeat", name: "alice", config_hash: "x", repos: [] }, aliceId.privateKey));
    await postFrame(alice.baseUrl, await signFrame("bob", "alice", { kind: "Heartbeat", name: "bob", config_hash: "x", repos: [] }, bobId.privateKey));

    expect(bob.daemon.peers.get("alice")!.isConnected()).toBe(true);
    expect(alice.daemon.peers.get("bob")!.isConnected()).toBe(true);
  });
});
