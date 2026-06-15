// Issue tracker: file-based issues stored as markdown + YAML frontmatter.
// Layout: {root}/issues/{repo}/{seq}-{authorShort}.md
// Comments appended with "::: comment {author} {created}" delimiter lines.

import * as nodePath from "node:path";
import * as fs from "node:fs/promises";
import type { IssueEvent } from "./proto.ts";

export type IssueStatus = "open" | "closed" | "trashed";

export interface IssueMeta {
  id: string;
  title: string;
  status: IssueStatus;
  labels: string[];
  created: string; // ISO 8601
  updated: string; // ISO 8601 — last meta change; drives last-writer-wins merge
  order: number;   // sort key; lower = higher priority; fractional indexing
  author: string;  // short pubkey
}

// Serializable form for wire transfer (no local filePath).
export interface IssueWire {
  meta: IssueMeta;
  body: string;
  comments: IssueComment[];
}

export interface IssueComment {
  author: string;
  created: string;
  body: string; // raw markdown
}

export interface Issue {
  meta: IssueMeta;
  body: string;    // raw markdown
  comments: IssueComment[];
  filePath: string;
}

// ---------- path helpers ----------

export function issuesDir(root: string, repo: string): string {
  return nodePath.join(root, "issues", repo);
}

// ---------- minimal YAML frontmatter parser ----------
// Only handles the flat key-value shape we write. No multi-line strings.

function parseFrontmatterYaml(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of yaml.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    if (!key || !raw) continue;
    // Inline array: [a, "b", c]
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const inner = raw.slice(1, -1).trim();
      out[key] = inner
        ? inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
        : [];
    // Quoted string
    } else if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      out[key] = raw.slice(1, -1);
    // Number (int or float)
    } else if (raw !== "" && !isNaN(Number(raw))) {
      out[key] = Number(raw);
    } else {
      out[key] = raw;
    }
  }
  return out;
}

// ---------- parse / serialize ----------

const COMMENT_LINE = /^::: comment (\S+) (\S+)$/m;

function parseIssueFile(text: string, filePath: string): Issue {
  // Extract YAML frontmatter between opening and closing ---
  let meta: IssueMeta = { id: "", title: "", status: "open", labels: [], created: "", updated: "", order: 0, author: "" };
  let rest = text;

  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end !== -1) {
      const yaml = text.slice(4, end);
      const p = parseFrontmatterYaml(yaml);
      const created = String(p.created ?? "");
      meta = {
        id: String(p.id ?? ""),
        title: String(p.title ?? ""),
        status: p.status === "closed" ? "closed" : p.status === "trashed" ? "trashed" : "open",
        labels: Array.isArray(p.labels) ? p.labels.map(String) : [],
        created,
        updated: String(p.updated ?? created), // fall back to created for older files
        order: typeof p.order === "number" ? p.order : Date.parse(created) || 0, // fall back to creation time for older files
        author: String(p.author ?? ""),
      };
      rest = text.slice(end + 5); // skip trailing "\n---\n"
    }
  }

  // Split on "::: comment author created" lines
  const parts = rest.split(COMMENT_LINE);
  // parts layout: [body, author1, created1, body1, author2, created2, body2, ...]
  const body = (parts[0] ?? "").trim();
  const comments: IssueComment[] = [];
  for (let i = 1; i + 2 < parts.length; i += 3) {
    comments.push({
      author: parts[i]!,
      created: parts[i + 1]!,
      body: parts[i + 2]!.trim(),
    });
  }

  return { meta, body, comments, filePath };
}

function serializeFrontmatter(meta: IssueMeta): string {
  const labels =
    meta.labels.length > 0
      ? `[${meta.labels.map((l) => JSON.stringify(l)).join(", ")}]`
      : "[]";
  return [
    "---",
    `id: ${meta.id}`,
    `title: ${JSON.stringify(meta.title)}`,
    `status: ${meta.status}`,
    `labels: ${labels}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `order: ${meta.order}`,
    `author: ${meta.author}`,
    "---",
  ].join("\n");
}

function serializeIssueFile(issue: Issue): string {
  let text = serializeFrontmatter(issue.meta) + "\n\n" + issue.body;
  for (const c of issue.comments) {
    text += `\n\n::: comment ${c.author} ${c.created}\n\n${c.body}`;
  }
  return text;
}

// ---------- sequence number ----------

async function nextSeq(dir: string): Promise<number> {
  let max = 0;
  try {
    const entries = await fs.readdir(dir);
    for (const e of entries) {
      if (!e.endsWith(".md")) continue;
      const n = parseInt(e, 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  } catch {
    // directory may not exist yet
  }
  return max + 1;
}

// ---------- public API ----------

export async function listIssues(root: string, repo: string): Promise<Issue[]> {
  const dir = issuesDir(root, repo);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const issues: Issue[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const fp = nodePath.join(dir, entry);
    try {
      const text = await fs.readFile(fp, "utf8");
      issues.push(parseIssueFile(text, fp));
    } catch {
      // skip unreadable files
    }
  }
  issues.sort((a, b) => a.meta.order - b.meta.order);
  return issues;
}

export async function readIssue(
  root: string,
  repo: string,
  id: string,
): Promise<Issue | null> {
  const fp = nodePath.join(issuesDir(root, repo), `${id}.md`);
  try {
    const text = await fs.readFile(fp, "utf8");
    return parseIssueFile(text, fp);
  } catch {
    return null;
  }
}

export async function createIssue(
  root: string,
  repo: string,
  authorShort: string,
  title: string,
  body: string,
  labels: string[],
): Promise<Issue> {
  const dir = issuesDir(root, repo);
  await fs.mkdir(dir, { recursive: true });
  const seq = await nextSeq(dir);
  const id = `${String(seq).padStart(4, "0")}-${authorShort}`;
  const created = new Date().toISOString();
  const meta: IssueMeta = { id, title, status: "open", labels, created, updated: created, order: Date.now(), author: authorShort };
  const filePath = nodePath.join(dir, `${id}.md`);
  const issue: Issue = { meta, body, comments: [], filePath };
  await fs.writeFile(filePath, serializeIssueFile(issue), "utf8");
  return issue;
}

export async function addComment(
  root: string,
  repo: string,
  id: string,
  authorShort: string,
  body: string,
  created: string = new Date().toISOString(),
): Promise<{ created: string }> {
  const issue = await readIssue(root, repo, id);
  if (!issue) throw new Error(`issue ${id} not found`);
  // Idempotent: skip if this (author, created) pair already exists
  const exists = issue.comments.some((c) => c.author === authorShort && c.created === created);
  if (!exists) {
    issue.comments.push({ author: authorShort, created, body });
    issue.comments.sort((a, b) => a.created.localeCompare(b.created));
    await fs.writeFile(issue.filePath, serializeIssueFile(issue), "utf8");
  }
  return { created };
}

export async function setStatus(
  root: string,
  repo: string,
  id: string,
  status: IssueStatus,
  updated: string = new Date().toISOString(),
): Promise<void> {
  const issue = await readIssue(root, repo, id);
  if (!issue) throw new Error(`issue ${id} not found`);
  // Last-writer-wins: only apply if this event is newer than the current updated timestamp
  if (issue.meta.updated && updated <= issue.meta.updated) return;
  issue.meta.status = status;
  issue.meta.updated = updated;
  await fs.writeFile(issue.filePath, serializeIssueFile(issue), "utf8");
}

export async function setOrder(
  root: string,
  repo: string,
  id: string,
  order: number,
): Promise<void> {
  const issue = await readIssue(root, repo, id);
  if (!issue) throw new Error(`issue ${id} not found`);
  issue.meta.order = order;
  await fs.writeFile(issue.filePath, serializeIssueFile(issue), "utf8");
}

// ---------- wire serialization ----------

export function toWire(issue: Issue): IssueWire {
  return { meta: issue.meta, body: issue.body, comments: issue.comments };
}

export async function listIssuesAsWire(root: string, repo: string): Promise<IssueWire[]> {
  const all = await listIssues(root, repo);
  return all.map(toWire);
}

// ---------- incoming event application ----------

export async function applyIssueEvent(root: string, event: IssueEvent): Promise<void> {
  const dir = issuesDir(root, event.repo);

  if (event.type === "IssueCreated") {
    const existing = await readIssue(root, event.repo, event.id);
    if (existing) return; // idempotent
    await fs.mkdir(dir, { recursive: true });
    const filePath = nodePath.join(dir, `${event.id}.md`);
    const meta: IssueMeta = {
      id: event.id,
      title: event.title,
      status: "open",
      labels: event.labels,
      created: event.created,
      updated: event.created,
      order: Date.parse(event.created) || Date.now(),
      author: event.author,
    };
    const issue: Issue = { meta, body: event.body, comments: [], filePath };
    await fs.writeFile(filePath, serializeIssueFile(issue), "utf8");
    return;
  }

  if (event.type === "IssueCommented") {
    await addComment(root, event.repo, event.id, event.author, event.body, event.created);
    return;
  }

  if (event.type === "IssueStatusChanged") {
    try {
      await setStatus(root, event.repo, event.id, event.status, event.updated);
    } catch {
      // issue may not exist yet on this node — ignore
    }
    return;
  }

  if (event.type === "IssueReordered") {
    try {
      await setOrder(root, event.repo, event.id, event.order);
    } catch {
      // issue may not exist yet on this node — ignore
    }
  }
}

// ---------- full sync merge ----------

const commentKey = (c: IssueComment) => `${c.author}|${c.created}`;

export async function mergeFromPeer(root: string, repo: string, peerIssues: IssueWire[]): Promise<void> {
  for (const pw of peerIssues) {
    const local = await readIssue(root, repo, pw.meta.id);

    if (!local) {
      // New to us — write it directly
      const dir = issuesDir(root, repo);
      await fs.mkdir(dir, { recursive: true });
      const filePath = nodePath.join(dir, `${pw.meta.id}.md`);
      await fs.writeFile(filePath, serializeIssueFile({ ...pw, filePath }), "utf8");
      continue;
    }

    let changed = false;
    const merged: Issue = { ...local, meta: { ...local.meta } };

    // Meta: last-writer-wins by updated timestamp
    if (pw.meta.updated > local.meta.updated) {
      merged.meta = { ...pw.meta };
      merged.body = pw.body;
      changed = true;
    }

    // Comments: union by (author, created) — both concurrent comments survive
    const commentMap = new Map(local.comments.map((c) => [commentKey(c), c]));
    for (const c of pw.comments) {
      if (!commentMap.has(commentKey(c))) {
        commentMap.set(commentKey(c), c);
        changed = true;
      }
    }

    if (changed) {
      merged.comments = [...commentMap.values()].sort((a, b) => a.created.localeCompare(b.created));
      await fs.writeFile(local.filePath, serializeIssueFile(merged), "utf8");
    }
  }
}
