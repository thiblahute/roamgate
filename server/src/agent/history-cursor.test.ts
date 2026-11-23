import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rewoundAfterQueuedRecords } from "./session-rewind.fixture";
import type { AgentSessionFileAccess } from "./session-file-access";
import { createSessionProjectionCache } from "./session-projection-cache";
import type { HistoryEntry, HistoryUpdate } from "./session-history";
import type { AgentSessionResolved, SessionFile } from "./session-types";

/**
 * The cursors of agent_history.get on a real-shaped transcript, held to
 * contract/vectors/history-cursor.json, which roamgate-agents reads too:
 * a cursor is the file's, the same in every process and on both sides.
 */
const VECTORS = join(
  import.meta.dir,
  "../../../contract/vectors/history-cursor.json",
);

type Write = {
  copies: number;
  /** Only the records of these types (none: all of them). */
  types?: string[];
  lines: number;
  identity: string;
  mtimeMs: number;
  changeToken: string;
};
type Step = {
  write?: Write;
  read: { cache: string; cursor: string | null };
  as: string;
  expect?: unknown;
};
type Vectors = {
  description: string;
  path: string;
  cases: { name: string; agent: string; steps: Step[] }[];
};

/** Ids a copy makes its own: `uuid`, `id` and `tool_use_id`, anywhere. */
function copiedIds(value: unknown, copy: number): unknown {
  if (Array.isArray(value)) return value.map((item) => copiedIds(item, copy));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    out[key] =
      typeof item === "string" && ["uuid", "id", "tool_use_id"].includes(key)
        ? `${item}-${copy}`
        : copiedIds(item, copy);
  return out;
}

/** The transcript a write describes. */
function transcriptOf(write: Write): string {
  const records = rewoundAfterQueuedRecords.filter(
    (record) => !write.types || write.types.includes(record.type as string),
  );
  const uuids = new Set(records.map((record) => record.uuid));
  const last = [...records].reverse().find((record) => record.uuid)?.uuid;
  const suffixed = (uuid: unknown, copy: number) =>
    copy > 0 ? `${uuid}-${copy}` : uuid;
  const lines: string[] = [];
  for (let copy = 0; copy < write.copies; copy++)
    for (const record of records) {
      const copied = (
        copy > 0 ? copiedIds(record, copy) : { ...record }
      ) as Record<string, unknown>;
      if (copy > 0) {
        // A copy goes on from the one before: its roots hang from that
        // copy's last record, so the copies make one conversation.
        if (typeof record.parentUuid === "string")
          copied.parentUuid = uuids.has(record.parentUuid)
            ? suffixed(record.parentUuid, copy)
            : suffixed(last, copy - 1);
      }
      lines.push(JSON.stringify(copied));
    }
  return lines
    .slice(0, write.lines)
    .map((line) => `${line}\n`)
    .join("");
}

/** What a step's answer is compared by. */
function summary(update: HistoryUpdate) {
  const ids = (entries: HistoryEntry[]) =>
    entries.map((entry) => `${entry.id} ${entry.text_hash ?? ""}`);
  return update.mode === "snapshot"
    ? { mode: update.mode, cursor: update.cursor, entries: ids(update.entries) }
    : {
        mode: update.mode,
        cursor: update.cursor,
        base_revision: update.base_revision,
        upserts: ids(update.upserts),
        removed: update.removed,
        ...(update.order ? { order: update.order } : {}),
      };
}

const vectors = JSON.parse(readFileSync(VECTORS, "utf8")) as Vectors;
const record = process.env.HISTORY_CURSOR_RECORD === "1";

describe("history cursors (contract/vectors/history-cursor.json)", () => {
  for (const each of vectors.cases)
    test(each.name, async () => {
      let bytes = Buffer.alloc(0);
      let file: SessionFile = { path: vectors.path, mtimeMs: 0, size: 0 };
      const files: AgentSessionFileAccess = {
        remote: false,
        async statFile() {
          return { ...file };
        },
        async readText() {
          return bytes.toString("utf8");
        },
        async readPrefix(_path, limit) {
          return bytes.subarray(0, limit);
        },
        async readTail(_path, limit) {
          return bytes.subarray(Math.max(0, bytes.length - limit));
        },
        async readRange(_path, start, end) {
          return bytes.subarray(start, end);
        },
        async readDownloadBody() {
          return bytes;
        },
        async findPiSessionById() {
          return null;
        },
        async findPiSessionForCwd() {
          return null;
        },
        async findClaudeSessionById() {
          return null;
        },
        async findClaudeSuccessor() {
          return null;
        },
        async findCodexSessionById() {
          return null;
        },
      };
      const caches = new Map<
        string,
        ReturnType<typeof createSessionProjectionCache>
      >();
      const cursors = new Map<string, unknown>();
      for (const step of each.steps) {
        if (step.write) {
          bytes = Buffer.from(transcriptOf(step.write));
          file = {
            path: vectors.path,
            mtimeMs: step.write.mtimeMs,
            size: bytes.length,
            identity: step.write.identity,
            changeToken: step.write.changeToken,
          };
        }
        let cache = caches.get(step.read.cache);
        if (!cache) {
          cache = createSessionProjectionCache(files);
          caches.set(step.read.cache, cache);
        }
        const resolved = {
          agent: each.agent,
          session: { kind: "path", value: vectors.path },
          file: { ...file },
        } as unknown as AgentSessionResolved;
        const cursor =
          step.read.cursor === null ? null : cursors.get(step.read.cursor);
        const { update } = await cache.history(resolved, cursor);
        cursors.set(step.as, update.cursor);
        const got = summary(update);
        if (record) step.expect = got;
        else expect(got, step.as).toEqual(step.expect as never);
      }
    });
});

afterAll(() => {
  if (record) writeFileSync(VECTORS, `${JSON.stringify(vectors, null, 2)}\n`);
});
