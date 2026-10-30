import type { HeadlessProcess } from "./headless";

/**
 * What Roamgate asks of a pane's holder (roamgate-hold), numbered: the
 * holder applies each once, in order, and says which it applied last. Until
 * then every poll answer carries it again.
 */
export type HolderCommand = {
  seq: number;
  op: "start" | "input" | "end" | "kill";
  [key: string]: unknown;
};

/** What a holder says of itself with each poll. */
export type HolderStatus = {
  /** A new id each time a holder starts: its log starts over with it. */
  holderId: string;
  /** The last command it applied. */
  applied: number;
  /** Its latest child's number (1, 2...; 0 before the first). */
  child: number;
  childAlive: boolean;
  childPid: number;
  /** How long its log is, in bytes. */
  logSize: number;
  /** Where its latest child's lines start in the log. */
  epochOffset: number;
};

/** What Roamgate had read of a holder's log, kept on the lease. */
export type HolderSaved = {
  id: string;
  offset: number;
  pending?: HolderCommand[];
};

function integer(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** A holder's status from its poll; null from a holder without a child. */
export function parseHolderStatus(form: URLSearchParams): HolderStatus | null {
  const holderId = form.get("holder_id") ?? "";
  if (!/^[0-9a-f]{8,64}$/i.test(holderId)) return null;
  const applied = integer(form.get("applied"));
  const child = integer(form.get("child"));
  const logSize = integer(form.get("log_size"));
  const epochOffset = integer(form.get("epoch_offset"));
  if (
    applied === null ||
    child === null ||
    logSize === null ||
    epochOffset === null
  )
    return null;
  return {
    holderId,
    applied,
    child,
    childAlive: form.get("child_alive") === "1",
    childPid: integer(form.get("child_pid")) ?? 0,
    logSize,
    epochOffset,
  };
}

type Epoch = {
  n: number;
  pid: number;
  buffer: string[];
  /** Lines at the head of `buffer` an earlier reader handled already. */
  replayed: number;
  code: number | null;
  /** Where its exit line ends in the log. */
  endOffset: number | null;
  taken: boolean;
  detached: boolean;
  /** The user messages written to it that claude never got (at its exit). */
  undelivered: string[];
  wake?: () => void;
  exit: PromiseWithResolvers<number>;
};

/** An input written to a child, until the holder notes it as applied. */
type SentInput = {
  child: number;
  line: string;
  kind: string;
  dropped: boolean;
};

function inputKind(line: string): {
  kind: string;
  request_id?: string;
} {
  try {
    const value = JSON.parse(line) as {
      type?: unknown;
      response?: { request_id?: unknown };
    };
    if (value.type === "user") return { kind: "user" };
    if (value.type === "control_response")
      return typeof value.response?.request_id === "string"
        ? { kind: "control_response", request_id: value.response.request_id }
        : { kind: "control_response" };
    if (value.type === "control_request") return { kind: "control_request" };
  } catch {
    // Written as is; the holder notes it as "other".
  }
  return { kind: "other" };
}

/**
 * Roamgate's end of one pane holder: the commands it has not confirmed,
 * where Roamgate is in its log, and the children found there. Each child
 * becomes a process the conversation session reads and writes as if it
 * were its own; reading it again after a new runtime (or a Roamgate
 * restart) starts where the earlier one stopped, the lines before that
 * handed over as already seen (`replayed`).
 */
export function createHolderChannel(options: {
  paneId: string;
  /** What a runtime before this one had read, if it was this holder. */
  saved?: HolderSaved | null;
  /** New commands wait: the holder's poll is answered now. */
  onWork: () => void;
  /** Roamgate has read the holder's log this far. */
  onOffset?: (id: string, offset: number) => void;
  /** A command was added: what is unconfirmed should be saved now. */
  onPending?: () => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}) {
  let saved = options.saved ?? null;
  let id: string | null = null;
  let status: HolderStatus | null = null;
  // 0 until the holder said which command it applied last.
  let nextSeq = 0;
  let pending: HolderCommand[] = [];
  // Where the next line Roamgate reads starts; null until synced.
  let expected: number | null = null;
  // Lines ending at or before this were handled by an earlier reader.
  let boundary = 0;
  // How long the log was when this reader started: caught up past it.
  let target = 0;
  // The holder should hear at once where to send its log from.
  let announce = false;
  let lastEpoch = 0;
  let refusal: string | null = null;
  let epochs: Epoch[] = [];
  // The inputs written to children, by sequence number, until the holder
  // notes them applied: one it dropped (or never applies, its child gone)
  // is a message claude never got.
  const sent = new Map<number, SentInput>();
  const listeners = new Set<() => void>();

  function changed() {
    for (const listener of [...listeners]) listener();
  }

  function waitFor(
    check: () => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (check()) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const finish = (value: boolean | Error) => {
        clearTimeout(timer);
        listeners.delete(listener);
        signal?.removeEventListener("abort", onAbort);
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      const listener = () => {
        if (check()) finish(true);
      };
      const onAbort = () =>
        finish(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Gave up waiting for the pane holder"),
        );
      const timer = setTimeout(() => finish(false), timeoutMs);
      listeners.add(listener);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  /**
   * `exited`: its exit line was read, so an input not noted before it is
   * one the holder drops. Otherwise (its holder is gone) only the inputs it
   * never confirmed count as not delivered.
   */
  function finishEpoch(
    epoch: Epoch,
    code: number,
    endOffset: number | null,
    exited = false,
  ) {
    if (epoch.code !== null) return;
    const unconfirmed = new Set(
      pending
        .filter((command) => command.child === epoch.n)
        .map((command) => command.seq),
    );
    for (const [seq, input] of sent) {
      if (input.child !== epoch.n) continue;
      sent.delete(seq);
      if (
        input.kind === "user" &&
        (input.dropped || exited || unconfirmed.has(seq))
      )
        epoch.undelivered.push(input.line);
    }
    // What is still to be sent to it would only be dropped.
    pending = pending.filter(
      (command) => command.op === "start" || command.child !== epoch.n,
    );
    epoch.code = code;
    epoch.endOffset = endOffset;
    epoch.exit.resolve(code);
    epoch.wake?.();
    epoch.wake = undefined;
    // Read to its end by its reader: nothing more is kept of it.
    if (epoch.taken) epochs = epochs.filter((each) => each !== epoch);
  }

  /** Another holder in the pane: the earlier one's children are gone. */
  function reset(next: HolderStatus) {
    for (const epoch of epochs) finishEpoch(epoch, -1, null);
    epochs = [];
    const carried = saved && saved.id === next.holderId ? saved : null;
    saved = null;
    id = next.holderId;
    pending = (carried?.pending ?? []).filter(
      (command) => command.seq > next.applied,
    );
    sent.clear();
    for (const command of pending)
      if (
        command.op === "input" &&
        typeof command.child === "number" &&
        typeof command.line === "string"
      )
        sent.set(command.seq, {
          child: command.child,
          line: command.line,
          kind: typeof command.kind === "string" ? command.kind : "other",
          dropped: false,
        });
    nextSeq =
      Math.max(next.applied, ...pending.map((command) => command.seq)) + 1;
    lastEpoch = 0;
    refusal = null;
    // Read again from the latest child's start (or from where an earlier
    // reader stopped, if before); what was read already is replayed.
    const offset = carried
      ? Math.min(carried.offset, next.logSize)
      : next.logSize;
    expected = Math.min(offset, next.epochOffset);
    boundary = offset;
    target = next.logSize;
    announce = true;
    options.log?.("reading the pane holder's log", {
      pane: options.paneId,
      from: expected,
      seen: boundary,
      size: next.logSize,
    });
  }

  function line(text: string, end: number) {
    if (text.startsWith('{"type":"roamgate_child"')) {
      let marker: {
        event?: unknown;
        child?: unknown;
        pid?: unknown;
        code?: unknown;
        reason?: unknown;
      };
      try {
        marker = JSON.parse(text);
      } catch {
        return;
      }
      if (marker.event === "start" && typeof marker.child === "number") {
        for (const epoch of epochs)
          if (epoch.code === null) finishEpoch(epoch, -1, null);
        epochs.push({
          n: marker.child,
          pid: typeof marker.pid === "number" ? marker.pid : 0,
          buffer: [],
          replayed: 0,
          code: null,
          endOffset: null,
          taken: false,
          detached: false,
          undelivered: [],
          exit: Promise.withResolvers<number>(),
        });
        lastEpoch = Math.max(lastEpoch, marker.child);
      } else if (marker.event === "exit") {
        const epoch = epochs.find((each) => each.n === marker.child);
        if (epoch)
          finishEpoch(
            epoch,
            typeof marker.code === "number" ? marker.code : -1,
            end,
            true,
          );
      } else if (marker.event === "refused" && end > boundary)
        refusal =
          typeof marker.reason === "string"
            ? marker.reason
            : "The pane holder did not start Claude";
      return;
    }
    if (text.startsWith('{"type":"roamgate_input"')) noted(text);
    const epoch = epochs.find(
      (each) => each.n === lastEpoch && each.code === null,
    );
    if (!epoch) return;
    epoch.buffer.push(text);
    if (end <= boundary && !epoch.taken) epoch.replayed += 1;
    epoch.wake?.();
    epoch.wake = undefined;
  }

  /** The holder noted an input: written to its child, or dropped. */
  function noted(text: string) {
    let note: { seq?: unknown; dropped?: unknown };
    try {
      note = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof note.seq !== "number") return;
    const input = sent.get(note.seq);
    if (!input) return;
    if (note.dropped) input.dropped = true;
    else sent.delete(note.seq);
  }

  function enqueue(command: Omit<HolderCommand, "seq">): number {
    if (!nextSeq || !id) throw new Error("The pane holder is not connected");
    const seq = nextSeq;
    nextSeq += 1;
    pending.push({ ...command, seq } as HolderCommand);
    if (
      command.op === "input" &&
      typeof command.child === "number" &&
      typeof command.line === "string"
    )
      sent.set(seq, {
        child: command.child,
        line: command.line,
        kind: typeof command.kind === "string" ? command.kind : "other",
        dropped: false,
      });
    options.onPending?.();
    options.onWork();
    return seq;
  }

  function adapter(epoch: Epoch): HeadlessProcess {
    epoch.taken = true;
    const replayed = epoch.replayed;
    // Everything read of it so far: caught up once these are handled.
    const catchUp = epoch.buffer.length;
    if (epoch.code !== null) epochs = epochs.filter((each) => each !== epoch);
    let ended = epoch.code !== null;
    async function* lines() {
      for (;;) {
        if (epoch.detached) return;
        if (epoch.buffer.length) {
          yield epoch.buffer.shift()!;
          continue;
        }
        if (epoch.code !== null) return;
        await new Promise<void>((resolve) => {
          epoch.wake = resolve;
        });
      }
    }
    return {
      lines: lines(),
      replayed,
      catchUp,
      undelivered: () => [...epoch.undelivered],
      pid: epoch.pid || undefined,
      exited: epoch.exit.promise,
      write(text) {
        if (ended || epoch.code !== null)
          throw new Error("The Claude Code process is closing");
        const line = text.replace(/\n$/, "");
        enqueue({ op: "input", child: epoch.n, line, ...inputKind(line) });
      },
      end() {
        if (ended) return;
        ended = true;
        if (epoch.code === null) enqueue({ op: "end", child: epoch.n });
      },
      kill() {
        if (epoch.code === null) enqueue({ op: "kill", child: epoch.n });
      },
      detach() {
        epoch.detached = true;
        epoch.wake?.();
        epoch.wake = undefined;
      },
    };
  }

  const synced = () => id !== null && expected !== null && expected >= target;

  return {
    paneId: options.paneId,
    holderId: () => id,
    status: () => status,
    /** A holder polled: its status is recorded, its acks drop commands. */
    update(next: HolderStatus) {
      if (next.holderId !== id) reset(next);
      pending = pending.filter((command) => command.seq > next.applied);
      status = next;
      changed();
    },
    /** Whether a poll should be answered at once. */
    hasWork: () => pending.length > 0 || announce,
    /** What a poll answer carries: commands, and where to send from. */
    work(): { commands?: HolderCommand[]; output_from?: number } {
      announce = false;
      return {
        ...(pending.length
          ? { commands: pending.map((command) => ({ ...command })) }
          : {}),
        ...(expected !== null ? { output_from: expected } : {}),
      };
    },
    /**
     * Lines of the holder's log from `offset` to `end`. Taken only when
     * they follow what was read (else the holder is told where to send
     * from), so each is read once.
     */
    receive(input: {
      holderId: string;
      offset: number;
      end: number;
      data: string;
    }): { offset?: number } {
      if (input.holderId !== id || expected === null) return {};
      if (input.offset !== expected || input.end < input.offset)
        return { offset: expected };
      let at = input.offset;
      const parts = input.data.split("\n");
      // Whole lines only: the text after the last newline is empty.
      parts.pop();
      for (const part of parts) {
        at += Buffer.byteLength(part) + 1;
        if (part) line(part, Math.min(at, input.end));
      }
      expected = input.end;
      if (id) options.onOffset?.(id, expected);
      changed();
      return { offset: expected };
    },

    /**
     * The pane's headless claude: the oldest child not read yet (one that
     * runs, or one that ended while nobody read), else, unless only
     * attaching, a new one the holder starts.
     */
    async spawn(spawn: {
      command: Record<string, unknown>;
      attachOnly?: boolean;
      signal?: AbortSignal;
      timeoutMs?: number;
    }): Promise<HeadlessProcess | null> {
      const timeoutMs = spawn.timeoutMs ?? 30_000;
      // A long log over a slow link takes a while: given up only when
      // nothing more comes for a whole timeout.
      let caughtUp = false;
      for (;;) {
        const from = expected;
        caughtUp = await waitFor(synced, timeoutMs, spawn.signal);
        if (caughtUp || expected === null || expected === from) break;
      }
      if (!caughtUp)
        throw new Error(
          id
            ? "The pane holder's log could not be read"
            : "The pane holder is not connected",
        );
      // Children that ended before the earlier reader stopped: done with.
      epochs = epochs.filter(
        (epoch) =>
          epoch.taken ||
          epoch.code === null ||
          epoch.endOffset === null ||
          epoch.endOffset > boundary,
      );
      const ready = epochs.find((epoch) => !epoch.taken);
      if (ready) return adapter(ready);
      if (spawn.attachOnly) return null;
      if (epochs.some((epoch) => epoch.code === null))
        throw new Error("The pane holder still runs a conversation process");
      const before = lastEpoch;
      refusal = null;
      enqueue({ op: "start", ...spawn.command });
      const started = await waitFor(
        () => lastEpoch > before || refusal !== null,
        timeoutMs,
        spawn.signal,
      );
      if (refusal) throw new Error(refusal);
      const epoch = epochs.find((each) => each.n > before && !each.taken);
      if (!started || !epoch)
        throw new Error("The pane holder did not start Claude in time");
      return adapter(epoch);
    },

    /** Whether the holder runs a child now (as it last said). */
    childAlive: () =>
      epochs.some((epoch) => epoch.code === null) ||
      (status?.childAlive ?? false),
    /** What a runtime after this one needs to read on. */
    save(): HolderSaved | null {
      if (!id || expected === null) return null;
      return {
        id,
        offset: expected,
        ...(pending.length
          ? { pending: pending.map((command) => ({ ...command })) }
          : {}),
      };
    },
    /** Stops every reader: the holder and its child keep running. */
    detach() {
      for (const epoch of epochs) {
        epoch.detached = true;
        epoch.wake?.();
        epoch.wake = undefined;
      }
    },
  };
}

export type HolderChannel = ReturnType<typeof createHolderChannel>;
