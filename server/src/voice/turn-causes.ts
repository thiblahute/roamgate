/**
 * What made each session start its turns, for the voice companion's EVENTs
 * (voice-front.ts): a session that finishes a turn the user just asked for
 * themselves is no news, one the companion, another agent or Ranger set
 * going is. Every way Roamgate gives a session words notes who sent them;
 * the user's own input (typing in the terminal, a chat message, a review
 * comment) also counts as their last interaction with it.
 */

/** Who started a turn, and how. */
export type TurnCause =
  | { by: "user"; via: "terminal" | "chat" | "review" }
  | { by: "companion" }
  | { by: "agent"; name: string }
  | { by: "ranger" };

type Noted = TurnCause & { at: number };

/** Causes kept per session, newest last. */
const KEPT = 8;
/** A cause noted this long before a turn started did not start it. */
const CAUSE_WINDOW_MS = 30 * 60_000;
/** Words sent this long after a turn started may still have started it. */
const START_SLACK_MS = 10_000;
/** Sessions remembered at most, the least recent dropped first. */
const MAX_SESSIONS = 500;

const key = (connectionId: string, paneId: string) =>
  `${connectionId}/${paneId}`;

export class TurnCauses {
  private causes = new Map<string, Noted[]>();
  private userAt = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** `cause` just gave the session words. */
  note(connectionId: string, paneId: string, cause: TurnCause) {
    const id = key(connectionId, paneId);
    const at = this.now();
    const list = [...(this.causes.get(id) ?? []), { ...cause, at }].slice(
      -KEPT,
    );
    this.causes.delete(id);
    this.causes.set(id, list);
    if (cause.by === "user") this.noteUser(connectionId, paneId);
    this.trim(this.causes);
  }

  /** The user did something in the session (a key typed, for one). */
  noteUser(connectionId: string, paneId: string) {
    const id = key(connectionId, paneId);
    this.userAt.delete(id);
    this.userAt.set(id, this.now());
    this.trim(this.userAt);
  }

  /**
   * What started the turn of the session that began `turnMs` ago (or the
   * newest cause, when that is not known), and when the user last did
   * something in it.
   */
  turn(
    connectionId: string,
    paneId: string,
    turnMs?: number,
  ): { cause: (TurnCause & { at: number }) | null; userAt: number | null } {
    const id = key(connectionId, paneId);
    const now = this.now();
    const started = turnMs === undefined ? now : now - turnMs;
    const cause =
      (this.causes.get(id) ?? [])
        .filter(
          (each) =>
            each.at <= started + START_SLACK_MS &&
            each.at >= started - CAUSE_WINDOW_MS,
        )
        .at(-1) ?? null;
    return { cause, userAt: this.userAt.get(id) ?? null };
  }

  private trim(map: Map<string, unknown>) {
    while (map.size > MAX_SESSIONS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }
}

/** The one record the server's ways of sending words share. */
export const turnCauses = new TurnCauses();

function ago(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

function causeWords(cause: TurnCause) {
  switch (cause.by) {
    case "user":
      return cause.via === "review"
        ? "the user's review comment"
        : cause.via === "chat"
          ? "the user's chat message"
          : "the user typing in its terminal";
    case "companion":
      return "your own errand";
    case "agent":
      return `a message from agent session ${cause.name}`;
    case "ranger":
      return "Ranger";
  }
}

/**
 * The words an EVENT about a session's turn ends with, in parentheses:
 * what started it, how long it ran, when the user last did something in
 * it and whether they are looking at it, e.g. "(started by the user's
 * review comment; ran 40 s; the user is looking at it)".
 */
export function turnContext(
  turn: {
    cause: (TurnCause & { at: number }) | null;
    userAt: number | null;
    turnMs?: number;
    looking?: boolean;
  },
  now = Date.now(),
): string {
  const parts = [
    turn.cause
      ? `started by ${causeWords(turn.cause)}`
      : "started by nothing Roamgate saw: cause unknown",
  ];
  if (turn.turnMs !== undefined) parts.push(`ran ${ago(turn.turnMs)}`);
  if (turn.userAt !== null)
    parts.push(`the user's last input there ${ago(now - turn.userAt)} ago`);
  else parts.push("no input from the user there lately");
  if (turn.looking) parts.push("the user is looking at it");
  return `(${parts.join("; ")})`;
}
