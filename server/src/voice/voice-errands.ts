import { randomUUID } from "node:crypto";

/** The history entries the errands session's answer is read from. */
export type ErrandEntry = {
  id?: unknown;
  role?: unknown;
  kind?: unknown;
  text?: unknown;
};

export type ErrandDeps = {
  read: (connectionId: string, paneId: string) => Promise<ErrandEntry[]>;
  /**
   * Sends the text to the session, in whichever mode it runs: a terminal
   * session takes it once idle.
   */
  prompt: (connectionId: string, paneId: string, text: string) => Promise<void>;
};

export type ErrandState = {
  done: boolean;
  /** The session's messages after the errand, once it is done. */
  answer: string | null;
  /** Nothing has moved for a while, and its last step is not an answer. */
  stalled: boolean;
};

const POLL_MS = 2000;
/** The answer is complete once nothing changed for this long. */
const SETTLED_MS = 6000;
/** Unchanged this long on a tool step: it likely waits for permission. */
const STALLED_MS = 20_000;
const LIMIT_MS = 15 * 60_000;
/** A finished errand is kept this long for the page to collect. */
const KEPT_MS = 10 * 60_000;

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
      stalled: STALLED_MS,
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
    const state: ErrandState = { done: false, answer: null, stalled: false };
    this.jobs.set(id, state);
    this.panes.set(id, pane);
    void this.watch(state, connectionId, paneId, before).finally(() => {
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

  private async watch(
    state: ErrandState,
    connectionId: string,
    paneId: string,
    before: ErrandEntry[],
  ) {
    const seen = new Set(before.map((entry) => entry.id));
    const started = Date.now();
    let signature = "";
    let since = Date.now();
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
        state.stalled = false;
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
      state.stalled = fresh.length > 0 && quiet >= this.timing.stalled;
    }
    state.done = true;
  }
}
