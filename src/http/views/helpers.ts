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

export function renderLabelDots(labels: string[]): string {
  if (!labels.length) return "";
  return labels
    .map((l) => {
      const c = labelColor(l);
      return `<span class="dot" style="background:${c.dot}"></span><span>${esc(l)}</span>`;
    })
    .join(" ");
}
