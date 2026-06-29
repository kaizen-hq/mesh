// Issues board rendering — pure functions, no Daemon dependency.

import { esc, fill, relativeAge, isStale, textPreview, renderMarkdown, labelColor, renderLabelDots } from "./helpers.ts";
import type { Issue } from "../../issues.ts";

// ---------- single card ----------

export function renderCard(issue: Issue, repo: string): string {
  const { meta, body, comments } = issue;
  const firstLabel = meta.labels[0];
  const cardBg = firstLabel ? labelColor(firstLabel).bg : "#f8f9fa";
  const staleClass = isStale(meta.created) ? " stale" : "";
  const age = relativeAge(meta.created);
  const replyText =
    comments.length === 0 ? "" :
    comments.length === 1 ? " &middot; 1 reply" :
    ` &middot; ${comments.length} replies`;
  const statusVal = meta.status === "open" ? "closed" : "open";
  const actionLabel = meta.status === "open" ? "done" : "reopen";
  const preview = esc(textPreview(body));

  const commentsHtml = comments.length
    ? `<div class="comments">${comments.map((c) => `
        <div class="comment">
          <div class="comment-meta">${esc(c.author)} &middot; ${relativeAge(c.created)}</div>
          <div class="comment-body">${renderMarkdown(c.body)}</div>
        </div>`).join("")}
      </div>`
    : "";

  return `
<article class="card${staleClass}" draggable="true" data-id="${esc(meta.id)}" data-status="${meta.status}" data-labels="${esc(meta.labels.join(","))}" data-order="${meta.order}" style="--card-tint:${cardBg}" id="${esc(meta.id)}">
  <header class="card-header" onclick="toggleCard('${esc(meta.id)}')">
    <div class="card-labels">${renderLabelDots(meta.labels)}</div>
    <h3 class="card-title">${esc(meta.title)}</h3>
    ${preview ? `<p class="card-preview">${preview}</p>` : ""}
  </header>
  <footer class="card-footer">
    <span class="card-meta">${age}${replyText}</span>
    <form method="POST" action="/repos/${esc(repo)}/issues/${esc(meta.id)}/status">
      <input type="hidden" name="status" value="${statusVal}">
      <button class="btn-action" type="submit">${actionLabel}</button>
    </form>
  </footer>
  <div class="card-detail" hidden>
    <div class="card-body">${renderMarkdown(body)}</div>
    ${commentsHtml}
    <form class="reply-form" method="POST" action="/repos/${esc(repo)}/issues/${esc(meta.id)}/comment">
      <textarea name="body" placeholder="add a reply..." rows="3"></textarea>
      <button class="btn-action" type="submit">reply</button>
    </form>
    <div class="card-danger">
      <button class="btn-trash" type="button" onclick="trashCard('${esc(meta.id)}', '${esc(repo)}')">trash</button>
    </div>
  </div>
</article>`;
}

// ---------- board grid (also used for SSE fragment refresh) ----------

export function renderBoardGridForRepo(all: Issue[], repo: string): string {
  const cards = all.map((issue) => renderCard(issue, repo)).join("\n");
  return `<div id="board" class="board">
${cards}
<article class="card card-new">
  <form method="POST" action="/repos/${esc(repo)}/issues">
    <input type="text" name="title" placeholder="title" required autocomplete="off">
    <textarea name="body" placeholder="describe the issue..." rows="3"></textarea>
    <div class="new-footer">
      <input type="text" name="labels" placeholder="labels, comma-separated" class="new-labels">
      <button class="btn-action" type="submit">post</button>
    </div>
  </form>
</article>
</div>`;
}

// ---------- full board page ----------

export function renderBoardPage(template: string, me: string, repo: string, all: Issue[], pagination: string): string {
  const labels = collectLabels(all);
  const chipHtml = labels.map((l) => {
    const c = labelColor(l);
    return `<button class="chip" data-label-chip="${esc(l)}" onclick="toggleLabel('${esc(l)}')" type="button"><span class="dot" style="background:${c.dot}"></span>${esc(l)}</button>`;
  }).join("\n");

  return fill(template, {
    me: esc(me),
    repo: esc(repo),
    repo_enc: encodeURIComponent(repo),
    filter_chips: chipHtml,
    board: renderBoardGridForRepo(all, repo),
    pagination,
  });
}

function collectLabels(all: Issue[]): string[] {
  const seen = new Set<string>();
  for (const issue of all) for (const l of issue.meta.labels) seen.add(l);
  return [...seen].sort();
}
