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
  prompt: (connectionId: string, paneId: string, text: string) => Promise<void>;
};

export type ErrandState = {
  done: boolean;
  /** The session's last message after the errand, once it is done. */
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
 * Errands said by voice: each is sent to the errands session as a prompt,
 * then its history is watched until the answer settles.
 */
export class VoiceErrands {
  private jobs = new Map<string, ErrandState>();

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
    void this.watch(state, connectionId, paneId, before).finally(() =>
      setTimeout(() => this.jobs.delete(id), KEPT_MS),
    );
    return id;
  }

  state(id: string): ErrandState | null {
    return this.jobs.get(id) ?? null;
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
        state.answer = (last!.text as string).trim();
        state.done = true;
        return;
      }
      state.stalled = fresh.length > 0 && quiet >= this.timing.stalled;
    }
    state.done = true;
  }
}
