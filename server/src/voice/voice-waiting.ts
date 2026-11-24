import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { uploadRoot } from "./voice-images";

/**
 * A session's answer to a job the voice companion gave it, kept until the
 * user hears it. A page follows a job it started (voice-errands.ts) and
 * has the companion tell the answer; but when the page reloaded, the call
 * ended or voice chat stopped before the session answered, nobody follows
 * it any more and the answer was lost (2026-11-19: three answers captured
 * in the sessions, never heard). So every answer is kept here, keyed by
 * its job, with the session's name and the question, for a day; the page
 * marks it heard once the companion told it or read it. At the start of
 * the next voice chat or call (or of the companion's conversation view),
 * the page mentions the ones still waiting, once ("one answer from gst
 * arrived while you were away; want it?"), and marks them mentioned: they
 * are read when asked for, or dismissed, and never mentioned again.
 *
 * Kept in a JSON file of the voice uploads' folder, so a server restart
 * (each deploy) loses nothing.
 */

export type WaitingAnswer = {
  /** The job's id (voice-errands.ts). */
  job: string;
  /** `<connection>/<pane>`: the session that answered. */
  pane: string;
  /** The session's name, as said aloud. */
  label: string;
  /** What the user asked it, as said or typed. */
  question: string;
  answer: string;
  /** When the answer settled. */
  at: number;
  /** Mentioned to the user once already, at a chat's start. */
  mentioned: boolean;
};

/** An answer is kept this long. */
export const WAITING_MS = 24 * 60 * 60_000;
/** Answers kept, at most: the oldest go first. */
const KEPT = 20;
/** Of each answer, what the front's state gives. */
const CONTEXT_CHARS = 300;

/** Where the answers are kept: the voice uploads' folder. */
export function waitingAnswersFile(root = uploadRoot()): string {
  return join(root, "voice-waiting-answers.json");
}

function isWaitingAnswer(value: unknown): value is WaitingAnswer {
  const answer = value as Partial<WaitingAnswer> | null;
  return (
    typeof answer?.job === "string" &&
    typeof answer.pane === "string" &&
    typeof answer.label === "string" &&
    typeof answer.question === "string" &&
    typeof answer.answer === "string" &&
    typeof answer.at === "number" &&
    typeof answer.mentioned === "boolean"
  );
}

export class WaitingAnswers {
  private answers: WaitingAnswer[] = [];

  /** `file` null: kept in memory only (tests). */
  constructor(
    private readonly file: string | null = waitingAnswersFile(),
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  /** Keeps a job's answer, until it is heard. */
  keep(
    answer: Omit<WaitingAnswer, "at" | "mentioned"> & { at?: number },
  ): WaitingAnswer {
    const kept: WaitingAnswer = {
      ...answer,
      at: answer.at ?? this.now(),
      mentioned: false,
    };
    this.answers = [
      ...this.answers.filter((each) => each.job !== kept.job),
      kept,
    ].slice(-KEPT);
    this.save();
    return kept;
  }

  /** The answers still waiting, oldest first. */
  list(): WaitingAnswer[] {
    this.prune();
    return [...this.answers];
  }

  get(job: string): WaitingAnswer | null {
    this.prune();
    return this.answers.find((answer) => answer.job === job) ?? null;
  }

  /** Marks `jobs` mentioned to the user; how many were. */
  mention(jobs: readonly string[]): number {
    let marked = 0;
    for (const answer of this.answers)
      if (jobs.includes(answer.job) && !answer.mentioned) {
        answer.mentioned = true;
        marked++;
      }
    if (marked) this.save();
    return marked;
  }

  /** The user heard it (told, read, or dismissed): forgotten. */
  heard(job: string): boolean {
    const before = this.answers.length;
    this.answers = this.answers.filter((answer) => answer.job !== job);
    if (this.answers.length === before) return false;
    this.save();
    return true;
  }

  /** The answers waiting, for the front's state (waitingContext). */
  context(): string {
    return waitingContext(this.list(), this.now());
  }

  /** Dismissed without `job`: every answer waiting goes. The jobs gone. */
  dismiss(job?: string): string[] {
    if (job) return this.heard(job) ? [job] : [];
    const gone = this.answers.map((answer) => answer.job);
    if (gone.length) {
      this.answers = [];
      this.save();
    }
    return gone;
  }

  private prune() {
    const now = this.now();
    const fresh = this.answers.filter(
      (answer) => now - answer.at <= WAITING_MS,
    );
    if (fresh.length !== this.answers.length) {
      this.answers = fresh;
      this.save();
    }
  }

  /** The file read afresh (the voice family came back to Bun). */
  reload() {
    this.load();
  }

  private load() {
    if (!this.file) return;
    try {
      const kept = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      this.answers = Array.isArray(kept) ? kept.filter(isWaitingAnswer) : [];
    } catch {
      this.answers = [];
    }
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.answers), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Kept here, at least.
    }
  }
}

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 2 ? "1 h ago" : `${hours} h ago`;
}

/**
 * The answers waiting, for the front's state (voice-front.ts): each with
 * its job (what "read" and "dismiss" name), who answered, when, the
 * question, whether it was mentioned, and how it starts. "" with none.
 */
export function waitingContext(
  answers: readonly WaitingAnswer[],
  now = Date.now(),
): string {
  if (!answers.length) return "";
  return [
    'Answers waiting (they came while the user was away: the page had reloaded or the call had ended; the page mentions each once at a chat\'s start, never read or summed up unasked; {"to": "read", "job": "<id>"} reads one whole, {"to": "dismiss", "job": "<id>"} drops it):',
    ...answers.map((answer) => {
      const text = answer.answer.replace(/\s+/g, " ").trim();
      const start =
        text.length > CONTEXT_CHARS
          ? `${text.slice(0, CONTEXT_CHARS)}...`
          : text;
      return `- job ${answer.job}: ${answer.label}, ${ago(answer.at, now)}, asked ${JSON.stringify(answer.question)}${answer.mentioned ? ", mentioned" : ", not mentioned yet"}. Starts: ${JSON.stringify(start)} (${text.length} characters)`;
    }),
  ].join("\n");
}
