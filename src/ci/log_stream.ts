// Subprocess log capture, batching, and CiLog frame broadcast.

import type { Daemon } from "../daemon.ts";
import type { LogBuffer, LogChunk } from "./types.ts";
import { appendLogChunk } from "./store.ts";

// ---------- log buffer management ----------

export function getOrCreateBuffer(state: Daemon, runId: string): LogBuffer {
  let buf = state.ci.getLogBuffer(runId);
  if (!buf) {
    buf = { run_id: runId, chunks: [], next_seq: 0 };
    state.ci.setLogBuffer(buf);
  }
  return buf;
}

export function appendToBuffer(
  buf: LogBuffer,
  stream: "stdout" | "stderr",
  data: string,
): LogChunk {
  const chunk: LogChunk = {
    seq: buf.next_seq++,
    t: new Date().toISOString(),
    stream,
    data,
  };
  buf.chunks.push(chunk);
  return chunk;
}

// ---------- flush loop ----------

export function startFlushLoop(
  state: Daemon,
  runId: string,
  repo: string,
  intervalMs: number,
  broadcast: (chunk: LogChunk) => void,
): () => void {
  const buf = getOrCreateBuffer(state, runId);
  const timer = setInterval(async () => {
    await flushBuffer(state, buf, repo, broadcast);
  }, intervalMs || 500);
  buf.flush_timer = timer;
  return () => {
    clearInterval(timer);
    flushBuffer(state, buf, repo, broadcast).catch(() => {});
  };
}

async function flushBuffer(
  state: Daemon,
  buf: LogBuffer,
  repo: string,
  broadcast: (chunk: LogChunk) => void,
): Promise<void> {
  if (buf.chunks.length === 0) return;
  const chunks = buf.chunks.splice(0);
  for (const chunk of chunks) {
    await appendLogChunk(state.root, repo, buf.run_id, chunk.data);
    broadcast(chunk);
  }
}

// ---------- log capture from a Bun.Subprocess ----------

export async function captureProcessLogs(
  state: Daemon,
  runId: string,
  repo: string,
  proc: ReturnType<typeof Bun.spawn>,
  broadcast: (chunk: LogChunk) => void,
): Promise<void> {
  const buf = getOrCreateBuffer(state, runId);
  const dec = new TextDecoder();

  async function drain(stream: ReadableStream<Uint8Array>, kind: "stdout" | "stderr"): Promise<void> {
    const reader = stream.getReader();
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += dec.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const chunk = appendToBuffer(buf, kind, line + "\n");
        await appendLogChunk(state.root, repo, runId, chunk.data);
        broadcast(chunk);
      }
    }
    if (pending) {
      const chunk = appendToBuffer(buf, kind, pending);
      await appendLogChunk(state.root, repo, runId, chunk.data);
      broadcast(chunk);
    }
  }

  await Promise.all([drain(proc.stdout as ReadableStream<Uint8Array>, "stdout"), drain(proc.stderr as ReadableStream<Uint8Array>, "stderr")]);
}
