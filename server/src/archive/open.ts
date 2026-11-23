/**
 * Opens an archived session at a search hit: the records around it, read
 * from raw/ (whole messages, tool output included), with the hit marked. A
 * text repo hit names a line of the rendered text; the transcript is
 * rendered again until that line to find its record.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS, type ParseState } from "./adapters";
import { type ArchiveRuntime, localRoot, resolveHosts } from "./hosts";
import { completeLines, fileRange } from "./lines";
import { type GuiArchiveSettings } from "./settings";
import { zstPath } from "./sync";
import { TextRenderer } from "./text-render";
import { renderOptionsFor } from "./text-repo";
import { hiddenBy } from "./text-search";
import { readArchived } from "./zstd";

/** Records shown before and after the hit. */
export const OPEN_CONTEXT = 12;
const MESSAGE_CHARS = 6000;

export type {
  OpenedMessage,
  OpenedRecord,
  OpenedSession,
} from "../../../shared/archiveSearch";
import type {
  OpenedRecord,
  OpenedSession,
} from "../../../shared/archiveSearch";

export type OpenRequest = {
  key: string;
  /** A text repo line, or a raw record line with `raw`. */
  line: number;
  raw?: boolean;
  context?: number;
};

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[a-z0-9_-]+\/[^\0]+$/;

function clipText(text: string): string {
  return text.length > MESSAGE_CHARS
    ? `${text.slice(0, MESSAGE_CHARS)} [...]`
    : text;
}

/** The transcript's bytes: this machine's live file when it holds more than raw/. */
function transcript(
  archiveDir: string,
  settings: GuiArchiveSettings,
  runtime: ArchiveRuntime | undefined,
  host: string,
  agent: string,
  relpath: string,
): AsyncIterable<Buffer> | null {
  const adapter = ADAPTERS[agent];
  if (!adapter) return null;
  const zst = zstPath(archiveDir, host, agent, relpath);
  if (runtime && !relpath.startsWith("@")) {
    const self = resolveHosts(settings, runtime)[0];
    if (self && self.id === host) {
      const live = join(localRoot(adapter, self, runtime), relpath);
      try {
        const size = statSync(live).size;
        if (size > 0) return fileRange(live, 0, size);
      } catch {
        // Gone from the agent: raw/ has it.
      }
    }
  }
  return existsSync(zst) ? readArchived(zst) : null;
}

export async function openArchived(
  archiveDir: string,
  settings: GuiArchiveSettings,
  request: OpenRequest,
  runtime?: ArchiveRuntime,
): Promise<OpenedSession | null> {
  if (
    !SAFE_KEY.test(request.key) ||
    request.key.split("/").some((part) => part === ".." || part === ".")
  )
    return null;
  const [host = "", agent = "", ...rest] = request.key.split("/");
  const relpath = rest.join("/");
  const adapter = ADAPTERS[agent];
  if (
    !adapter ||
    !adapter.indexable ||
    relpath.startsWith("@") ||
    !adapter.accepts(relpath)
  )
    return null;
  const meta = adapter.classify(relpath);
  if (hiddenBy(settings.hide, { host, agent, project: meta.project }))
    return null;
  const chunks = transcript(
    archiveDir,
    settings,
    runtime,
    host,
    agent,
    relpath,
  );
  if (!chunks) return null;
  const context = Math.min(Math.max(request.context ?? OPEN_CONTEXT, 1), 60);
  const renderer = new TextRenderer(adapter, false, renderOptionsFor(settings));
  const parse: ParseState = { thinking: settings.thinking, unknown: new Map() };
  const before: OpenedRecord[] = [];
  const after: OpenedRecord[] = [];
  let hit: OpenedRecord | null = null;
  let more = false;
  let dropped = false;
  let title: string | null = null;
  let line = 0;
  let lastTs: string | null = null;
  for await (const { line: raw } of completeLines(chunks)) {
    line += 1;
    if (raw.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw.toString("utf8"));
    } catch {
      continue;
    }
    lastTs = adapter.timestampOf(record)?.slice(0, 19) ?? lastTs;
    const messages = adapter.parse(record, parse).map((doc) => {
      if (doc.kind === "title") title = doc.text;
      return {
        role: doc.role,
        kind: doc.kind,
        tool: doc.tool,
        text: clipText(doc.text),
      };
    });
    let isHit = false;
    if (!hit) {
      if (request.raw) isHit = line === request.line;
      else {
        // The text line this record's messages end at (the header is line 1).
        renderer.line(raw);
        isHit = renderer.lines.length + 1 >= request.line;
      }
    }
    if (messages.length === 0 && !isHit) continue;
    const entry: OpenedRecord = { line, ts: lastTs, messages, hit: isHit };
    if (isHit) hit = entry;
    else if (!hit) {
      before.push(entry);
      if (before.length > context) {
        before.shift();
        dropped = true;
      }
    } else if (after.length < context) after.push(entry);
    else {
      more = true;
      break;
    }
  }
  return {
    key: request.key,
    host,
    agent,
    relpath,
    session: meta.session,
    project: parse.project || meta.project,
    title,
    cwd: parse.cwd ?? null,
    hit: hit ? (hit as OpenedRecord).line : null,
    records: hit ? [...before, hit, ...after] : before,
    before: dropped,
    after: more,
  };
}
