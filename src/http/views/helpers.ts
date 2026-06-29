// Pure helper functions shared across all view modules.
// No Daemon dependency — these are value-in, string-out.

// ---------- HTML escaping ----------

export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ---------- template fill ----------

/** Replace every {{key}} in a template string with vars[key]. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);
}

// ---------- dates ----------

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const mon = MONTHS[d.getMonth()]!;
  const day = String(d.getDate()).padStart(2, "0");
  const h   = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const sec = String(d.getSeconds()).padStart(2, "0");
  const thisYear = new Date().getFullYear();
  return d.getFullYear() === thisYear
    ? `${mon} ${day} ${h}:${min}:${sec}`
    : `${mon} ${day} ${d.getFullYear()} ${h}:${min}:${sec}`;
}

export function relativeAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(diff / 3_600_000);
  if (h < 24) return `${h}h`;
  const d = Math.floor(diff / 86_400_000);
  if (d < 14) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

export function isStale(iso: string): boolean {
  return Date.now() - new Date(iso).getTime() > 14 * 86_400_000;
}

// ---------- text ----------

export function textPreview(md: string, max = 140): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`[^`]+`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, " ")
    .trim()
    .slice(0, max);
}

export function renderMarkdown(md: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bunMd = (Bun as any).markdown;
  if (bunMd?.html) {
    try {
      return bunMd.html(md, { tables: true, strikethrough: true, tasklists: true }) as string;
    } catch { /* fall through */ }
  }
  return md.split(/\n\n+/).map((p) => `<p>${esc(p.trim())}</p>`).join("\n");
}

// ---------- CI status ----------

export function ciStatusBadge(status: string): string {
  switch (status) {
    case "passed":    return `<span class="ok">✓ pass</span>`;
    case "failed":    return `<span class="down">✗ fail</span>`;
    case "running":   return `<span class="running">● run</span>`;
    case "cancelled": return `<span class="down">✕ cancelled</span>`;
    default:          return `<span>${esc(status)}</span>`;
  }
}

// ---------- label colours ----------

const LABEL_COLORS = [
  { bg: "#dbeafe", dot: "#2563eb" },
  { bg: "#fce7f3", dot: "#db2777" },
  { bg: "#d1fae5", dot: "#059669" },
  { bg: "#fef3c7", dot: "#d97706" },
  { bg: "#ede9fe", dot: "#7c3aed" },
  { bg: "#fee2e2", dot: "#dc2626" },
  { bg: "#e0f2fe", dot: "#0284c7" },
];

export function labelColor(label: string): { bg: string; dot: string } {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (Math.imul(h, 31) + label.charCodeAt(i)) | 0;
  return LABEL_COLORS[Math.abs(h) % LABEL_COLORS.length]!;
}

// ---------- pagination ----------

const VALID_SIZES = [10, 20, 50, 100];

export function parsePage(raw: string | null): number {
  const n = parseInt(raw ?? "0", 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function parseSize(raw: string | null, defaultSize = 100): number {
  const n = parseInt(raw ?? String(defaultSize), 10);
  return VALID_SIZES.includes(n) ? n : defaultSize;
}

export function renderPagination(page: number, size: number, total: number, baseUrl: string): string {
  if (total === 0) return "";
  const totalPages = Math.ceil(total / size);
  const from = page * size + 1;
  const to = Math.min((page + 1) * size, total);

  const prevHref = page > 0 ? `${baseUrl}?page=${page - 1}&size=${size}` : null;
  const nextHref = page < totalPages - 1 ? `${baseUrl}?page=${page + 1}&size=${size}` : null;

  const sizeOptions = VALID_SIZES
    .map((s) => `<option value="${s}"${s === size ? " selected" : ""}>${s} per page</option>`)
    .join("");

  return `<div class="pagination">
  <span class="page-info">showing ${from}–${to} of ${total}</span>
  <form class="page-size-form" method="GET" action="${baseUrl}">
    <input type="hidden" name="page" value="0">
    <select name="size" onchange="this.form.submit()">${sizeOptions}</select>
  </form>
  ${prevHref ? `<a class="page-btn" href="${prevHref}">← prev</a>` : `<span class="page-btn disabled">← prev</span>`}
  <span class="page-num">${page + 1} / ${totalPages}</span>
  ${nextHref ? `<a class="page-btn" href="${nextHref}">next →</a>` : `<span class="page-btn disabled">next →</span>`}
</div>`;
}

export function renderLabelDots(labels: string[]): string {
  if (!labels.length) return "";
  return labels
    .map((l) => {
      const c = labelColor(l);
      return `<span class="dot" style="background:${c.dot}"></span><span>${esc(l)}</span>`;
    })
    .join(" ");
}
