import { type Logger, serverLogger } from "../utils/logger";

/**
 * Every network call Roamgate makes to a forge (glab, gh) goes through one
 * gate per checkout host and forge host: a budget of calls per minute with
 * a queue, a pause when the forge says it is rate limiting (429,
 * Retry-After, RateLimit-Remaining 0), identical calls shared while in
 * flight and for a short while after, and GETs sent with If-None-Match so
 * that an unchanged answer costs the forge nothing to send (GitHub does
 * not count those against the rate limit). One debug line per call.
 */

export type ProcessOutput = { code: number; stdout: string; stderr: string };

export type ForgeCall = {
  /** The checkout's SSH host; "" or unset for this machine. */
  checkout?: string;
  /** The forge's API host. */
  host: string;
  /** Who asks, for the log: badge, card, chip, session, review... */
  feature: string;
  /** What is asked, for the log: mr-list, project, graphql, auth... */
  kind: string;
  /** Not started after this time (ms since epoch): ForgeBusyError. */
  deadline?: number;
  /**
   * A `glab api` / `gh api` call (without --paginate) whose response
   * headers are read: --include is added and stripped from stdout.
   */
  include?: boolean;
  /** A GET answered with 304 when unchanged since the last answer. */
  conditional?: boolean;
  /** An identical call answered this recently (ms) is not made again. */
  reuseMs?: number;
};

export type ForgeOutput = ProcessOutput & {
  /** The HTTP status, when the response headers were read. */
  status?: number;
  /** Answered 304: stdout is the remembered body. */
  notModified?: boolean;
};

/** The gate would not start the call before its deadline. */
export class ForgeBusyError extends Error {}

/** Calls started per minute and per (checkout host, forge host). */
export const FORGE_CALLS_PER_MINUTE = 60;
/** Calls running at once per (checkout host, forge host). */
export const FORGE_CONCURRENCY = 4;
/** A 429 with neither Retry-After nor a reset time waits this long. */
export const FORGE_BACKOFF_MS = 60_000;
/** The longest a forge's rate limit pause is honoured. */
const MAX_BACKOFF_MS = 60 * 60_000;
const WINDOW_MS = 60_000;
const ETAGS_KEPT = 300;
const ETAG_BODY_MAX = 1_000_000;
const REUSE_KEPT = 300;

type Waiter = {
  deadline: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

type HostState = {
  starts: number[];
  active: number;
  blockedUntil: number;
  queue: Waiter[];
  timer: ReturnType<typeof setTimeout> | null;
};

type Scope = {
  hosts: Map<string, HostState>;
  etags: Map<string, { etag: string; body: string }>;
  reused: Map<string, { at: number; output: Promise<ForgeOutput> }>;
};

/** The status line and headers `--include` prints before the body. */
export function splitIncluded(stdout: string): {
  status?: number;
  headers: Map<string, string>;
  body: string;
} {
  const headers = new Map<string, string>();
  let rest = stdout;
  let status: number | undefined;
  // A response may follow an interim one (100 Continue): the last wins.
  while (/^HTTP\/[\d.]+ \d{3}/.test(rest)) {
    const end = /\r?\n\r?\n/.exec(rest);
    const block = end ? rest.slice(0, end.index) : rest;
    rest = end ? rest.slice(end.index + end[0].length) : "";
    const lines = block.split(/\r?\n/);
    status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(lines[0]!)![1]);
    headers.clear();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon > 0)
        headers.set(
          line.slice(0, colon).trim().toLowerCase(),
          line.slice(colon + 1).trim(),
        );
    }
  }
  return { status, headers, body: rest };
}

/** When the forge asks to be left alone until, from its headers. */
export function rateLimitPause(
  status: number | undefined,
  headers: Map<string, string>,
  now: number,
): number | null {
  const resetAt = () => {
    const reset = Number(
      headers.get("ratelimit-reset") ?? headers.get("x-ratelimit-reset"),
    );
    // Epoch seconds (GitLab, GitHub); a small number is a delay in seconds.
    if (!Number.isFinite(reset) || reset <= 0) return null;
    return reset > 1e9 ? reset * 1000 : now + reset * 1000;
  };
  const retryAfter = () => {
    const value = headers.get("retry-after");
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? date : null;
  };
  let until: number | null = null;
  if (status === 429 || status === 503)
    until = retryAfter() ?? resetAt() ?? now + FORGE_BACKOFF_MS;
  else {
    const remaining = Number(
      headers.get("ratelimit-remaining") ??
        headers.get("x-ratelimit-remaining"),
    );
    if (headers.has("retry-after") && status !== undefined && status >= 400)
      until = retryAfter();
    else if (
      (headers.has("ratelimit-remaining") ||
        headers.has("x-ratelimit-remaining")) &&
      remaining <= 0
    )
      until = resetAt() ?? now + FORGE_BACKOFF_MS;
  }
  if (until === null || until <= now) return null;
  return Math.min(until, now + MAX_BACKOFF_MS);
}

/** `cli api ...` with flags added right after `api`. */
function withApiFlags(argv: string[], flags: string[]): string[] {
  const at = argv.indexOf("api");
  if (at < 0 || !flags.length) return argv;
  return [...argv.slice(0, at + 1), ...flags, ...argv.slice(at + 1)];
}

export function createForgeGate(
  options: {
    now?: () => number;
    perMinute?: number;
    concurrency?: number;
    logger?: Logger;
  } = {},
) {
  const now = options.now ?? (() => Date.now());
  const perMinute = options.perMinute ?? FORGE_CALLS_PER_MINUTE;
  const concurrency = options.concurrency ?? FORGE_CONCURRENCY;
  const logger = options.logger ?? serverLogger.child("forge");
  // By process runner: tests (and each bridge's runner) get their own.
  const scopes = new WeakMap<object, Scope>();

  function scopeOf(owner: object): Scope {
    let scope = scopes.get(owner);
    if (!scope) {
      scope = { hosts: new Map(), etags: new Map(), reused: new Map() };
      scopes.set(owner, scope);
    }
    return scope;
  }

  function hostOf(scope: Scope, key: string): HostState {
    let state = scope.hosts.get(key);
    if (!state) {
      state = {
        starts: [],
        active: 0,
        blockedUntil: 0,
        queue: [],
        timer: null,
      };
      scope.hosts.set(key, state);
    }
    return state;
  }

  function pump(state: HostState) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    for (;;) {
      const at = now();
      // Waiters past their deadline give up.
      for (const waiter of [...state.queue])
        if (waiter.deadline <= at) {
          state.queue.splice(state.queue.indexOf(waiter), 1);
          waiter.reject(
            new ForgeBusyError("the forge is busy or rate limited; try later"),
          );
        }
      const next = state.queue[0];
      if (!next) return;
      while (state.starts.length && state.starts[0]! <= at - WINDOW_MS)
        state.starts.shift();
      if (state.active >= concurrency) return; // a release pumps again
      const wait = Math.max(
        state.blockedUntil - at,
        state.starts.length >= perMinute
          ? state.starts[0]! + WINDOW_MS - at
          : 0,
      );
      if (wait > 0) {
        const firstDeadline = Math.min(...state.queue.map((w) => w.deadline));
        const delay = Math.max(1, Math.min(wait, firstDeadline - at));
        state.timer = setTimeout(() => pump(state), delay);
        return;
      }
      state.queue.shift();
      state.starts.push(at);
      state.active++;
      next.resolve();
    }
  }

  function acquire(state: HostState, deadline: number): Promise<void> {
    return new Promise((resolve, reject) => {
      state.queue.push({ deadline, resolve, reject });
      pump(state);
    });
  }

  function release(state: HostState) {
    state.active--;
    pump(state);
  }

  async function perform(
    scope: Scope,
    call: ForgeCall,
    argv: string[],
    spawn: (argv: string[]) => Promise<ProcessOutput>,
    key: string,
  ): Promise<ForgeOutput> {
    const checkout = call.checkout ?? "";
    const state = hostOf(scope, `${checkout}\n${call.host}`);
    const queuedAt = now();
    await acquire(state, call.deadline ?? Number.POSITIVE_INFINITY);
    const startedAt = now();
    const known = call.conditional ? scope.etags.get(key) : undefined;
    const flags = [
      ...(call.include || call.conditional ? ["--include"] : []),
      ...(known ? ["--header", `If-None-Match: ${known.etag}`] : []),
    ];
    let output: ForgeOutput;
    try {
      output = await spawn(withApiFlags(argv, flags));
    } catch (error) {
      logger.debug("forge call", {
        feature: call.feature,
        kind: call.kind,
        host: call.host,
        checkout: checkout || "local",
        code: "spawn-error",
        waited_ms: startedAt - queuedAt,
        ms: now() - startedAt,
      });
      throw error;
    } finally {
      release(state);
    }
    if (flags.length) {
      const split = splitIncluded(output.stdout);
      output = { ...output, stdout: split.body, status: split.status };
      const pause = rateLimitPause(split.status, split.headers, now());
      if (pause !== null)
        state.blockedUntil = Math.max(state.blockedUntil, pause);
      if (split.status === 304 && known) {
        // Most recently used last.
        scope.etags.delete(key);
        scope.etags.set(key, known);
        output = {
          code: 0,
          stdout: known.body,
          stderr: "",
          status: 304,
          notModified: true,
        };
      } else if (
        call.conditional &&
        output.code === 0 &&
        split.status !== undefined &&
        split.status >= 200 &&
        split.status < 300
      ) {
        const etag = split.headers.get("etag");
        scope.etags.delete(key);
        if (etag && split.body.length <= ETAG_BODY_MAX) {
          scope.etags.set(key, { etag, body: split.body });
          if (scope.etags.size > ETAGS_KEPT)
            scope.etags.delete(scope.etags.keys().next().value as string);
        }
      }
    } else if (/\bHTTP 429\b/.test(output.stderr)) {
      state.blockedUntil = Math.max(
        state.blockedUntil,
        now() + FORGE_BACKOFF_MS,
      );
      output = { ...output, status: 429 };
    }
    logger.debug("forge call", {
      feature: call.feature,
      kind: call.kind,
      host: call.host,
      checkout: checkout || "local",
      code: output.code,
      status: output.status,
      not_modified: output.notModified || undefined,
      waited_ms: startedAt - queuedAt,
      ms: now() - startedAt,
    });
    return output;
  }

  return {
    /**
     * Runs one forge call through the gate. `owner` scopes the budget and
     * caches (the process runner); `spawn` runs the final argv, through
     * SSH when the checkout is remote.
     */
    run(
      owner: object,
      call: ForgeCall,
      argv: string[],
      spawn: (argv: string[]) => Promise<ProcessOutput>,
    ): Promise<ForgeOutput> {
      const scope = scopeOf(owner);
      const key = `${call.checkout ?? ""}\n${call.host}\n${argv.join("\0")}`;
      if (call.reuseMs === undefined)
        return perform(scope, call, argv, spawn, key);
      const known = scope.reused.get(key);
      if (
        known &&
        (known.at === Number.POSITIVE_INFINITY ||
          now() - known.at < call.reuseMs)
      )
        return known.output;
      const entry = {
        at: Number.POSITIVE_INFINITY,
        output: perform(scope, call, argv, spawn, key),
      };
      scope.reused.delete(key);
      scope.reused.set(key, entry);
      if (scope.reused.size > REUSE_KEPT)
        for (const [other, value] of scope.reused) {
          if (scope.reused.size <= REUSE_KEPT) break;
          if (value.at !== Number.POSITIVE_INFINITY) scope.reused.delete(other);
        }
      entry.output.then(
        (output) => {
          // Failures are not reused: the next ask tries again.
          if (output.code === 0) entry.at = now();
          else if (scope.reused.get(key) === entry) scope.reused.delete(key);
        },
        () => {
          if (scope.reused.get(key) === entry) scope.reused.delete(key);
        },
      );
      return entry.output;
    },
    /** How long calls to a host wait for its rate limit (tests, logs). */
    pausedUntil(owner: object, checkout: string, host: string): number {
      return (
        scopeOf(owner).hosts.get(`${checkout}\n${host}`)?.blockedUntil ?? 0
      );
    },
  };
}

export type ForgeGate = ReturnType<typeof createForgeGate>;

/** An argv without the flags the gate adds (tests compare argv). */
export function withoutGateFlags(argv: readonly string[]): string[] {
  const plain: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--include") continue;
    if (argv[i] === "--header" && argv[i + 1]?.startsWith("If-None-Match:")) {
      i++;
      continue;
    }
    plain.push(argv[i]!);
  }
  return plain;
}

/** The bridge's one gate. */
export const forgeGate = createForgeGate();
