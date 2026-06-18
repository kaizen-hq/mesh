// Cron expression parser, next-slot calculator, and distributed claim election.

import { sha256Hex } from "../proto.ts";
import type { CiState, CronClaim } from "./types.ts";

// ---------- expression types ----------

export type CronField =
  | { type: "any" }
  | { type: "value"; v: number }
  | { type: "range"; from: number; to: number }
  | { type: "step"; from: number; to: number; step: number }
  | { type: "list"; values: number[] };

export interface CronExpr {
  minute: CronField; // 0-59
  hour: CronField;   // 0-23
  dom: CronField;    // 1-31
  month: CronField;  // 1-12
  dow: CronField;    // 0-6 (Sunday=0)
}

// ---------- range bounds for each field ----------

const BOUNDS: Record<string, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
};

function parseField(s: string, field: string): CronField {
  const [min, max] = BOUNDS[field]!;

  if (s === "*") return { type: "any" };

  if (s.includes(",")) {
    const values = s.split(",").map((p) => {
      const n = parseInt(p, 10);
      if (isNaN(n) || n < min || n > max) throw new Error(`${field}: value ${p} out of range [${min},${max}]`);
      return n;
    });
    return { type: "list", values };
  }

  if (s.includes("/")) {
    const [rangePart, stepPart] = s.split("/", 2);
    const step = parseInt(stepPart!, 10);
    if (isNaN(step) || step <= 0) throw new Error(`${field}: invalid step ${stepPart}`);
    if (rangePart === "*") {
      return { type: "step", from: min, to: max, step };
    }
    if (rangePart!.includes("-")) {
      const [fromS, toS] = rangePart!.split("-", 2);
      const from = parseInt(fromS!, 10);
      const to = parseInt(toS!, 10);
      if (isNaN(from) || isNaN(to) || from < min || to > max || from > to)
        throw new Error(`${field}: invalid range ${rangePart}`);
      return { type: "step", from, to, step };
    }
    throw new Error(`${field}: invalid step expression ${s}`);
  }

  if (s.includes("-")) {
    const [fromS, toS] = s.split("-", 2);
    const from = parseInt(fromS!, 10);
    const to = parseInt(toS!, 10);
    if (isNaN(from) || isNaN(to) || from < min || to > max || from > to)
      throw new Error(`${field}: invalid range ${s}`);
    return { type: "range", from, to };
  }

  const n = parseInt(s, 10);
  if (isNaN(n) || n < min || n > max) throw new Error(`${field}: value ${s} out of range [${min},${max}]`);
  return { type: "value", v: n };
}

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

export function parseCron(expr: string): CronExpr {
  const resolved = ALIASES[expr];
  if (resolved !== undefined) return parseCron(resolved);
  if (expr.startsWith("@")) throw new Error(`unknown cron alias: ${expr}`);

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron expression must have 5 fields, got ${parts.length}`);
  const [minuteS, hourS, domS, monthS, dowS] = parts as [string, string, string, string, string];
  return {
    minute: parseField(minuteS, "minute"),
    hour: parseField(hourS, "hour"),
    dom: parseField(domS, "dom"),
    month: parseField(monthS, "month"),
    dow: parseField(dowS, "dow"),
  };
}

// ---------- field matching ----------

function matchesField(field: CronField, v: number): boolean {
  switch (field.type) {
    case "any": return true;
    case "value": return v === field.v;
    case "range": return v >= field.from && v <= field.to;
    case "step":
      if (v < field.from || v > field.to) return false;
      return (v - field.from) % field.step === 0;
    case "list": return field.values.includes(v);
  }
}

// ---------- next slot computation ----------

export function nextSlot(expr: CronExpr, from: Date): Date {
  // Start at the current minute (truncated to minute boundary).
  const start = new Date(from);
  start.setUTCSeconds(0, 0);

  // Walk forward up to ~2 years in minutes to find the next match.
  const MAX_ITERATIONS = 60 * 24 * 366 * 2;
  const candidate = new Date(start);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const minute = candidate.getUTCMinutes();
    const hour = candidate.getUTCHours();
    const dom = candidate.getUTCDate();
    const month = candidate.getUTCMonth() + 1; // 1-based
    const dow = candidate.getUTCDay();

    if (
      matchesField(expr.month, month) &&
      matchesField(expr.dom, dom) &&
      matchesField(expr.dow, dow) &&
      matchesField(expr.hour, hour) &&
      matchesField(expr.minute, minute)
    ) {
      return candidate;
    }

    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  throw new Error("no matching cron slot found within 2 years");
}

// ---------- slot key ----------

export function slotKey(repo: string, job: string, slot: Date): string {
  return `${repo}/${job}/${slot.toISOString()}`;
}

// ---------- distributed election ----------

// Deterministic tiebreaker: sort by sha256(claimer + slotKey) ascending.
export function electWinner(
  claims: Array<{ claimer: string; capability_hash: string }>,
  slot: string,
): string | null {
  if (claims.length === 0) return null;
  if (claims.length === 1) return claims[0]!.claimer;

  const ranked = [...claims].sort((a, b) => {
    const ha = sha256Hex(new TextEncoder().encode(a.claimer + slot));
    const hb = sha256Hex(new TextEncoder().encode(b.claimer + slot));
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
  return ranked[0]!.claimer;
}

// ---------- cron loop tick ----------

export interface CronJobSpec {
  repo: string;
  job: string;
  cron: string;
}

export interface CronFireEvent {
  repo: string;
  job: string;
  slot: Date;
  slotKey: string;
}

export function checkCronSlots(
  jobs: CronJobSpec[],
  ciState: CiState,
  now: Date,
  windowMs = 2000,
): CronFireEvent[] {
  const fires: CronFireEvent[] = [];

  for (const spec of jobs) {
    let expr: CronExpr;
    try {
      expr = parseCron(spec.cron);
    } catch {
      continue;
    }

    const slot = nextSlot(expr, now);
    // Only fire if the slot is within ±5s of now.
    const diff = Math.abs(slot.getTime() - now.getTime());
    if (diff > 5000) continue;

    const key = slotKey(spec.repo, spec.job, slot);
    if (ciState.cron_claims.has(key)) continue;

    const claim: CronClaim = {
      repo: spec.repo,
      job: spec.job,
      slot: key,
      claims: [],
      window_closes_at: now.getTime() + windowMs,
      started: false,
    };
    ciState.cron_claims.set(key, claim);
    fires.push({ repo: spec.repo, job: spec.job, slot, slotKey: key });
  }

  return fires;
}
