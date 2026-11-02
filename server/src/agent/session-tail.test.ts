import { describe, expect, test } from "bun:test";
import { scanRewind } from "../conversation/rewind-scan";
import { createAgentSessionHandlers } from "./agent-sessions";
import type { AgentSessionFileAccess } from "./session-file-access";
import { readSessionProjection } from "./session-projection-cache";
import {
  findLineFromEnd,
  LARGE_SESSION_BYTES,
  readTailRecords,
} from "./session-tail";
import type { SessionFile } from "./session-types";
import {
  createSessionIndexStore,
  type SessionIndexStore,
} from "./session-index-store";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Summary = {
  title: string | null;
  stats: { turns: number; records: number; token_usage: unknown };
  partial?: boolean;
};

/** Asks until the answer covers the whole session (its index is ready). */
async function whole(read: () => Promise<unknown>): Promise<Summary> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const summary = (await read()) as Summary;
    if (!summary.partial) return summary;
    await Bun.sleep(5);
  }
  throw new Error("the index never got ready");
}

type HistoryResult = {
  mode: "snapshot" | "delta";
  cursor: { epoch: string; revision: number };
  entries?: { id: string; kind: string; role: string; text: string }[];
  upserts?: { id: string; text: string }[];
};

/** A Claude transcript: `bulk` large tool results, then `turns` turns. */
function transcript(bulk: number, turns: number, from = 0) {
  const records: Record<string, unknown>[] = [];
  let parent: string | null = null;
  const add = (record: Record<string, unknown>) => {
    const uuid = `u${from + records.length}`;
    records.push({
      ...record,
      uuid,
      parentUuid: parent,
      timestamp: new Date(
        1_700_000_000_000 + from + records.length,
      ).toISOString(),
    });
    parent = uuid;
  };
  if (!from) {
    add({ type: "custom-title", customTitle: "Large session" });
    add({ type: "user", message: { role: "user", content: "First prompt" } });
  }
  for (let i = 0; i < bulk; i++) {
    const id = `toolu_${from}_${i}`;
    add({
      type: "assistant",
      message: {
        id: `msg_b${from}_${i}`,
        role: "assistant",
        content: [
          { type: "tool_use", id, name: "Bash", input: { command: "ls" } },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    add({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: id, content: "x".repeat(4096) },
        ],
      },
    });
  }
  for (let i = 0; i < turns; i++) {
    add({
      type: "user",
      message: { role: "user", content: `Prompt ${from}-${i}` },
    });
    add({
      type: "assistant",
      message: {
        id: `msg_t${from}_${i}`,
        role: "assistant",
        content: [{ type: "text", text: `Answer ${from}-${i}` }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
  }
  return records;
}

function lines(records: Record<string, unknown>[]) {
  return Buffer.from(
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
}

function fixture(initial: Buffer, indexStore?: SessionIndexStore) {
  const path = "/tmp/large-session.jsonl";
  let bytes = initial;
  let identity = "1";
  let rangeBytes = 0;
  let wholeReads = 0;
  const file = (): SessionFile => ({
    path,
    mtimeMs: 1000 + bytes.length,
    size: bytes.length,
    identity,
    changeToken: String(bytes.length),
  });
  const files: AgentSessionFileAccess = {
    remote: false,
    async statFile() {
      return file();
    },
    async readText() {
      wholeReads += 1;
      return bytes.toString("utf8");
    },
    async readRange(_path, start, end) {
      const range = bytes.subarray(start, Math.min(end, bytes.length));
      rangeBytes += range.length;
      return new Uint8Array(range);
    },
    async readPrefix(_path, limit) {
      return bytes.subarray(0, limit);
    },
    async readTail(_path, limit) {
      return bytes.subarray(Math.max(0, bytes.length - limit));
    },
    async readDownloadBody() {
      return new Uint8Array(bytes);
    },
    async findPiSessionForCwd() {
      return null;
    },
    async findPiSessionById() {
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
  const herdrCall = async () => ({
    agent: {
      agent: "claude",
      agent_session: { kind: "path", value: path },
    },
  });
  const handlers = createAgentSessionHandlers({
    files,
    herdrCall,
    ...(indexStore ? { indexStore } : {}),
  });
  return {
    handlers,
    files,
    async history(cursor: unknown = null) {
      return (await handlers.readHistory({
        pane_id: "p",
        history_version: 2,
        cursor,
      })) as unknown as HistoryResult;
    },
    /** What the file holds now. */
    get bytes() {
      return bytes;
    },
    append(more: Buffer) {
      bytes = Buffer.concat([bytes, more]);
    },
    replace(next: Buffer) {
      bytes = next;
      identity = String(Number(identity) + 1);
    },
    full() {
      return readSessionProjection("claude", file(), {
        ...files,
        readRange: undefined,
      });
    },
    takeRangeBytes() {
      const taken = rangeBytes;
      rangeBytes = 0;
      return taken;
    },
    get wholeReads() {
      return wholeReads;
    },
    get size() {
      return bytes.length;
    },
  };
}

const shape = (entries: { kind: string; role: string; text: string }[]) =>
  entries.map((entry) => [entry.kind, entry.role, entry.text]);

describe("large transcripts", () => {
  test("a history load reads the end of the file, not all of it", async () => {
    const session = fixture(lines(transcript(1500, 300)));
    expect(session.size).toBeGreaterThan(LARGE_SESSION_BYTES);
    const result = await session.history();
    expect(session.wholeReads).toBe(0);
    // 300 short turns at the end: well under a megabyte of a 6 MB file.
    expect(session.takeRangeBytes()).toBeLessThan(1024 * 1024);
    expect(result.mode).toBe("snapshot");
    const full = await session.full();
    expect(shape(result.entries!)).toEqual(
      shape(full.entries).map(([kind, role, text]) => [
        kind,
        role,
        role === "tool" ? "" : text,
      ]),
    );
  });

  test("appended records are read alone and sent as a delta", async () => {
    const session = fixture(lines(transcript(1500, 300)));
    const first = await session.history();
    session.takeRangeBytes();
    const more = lines(transcript(0, 2, 1_000_000));
    session.append(more);
    const next = await session.history(first.cursor);
    expect(session.takeRangeBytes()).toBe(more.length);
    expect(next.mode).toBe("delta");
    expect(next.cursor.epoch).toBe(first.cursor.epoch);
    expect(next.upserts!.map((entry) => entry.text)).toEqual([
      "Prompt 1000000-0",
      "Answer 1000000-0",
      "Prompt 1000000-1",
      "Answer 1000000-1",
    ]);
    expect(session.wholeReads).toBe(0);
  });

  test("a replaced transcript starts a new epoch", async () => {
    const session = fixture(lines(transcript(1500, 300)));
    const first = await session.history();
    session.replace(lines(transcript(1400, 250)));
    const next = await session.history(first.cursor);
    expect(next.mode).toBe("snapshot");
    expect(next.cursor.epoch).not.toBe(first.cursor.epoch);
  });

  test("the summary comes from an index streamed in chunks", async () => {
    const session = fixture(lines(transcript(1500, 300)));
    // The index is not ready: the first answer comes from the end read,
    // without waiting for it.
    const first = (await session.handlers.readSummary({
      pane_id: "p",
    })) as Summary;
    expect(first.partial).toBe(true);
    const summary = await whole(() =>
      session.handlers.readSummary({ pane_id: "p" }),
    );
    expect(session.wholeReads).toBe(0);
    const full = await session.full();
    expect(summary.title).toBe("Large session");
    expect(summary.stats).toEqual(full.stats);
    // The index reads on from where it stopped.
    session.takeRangeBytes();
    const more = lines(transcript(0, 1, 2_000_000));
    session.append(more);
    const next = (await session.handlers.readSummary({ pane_id: "p" })) as {
      stats: { turns: number };
    };
    expect(next.stats.turns).toBe(full.stats.turns + 1);
    // The history's tail and the index each read the appended bytes once.
    expect(session.takeRangeBytes()).toBe(2 * more.length);
  });

  test("a restart takes the index from disk and reads only what was appended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-index-"));
    try {
      const store = () => createSessionIndexStore({ dir, scope: "local" });
      const before = fixture(lines(transcript(1500, 300)), store());
      const full = await whole(() =>
        before.handlers.readSummary({ pane_id: "p" }),
      );
      // Saved in the background.
      for (let i = 0; i < 100 && readdirSync(dir).length < 2; i++)
        await Bun.sleep(5);
      await Bun.sleep(20);
      expect(readdirSync(dir).sort()).toEqual([
        expect.stringMatching(/\.json$/),
        expect.stringMatching(/\.jsonl$/),
      ]);
      const more = lines(transcript(0, 1, 2_000_000));
      const after = fixture(Buffer.concat([before.bytes, more]), store());
      const first = (await after.handlers.readSummary({
        pane_id: "p",
      })) as Summary;
      // Answered at once from what was saved with the index.
      expect(first.partial).toBe(true);
      expect(first.title).toBe("Large session");
      expect(first.stats.turns).toBe(full.stats.turns);
      after.takeRangeBytes();
      const next = await whole(() =>
        after.handlers.readSummary({ pane_id: "p" }),
      );
      expect(next.stats.turns).toBe(full.stats.turns + 1);
      expect(next.title).toBe("Large session");
      // Not the whole transcript again: what was appended, and a few
      // bytes to check the saved index still matches the file.
      expect(after.takeRangeBytes()).toBeLessThan(more.length + 16 * 1024);

      // Nothing appended since the save: whole at once, from what was
      // saved, without taking the index up at all.
      const idle = fixture(before.bytes, store());
      idle.takeRangeBytes();
      const idleFirst = (await idle.handlers.readSummary({
        pane_id: "p",
      })) as Summary;
      expect(idleFirst.partial).toBeUndefined();
      expect(idleFirst.stats).toEqual(full.stats);
      // Nor even its end, for what needs only the whole session.
      await idle.handlers.readTasks({ pane_id: "p" });
      expect(idle.takeRangeBytes()).toBe(0);

      // A file replaced since (another one at that path): built again.
      const other = fixture(lines(transcript(1500, 2)), store());
      other.replace(lines(transcript(1500, 2)));
      const rebuilt = await whole(() =>
        other.handlers.readSummary({ pane_id: "p" }),
      );
      expect(rebuilt.stats).toEqual((await other.full()).stats);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a saved index that no longer matches its file is dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-index-"));
    try {
      const store = createSessionIndexStore({ dir, scope: "local" });
      const bytes = lines(transcript(10, 3));
      const read = async (_path: string, start: number, end: number) =>
        new Uint8Array(bytes.subarray(start, end));
      const records = [{ type: "user" }, { type: "assistant" }];
      await store.save({
        path: "/t.jsonl",
        identity: "1",
        end: bytes.length,
        parsed: 2,
        records,
        read,
      });
      const load = (identity: string, size: number, from = read) =>
        createSessionIndexStore({ dir, scope: "local" }).load({
          path: "/t.jsonl",
          identity,
          size,
          read: from,
        });
      expect((await load("1", bytes.length))?.records).toEqual(records);
      // Another scope (connection) does not see it.
      expect(
        await createSessionIndexStore({ dir, scope: "desktop" }).load({
          path: "/t.jsonl",
          identity: "1",
          size: bytes.length,
          read,
        }),
      ).toBeNull();
      // Cut short, or rewritten in place: not that file any more.
      expect(await load("1", bytes.length - 1)).toBeNull();
      await store.save({
        path: "/t.jsonl",
        identity: "1",
        end: bytes.length,
        parsed: 2,
        records,
        read,
      });
      const rewritten = Buffer.from(bytes);
      rewritten[bytes.length - 2] = 0x20;
      expect(
        await load(
          "1",
          bytes.length,
          async (_p, start, end) =>
            new Uint8Array(rewritten.subarray(start, end)),
        ),
      ).toBeNull();
      expect(readdirSync(dir)).toEqual([]);
      // An append cut short is left out; the records before it stand.
      await store.save({
        path: "/t.jsonl",
        identity: "1",
        end: bytes.length,
        parsed: 2,
        records,
        read,
      });
      const jsonl = readdirSync(dir).find((name) => name.endsWith(".jsonl"))!;
      writeFileSync(
        join(dir, jsonl),
        '{"type":"user"}\n{"type":"assistant"}\n{"ty',
        {
          flag: "w",
        },
      );
      expect((await load("1", bytes.length))?.records).toEqual(records);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rewind's scan reads the slim index as it would the text", async () => {
    const records = transcript(1500, 3);
    const prompt = records.findLast((record) => record.type === "user")!;
    records.push(
      { type: "file-history-snapshot", messageId: prompt.uuid, snapshot: {} },
      {
        type: "assistant",
        uuid: "edit",
        parentUuid: prompt.uuid,
        message: {
          id: "msg_edit",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_edit",
              name: "Edit",
              input: { file_path: "/src/a.ts", old_string: "a".repeat(9000) },
            },
          ],
        },
      },
    );
    const bytes = lines(records);
    const session = fixture(bytes);
    const slim = await session.handlers.readRecords({ pane_id: "p" });
    expect(session.wholeReads).toBe(0);
    const uuid = String(prompt.uuid);
    expect(scanRewind(slim!, uuid)).toEqual(
      scanRewind(bytes.toString("utf8"), uuid),
    );
    expect(scanRewind(slim!, uuid)).toEqual({
      found: true,
      edited: ["/src/a.ts"],
      checkpoint: true,
    });
  });

  test("older entries are read a page at a time when asked", async () => {
    // Tool results first make the file large enough to read by its end.
    const padded = fixture(
      Buffer.concat([
        lines(transcript(1100, 0)),
        lines(transcript(0, 1200, 5_000_000)),
      ]),
    );
    const first = await padded.history();
    const firstRead = padded.takeRangeBytes();
    const oldest = first.entries![0]!;
    const page = (await padded.handlers.readOlder({
      pane_id: "p",
      before_id: oldest.id,
      limit: 50,
    })) as { entries: { text: string }[]; has_more: boolean };
    expect(page.entries.map((entry) => entry.text)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1075).flatMap((i) => [
        `Prompt 5000000-${i}`,
        `Answer 5000000-${i}`,
      ]),
    );
    expect(page.has_more).toBe(true);
    // Only what that page needed, not the rest of the file.
    expect(padded.takeRangeBytes()).toBeLessThan(firstRead + 1024 * 1024);
    expect(padded.wholeReads).toBe(0);
  });
});

describe("readTailRecords", () => {
  test("reads back across lines split by chunk boundaries", async () => {
    const records = transcript(0, 400);
    const bytes = lines(records);
    let read = 0;
    const tail = await readTailRecords(
      async (_path, start, end) => {
        read += end - start;
        return new Uint8Array(bytes.subarray(start, end));
      },
      "",
      bytes.length,
      (got) => got.length >= 100,
      { firstBytes: 1000 },
    );
    expect(tail.records).toEqual(records.slice(-tail.records.length));
    expect(tail.records.length).toBeGreaterThanOrEqual(100);
    expect(tail.end).toBe(bytes.length);
    expect(read).toBeLessThan(bytes.length);
  });

  test("leaves an unfinished last line for later", async () => {
    const bytes = Buffer.concat([
      lines(transcript(0, 3)),
      Buffer.from('{"type":"user"'),
    ]);
    const tail = await readTailRecords(
      async (_path, start, end) => new Uint8Array(bytes.subarray(start, end)),
      "",
      bytes.length,
      () => false,
    );
    expect(tail.records).toHaveLength(8);
    expect(tail.end).toBe(bytes.length - '{"type":"user"'.length);
  });
});

describe("findLineFromEnd", () => {
  test("finds a record's line from the end, decoding only matches", async () => {
    const records = transcript(0, 2000);
    const bytes = lines(records);
    let read = 0;
    const seen: string[] = [];
    const line = await findLineFromEnd(
      async (_path, start, end) => {
        read += end - start;
        return new Uint8Array(bytes.subarray(start, end));
      },
      "",
      bytes.length,
      JSON.stringify("u3900"),
      (text) => {
        seen.push(text);
        return JSON.parse(text).uuid === "u3900" ? text : null;
      },
    );
    expect(JSON.parse(line!)).toEqual(records[3900]);
    // u3900's line, and u3901's naming it as its parent.
    expect(seen).toHaveLength(2);
    expect(read).toBeLessThan(bytes.length);
  });

  test("reaches lines at the file's start", async () => {
    const bytes = lines(transcript(0, 50));
    const line = await findLineFromEnd(
      async (_path, start, end) => new Uint8Array(bytes.subarray(start, end)),
      "",
      bytes.length,
      '"custom-title"',
      (text) => text,
    );
    expect(JSON.parse(line!).customTitle).toBe("Large session");
  });
});
