// Round-trip encode/decode tests for proto Message variants.
// Uses signFrame + verifyFrame so the full bincode path is exercised.

import { describe, it, expect } from "bun:test";
import * as ed from "./ed25519.ts";
import { signFrame, verifyFrame, encodePubkey } from "./proto.ts";

async function makeKey(): Promise<{ priv: Uint8Array; pub: Uint8Array }> {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed.getPublicKeyAsync(priv);
  return { priv, pub };
}

describe("RepoDeleted round-trip", () => {
  it("encodes and decodes repo name and deleted_at", async () => {
    const { priv, pub } = await makeKey();
    const frame = await signFrame("alice", "bob", {
      kind: "RepoDeleted",
      repo: "my-project",
      deleted_at: "2026-10-01T12:00:00.000Z",
    }, priv);
    const msg = await verifyFrame(frame, pub);
    expect(msg.kind).toBe("RepoDeleted");
    if (msg.kind !== "RepoDeleted") return;
    expect(msg.repo).toBe("my-project");
    expect(msg.deleted_at).toBe("2026-10-01T12:00:00.000Z");
  });

  it("preserves repo names with hyphens and dots", async () => {
    const { priv, pub } = await makeKey();
    const frame = await signFrame("alice", "bob", {
      kind: "RepoDeleted",
      repo: "my.repo-v2",
      deleted_at: "2026-01-01T00:00:00.000Z",
    }, priv);
    const msg = await verifyFrame(frame, pub);
    expect(msg.kind).toBe("RepoDeleted");
    if (msg.kind !== "RepoDeleted") return;
    expect(msg.repo).toBe("my.repo-v2");
  });
});

describe("RepoCreated round-trip", () => {
  it("encodes and decodes repo, introduced_at, and introduced_by", async () => {
    const { priv, pub } = await makeKey();
    const frame = await signFrame("alice", "bob", {
      kind: "RepoCreated",
      repo: "my-project",
      introduced_at: "2026-10-02T09:00:00.000Z",
      introduced_by: "alice",
    }, priv);
    const msg = await verifyFrame(frame, pub);
    expect(msg.kind).toBe("RepoCreated");
    if (msg.kind !== "RepoCreated") return;
    expect(msg.repo).toBe("my-project");
    expect(msg.introduced_at).toBe("2026-10-02T09:00:00.000Z");
    expect(msg.introduced_by).toBe("alice");
  });
});

describe("RepoDeleted / RepoCreated tag isolation", () => {
  it("RepoDeleted and RepoCreated decode as distinct kinds", async () => {
    const { priv, pub } = await makeKey();
    const deleted = await signFrame("alice", "bob", {
      kind: "RepoDeleted",
      repo: "foo",
      deleted_at: "2026-10-01T00:00:00.000Z",
    }, priv);
    const created = await signFrame("alice", "bob", {
      kind: "RepoCreated",
      repo: "foo",
      introduced_at: "2026-10-02T00:00:00.000Z",
      introduced_by: "alice",
    }, priv);
    const d = await verifyFrame(deleted, pub);
    const c = await verifyFrame(created, pub);
    expect(d.kind).toBe("RepoDeleted");
    expect(c.kind).toBe("RepoCreated");
  });
});
