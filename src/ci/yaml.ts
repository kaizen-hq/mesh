// Minimal YAML parser for mesh-ci.yml config files.
// Supports: block mappings, block sequences, flow sequences, scalars.
// Does not support: anchors, multi-line strings, flow mappings, tags.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type YamlValue = string | number | boolean | null | any[] | Record<string, any>;

// ---------- preprocessing ----------

interface Line {
  indent: number; // -1 means blank or comment
  text: string;   // trimmed content (inline comments removed)
}

function preprocessLines(src: string): Line[] {
  return src.split("\n").map((raw) => {
    const stripped = raw.trimEnd();
    const trimmed = stripped.trimStart();
    if (!trimmed || trimmed.startsWith("#")) {
      return { indent: -1, text: "" };
    }
    const indent = stripped.length - trimmed.length;
    return { indent, text: stripInlineComment(trimmed) };
  });
}

function stripInlineComment(s: string): string {
  let inQuote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inQuote) {
      if (c === "\\" && inQuote === '"') { i++; continue; }
      if (c === inQuote) inQuote = null;
    } else {
      if (c === '"' || c === "'") inQuote = c;
      else if (c === "#" && i > 0 && s[i - 1] === " ") return s.slice(0, i - 1).trimEnd();
    }
  }
  return s;
}

// ---------- parser state ----------

interface ParseState {
  lines: Line[];
  pos: number;
}

function peek(st: ParseState): Line | null {
  let p = st.pos;
  while (p < st.lines.length && st.lines[p]!.indent === -1) p++;
  if (p >= st.lines.length) return null;
  st.pos = p; // skip blanks
  return st.lines[p]!;
}

// ---------- colon finder (key: value split) ----------

function findMappingColon(text: string): number {
  let inQuote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuote) {
      if (c === "\\" && inQuote === '"') { i++; continue; }
      if (c === inQuote) inQuote = null;
    } else {
      if (c === '"' || c === "'") inQuote = c;
      else if (c === ":" && (i + 1 >= text.length || text[i + 1] === " ")) return i;
    }
  }
  return -1;
}

// ---------- scalar parsers ----------

export function parseScalar(s: string): string | number | boolean | null {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~" || s === "") return null;
  if (s.startsWith('"') && s.endsWith('"')) return parseDoubleQuoted(s.slice(1, -1));
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  const n = Number(s);
  if (!isNaN(n) && s.trim() !== "") return n;
  return s;
}

function parseDoubleQuoted(inner: string): string {
  let result = "";
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "\\") {
      i++;
      switch (inner[i]) {
        case "n": result += "\n"; break;
        case "t": result += "\t"; break;
        case "r": result += "\r"; break;
        default: result += inner[i];
      }
    } else {
      result += inner[i];
    }
    i++;
  }
  return result;
}

export function parseFlowSeq(s: string): YamlValue[] {
  const end = s.indexOf("]");
  if (end === -1) throw new Error(`unterminated flow sequence: ${s}`);
  const inner = s.slice(1, end).trim();
  if (!inner) return [];

  const result: YamlValue[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && (inner[i] === " " || inner[i] === ",")) i++;
    if (i >= inner.length) break;

    if (inner[i] === '"' || inner[i] === "'") {
      const q = inner[i]!;
      i++;
      let s2 = "";
      while (i < inner.length && inner[i] !== q) {
        if (inner[i] === "\\" && q === '"') { i++; s2 += inner[i]; }
        else s2 += inner[i];
        i++;
      }
      i++; // close quote
      result.push(s2);
    } else {
      let val = "";
      while (i < inner.length && inner[i] !== "," && inner[i] !== "]") {
        val += inner[i]; i++;
      }
      result.push(parseScalar(val.trim()));
    }
  }
  return result;
}

// ---------- block parsers ----------

function parseBlock(st: ParseState, minIndent: number): YamlValue {
  const first = peek(st);
  if (!first || first.indent < minIndent) return null;
  if (first.text.startsWith("- ") || first.text === "-") {
    return parseBlockSeq(st, first.indent);
  }
  return parseBlockMap(st, first.indent);
}

function parseBlockMap(st: ParseState, mapIndent: number): Record<string, YamlValue> {
  const result: Record<string, YamlValue> = {};
  while (true) {
    const line = peek(st);
    if (!line || line.indent !== mapIndent) break;
    const ci = findMappingColon(line.text);
    if (ci === -1) break;
    const key = line.text.slice(0, ci).trim();
    const afterColon = line.text.slice(ci + 1).trim();
    st.pos++;
    result[key] = resolveValue(st, afterColon, mapIndent);
  }
  return result;
}

function parseBlockSeq(st: ParseState, seqIndent: number): YamlValue[] {
  const result: YamlValue[] = [];
  while (true) {
    const line = peek(st);
    if (!line || line.indent !== seqIndent) break;
    if (!line.text.startsWith("- ") && line.text !== "-") break;
    st.pos++;

    const afterDash = line.text.startsWith("- ") ? line.text.slice(2) : "";

    if (afterDash === "") {
      const next = peek(st);
      result.push(next && next.indent > seqIndent ? parseBlock(st, next.indent) : null);
    } else if (afterDash.startsWith("[")) {
      result.push(parseFlowSeq(afterDash));
    } else {
      const ci = findMappingColon(afterDash);
      if (ci !== -1) {
        // Inline mapping: "- key: val" with optional continuation keys
        const itemIndent = seqIndent + 2;
        const obj: Record<string, YamlValue> = {};
        const k = afterDash.slice(0, ci).trim();
        const v = afterDash.slice(ci + 1).trim();
        obj[k] = resolveValue(st, v, itemIndent - 1);

        // Continuation keys of the same mapping entry
        while (true) {
          const next = peek(st);
          if (!next || next.indent !== itemIndent) break;
          const nci = findMappingColon(next.text);
          if (nci === -1) break;
          const nk = next.text.slice(0, nci).trim();
          const nv = next.text.slice(nci + 1).trim();
          st.pos++;
          obj[nk] = resolveValue(st, nv, itemIndent);
        }
        result.push(obj);
      } else {
        result.push(parseScalar(afterDash));
      }
    }
  }
  return result;
}

function resolveValue(st: ParseState, afterColon: string, parentIndent: number): YamlValue {
  if (afterColon === "") {
    const next = peek(st);
    if (!next || next.indent <= parentIndent) return null;
    return parseBlock(st, next.indent);
  }
  if (afterColon.startsWith("[")) return parseFlowSeq(afterColon);
  return parseScalar(afterColon);
}

// ---------- public API ----------

export function parse(src: string): Record<string, YamlValue> {
  const lines = preprocessLines(src);
  const st: ParseState = { lines, pos: 0 };
  const first = peek(st);
  if (!first) return {};
  const result = parseBlockMap(st, first.indent);
  return result;
}
