/**
 * The conversation text of an archived transcript, one line per message, as
 * the text repo keeps it (see text-repo.ts):
 *
 *   <timestamp> <role> <kind>[ <tool>]: <text, newlines folded>
 *
 * Rendered with the archive's own adapters (the same parse the index used),
 * tool calls cut, tool output left out, secrets redacted. A renderer resumes
 * from a saved state, so a transcript that grew is rendered from where the
 * last pass stopped.
 */
import { posix } from "node:path";
import { type AgentAdapter, type ParseState } from "./adapters";
import { clip } from "./extract";
import { redactSecrets } from "../utils/secrets";

/** Characters of a tool call's input kept on its line. */
export const DEFAULT_TOOL_CALL_CHARS = 2000;
/** What a newline inside a message becomes, so every message is one line. */
export const FOLD = " ⏎ ";
const UNDATED = "undated";

/** Bump when the rendering changes: a repo of another version is rebuilt. */
export const RENDER_VERSION = 2;

const HUGE_LINE = 100_000;
const NEWLINES = / *\r?\n */g;

export type RenderOptions = {
  toolCallChars: number;
  thinking: boolean;
};

/** What a renderer carries from one pass to the next. */
export type RenderState = {
  cwd?: string;
  project?: string;
  cost?: number;
  session?: string;
  /** The last timestamp seen, carried to records without one. */
  lastTs?: string;
  /** The first timestamp seen. */
  firstTs?: string;
  /**
   * The session's day in the repo: the first timestamp as of its first
   * line, or "undated" when none came before it. Fixed then, so a file
   * rendered in several passes gets the path a rebuild gives it.
   */
  day?: string;
  lastMeta?: string;
  lastTitle?: string;
};

export function foldLine(text: string): string {
  return text.replace(NEWLINES, FOLD).replace(/[\t\r]/g, " ");
}

/** A token without spaces (a tool name, a project in a prompt line). */
function token(value: string): string {
  return value.replace(/[\s:]+/g, "_") || "-";
}

export class TextRenderer {
  readonly lines: string[] = [];
  redactions = 0;
  private readonly parse: ParseState;
  private readonly state: RenderState;

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly history: boolean,
    private readonly options: RenderOptions,
    saved: RenderState = {},
  ) {
    this.state = { ...saved };
    this.parse = {
      thinking: options.thinking,
      unknown: new Map(),
      ...(saved.cwd !== undefined ? { cwd: saved.cwd } : {}),
      ...(saved.project !== undefined ? { project: saved.project } : {}),
      ...(saved.cost !== undefined ? { cost: saved.cost } : {}),
      ...(saved.session !== undefined ? { session: saved.session } : {}),
    };
  }

  /** The state to resume from later. */
  save(): RenderState {
    const out: RenderState = { ...this.state };
    if (this.parse.cwd !== undefined) out.cwd = this.parse.cwd;
    if (this.parse.project !== undefined) out.project = this.parse.project;
    if (this.parse.cost !== undefined) out.cost = this.parse.cost;
    if (this.parse.session !== undefined) out.session = this.parse.session;
    return out;
  }

  get firstTs(): string | undefined {
    return this.state.firstTs;
  }

  private push(head: string, text: string): void {
    if (this.state.day === undefined) {
      const day = this.state.firstTs?.slice(0, 10) ?? "";
      this.state.day = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : UNDATED;
    }
    const redacted = redactSecrets(foldLine(text));
    this.redactions += redacted.count;
    this.lines.push(`${head}: ${redacted.text}`);
  }

  /** Render one complete JSONL line (without its newline). */
  line(raw: Buffer): void {
    if (raw.length === 0) return;
    if (raw.length > HUGE_LINE) {
      const head = raw.subarray(0, 400).toString("latin1");
      if (head.includes('"type":"api-request')) return;
    }
    let record: unknown;
    try {
      record = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    if (this.history) {
      const entry = record as {
        display?: unknown;
        timestamp?: unknown;
        project?: unknown;
      };
      const text =
        typeof entry.display === "string" ? entry.display.trim() : "";
      if (!text) return;
      const ts =
        typeof entry.timestamp === "number"
          ? new Date(entry.timestamp).toISOString().slice(0, 19)
          : (this.state.lastTs ?? "-");
      if (ts !== "-") {
        this.state.lastTs = ts;
        this.state.firstTs ??= ts;
      }
      const project =
        typeof entry.project === "string" ? token(entry.project) : "-";
      this.push(`${ts} user prompt ${project}`, text);
      return;
    }
    const stamp = this.adapter.timestampOf(record)?.slice(0, 19);
    if (stamp) {
      this.state.lastTs = stamp;
      this.state.firstTs ??= stamp;
    }
    const ts = this.state.lastTs ?? "-";
    for (const doc of this.adapter.parse(record, this.parse)) {
      if (doc.kind === "tool_result") continue;
      if (doc.kind === "title") {
        if (doc.text === this.state.lastTitle) continue;
        this.state.lastTitle = doc.text;
      }
      const text =
        doc.kind === "tool_use"
          ? clip(doc.text, this.options.toolCallChars)
          : doc.text;
      const kind = doc.tool ? `${doc.kind} ${token(doc.tool)}` : doc.kind;
      if (doc.role === "meta") {
        const key = `${doc.role} ${kind}: ${text}`;
        if (key === this.state.lastMeta) continue;
        this.state.lastMeta = key;
      }
      this.push(`${ts} ${doc.role} ${kind}`, text);
    }
  }
}

/** Keeps a path component safe: letters, digits, dot, dash, underscore. */
export function safeComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "_";
}

export type TextFileSubject = {
  host: string;
  agent: string;
  relpath: string;
  history: boolean;
  project: string;
  session: string;
  subagent: boolean;
};

/**
 * The path of a transcript's text in the repo:
 * host/agent/project/YYYY/MM/DD/<session>[.<subagent>].md (project/undated/
 * when no timestamp came before its first line), or
 * host/@history/agent/<name>.md for a prompt history. Null before its first
 * line.
 */
export function textPath(
  subject: TextFileSubject,
  state: RenderState,
): string | null {
  const host = safeComponent(subject.host);
  const agent = safeComponent(subject.agent);
  if (subject.history) {
    const name = safeComponent(
      subject.relpath.replace(/^@/, "").replace(/\.jsonl$/, ""),
    );
    return `${host}/@history/${agent}/${name}.md`;
  }
  if (!state.day) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(state.day)
    ? state.day.replace(/-/g, "/")
    : UNDATED;
  const project = safeComponent(state.project || subject.project || "_unknown");
  let name = safeComponent(
    subject.session || posix.basename(subject.relpath, ".jsonl"),
  );
  if (subject.subagent)
    name += `.${safeComponent(posix.basename(subject.relpath, ".jsonl"))}`;
  return `${host}/${agent}/${project}/${day}/${name}.md`;
}

/** A taken path's deterministic alternative: the 8 hex of the raw path's sha256. */
export function suffixedPath(path: string, rawKey: string): string {
  const hash = new Bun.CryptoHasher("sha256")
    .update(rawKey)
    .digest("hex")
    .slice(0, 8);
  return path.replace(/\.md$/, `.${hash}.md`);
}

/** The first line of a text file: where it comes from. */
export function headerLine(rawKey: string, state: RenderState): string {
  return `# ${rawKey}${state.cwd ? ` cwd=${foldLine(state.cwd)}` : ""}`;
}

export type ParsedLine = {
  ts: string | null;
  role: string;
  kind: string;
  tool: string | null;
  text: string;
};

const LINE = /^(\S+) (\S+) ([^\s:]+)(?: ([^\s:]+))?: ([\s\S]*)$/;

/** A text line back into its fields; null for the header or a foreign line. */
export function parseTextLine(line: string): ParsedLine | null {
  if (line.startsWith("# ")) return null;
  const match = LINE.exec(line);
  if (!match) return null;
  return {
    ts: match[1] === "-" ? null : (match[1] as string),
    role: match[2] as string,
    kind: match[3] as string,
    tool: match[4] ?? null,
    text: match[5] as string,
  };
}
