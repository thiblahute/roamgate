/**
 * How a chat's history reads are spaced: one at a time, and what is asked
 * meanwhile (pushes, polls, a send) folds into a single read after it. A
 * read that just ended is followed by a short pause, so a transcript written
 * continuously is read a few times a second at most, never back to back.
 * What the reader asks for (a refresh, a send) skips the pause.
 */
export const HISTORY_REFRESH_GAP_MS = 400;

export type HistoryRefreshGate = {
  /**
   * Reads now, or once after the one running (and its pause, unless
   * `urgent`: the reader asked).
   */
  request(read: () => Promise<unknown>, urgent?: boolean): void;
  /** Forgets what runs and what was asked (a pane switch, a close). */
  reset(): void;
  /** Whether a read is running. */
  readonly busy: boolean;
};

export function createHistoryRefreshGate(
  gapMs = HISTORY_REFRESH_GAP_MS,
): HistoryRefreshGate {
  let scope = 0;
  let running = false;
  let queued = false;
  let urgentQueued = false;
  let pause: ReturnType<typeof setTimeout> | null = null;
  let latest: () => Promise<unknown> = async () => {};

  function start() {
    const mine = scope;
    running = true;
    queued = false;
    urgentQueued = false;
    let done: Promise<unknown>;
    try {
      done = latest();
    } catch (error) {
      done = Promise.reject(error);
    }
    void done
      .catch(() => {})
      .finally(() => {
        if (mine !== scope) return;
        running = false;
        if (urgentQueued) {
          start();
          return;
        }
        pause = setTimeout(() => {
          pause = null;
          if (mine === scope && queued) start();
        }, gapMs);
      });
  }

  return {
    request(read, urgent = false) {
      latest = read;
      if (running) {
        queued = true;
        urgentQueued ||= urgent;
        return;
      }
      if (pause !== null) {
        if (!urgent) {
          queued = true;
          return;
        }
        clearTimeout(pause);
        pause = null;
      }
      start();
    },
    reset() {
      scope += 1;
      running = false;
      queued = false;
      urgentQueued = false;
      if (pause !== null) clearTimeout(pause);
      pause = null;
    },
    get busy() {
      return running;
    },
  };
}
