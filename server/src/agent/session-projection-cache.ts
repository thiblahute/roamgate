import { parseSessionTasks } from "./session-tasks";
import { parseSessionTitle } from "./session-title";
import { parseSessionCommands } from "./session-commands";
import { parseSessionArtifacts } from "./session-artifacts";
import type { AgentSessionFileAccess } from "./session-file-access";
import type { AgentSessionResolved, SessionFile } from "./session-types";
import { conversationMessagesFromTrajectory } from "./session-messages";
import { projectAgentTrajectory } from "./session-trajectory";
import {
  allHistoryEntries,
  appendOnlyHistory,
  HISTORY_WINDOW_LIMIT,
  historyEpoch,
  historyEntriesFromTrajectory,
  historyUpdate,
  type HistoryEntry,
} from "./session-history";
import { historyWindowEntries } from "../../../shared/agentHistory";
import {
  createSlicer,
  createSlimIndex,
  LARGE_SESSION_BYTES,
  MAX_APPEND_BYTES,
  MAX_TAIL_BYTES,
  parseWholeLines,
  readTailRecords,
  slimRecord,
  yieldToLoop,
} from "./session-tail";
import type { SessionIndexStore } from "./session-index-store";
import { isRecord } from "./session-utils";
import { summarizeTokenUsage } from "./token-usage";
import { readAntigravitySessionRecords } from "./antigravity-session";
import { keptRecords, rewoundRecordIds } from "./session-rewind";

function parseJsonl(text: string) {
  const records: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (isRecord(record)) records.push(record);
    } catch {
      // A writer may not have finished its last JSONL record yet.
    }
  }
  return records;
}

/**
 * Every record of a transcript, read in chunks when the file access can:
 * never the whole file as one string, and the event loop gets turns.
 */
async function readJsonlRecords(
  file: SessionFile,
  files: AgentSessionFileAccess,
) {
  if (!files.readRange || (file.size ?? 0) < LARGE_SESSION_BYTES)
    return parseJsonl(await files.readText(file.path));
  const records: Record<string, unknown>[] = [];
  const slice = createSlicer();
  let carry: Uint8Array = new Uint8Array(0);
  let at = 0;
  for (;;) {
    const chunk = await files.readRange(file.path, at, at + 4 * 1024 * 1024);
    if (!chunk.length) break;
    at += chunk.length;
    const bytes = new Uint8Array(carry.length + chunk.length);
    bytes.set(carry, 0);
    bytes.set(chunk, carry.length);
    const lines = await parseWholeLines(bytes, slice);
    for (const record of lines.records) records.push(record);
    carry = bytes.slice(lines.used);
  }
  // A last line with no newline yet may still be whole.
  if (carry.length)
    records.push(...parseJsonl(Buffer.from(carry).toString("utf8")));
  return records;
}

export async function readSessionProjection(
  agent: string,
  file: SessionFile,
  files: AgentSessionFileAccess,
  fallbackTime = file.createdAtMs ?? file.mtimeMs,
) {
  const read =
    agent === "agy"
      ? await readAntigravitySessionRecords(file.path)
      : await readJsonlRecords(file, files);
  const rewound = agent === "claude" ? rewoundRecordIds(read) : null;
  // What a rewind cut: out, its prompts kept as stand-ins (session-rewind).
  const records = keptRecords(read, rewound);
  const projectionFile = { ...file, mtimeMs: fallbackTime };
  const trajectory = projectAgentTrajectory(agent, projectionFile, records);
  const messages = conversationMessagesFromTrajectory(
    projectionFile,
    trajectory,
  );
  return {
    file,
    trajectory,
    messages,
    entries: historyEntriesFromTrajectory(projectionFile, trajectory),
    /** Every entry, for older pages; the cache keeps it only when small. */
    allEntries: allHistoryEntries(projectionFile, trajectory),
    /** What a Claude session ran on the side, rewound turns' still running. */
    tasks: agent === "claude" ? parseSessionTasks(read, { rewound }) : [],
    /** What a Claude session is about (session-title.ts). */
    title: agent === "claude" ? parseSessionTitle(records) : null,
    /** The pages a Claude session published with its Artifact tool. */
    artifacts: agent === "claude" ? parseSessionArtifacts(records) : [],
    /** The skills and custom commands a Claude session offers as /name. */
    commands: agent === "claude" ? parseSessionCommands(records) : [],
    stats: {
      turns: messages.filter((message) => message.role === "user").length,
      records: read.length - (rewound?.size ?? 0),
      token_usage: summarizeTokenUsage(records),
    },
  };
}

/** Entries past the window a tail read covers, so it starts on a turn. */
const TAIL_MARGIN = 20;

function withoutRewound(records: Record<string, unknown>[]) {
  const rewound = rewoundRecordIds(records);
  return {
    rewound,
    kept: keptRecords(records, rewound),
  };
}

/** The end of a Claude transcript as the history shows it. */
function projectTail(
  file: SessionFile,
  records: Record<string, unknown>[],
  fallbackTime: number,
) {
  // Only the turns in what was read can be rewound out of it; earlier ones
  // are before the window anyway.
  const { kept } = withoutRewound(records);
  const projectionFile = { ...file, mtimeMs: fallbackTime };
  const trajectory = projectAgentTrajectory("claude", projectionFile, kept);
  const all = allHistoryEntries(projectionFile, trajectory, { byRecord: true });
  return {
    trajectory,
    all,
    entries: historyWindowEntries(all, HISTORY_WINDOW_LIMIT),
    messages: conversationMessagesFromTrajectory(projectionFile, trajectory),
  };
}

function shownEntries(all: HistoryEntry[]) {
  let count = 0;
  for (const entry of all) if (entry.role !== "tool") count += 1;
  return count;
}

/** Whether a large transcript is read by its end (session-tail.ts). */
export function readsByTail(
  agent: string,
  file: SessionFile,
  files: AgentSessionFileAccess,
) {
  return (
    agent === "claude" &&
    !!files.readRange &&
    (file.size ?? 0) >= LARGE_SESSION_BYTES
  );
}

/**
 * A large Claude transcript's projection from its end only: what a task's
 * conversation or a preview shows of it.
 */
export async function readTailProjection(
  file: SessionFile,
  files: AgentSessionFileAccess,
  fallbackTime = file.createdAtMs ?? file.mtimeMs,
) {
  const tail = await readTailRecords(
    files.readRange!.bind(files),
    file.path,
    file.size ?? 0,
    (records) =>
      shownEntries(projectTail(file, records, fallbackTime).all) >=
      HISTORY_WINDOW_LIMIT + TAIL_MARGIN,
  );
  return projectTail(file, tail.records, fallbackTime);
}

/** What needs the whole session, from slim records (its index's). */
async function indexedAggregates(
  slim: Record<string, unknown>[],
  parsed: number,
) {
  const { rewound, kept } = withoutRewound(slim);
  await yieldToLoop();
  const tasks = parseSessionTasks(slim, { rewound });
  await yieldToLoop();
  const artifacts = parseSessionArtifacts(kept);
  const title = parseSessionTitle(kept);
  const commands = parseSessionCommands(kept);
  await yieldToLoop();
  // The history's own count over the slim records: their texts' starts
  // tell a prompt from what Claude Code wrote in the user's turn.
  const slimFile = { path: "", mtimeMs: 0 };
  const turns = conversationMessagesFromTrajectory(
    slimFile,
    projectAgentTrajectory("claude", slimFile, kept),
  ).filter((message) => message.role === "user").length;
  const token_usage = summarizeTokenUsage(kept);
  return {
    tasks,
    artifacts,
    title,
    commands,
    stats: {
      turns,
      records: parsed - rewound.size,
      token_usage,
    },
  };
}
type Aggregates = Awaited<ReturnType<typeof indexedAggregates>>;
/** Large sessions whose last aggregates are kept past their state. */
const KNOWN_LIMIT = 256;

/** Aggregates from part of a session only, until its index is ready. */
type MaybePartial = Aggregates & { partial?: true };

/**
 * Indexes built or brought up to date in the background, one at a time
 * for the whole process: after a restart many sessions want theirs, and
 * the requests that wait are answered meanwhile.
 */
let warmChain: Promise<unknown> = Promise.resolve();
function queueWarm<T>(work: () => Promise<T>): Promise<T> {
  const run = warmChain.then(work, work);
  warmChain = run.catch(() => {});
  return run;
}

/** A large transcript as read so far: its end, and its index once asked. */
type LargeSession = {
  identity: string | undefined;
  records: Record<string, unknown>[];
  /** Where the records read start, and where the last whole line ends. */
  start: number;
  end: number;
  /** What the first read from the end took: the tail is read again past 4x. */
  firstSpan: number;
  index: ReturnType<typeof createSlimIndex> | null;
  aggregates: { end: number; value: Promise<Aggregates> } | null;
  /** The aggregates saved with the index on disk, for a first answer. */
  saved: { end: number; value: Aggregates } | null;
  /** The index being taken from disk or built, in the background. */
  warming: Promise<void> | null;
  /** When the index was last saved, and how far. */
  persisted: { at: number; end: number } | null;
  cached: Cached | null;
};

type FullProjection = Awaited<ReturnType<typeof readSessionProjection>>;
/**
 * What the cache keeps: the trajectory is most of a projection's size (20 of
 * 27 MB for a 33 MB transcript) and only previews and exports need it, so
 * they build it again with `trajectory()`.
 */
type Projection = Omit<FullProjection, "trajectory">;
function withoutTrajectory(projection: FullProjection): Projection {
  const kept: Partial<FullProjection> = { ...projection };
  delete kept.trajectory;
  return kept as Projection;
}
type Cached = {
  projection: Projection;
  signature: string;
  /** historyEpoch's: the same in every process reading this file. */
  epoch: string;
  /** The transcript's size plus one: its prefix is the earlier revision. */
  revision: number;
  /** Set once this file was seen rewritten: its signature then. */
  generation: string | null;
  versions: Map<number, HistoryEntry[]>;
  bytes: number;
  fallbackTime: number;
  /** A large transcript's state: its projection covers its end only. */
  large?: LargeSession;
};
// Cache admission only needs a conservative retained-value estimate, not a
// serialized copy. Count shared values again; stop at the budget or deep input.
export function estimateRetainedBytes(
  value: unknown,
  budget: number,
  depth = 0,
): number {
  if (depth > 64 || budget < 0) return Infinity;
  if (typeof value === "string") {
    const bytes = 32 + 2 * value.length;
    return bytes > budget ? Infinity : bytes;
  }
  if (value === null || typeof value !== "object")
    return budget < 16 ? Infinity : 16;

  let bytes = 64;
  if (bytes > budget) return Infinity;
  if (Array.isArray(value)) {
    for (const item of value) {
      bytes += 8 + estimateRetainedBytes(item, budget - bytes - 8, depth + 1);
      if (bytes > budget) return Infinity;
    }
  } else {
    const record = value as Record<string, unknown>;
    for (const key in record) {
      if (!Object.hasOwn(record, key)) continue;
      bytes += 32 + 2 * key.length;
      if (bytes > budget) return Infinity;
      bytes += estimateRetainedBytes(record[key], budget - bytes, depth + 1);
      if (bytes > budget) return Infinity;
    }
  }
  return bytes;
}

function signature(file: SessionFile) {
  return JSON.stringify([
    file.path,
    file.mtimeMs,
    file.size,
    file.identity,
    file.changeToken,
    file.sessionId,
    file.createdAtMs,
    file.modelName,
    file.agentVersion,
  ]);
}
/**
 * The cursor of a transcript as it stands (shared/agentHistory.ts): a pure
 * function of the file, so every process answers a browser's cursor the
 * same. A format rewritten in place takes its signature into its epoch.
 */
function historyCursor(
  agent: string,
  file: SessionFile,
  generation: string | null,
) {
  return {
    epoch: historyEpoch(
      agent,
      file.path,
      file.identity,
      appendOnlyHistory(agent) ? generation : signature(file),
    ),
    revision: (file.size ?? 0) + 1,
  };
}

/** The versions kept under a cursor: those of the same epoch, and its own. */
function nextVersions(
  old: Cached | null | undefined,
  epoch: string,
  revision: number,
  entries: HistoryEntry[],
) {
  const versions =
    old && old.epoch === epoch
      ? new Map(old.versions)
      : new Map<number, HistoryEntry[]>();
  versions.delete(revision);
  versions.set(revision, entries);
  while (versions.size > 4) versions.delete(versions.keys().next().value!);
  return versions;
}

/** A file access that sees a file's first `size` bytes only. */
function prefixAccess(
  files: AgentSessionFileAccess,
  size: number,
): AgentSessionFileAccess {
  return {
    ...files,
    readText: async (path) =>
      size > 0
        ? Buffer.from(
            (await files.readPrefix(path, size)).subarray(0, size),
          ).toString("utf8")
        : "",
    readRange: files.readRange
      ? async (path, start, end) =>
          Math.min(end, size) > start
            ? files.readRange!(path, start, Math.min(end, size))
            : new Uint8Array(0)
      : undefined,
  };
}

function sessionKey(resolved: AgentSessionResolved) {
  return JSON.stringify([
    resolved.agent,
    resolved.session?.kind,
    resolved.session?.value,
  ]);
}

// One instance per connection. Pending work coalesces, while completed payloads
// are LRU bounded (including the small revision history). Oversize sessions are
// served but not retained. Changed files still require a full provider projection.
export function createSessionProjectionCache(
  files: AgentSessionFileAccess,
  limits: { entries: number; bytes: number; large?: number } = {
    entries: 16,
    bytes: 64 * 1024 * 1024,
  },
  options: {
    /** Where large sessions' indexes are kept across restarts. */
    store?: SessionIndexStore | null;
    /** How often a growing index is saved again, at most. */
    persistMs?: number;
  } = {},
) {
  const store = options.store ?? null;
  const persistMs = options.persistMs ?? 30_000;
  // The last aggregates of each large session, by path, kept past its
  // state (larges holds a few only): one unchanged since answers at once.
  const known = new Map<
    string,
    { identity: string | undefined; end: number; value: Aggregates }
  >();
  const largeLimit = limits.large ?? 8;
  const cache = new Map<string, Cached>();
  const pending = new Map<string, Promise<Cached>>();
  // Large transcripts' states, kept apart from the byte budget: dropping
  // one would mean reading its end again.
  const larges = new Map<string, LargeSession>();
  let retainedBytes = 0;
  function remove(key: string) {
    const old = cache.get(key);
    if (old) retainedBytes -= old.bytes;
    cache.delete(key);
  }
  const read = (path: string, start: number, end: number) =>
    files.readRange!(path, start, end);

  async function readLargeTail(file: SessionFile, fallbackTime: number) {
    return readTailRecords(
      read,
      file.path,
      file.size ?? 0,
      (records) =>
        shownEntries(projectTail(file, records, fallbackTime).all) >=
        HISTORY_WINDOW_LIMIT + TAIL_MARGIN,
    );
  }

  /** A large Claude transcript: its end read, then what is appended. */
  async function loadLarge(
    key: string,
    agent: string,
    current: SessionFile,
    isCurrent: () => boolean,
  ): Promise<Cached> {
    let state = larges.get(key);
    const size = current.size ?? 0;
    // Cut, or changed without growing: the same file rewritten.
    const cut =
      !!state &&
      state.identity === current.identity &&
      (size < state.end ||
        (size === state.end &&
          !!state.cached &&
          state.cached.signature !== signature(current)));
    if (state && (state.identity !== current.identity || cut)) {
      // Replaced or cut: read again, as a new epoch.
      state = undefined;
      larges.delete(key);
    }
    const old = state?.cached ?? null;
    if (old?.signature === signature(current)) return old;
    const fallbackTime =
      old?.fallbackTime ?? current.createdAtMs ?? current.mtimeMs;
    if (!state) {
      const tail = await readLargeTail(current, fallbackTime);
      state = {
        identity: current.identity,
        records: tail.records,
        start: tail.start,
        end: tail.end,
        firstSpan: Math.max(1, tail.end - tail.start),
        index: null,
        aggregates: null,
        saved: null,
        warming: null,
        persisted: null,
        cached: null,
      };
    } else if (
      size - state.end > MAX_APPEND_BYTES ||
      state.end - state.start > Math.max(4 * state.firstSpan, MAX_TAIL_BYTES)
    ) {
      // Much was appended, or what is kept has grown well past a window:
      // read the end again. Entry ids hold (allHistoryEntries' byRecord).
      const tail = await readLargeTail(current, fallbackTime);
      state.records = tail.records;
      state.start = tail.start;
      state.end = tail.end;
      state.firstSpan = Math.max(1, tail.end - tail.start);
    } else if (size > state.end) {
      const appended = await read(current.path, state.end, size);
      const lines = await parseWholeLines(appended);
      for (const record of lines.records) state.records.push(record);
      state.end += lines.used;
    }
    const tail = projectTail(current, state.records, fallbackTime);
    const generation = cut ? signature(current) : (old?.generation ?? null);
    const { epoch, revision } = historyCursor(agent, current, generation);
    const versions = nextVersions(old, epoch, revision, tail.entries);
    const value: Cached = {
      projection: {
        file: current,
        messages: tail.messages,
        entries: tail.entries,
        allEntries: tail.all,
        tasks: [],
        artifacts: [],
        title: null,
        commands: [],
        stats: { turns: 0, records: 0, token_usage: null },
      },
      signature: signature(current),
      epoch,
      revision,
      generation,
      versions,
      bytes: 0,
      fallbackTime,
      large: state,
    };
    if (!isCurrent()) return value;
    state.cached = value;
    larges.delete(key);
    larges.set(key, state);
    while (larges.size > largeLimit) larges.delete(larges.keys().next().value!);
    return value;
  }

  /** The aggregates of the index as it stands, computed once per end. */
  function aggregatesOf(state: LargeSession, path: string) {
    const index = state.index!;
    const end = index.end;
    if (state.aggregates?.end !== end) {
      const value = indexedAggregates(index.records, index.parsed);
      state.aggregates = { end, value };
      void value.then((aggregates) =>
        remember(path, state.identity, end, aggregates),
      );
      void persist(state, path);
    }
    return state.aggregates.value;
  }

  function remember(
    path: string,
    identity: string | undefined,
    end: number,
    value: Aggregates,
  ) {
    known.delete(path);
    known.set(path, { identity, end, value });
    while (known.size > KNOWN_LIMIT) known.delete(known.keys().next().value!);
  }

  /** Saves the index (and its aggregates) on disk, now and then. */
  async function persist(state: LargeSession, path: string) {
    const index = state.index;
    if (!store || !index || !state.aggregates) return;
    if (state.persisted?.end === index.end) return;
    if (state.persisted && Date.now() - state.persisted.at < persistMs) return;
    const end = index.end;
    state.persisted = { at: Date.now(), end };
    const aggregates = { end, value: await state.aggregates.value };
    await queueWarm(() =>
      store.save({
        path,
        identity: state.identity,
        end,
        parsed: index.parsed,
        records: index.records.slice(),
        read,
        aggregates,
      }),
    ).catch(() => {
      state.persisted = null;
    });
  }

  /**
   * The index taken from disk (only what was appended since is read) or
   * built, in the background, one session at a time.
   */
  function warm(state: LargeSession, path: string): Promise<void> {
    // Made ready even once dropped from the cache meanwhile (many large
    // sessions at once): its aggregates are remembered and saved, so its
    // next read answers whole without its index.
    state.warming ??= queueWarm(async () => {
      if (!state.index) {
        const index = createSlimIndex(read, path);
        const saved = store
          ? await store
              .load({ path, identity: state.identity, size: state.end, read })
              .catch(() => null)
          : null;
        if (saved) {
          index.restore(saved);
          if (saved.aggregates)
            state.saved = {
              end: saved.aggregates.end,
              value: saved.aggregates.value as Aggregates,
            };
          state.persisted = { at: Date.now(), end: saved.end };
        }
        state.index = index;
      }
      await state.index.update(state.end);
      await aggregatesOf(state, path);
    }).finally(() => {
      state.warming = null;
    });
    return state.warming;
  }

  /**
   * What needs the whole of a large session, from its index. An index not
   * ready (a restart, a session not asked before) never holds a request
   * up: it is made ready in the background, and meanwhile the answer comes
   * from what is known (the last aggregates, those saved with the index,
   * or the end of the session read already), marked partial.
   */
  async function largeAggregates(
    state: LargeSession,
    path: string,
    wait = false,
  ): Promise<MaybePartial> {
    if (wait) {
      await warm(state, path);
      await state.index!.update(state.end);
      return aggregatesOf(state, path);
    }
    const index = state.index;
    if (index && !state.warming && state.end - index.end <= MAX_APPEND_BYTES) {
      await index.update(state.end);
      return aggregatesOf(state, path);
    }
    const last = known.get(path);
    if (last && last.identity === state.identity && last.end === state.end)
      return last.value;
    if (!state.saved && !state.aggregates && store) {
      const saved = await store
        .peek({ path, identity: state.identity, size: state.end })
        .catch(() => null);
      if (saved && !state.saved)
        state.saved = { end: saved.end, value: saved.value as Aggregates };
    }
    // Saved for the session as it stands (nothing appended since): whole,
    // and its index is not even loaded. Most sessions are idle.
    if (state.saved?.end === state.end && !state.index) {
      remember(path, state.identity, state.end, state.saved.value);
      return state.saved.value;
    }
    void warm(state, path).catch(() => {});
    if (state.aggregates)
      return { ...(await state.aggregates.value), partial: true };
    if (state.saved) return { ...state.saved.value, partial: true };
    const slim = state.records.flatMap((record) => {
      const kept = slimRecord(record);
      return kept ? [kept] : [];
    });
    return {
      ...(await indexedAggregates(slim, state.records.length)),
      partial: true,
    };
  }

  function invalidate(resolved: AgentSessionResolved) {
    const prefix = `${sessionKey(resolved)}:`;
    for (const key of larges.keys())
      if (key.startsWith(prefix)) {
        larges.delete(key);
        known.delete(key.slice(prefix.length));
      }
    for (const key of cache.keys()) if (key.startsWith(prefix)) remove(key);
    for (const key of pending.keys())
      if (key.startsWith(prefix)) pending.delete(key);
  }
  async function load(resolved: AgentSessionResolved): Promise<Cached> {
    const file = resolved.file;
    if (!file) throw new Error("Session file unavailable");
    const key = `${sessionKey(resolved)}:${file.path}`;
    const running = pending.get(key);
    if (running) return running;
    const isCurrent = () => pending.get(key) === task;
    const task: Promise<Cached> = (async () => {
      const old = cache.get(key);
      // Re-stat even if resolution came from a provider's descriptor cache.
      let before = await files.statFile(file.path);
      if (!before)
        throw new Error(
          "Session file disappeared; refresh to resolve it again",
        );
      let current = { ...file, ...before };
      if (readsByTail(resolved.agent, current, files)) {
        remove(key);
        return loadLarge(key, resolved.agent, current, isCurrent);
      }
      larges.delete(key);
      if (old?.signature === signature(current)) {
        if (isCurrent() && cache.get(key) === old) {
          cache.delete(key);
          cache.set(key, old);
        }
        return old;
      }
      let projection: Projection | undefined;
      const isReset = () =>
        !old ||
        old.projection.file.identity !== current.identity ||
        (current.size ?? 0) < (old.projection.file.size ?? 0);
      let fallbackTime = current.createdAtMs ?? current.mtimeMs;
      for (let attempt = 0; attempt < 3; attempt++) {
        // Keep synthetic timestamps stable on append, but respect explicit
        // corrections (including removal) of the descriptor's creation time.
        fallbackTime =
          !isReset() &&
          old &&
          old.projection.file.createdAtMs === current.createdAtMs
            ? old.fallbackTime
            : (current.createdAtMs ?? current.mtimeMs);
        projection = withoutTrajectory(
          await readSessionProjection(
            resolved.agent,
            current,
            files,
            fallbackTime,
          ),
        );
        const after = await files.statFile(file.path);
        if (!after) throw new Error("Session file disappeared while reading");
        if (signature({ ...file, ...after }) === signature(current)) break;
        projection = undefined;
        before = after;
        current = { ...file, ...before };
      }
      if (!projection)
        throw new Error(
          "Session file changed while reading; retry on the next refresh",
        );
      // The same file cut, or changed without growing: rewritten.
      const sameFile =
        !!old && old.projection.file.identity === current.identity;
      const cut =
        sameFile && (current.size ?? 0) <= (old!.projection.file.size ?? 0);
      const generation = !sameFile
        ? null
        : cut
          ? signature(current)
          : old!.generation;
      const { epoch, revision } = historyCursor(
        resolved.agent,
        current,
        generation,
      );
      const versions = nextVersions(old, epoch, revision, projection.entries);
      const value: Cached = {
        projection,
        signature: signature(current),
        epoch,
        revision,
        generation,
        versions,
        bytes: 0,
        fallbackTime,
      };
      value.bytes = estimateRetainedBytes(
        [projection, ...versions.values()],
        limits.bytes,
      );
      if (!isCurrent()) return value;
      remove(key);
      if (value.bytes <= limits.bytes && limits.entries > 0) {
        cache.set(key, value);
        retainedBytes += value.bytes;
        while (cache.size > limits.entries || retainedBytes > limits.bytes)
          remove(cache.keys().next().value!);
      }
      return value;
    })();
    pending.set(key, task);
    try {
      return await task;
    } catch (error) {
      if (pending.get(key) === task) remove(key);
      throw error;
    } finally {
      if (pending.get(key) === task) pending.delete(key);
    }
  }
  /** The entries a transcript's first `size` bytes showed. */
  async function entriesAt(agent: string, cached: Cached, size: number) {
    const file = { ...cached.projection.file, size };
    const limited = prefixAccess(files, size);
    if (readsByTail(agent, file, limited))
      return (await readTailProjection(file, limited, cached.fallbackTime))
        .entries;
    return (
      await readSessionProjection(agent, file, limited, cached.fallbackTime)
    ).entries;
  }

  const api = {
    invalidate,
    /**
     * The session's projection with what needs all of it. A large one's
     * index not ready yet answers from part of it (`partial`), unless
     * `wait`.
     */
    async get(
      resolved: AgentSessionResolved,
      options: { wait?: boolean } = {},
    ) {
      const cached = await load(resolved);
      if (!cached.large) return cached.projection;
      return {
        ...cached.projection,
        ...(await largeAggregates(
          cached.large,
          cached.projection.file.path,
          options.wait,
        )),
      };
    },
    /**
     * The session's entries shown: a history's window. For an entry looked
     * up by id, without a large session's index.
     */
    /**
     * What needs the whole session (tasks, artifacts, title, commands,
     * stats) and the file as it stands. A large session unchanged since
     * its aggregates were computed (here, or saved with its index) is
     * answered from them without reading its end again.
     */
    async aggregates(resolved: AgentSessionResolved) {
      const file = resolved.file;
      if (!file) throw new Error("Session file unavailable");
      const stat = await files.statFile(file.path);
      const current = stat ? { ...file, ...stat } : null;
      if (current && readsByTail(resolved.agent, current, files)) {
        const size = current.size ?? 0;
        const last = known.get(current.path);
        if (last && last.identity === current.identity && last.end === size)
          return { file: current, ...last.value };
        const saved = store
          ? await store
              .peek({ path: current.path, identity: current.identity, size })
              .catch(() => null)
          : null;
        if (saved?.end === size) {
          const value = saved.value as Aggregates;
          remember(current.path, current.identity, size, value);
          return { file: current, ...value };
        }
      }
      const projection = await api.get(resolved);
      const {
        file: read,
        tasks,
        artifacts,
        title,
        commands,
        stats,
      } = projection;
      return {
        file: read,
        tasks,
        artifacts,
        title,
        commands,
        stats,
        ...((projection as MaybePartial).partial ? { partial: true } : {}),
      };
    },
    /** Entries and messages shown, without what needs the whole session. */
    async recent(resolved: AgentSessionResolved) {
      return (await load(resolved)).projection;
    },
    /**
     * The session's records for a whole-session scan (a rewind's): a large
     * one's slim index (session-tail.ts), a small one read whole.
     */
    async records(resolved: AgentSessionResolved) {
      const cached = await load(resolved);
      if (!cached.large) return readJsonlRecords(cached.projection.file, files);
      const state = cached.large;
      // A scan needs every record: it waits for the index.
      await warm(state, cached.projection.file.path);
      await state.index!.update(state.end);
      return state.index!.records;
    },
    async entries(resolved: AgentSessionResolved) {
      return (await load(resolved)).projection.allEntries;
    },
    /**
     * A page of entries before `beforeId`, the newest last: what scrolling
     * up shows. A large session reads further back from where it stopped,
     * a chunk at a time, only as far as the page needs.
     */
    async older(
      resolved: AgentSessionResolved,
      beforeId: string,
      limit: number,
    ) {
      const cached = await load(resolved);
      const page = Math.max(1, Math.min(Math.floor(limit) || 50, 200));
      const before = (all: HistoryEntry[]) => {
        const at = all.findIndex((entry) => entry.id === beforeId);
        return at < 0 ? null : all.slice(0, at);
      };
      let all = cached.projection.allEntries;
      let earlier = before(all);
      const state = cached.large;
      if (state) {
        let chunk = 1024 * 1024;
        while (
          state.start > 0 &&
          (!earlier || shownEntries(earlier) < page + TAIL_MARGIN)
        ) {
          const from = Math.max(0, state.start - chunk);
          const bytes = await read(
            cached.projection.file.path,
            from,
            state.start,
          );
          // The first line read may have started before `from`.
          const skip = from > 0 ? bytes.indexOf(10) + 1 : 0;
          if (from > 0 && skip === 0) {
            chunk *= 2;
            continue;
          }
          const lines = await parseWholeLines(bytes.subarray(skip));
          state.records = lines.records.concat(state.records);
          state.start = from + skip;
          chunk = Math.min(chunk * 2, MAX_APPEND_BYTES);
          all = projectTail(
            cached.projection.file,
            state.records,
            cached.fallbackTime,
          ).all;
          earlier = before(all);
        }
        cached.projection.allEntries = all;
      }
      if (!earlier) throw new Error("That entry is no longer in the history");
      const shown = historyWindowEntries(earlier, page);
      return {
        entries: shown,
        has_more: shown.length < earlier.length || (state?.start ?? 0) > 0,
      };
    },
    /**
     * The session's trajectory, built again from its file. A large one's
     * covers its end only unless `whole` (an export) asks for all of it.
     */
    async trajectory(
      resolved: AgentSessionResolved,
      options: { whole?: boolean } = {},
    ) {
      const cached = await load(resolved);
      if (cached.large && !options.whole)
        return projectTail(
          cached.projection.file,
          cached.large.records,
          cached.fallbackTime,
        ).trajectory;
      const projection = await readSessionProjection(
        resolved.agent,
        cached.projection.file,
        files,
        cached.fallbackTime,
      );
      return projection.trajectory;
    },
    /**
     * The history as it stands, as a delta from the browser's `cursor`
     * when that cursor is this file's: its revision, if not kept, is
     * projected again from the transcript's prefix, so any process
     * answers it the same.
     */
    async history(resolved: AgentSessionResolved, cursor: unknown) {
      const cached = await load(resolved);
      const agent = resolved.agent;
      const base = isRecord(cursor)
        ? (cursor as { epoch?: unknown; revision?: unknown })
        : null;
      const revision =
        base?.epoch === cached.epoch &&
        typeof base.revision === "number" &&
        Number.isSafeInteger(base.revision)
          ? base.revision
          : null;
      if (
        appendOnlyHistory(agent) &&
        revision !== null &&
        revision > cached.revision
      ) {
        // Its cursor is past the file's end: rewritten, unseen here.
        const file = cached.projection.file;
        cached.generation = signature(file);
        const next = historyCursor(agent, file, cached.generation);
        cached.epoch = next.epoch;
        cached.versions = nextVersions(
          null,
          next.epoch,
          next.revision,
          cached.projection.entries,
        );
      }
      let versions = cached.versions;
      if (
        appendOnlyHistory(agent) &&
        base?.epoch === cached.epoch &&
        revision !== null &&
        revision >= 1 &&
        revision < cached.revision &&
        !versions.has(revision)
      ) {
        versions = new Map(versions);
        versions.set(revision, await entriesAt(agent, cached, revision - 1));
      }
      return {
        projection: cached.projection,
        update: historyUpdate(
          { epoch: cached.epoch, revision: cached.revision },
          cached.projection.entries,
          cursor,
          versions,
        ),
      };
    },
  };
  return api;
}
export type SessionProjectionCache = ReturnType<
  typeof createSessionProjectionCache
>;
