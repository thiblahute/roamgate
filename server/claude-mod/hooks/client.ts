/**
 * The Roamgate mod's client: no engine types, so the server's tests run it
 * with a fake engine. It long-polls Roamgate for the messages addressed to
 * this Claude session's pane, submits them one at a time as prompts, and
 * acknowledges each once its turn started. register.ts binds it to `$`.
 */

/** The protocol this mod speaks; the server answers its own. */
export const MOD_PROTOCOL = 1;

/** How long the server may hold a poll: under the 30 s fetch limit. */
export const POLL_WAIT_MS = 20_000;

/** How often a missing socket (Roamgate not running) is looked for. */
export const ABSENT_RETRY_MS = 30_000;

/** Right after a working poll (Roamgate restarting): this often, a minute. */
export const RESTART_RETRY_MS = 3_000;
const RESTART_RETRIES = 20;

/** The longest wait between failed polls. */
export const MAX_BACKOFF_MS = 30_000;

/**
 * A submit refused because the user stopped the session (Esc), or a queued
 * prompt that stop removed: both hold the queue until the user's next turn
 * ends (Claude Code refuses plugin input until the user's next input).
 */
const STOPPED =
  /the session was stopped and nobody has sent input since|was removed from the queue before it ran/;

export type ModCommand = "mod_poll" | "mod_ack" | "mod_event";

/** Says which pane and session this is; sent with every request. */
export type ModIdentity = {
  pane: string;
  workspace: string;
  herdr_socket: string;
  session: string;
  cwd: string;
  /** Claude Code's version. */
  claude: string;
};

export type ModMessage = { id: number; text: string };

export type ModHost = {
  /**
   * One request to Roamgate: the parsed JSON answer, or a rejection when
   * the socket cannot be reached or the answer is an error.
   */
  request(
    command: ModCommand,
    body: Record<string, string | number>,
  ): Promise<unknown>;
  /** Whether Roamgate's socket is there at all. */
  socketExists(): Promise<boolean>;
  /** Submits a prompt: "" once its turn started, else why it was not. */
  submit(text: string): Promise<string>;
  /** Calls `fn` once after `ms`. */
  after(ms: number, fn: () => void): { cancel(): void };
  log?(message: string): void;
};

/** The model, context and plan usage, as the status line has them. */
export type ModUsage = {
  model?: string;
  context?: { tokens?: number; window?: number; percent?: number };
  rate_limits?: { kind: string; percent_used: number; resets_at?: string }[];
  cost_usd?: number;
};

export type ModEvent =
  | { type: "turn_start" }
  | ({ type: "turn_complete"; reason: string; aborted: boolean } & ModUsage)
  | { type: "blocked" }
  | { type: "unblocked" }
  | ({ type: "usage" } & ModUsage)
  | { type: "bye"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function messagesOf(value: unknown): ModMessage[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) return [];
  return value.messages.flatMap((each) =>
    isRecord(each) &&
    typeof each.id === "number" &&
    Number.isSafeInteger(each.id) &&
    typeof each.text === "string" &&
    each.text
      ? [{ id: each.id, text: each.text }]
      : [],
  );
}

export function createModClient(args: {
  host: ModHost;
  identity: ModIdentity;
  /** Random per module instance: the server knows a new one by it. */
  client: string;
  /** What it does, for the debug log. */
  log?: (text: string) => void;
}) {
  const { host, client } = args;
  const log = (text: string) => (args.log ?? host.log)?.(text);
  const identity = { ...args.identity };
  /** The highest id received; the server sends what is above it. */
  let after = 0;
  let epoch = "";
  /** Received and not yet submitted, oldest first. */
  const queue: ModMessage[] = [];
  /** Submitted by this instance (acknowledged again if sent again). */
  const submitted = new Set<number>();
  let held = false;
  let pumping = false;
  let stopped = false;
  let backoff = 0;
  /** Quick looks left for a socket that was there a moment ago. */
  let quick = 0;
  let timer: { cancel(): void } | null = null;

  const base = () => ({
    pane: identity.pane,
    workspace: identity.workspace,
    herdr_socket: identity.herdr_socket,
    session: identity.session,
    cwd: identity.cwd,
    client,
  });

  function schedule(ms: number) {
    if (stopped) return;
    timer?.cancel();
    timer = host.after(ms, () => {
      timer = null;
      void poll();
    });
  }

  function ack(id: number, outcome: string, reason = "") {
    void host
      .request("mod_ack", { ...base(), id, outcome, reason })
      .catch(() => {});
  }

  async function poll() {
    if (stopped) return;
    if (!(await host.socketExists().catch(() => false))) {
      backoff = 0;
      if (quick > 0) {
        quick -= 1;
        return schedule(RESTART_RETRY_MS);
      }
      return schedule(ABSENT_RETRY_MS);
    }
    let answer: unknown;
    try {
      answer = await host.request("mod_poll", {
        ...base(),
        protocol: MOD_PROTOCOL,
        claude: identity.claude,
        after,
        wait_ms: POLL_WAIT_MS,
      });
    } catch (error) {
      backoff = Math.min(Math.max(backoff * 2, 1000), MAX_BACKOFF_MS);
      log(`poll failed: ${String(error)}`);
      return schedule(backoff);
    }
    backoff = 0;
    quick = RESTART_RETRIES;
    if (isRecord(answer) && answer.superseded === true) {
      // A newer claude in this pane took its messages.
      stopped = true;
      log("superseded by another session in this pane");
      return;
    }
    const answered = isRecord(answer) ? String(answer.epoch ?? "") : "";
    if (answered && answered !== epoch) {
      const first = !epoch;
      epoch = answered;
      // Another inbox: its ids start over; ask again from the start.
      if (!first && after > 0) {
        after = 0;
        return schedule(0);
      }
    }
    for (const message of messagesOf(answer)) {
      if (message.id > after) after = message.id;
      if (submitted.has(message.id)) ack(message.id, "submitted");
      else if (!queue.some((each) => each.id === message.id))
        queue.push(message);
    }
    void pump();
    // The server holds the next poll until there is something.
    schedule(10);
  }

  /** Submits what waits, one at a time, in order. */
  async function pump() {
    if (pumping || held || stopped) return;
    pumping = true;
    try {
      while (queue.length && !held && !stopped) {
        const message = queue[0]!;
        let reason: string;
        try {
          reason = await host.submit(message.text);
        } catch (error) {
          reason = String(
            (error as { message?: unknown })?.message ?? error ?? "failed",
          );
          if (!reason) reason = "failed";
        }
        if (!reason) {
          submitted.add(message.id);
          queue.shift();
          ack(message.id, "submitted");
          log(`submitted message ${message.id}`);
          continue;
        }
        if (STOPPED.test(reason)) {
          // Held until the user's next turn ends.
          held = true;
          ack(message.id, "held", reason);
          log(`holding message ${message.id}: ${reason}`);
          break;
        }
        queue.shift();
        ack(message.id, "failed", reason);
        log(`message ${message.id} not submitted: ${reason}`);
      }
    } finally {
      pumping = false;
    }
  }

  return {
    start() {
      schedule(0);
    },
    /** /clear and /resume start another session in this process. */
    setSession(session: string) {
      if (session) identity.session = session;
    },
    /** The main loop's turn ended: a held queue tries again. */
    turnComplete() {
      if (!held) return;
      held = false;
      log("turn ended: trying the held messages again");
      void pump();
    },
    report(event: ModEvent) {
      if (stopped) return;
      void host
        .request("mod_event", { ...base(), event: JSON.stringify(event) })
        .catch(() => {});
    },
    /** The session ends: no more polls, and Roamgate is told. */
    stop(reason: string) {
      if (stopped) return;
      timer?.cancel();
      timer = null;
      void host
        .request("mod_event", {
          ...base(),
          event: JSON.stringify({ type: "bye", reason }),
        })
        .catch(() => {});
      stopped = true;
    },
    /** For tests. */
    state: () => ({
      after,
      epoch,
      queued: queue.map((each) => each.id),
      held,
      stopped,
    }),
  };
}

export type ModClient = ReturnType<typeof createModClient>;
