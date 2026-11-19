import { randomUUID } from "node:crypto";

/** The history entries the errands session's answer is read from. */
export type ErrandEntry = {
  id?: unknown;
  role?: unknown;
  kind?: unknown;
  text?: unknown;
};

/** What the session is doing now, as its status and its queues say. */
export type ErrandSessionStatus = {
  /** Its agent status: "working", "blocked", "idle", "done", ... */
  status: string | null;
  /** What it asks the user (a permission or a question); null: nothing. */
  waiting: string | null;
  /** Messages queued for it, not read yet (the companion's included). */
  queued: number;
};

export type ErrandDeps = {
  read: (connectionId: string, paneId: string) => Promise<ErrandEntry[]>;
  /**
   * Sends the text to the session, in whichever mode it runs: a terminal
   * session takes it once idle.
   */
  prompt: (connectionId: string, paneId: string, text: string) => Promise<void>;
  /** The session's status; null (or no reader) when unknown. */
  status?: (
    connectionId: string,
    paneId: string,
  ) => Promise<ErrandSessionStatus | null>;
};

/**
 * What is worth telling of a job that runs, numbered: a new number is told
 * again. It waits for the user's OK (`what` it asks, when known), or it is
 * still working, `minutes` since its last message.
 */
export type ErrandNotice =
  | { seq: number; kind: "waiting"; what: string | null }
  | { seq: number; kind: "working"; minutes: number };

export type ErrandState = {
  done: boolean;
  /** The session's messages after the errand, once it is done. */
  answer: string | null;
  /** The last thing worth telling while it runs; null: nothing. */
  notice: ErrandNotice | null;
};

const POLL_MS = 2000;
/** The answer is complete once nothing changed for this long. */
const SETTLED_MS = 6000;
/** Still working, with nothing new this long: worth telling. */
const WORKING_MS = 5 * 60_000;
/** Told again, at most this often, while it goes on. */
const REPEAT_MS = 10 * 60_000;
const LIMIT_MS = 15 * 60_000;
/** A finished errand is kept this long for the page to collect. */
const KEPT_MS = 10 * 60_000;

/** A status with the session busy on its own work. */
const BUSY = new Set(["working", "starting"]);

function isAnswer(entry: ErrandEntry | undefined) {
  return (
    entry?.role === "assistant" &&
    entry.kind === "message" &&
    typeof entry.text === "string" &&
    entry.text.trim() !== ""
  );
}

/**
 * Work said by voice: an errand for the errands session, or a job the voice
 * companion starts on any session (POST /api/voice/forward). Each is sent
 * as a prompt, then the session's history is watched until its answer
 * settles; the answer is everything it wrote meanwhile.
 */
export class VoiceErrands {
  private jobs = new Map<string, ErrandState>();
  /** The session (`<connection>/<pane>`) each job runs on. */
  private panes = new Map<string, string>();

  constructor(
    private readonly deps: ErrandDeps,
    private readonly timing = {
      poll: POLL_MS,
      settled: SETTLED_MS,
      working: WORKING_MS,
      repeat: REPEAT_MS,
      limit: LIMIT_MS,
    },
  ) {}

  /** Sends `text` to `pane` (`<connection>/<pane>`); its job's id back. */
  async start(pane: string, text: string): Promise<string> {
    const slash = pane.indexOf("/");
    const connectionId = pane.slice(0, slash);
    const paneId = pane.slice(slash + 1);
    const before = await this.deps.read(connectionId, paneId);
    await this.deps.prompt(connectionId, paneId, text);
    const id = randomUUID();
    const state: ErrandState = { done: false, answer: null, notice: null };
    this.jobs.set(id, state);
    this.panes.set(id, pane);
    void this.watch(id, state, connectionId, paneId, before).finally(() => {
      // Over (answered, or given up): the session may idle-stop again.
      state.done = true;
      setTimeout(() => {
        this.jobs.delete(id);
        this.panes.delete(id);
      }, KEPT_MS);
    });
    return id;
  }

  state(id: string): ErrandState | null {
    return this.jobs.get(id) ?? null;
  }

  /** Whether a job still runs on the session (`<connection>/<pane>`). */
  working(pane: string): boolean {
    for (const [id, state] of this.jobs)
      if (!state.done && this.panes.get(id) === pane) return true;
    return false;
  }

  /** The oldest job still running on `pane`: the one that tells. */
  private first(pane: string): string | null {
    for (const [id, state] of this.jobs)
      if (!state.done && this.panes.get(id) === pane) return id;
    return null;
  }

  private async watch(
    id: string,
    state: ErrandState,
    connectionId: string,
    paneId: string,
    before: ErrandEntry[],
  ) {
    const pane = `${connectionId}/${paneId}`;
    const seen = new Set(before.map((entry) => entry.id));
    const started = Date.now();
    let signature = "";
    let since = Date.now();
    let seq = 0;
    // When "still working" is next worth telling, in quiet time.
    let tellWorking = this.timing.working;
    while (Date.now() - started < this.timing.limit) {
      await new Promise((resolve) => setTimeout(resolve, this.timing.poll));
      const entries = await this.deps
        .read(connectionId, paneId)
        .catch(() => null);
      if (!entries) continue;
      const fresh = entries.filter((entry) => !seen.has(entry.id));
      const last = fresh[fresh.length - 1];
      const now = `${fresh.length} ${String(last?.id)} ${String(last?.text).length}`;
      if (now !== signature) {
        signature = now;
        since = Date.now();
        tellWorking = this.timing.working;
        // It moved: whatever it waited for was answered.
        if (state.notice?.kind === "waiting") state.notice = null;
        continue;
      }
      const quiet = Date.now() - since;
      if (isAnswer(last) && quiet >= this.timing.settled) {
        // The whole answer: every message it wrote since, in order.
        state.answer = fresh
          .filter(isAnswer)
          .map((entry) => (entry.text as string).trim())
          .join("\n\n");
        state.done = true;
        return;
      }
      // One job per session tells how it goes; quiet a moment first.
      if (quiet < this.timing.settled || this.first(pane) !== id) continue;
      const status = this.deps.status
        ? await this.deps.status(connectionId, paneId).catch(() => null)
        : null;
      if (status?.waiting || status?.status === "blocked") {
        const what = status.waiting || null;
        if (state.notice?.kind !== "waiting" || state.notice.what !== what)
          state.notice = { seq: ++seq, kind: "waiting", what };
        continue;
      }
      if (state.notice?.kind === "waiting") state.notice = null;
      // Still at work: its status says so, or messages wait for it (the
      // companion's own); without a status, what it wrote since.
      const working = status
        ? (status.status !== null && BUSY.has(status.status)) ||
          status.queued > 0
        : fresh.length > 0;
      if (working && quiet >= tellWorking) {
        state.notice = {
          seq: ++seq,
          kind: "working",
          minutes: Math.floor(quiet / 60_000),
        };
        tellWorking = quiet + this.timing.repeat;
      }
    }
    state.done = true;
  }
}
