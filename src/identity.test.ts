import { describe, it, expect, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { ensureTlsCert } from "./identity.ts";

describe("ensureTlsCert", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("generates a valid ECDSA P-256 self-signed cert", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-tls-test-"));
    const { cert, key } = await ensureTlsCert(tmpDir);

    expect(cert).toContain("-----BEGIN CERTIFICATE-----");
    expect(key).toContain("-----BEGIN PRIVATE KEY-----");

    const x509 = new X509Certificate(cert);
    expect(x509.subject).toBe("CN=mesh.local");
    expect(x509.issuer).toBe("CN=mesh.local");
    expect(x509.publicKey.asymmetricKeyType).toBe("ec");
    expect(x509.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  });

  it("is idempotent — repeated calls return the same cert", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-tls-test-"));
    const first = await ensureTlsCert(tmpDir);
    const second = await ensureTlsCert(tmpDir);
    expect(second.cert).toBe(first.cert);
    expect(second.key).toBe(first.key);
  });

  it("writes key.pem with mode 0600", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-tls-test-"));
    await ensureTlsCert(tmpDir);
    const stat = await fs.stat(path.join(tmpDir, "tls", "key.pem"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("cert is accepted by Bun.serve as a TLS certificate", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-tls-test-"));
    const { cert, key } = await ensureTlsCert(tmpDir);

    // If the cert/key are malformed Bun.serve will throw synchronously.
    const server = Bun.serve({
      port: 0,
      tls: { cert, key },
      fetch() { return new Response("ok"); },
    });
    server.stop(true);
  });
});
