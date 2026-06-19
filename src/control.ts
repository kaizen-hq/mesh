// Unix-domain socket at ~/.mesh/sock that the CLI subcommands talk to.
// Protocol: newline-delimited JSON.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import type { DaemonState } from "./state.ts";
import * as repoStore from "./repo_store.ts";
import { onRefUpdate } from "./ci/scheduler.ts";

import {
  loadConfig,
  addPeerToConfig,
  addRepoToConfig,
  normalizePeerUrl,
  savePendingInvites,
} from "./config.ts";
import { loadSecretsConfig, detectTools } from "./ci/config.ts";
import {
  buildInviteToken,
  buildJoinRequest,
  decodeInviteToken,
  encodeInviteToken,
  nonceHex,
  verifyInviteToken,
  type JoinResponse,
} from "./invite.ts";
import { decodePubkey, encodePubkey } from "./proto.ts";

export interface ControlRequest {
  type: string;
  [k: string]: unknown;
}

export interface ControlResponse {
  type: string;
  [k: string]: unknown;
}

export async function run(state: DaemonState): Promise<net.Server> {
  const sockPath = path.join(state.root, "sock");
  try {
    await fs.unlink(sockPath);
  } catch {
    // ignore
  }
  // `allowHalfOpen: true` lets the server keep its writable side open after
  // the client sends FIN (which it does immediately via `sock.end()` after
  // the request). Without this Node auto-closes the writable side and our
  // response write hits EPIPE.
  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    let buf = "";
    let processing = false;
    let clientEnded = false;

    const tryProcess = async () => {
      if (processing) return;
      const nl = buf.indexOf("\n");
      if (nl === -1) {
        // No complete request; if the client also ended, nothing left to do.
        if (clientEnded && !sock.destroyed) sock.end();
        return;
      }
      processing = true;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) {
        processing = false;
        // Recurse in case there are more newlines already buffered.
        void tryProcess();
        return;
      }
      try {
        const req = JSON.parse(line) as ControlRequest;
        const resp = await dispatch(state, req);
        await writeJson(sock, resp);
      } catch (e) {
        await writeJson(sock, {
          type: "error",
          message: (e as Error).message ?? String(e),
        });
      }
      if (!sock.destroyed) sock.end();
    };

    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      void tryProcess();
    });
    sock.on("end", () => {
      clientEnded = true;
      // Only close immediately if there's nothing in flight and nothing
      // buffered. Otherwise tryProcess will close after responding.
      if (!processing && buf.indexOf("\n") === -1 && !sock.destroyed) {
        sock.end();
      }
    });
    sock.on("error", () => {
      // ignore — peer disconnected
    });
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(sockPath, () => res());
  });
  // Restrict socket to owner-only so other local users cannot send control commands.
  await fs.chmod(sockPath, 0o600);
  console.log(`control socket listening at ${sockPath}`);
  return server;
}

async function dispatch(state: DaemonState, req: ControlRequest): Promise<ControlResponse> {
  const now = Date.now();
  switch (req.type) {
    case "status": {
      return {
        type: "status",
        name: state.config.self.name,
        listen: "127.0.0.1:7979",
        peers: peerSummaries(state, now),
        repos: await repoSummaries(state, now),
        config_hash: state.config.raw_hash,
      };
    }
    case "peers":
      return { type: "peers", peers: peerSummaries(state, now) };
    case "repos":
      return { type: "repos", repos: await repoSummaries(state, now) };
    case "sync":
      try {
        await repoStore.fetchAll(state);
        return { type: "ok" };
      } catch (e) {
        return { type: "error", message: (e as Error).message };
      }
    case "stop":
      state.signalShutdown();
      return { type: "ok" };
    case "reload":
      try {
        const next = await loadConfig(path.join(state.root, "mesh.toml"));
        state.config = next;
        state.refreshPeers();
        await repoStore.ensureMirrors(state);
        state.ciSecrets = await loadSecretsConfig(state.root);
        const tools = await detectTools(next.runner.tools.length > 0 ? next.runner.tools : undefined);
        if (state.ciCapabilities) {
          state.ciCapabilities.labels = next.runner.labels;
          state.ciCapabilities.runner = next.runner.enabled;
          state.ciCapabilities.tools = tools;
        }
        return { type: "ok" };
      } catch (e) {
        return { type: "error", message: (e as Error).message };
      }
    case "add_peer":
      return {
        type: "error",
        message: "mesh add-peer: not yet implemented (edit mesh.toml and `mesh reload`)",
      };
    case "add_address": {
      const peer = String(req.peer ?? "");
      const address = String(req.address ?? "");
      if (!state.peers.has(peer)) {
        return { type: "error", message: `peer ${peer} not in mesh.toml roster` };
      }
      if (!address.includes(":")) {
        return { type: "error", message: `address ${address} must be host:port` };
      }
      await state.recordPeerAddress(peer, address);
      return { type: "ok" };
    }
    case "add_peer": {
      const name = String(req.name ?? "").trim();
      const pubkey = String(req.pubkey ?? "").trim();
      const address = req.address ? String(req.address).trim() : undefined;
      if (!name || !pubkey) {
        return { type: "error", message: "add_peer requires name and pubkey" };
      }
      try {
        decodePubkey(pubkey);
      } catch (e) {
        return { type: "error", message: `bad pubkey: ${(e as Error).message}` };
      }
      if (address && !address.includes(":")) {
        return { type: "error", message: `address ${address} must be host:port` };
      }
      const cfgPath = path.join(state.root, "mesh.toml");
      try {
        const changed = await addPeerToConfig(cfgPath, { name, pubkey, addresses: address ? [address] : [] });
        const next = await loadConfig(cfgPath);
        state.config = next;
        state.refreshPeers();
        if (address) await state.recordPeerAddress(name, address);
        return { type: "ok", changed } as ControlResponse;
      } catch (e) {
        return { type: "error", message: (e as Error).message };
      }
    }
    case "add_repo": {
      const name = String(req.name ?? "").trim();
      const repoPath = String(req.path ?? "").trim();
      const branches = Array.isArray(req.branches)
        ? (req.branches as unknown[]).map((b) => String(b))
        : [];
      if (!name || !repoPath) {
        return { type: "error", message: "add_repo requires name and path" };
      }
      const cfgPath = path.join(state.root, "mesh.toml");
      try {
        const changed = await addRepoToConfig(cfgPath, { name, path: repoPath, branches });
        const next = await loadConfig(cfgPath);
        state.config = next;
        state.refreshPeers();
        await repoStore.ensureMirrors(state);
        return { type: "ok", changed } as ControlResponse;
      } catch (e) {
        return { type: "error", message: (e as Error).message };
      }
    }
    case "invite": {
      const ttlSecs = Number(req.ttl_secs ?? 600);
      const address = String(req.address ?? "").trim() || inferReachableAddress(state);
      if (!address || !address.includes(":")) {
        return {
          type: "error",
          message: "invite requires a host:port address (pass --addr or set listen explicitly)",
        };
      }
      try {
        const token = await buildInviteToken({
          inviterPubkey: state.identity.publicKey,
          inviterName: state.config.self.name,
          address,
          ttlSecs,
          signingKey: state.identity.privateKey,
        });
        state.pendingInvites.set(nonceHex(token.nonce), {
          expiryMs: token.expiryMs,
          address,
        });
        sweepExpiredInvites(state);
        await savePendingInvites(state.root, state.pendingInvites);
        return {
          type: "invite",
          token: encodeInviteToken(token),
          expires_at_ms: token.expiryMs,
          address,
        };
      } catch (e) {
        return { type: "error", message: (e as Error).message };
      }
    }
    case "join": {
      const tokenStr = String(req.token ?? "").trim();
      if (!tokenStr) return { type: "error", message: "join requires token" };
      let parsed;
      try {
        parsed = decodeInviteToken(tokenStr);
        await verifyInviteToken(parsed);
      } catch (e) {
        return { type: "error", message: `invite: ${(e as Error).message}` };
      }
      if (parsed.inviterName === state.config.self.name) {
        return { type: "error", message: "cannot join with an invite from yourself" };
      }
      const inviterPubkeyStr = encodePubkey(parsed.inviterPubkey);
      const cfgPath = path.join(state.root, "mesh.toml");
      try {
        await addPeerToConfig(cfgPath, {
          name: parsed.inviterName,
          pubkey: inviterPubkeyStr,
          addresses: [parsed.address],
        });
        const next = await loadConfig(cfgPath);
        state.config = next;
        state.refreshPeers();
        await state.recordPeerAddress(parsed.inviterName, parsed.address);
      } catch (e) {
        return { type: "error", message: `mesh.toml update failed: ${(e as Error).message}` };
      }

      const joinReq = await buildJoinRequest({
        nonce: parsed.nonce,
        joinerName: state.config.self.name,
        joinerPubkey: state.identity.publicKey,
        signingKey: state.identity.privateKey,
      });
      const { baseUrl } = normalizePeerUrl(parsed.address, state.config.transport.tls);
      let resp: JoinResponse;
      try {
        const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(joinReq),
          tls: { rejectUnauthorized: false },
        };
        const r = await fetch(`${baseUrl}/mesh/join`, init);
        resp = (await r.json()) as JoinResponse;
        if (!r.ok || !resp.ok) {
          return {
            type: "error",
            message: `inviter rejected join: ${resp.error ?? r.statusText}`,
          };
        }
      } catch (e) {
        return { type: "error", message: `join POST failed: ${(e as Error).message}` };
      }
      return {
        type: "join",
        inviter_name: parsed.inviterName,
        inviter_pubkey: inviterPubkeyStr,
        inviter_address: parsed.address,
      };
    }
    case "reset_repo": {
      const name = String(req.name ?? "");
      try {
        await repoStore.resetRepo(state, name);
        return { type: "ok" };
      } catch (e) {
        return { type: "error", message: (e as Error).message };
      }
    }
    // ---------- CI commands ----------
    case "ci_status": {
      const repo = req.repo ? String(req.repo) : null;
      const { listRuns, loadRun } = await import("./ci/store.ts");
      const repos = repo
        ? state.config.repos.filter((r) => r.name === repo)
        : state.config.repos;
      const runList: unknown[] = [];
      for (const r of repos) {
        const entries = await listRuns(state.root, r.name);
        for (const e of entries.slice(0, 10)) {
          const run = await loadRun(state.root, r.name, e.run_id);
          if (run) runList.push(run);
        }
      }
      return { type: "ci_status", runs: runList };
    }
    case "ci_run": {
      const repo = String(req.repo ?? "");
      const ref = String(req.ref ?? "");
      if (!repo || !ref) return { type: "error", message: "ci_run requires repo and ref" };
      void onRefUpdate(state, repo, ref, ref).catch(() => {});
      return { type: "ok" };
    }
    case "ci_logs": {
      const repo = String(req.repo ?? "");
      const runId = String(req.run_id ?? "");
      if (!repo || !runId) return { type: "error", message: "ci_logs requires repo and run_id" };
      const { readLog } = await import("./ci/store.ts");
      const log = await readLog(state.root, repo, runId);
      return { type: "ci_logs", log };
    }
    case "ci_cancel": {
      const runId = String(req.run_id ?? "");
      const run = state.ci.runs.get(runId);
      if (!run) return { type: "error", message: `run ${runId} not found` };
      run.status = "cancelled";
      run.completed_at = new Date().toISOString();
      state.notifyCiRunChanged(run.repo);
      return { type: "ok" };
    }
    case "ci_runners": {
      const runners: unknown[] = [];
      for (const [name, peer] of state.peers.entries()) {
        if (!peer.capabilities) continue;
        runners.push({
          name,
          runner: peer.capabilities.runner,
          labels: peer.capabilities.labels,
          tools: peer.capabilities.tools,
          load: peer.capabilities.load,
        });
      }
      return { type: "ci_runners", runners };
    }
    default:
      return { type: "error", message: `unknown command: ${req.type}` };
  }
}

function peerSummaries(state: DaemonState, now: number): unknown[] {
  return state.config.peers
    .filter((p) => p.name !== state.config.self.name)
    .map((p) => {
      const e = state.peers.get(p.name);
      const last = e?.lastHeartbeat ? Math.floor((now - e.lastHeartbeat) / 1000) : null;
      return {
        name: p.name,
        pubkey: p.pubkey,
        last_heartbeat_secs: last,
        address: e?.addresses[0] ?? null,
        reachable: e?.isConnected() ?? false,
        config_hash_match:
          e?.lastConfigHash == null ? null : e.lastConfigHash === state.config.raw_hash,
      };
    });
}

async function repoSummaries(state: DaemonState, now: number): Promise<unknown[]> {
  const contributed = new Set(state.config.repos.map((r) => r.name));
  const allNames = new Set<string>(contributed);
  for (const k of state.repos.keys()) allNames.add(k);
  return [...allNames].sort().map((name) => {
    const local = state.repos.get(name);
    const cfg_entry = state.config.repos.find((r) => r.name === name);
    return {
      name,
      contributed: contributed.has(name),
      sources: local?.sourceList() ?? [],
      local_head: local?.lastHead ?? null,
      last_fetch_secs: local?.lastFetch ? Math.floor((now - local.lastFetch) / 1000) : null,
      branches: cfg_entry?.branches ?? [],
      divergences:
        local?.divergenceList().map((d) => ({
          peer: d.peer,
          branch: d.branch,
          replica_ref: d.replica_ref,
          their_sha: d.their_sha,
        })) ?? [],
    };
  });
}

function inferReachableAddress(state: DaemonState): string {
  const listen = state.listenAddr;
  if (!listen) return "";
  // listen is "host:port" — if host is wildcard (0.0.0.0 / ::) we can't put it
  // in a token because the joiner won't be able to reach it. Caller must pass
  // --addr explicitly in that case.
  const [host, port] = splitHostPort(listen);
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]") return "";
  return `${host}:${port}`;
}

function splitHostPort(s: string): [string, string] {
  const idx = s.lastIndexOf(":");
  if (idx < 0) return ["", s];
  return [s.slice(0, idx), s.slice(idx + 1)];
}

function sweepExpiredInvites(state: DaemonState): void {
  const now = Date.now();
  for (const [k, v] of state.pendingInvites) {
    if (v.expiryMs < now) state.pendingInvites.delete(k);
  }
}

async function writeJson(sock: net.Socket, resp: ControlResponse): Promise<void> {
  if (sock.destroyed) {
    console.warn("control: skipping write — socket destroyed");
    return;
  }
  try {
    await new Promise<void>((res, rej) => {
      sock.write(JSON.stringify(resp) + "\n", (err) => (err ? rej(err) : res()));
    });
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
      console.warn("control: write swallowed", code);
      return;
    }
    throw e;
  }
}

// ---------- client side: used by CLI subcommands ----------

export async function sendRequest(root: string, req: ControlRequest): Promise<ControlResponse> {
  const sockPath = path.join(root, "sock");
  return await new Promise<ControlResponse>((res, rej) => {
    const sock = net.createConnection({ path: sockPath, allowHalfOpen: true }, () => {
      // Write the request; do NOT call sock.end() here. The server reads up to
      // the first newline and then ends the socket itself after responding.
      // Calling end() on this side immediately triggers a FIN that, with some
      // half-open implementations, causes the server's writable side to close
      // before its response goes out.
      sock.write(JSON.stringify(req) + "\n", (err) => {
        if (err) {
          rej(err);
          sock.destroy();
        }
      });
    });
    let buf = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // Resolve as soon as we get a complete line, even before 'end' fires.
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        if (line) {
          try {
            const parsed = JSON.parse(line) as ControlResponse;
            settle(() => res(parsed));
            sock.end(); // ack and close
          } catch (e) {
            settle(() => rej(e));
            sock.destroy();
          }
        }
      }
    });
    sock.on("end", () => {
      settle(() =>
        rej(new Error("server closed connection without responding")),
      );
    });
    sock.on("error", (e) => settle(() => rej(e)));
  });
}
