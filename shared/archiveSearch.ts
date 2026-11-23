/**
 * The archive search's wire shapes: what `roamgate archive search --json`,
 * Ranger's tools and the search view (`bridge.archive.search`,
 * `bridge.archive.open`) get.
 */

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
  /** The text repo's line (a raw/ record's line with toolOutput). */
  doc: number;
  cost_usd: number | null;
  /** Matching messages in this session. */
  matches?: number;
  /** A few matching messages of this session, latest last. */
  snippets?: string[];
  /** The session's file in the text repo. */
  path?: string;
  /** Its raw/ file: host/agent/relpath (what `openArchived` opens). */
  key?: string;
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
  /** Sessions with a match (hits are one per session). */
  sessions?: number;
  /** Where the results come from. */
  source?: "text" | "raw";
};

export type OpenedMessage = {
  role: string;
  kind: string;
  tool: string | null;
  text: string;
};

export type OpenedRecord = {
  /** The record's line in the transcript, from 1. */
  line: number;
  ts: string | null;
  messages: OpenedMessage[];
  hit: boolean;
};

export type OpenedSession = {
  key: string;
  host: string;
  agent: string;
  relpath: string;
  session: string;
  project: string;
  title: string | null;
  cwd: string | null;
  /** The hit's record line; null when it was not found. */
  hit: number | null;
  records: OpenedRecord[];
  /** More records before the first and after the last shown. */
  before: boolean;
  after: boolean;
};
