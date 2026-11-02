/**
 * Large transcripts' slim indexes (session-tail.ts) kept on disk, so a
 * Roamgate restart reads only what was appended since instead of the whole
 * transcript again. A cache: anything missing, unreadable or not matching
 * the transcript any more is built again from the transcript.
 *
 * Per transcript, `<key>.jsonl` holds the slim records, one per line, only
 * ever appended to, and `<key>.json` what they cover: the transcript's
 * identity (device and inode), where the last line indexed ends, a hash of
 * the bytes before that end (a file rewritten in place shows), and the
 * aggregates last computed from them.
 */
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RangeReader } from "./session-tail";

const VERSION = 1;
/** The bytes before an index's end that must still be the same. */
const CHECK_BYTES = 4096;

export function defaultSessionIndexDir(home = homedir()): string {
  return join(home, ".cache", "roamgate", "session-index");
}

type SessionRecord = Record<string, unknown>;

type Meta = {
  version: number;
  path: string;
  identity: string;
  end: number;
  parsed: number;
  count: number;
  /** How long `<key>.jsonl` is for those `count` records. */
  bytes: number;
  check: string;
  aggregates?: { end: number; value: unknown };
};

/** An index as saved: what it covers, its records, its last aggregates. */
export type SavedSessionIndex = {
  end: number;
  parsed: number;
  records: SessionRecord[];
  aggregates?: { end: number; value: unknown };
};

/** What a transcript's last bytes before `end` hash to. */
async function checkOf(read: RangeReader, path: string, end: number) {
  const bytes = await read(path, Math.max(0, end - CHECK_BYTES), end);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `scope` keeps one connection's transcripts apart from another's (the
 * same path on two hosts). null `dir` keeps nothing.
 */
export function createSessionIndexStore(options: {
  dir: string | null;
  scope: string;
}) {
  const { dir } = options;
  // What each file holds on disk, as this process last wrote or read it.
  const written = new Map<string, { count: number; bytes: number }>();
  function keyOf(path: string) {
    return createHash("sha256")
      .update(`${options.scope}\0${path}`)
      .digest("hex")
      .slice(0, 32);
  }
  async function readMeta(key: string): Promise<Meta | null> {
    if (!dir) return null;
    try {
      const meta = JSON.parse(
        await readFile(join(dir, `${key}.json`), "utf8"),
      ) as Meta;
      return meta.version === VERSION ? meta : null;
    } catch {
      return null;
    }
  }
  async function writeMeta(key: string, meta: Meta) {
    const file = join(dir!, `${key}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(meta), { mode: 0o600 });
    await rename(temp, file);
  }
  return {
    /**
     * The aggregates saved with the index of the transcript at `path`,
     * without reading the index or the transcript: a first answer, partial,
     * while the index itself is taken up.
     */
    async peek(input: {
      path: string;
      identity: string | undefined;
      size: number;
    }): Promise<{ end: number; value: unknown } | null> {
      if (!dir || !input.identity) return null;
      const meta = await readMeta(keyOf(input.path));
      return meta?.aggregates &&
        meta.path === input.path &&
        meta.identity === input.identity &&
        meta.end <= input.size
        ? meta.aggregates
        : null;
    },
    /**
     * The index saved for the transcript at `path`, if it still matches it:
     * the same file (`identity`), at least as long, the same bytes before
     * the saved end. Null otherwise (and what was saved is dropped).
     */
    async load(input: {
      path: string;
      identity: string | undefined;
      size: number;
      read: RangeReader;
    }): Promise<SavedSessionIndex | null> {
      if (!dir || !input.identity) return null;
      const key = keyOf(input.path);
      const meta = await readMeta(key);
      if (!meta) return null;
      const drop = async () => {
        written.delete(key);
        await rm(join(dir, `${key}.json`), { force: true });
        await rm(join(dir, `${key}.jsonl`), { force: true });
        return null;
      };
      if (
        meta.path !== input.path ||
        meta.identity !== input.identity ||
        meta.end > input.size ||
        (await checkOf(input.read, input.path, meta.end).catch(() => "")) !==
          meta.check
      )
        return drop();
      let text: Buffer;
      try {
        text = await readFile(join(dir, `${key}.jsonl`));
      } catch {
        return drop();
      }
      if (text.length < meta.bytes) return drop();
      const records: SessionRecord[] = [];
      try {
        // Past `bytes`: an append the meta never got to; left out.
        for (const line of text.toString("utf8", 0, meta.bytes).split("\n"))
          if (line) records.push(JSON.parse(line) as SessionRecord);
      } catch {
        return drop();
      }
      if (records.length !== meta.count) return drop();
      written.set(key, { count: meta.count, bytes: meta.bytes });
      return {
        end: meta.end,
        parsed: meta.parsed,
        records,
        ...(meta.aggregates ? { aggregates: meta.aggregates } : {}),
      };
    },
    /**
     * Saves an index: the records not on disk yet are appended (all of
     * them again when what is there does not lead to them).
     */
    async save(input: {
      path: string;
      identity: string | undefined;
      end: number;
      parsed: number;
      records: SessionRecord[];
      read: RangeReader;
      aggregates?: { end: number; value: unknown };
    }) {
      if (!dir || !input.identity) return;
      const key = keyOf(input.path);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const check = await checkOf(input.read, input.path, input.end);
      const file = join(dir, `${key}.jsonl`);
      let on = written.get(key);
      if (!on) {
        const meta = await readMeta(key);
        on =
          meta && meta.path === input.path && meta.identity === input.identity
            ? { count: meta.count, bytes: meta.bytes }
            : undefined;
      }
      let bytes: number;
      if (on && on.count <= input.records.length) {
        const added = input.records
          .slice(on.count)
          .map((record) => `${JSON.stringify(record)}\n`)
          .join("");
        // Whatever an interrupted append left past `bytes` goes first.
        const length = await stat(file).then(
          (info) => info.size,
          () => -1,
        );
        if (length < on.bytes) on = undefined;
        else {
          if (length > on.bytes) await truncate(file, on.bytes);
          if (added) await appendFile(file, added);
          bytes = on.bytes + Buffer.byteLength(added);
        }
      }
      if (!on) {
        const all = input.records
          .map((record) => `${JSON.stringify(record)}\n`)
          .join("");
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, all, { mode: 0o600 });
        await rename(temp, file);
        bytes = Buffer.byteLength(all);
      }
      await writeMeta(key, {
        version: VERSION,
        path: input.path,
        identity: input.identity,
        end: input.end,
        parsed: input.parsed,
        count: input.records.length,
        bytes: bytes!,
        check,
        ...(input.aggregates ? { aggregates: input.aggregates } : {}),
      });
      written.set(key, { count: input.records.length, bytes: bytes! });
    },
  };
}

export type SessionIndexStore = ReturnType<typeof createSessionIndexStore>;
