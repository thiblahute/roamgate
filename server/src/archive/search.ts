/** Full-text search over the index. */
import { type ArchiveDb } from "./store";
import { type ArchiveRule, type GuiArchiveSettings } from "./settings";

export const SNIPPET_WIDTH = 120;

export type SearchQuery = {
  terms: string[];
  agent?: string;
  host?: string;
  project?: string;
  role?: string;
  kind?: string;
  since?: string;
  until?: string;
  recent?: boolean;
  history?: boolean;
  limit: number;
};

export type SearchHit = {
  session: string;
  agent: string;
  host: string;
  project: string;
  subagent: boolean;
  title: string | null;
  ts: string | null;
  role: string;
  kind: string;
  tool: string | null;
  snippet: string;
  doc: number;
  cost_usd: number | null;
};

export type SearchResult = {
  query: string;
  total: number;
  hits: SearchHit[];
  truncated: boolean;
  history?: Array<{
    host: string;
    ts: string | null;
    project: string | null;
    snippet: string;
  }>;
  warning?: string;
};

const FTS_OPERATORS = /["()*]|\b(AND|OR|NOT|NEAR)\b/;

/**
 * Bare words are quoted so paths and dashes do not trip FTS5 syntax. A query
 * that already uses FTS5 operators is passed through unchanged.
 */
export function ftsQuery(query: string): string {
  if (FTS_OPERATORS.test(query)) return query;
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" ");
}

function plainTerms(terms: string[]): string[] {
  return (terms.join(" ").match(/[^\s"()*]+/g) ?? []).filter(
    (term) => !["AND", "OR", "NOT", "NEAR"].includes(term),
  );
}

function lower(char: string): string {
  return char.toLowerCase().charAt(0) || char;
}

/** Context around the first match, with every match in the window in [brackets]. */
export function makeSnippet(
  text: string,
  terms: string[],
  width: number,
): string {
  const chars = Array.from(text);
  const low = chars.map(lower);
  const needles = terms
    .filter(Boolean)
    .map((term) => Array.from(term).map(lower));
  const findAll = (
    needle: string[],
    lo: number,
    hi: number,
  ): Array<[number, number]> => {
    const found: Array<[number, number]> = [];
    if (needle.length === 0 || hi < lo + needle.length) return found;
    let i = lo;
    while (i + needle.length <= hi) {
      let match = true;
      for (let k = 0; k < needle.length; k += 1)
        if (low[i + k] !== needle[k]) {
          match = false;
          break;
        }
      if (match) {
        found.push([i, i + needle.length]);
        i += needle.length;
      } else i += 1;
    }
    return found;
  };
  const firsts = needles
    .map((needle) => findAll(needle, 0, low.length)[0]?.[0])
    .filter((value): value is number => value !== undefined);
  if (firsts.length === 0)
    return chars
      .slice(0, 2 * width)
      .join("")
      .replace(/\n/g, " ");
  const first = Math.min(...firsts);
  const a = Math.max(0, first - width);
  const b = Math.min(chars.length, first + width);
  const ranges = needles
    .flatMap((needle) => findAll(needle, a, b))
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  let out = a > 0 ? "... " : "";
  let at = a;
  for (const [start, end] of merged) {
    out += chars.slice(at, start).join("");
    out += `[${chars.slice(start, end).join("")}]`;
    at = end;
  }
  out += chars.slice(at, b).join("");
  if (b < chars.length) out += " ...";
  return out.replace(/\n/g, " ");
}

function hideClause(
  rules: readonly ArchiveRule[],
  params: Array<string>,
): string {
  const parts: string[] = [];
  for (const rule of rules) {
    const conditions: string[] = [];
    if (rule.host) {
      conditions.push("f.host = ?");
      params.push(rule.host);
    }
    if (rule.agent) {
      conditions.push("f.agent = ?");
      params.push(rule.agent);
    }
    if (rule.project) {
      conditions.push("instr(f.project, ?) > 0");
      params.push(rule.project);
    }
    if (conditions.length > 0) parts.push(`NOT (${conditions.join(" AND ")})`);
  }
  return parts.join(" AND ");
}

type HitRow = {
  session: string;
  agent: string;
  host: string;
  project: string;
  subagent: number;
  title: string | null;
  ts: string | null;
  role: string;
  kind: string;
  tool: string | null;
  text: string;
  doc: number;
  cost_usd: number | null;
};

export function searchArchive(
  db: ArchiveDb,
  query: SearchQuery,
  settings: Pick<GuiArchiveSettings, "hide">,
): SearchResult {
  const raw = query.terms.join(" ").trim();
  const fts = ftsQuery(raw);
  const terms = plainTerms(query.terms);
  const where: string[] = ["%TABLE% MATCH ?"];
  const params: string[] = [fts];
  const filters: Array<[string, string | undefined]> = [
    ["f.agent = ?", query.agent],
    ["f.host = ?", query.host],
    ["d.role = ?", query.role],
    ["d.kind = ?", query.kind],
    ["d.ts >= ?", query.since],
    ["d.ts <= ?", query.until],
  ];
  for (const [clause, value] of filters)
    if (value) {
      where.push(clause);
      params.push(value);
    }
  if (query.project) {
    where.push("instr(f.project, ?) > 0");
    params.push(query.project);
  }
  const hide = hideClause(settings.hide, params);
  if (hide) where.push(hide);
  const order = query.recent ? "d.ts DESC" : "rank";
  const warning = terms.some((term) => Array.from(term).length < 3)
    ? "terms shorter than 3 characters match nothing in the trigram index"
    : undefined;
  const hasWords = Boolean(
    db.query("SELECT 1 FROM files WHERE index_level = 'words' LIMIT 1").get(),
  );
  const tables = hasWords ? ["fts", "fts_words"] : ["fts"];
  const hits: SearchHit[] = [];
  let total = 0;
  for (const table of tables) {
    const clause = where.join(" AND ").replace("%TABLE%", table);
    const base = `FROM ${table} JOIN docs d ON d.id = ${table}.rowid JOIN files f ON f.id = d.file_id WHERE ${clause}`;
    try {
      total +=
        db
          .query<{ n: number }, string[]>(`SELECT count(*) AS n ${base}`)
          .get(...params)?.n ?? 0;
      const rows = db
        .query<HitRow, string[]>(
          `SELECT f.session, f.agent, f.host, f.project, f.subagent, f.title, d.ts, d.role, d.kind, d.tool,
                  ${table}.text AS text, d.id AS doc, f.cost_usd
           ${base} ORDER BY ${order.replace("rank", `${table}.rank`)} LIMIT ${Math.max(1, query.limit)}`,
        )
        .all(...params);
      for (const row of rows)
        hits.push({
          session: row.session,
          agent: row.agent,
          host: row.host,
          project: row.project,
          subagent: row.subagent !== 0,
          title: row.title,
          ts: row.ts,
          role: row.role,
          kind: row.kind,
          tool: row.tool,
          snippet: makeSnippet(row.text, terms, SNIPPET_WIDTH),
          doc: row.doc,
          cost_usd: row.cost_usd,
        });
    } catch (error) {
      throw new Error(
        `query error (query was: ${fts}): ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
  if (tables.length > 1)
    hits.sort((a, b) =>
      query.recent ? (b.ts ?? "").localeCompare(a.ts ?? "") : 0,
    );
  const limited = hits.slice(0, query.limit);
  const result: SearchResult = {
    query: raw,
    total,
    hits: limited,
    truncated: total > limited.length,
    ...(warning ? { warning } : {}),
  };
  if (query.history) {
    const params2: Array<string | number> = [fts];
    const filter = query.host ? " AND h.host = ?" : "";
    if (query.host) params2.push(query.host);
    params2.push(query.limit);
    result.history = db
      .query<
        {
          host: string;
          ts: string | null;
          project: string | null;
          text: string;
        },
        Array<string | number>
      >(
        `SELECT h.host, h.ts, h.project, hist_fts.text AS text FROM hist_fts JOIN history h ON h.id = hist_fts.rowid
         WHERE hist_fts MATCH ?${filter} ORDER BY rank LIMIT ?`,
      )
      .all(...params2)
      .map((row) => ({
        host: row.host,
        ts: row.ts,
        project: row.project,
        snippet: makeSnippet(row.text, terms, SNIPPET_WIDTH),
      }));
  }
  return result;
}
