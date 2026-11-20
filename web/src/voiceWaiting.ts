import { logCompanion } from "./companionCall";
import { ackLanguage } from "./voiceAck";
import { folded } from "./voiceCompanion";

/**
 * A session's answer to a job the companion gave it that nobody heard
 * (server voice-waiting.ts): the page had reloaded, the call had ended or
 * voice chat had stopped before the session answered, so the page that
 * followed the job was gone and its answer, polled or not, went nowhere.
 * The server keeps every job's answer until a page marks it heard; at the
 * start of the next voice chat or call, and when the companion's
 * conversation opens without a call, the page mentions those waiting once
 * ("one answer from gst arrived while you were away; want it?") and marks
 * them mentioned. The user asks for one ("lis-la", "la réponse de gst":
 * readItRequest, or through the front's "read" route with its job) and it
 * is read as any kept answer is (voiceCompanion.ts), or dismisses it; it is
 * never read unasked, and never mentioned again.
 */

export type WaitingAnswer = {
  /** The job's id. */
  job: string;
  /** The session's name, as said aloud. */
  label: string;
  /** What the user asked it. */
  question: string;
  at: number;
  /** Mentioned to the user once already. */
  mentioned: boolean;
  /** The answer's length; the text comes with takeWaiting. */
  chars: number;
};

/** An answer taken to be read: who wrote it, for which question. */
export type TakenAnswer = {
  job: string;
  label: string;
  question: string;
  answer: string;
  /** `<connection>/<pane>`. */
  pane?: string;
};

/** The server's side of it, replaceable in tests. */
export type WaitingDeps = {
  list: () => Promise<WaitingAnswer[]>;
  text: (job: string) => Promise<TakenAnswer | null>;
  mentioned: (jobs: readonly string[]) => Promise<void>;
  heard: (job: string) => Promise<void>;
};

const VOICE_HEADERS = { "x-roamgate-voice": "1" };

function isWaitingAnswer(value: unknown): value is WaitingAnswer {
  const answer = value as Partial<WaitingAnswer> | null;
  return (
    typeof answer?.job === "string" &&
    typeof answer.label === "string" &&
    typeof answer.question === "string" &&
    typeof answer.at === "number" &&
    typeof answer.mentioned === "boolean"
  );
}

export const waitingDeps: WaitingDeps = {
  async list() {
    const response = await fetch("/api/voice/answers", {
      headers: VOICE_HEADERS,
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { answers?: unknown };
    return Array.isArray(body.answers)
      ? body.answers.filter(isWaitingAnswer).map((answer) => ({
          ...answer,
          chars:
            typeof (answer as { chars?: unknown }).chars === "number"
              ? (answer as { chars: number }).chars
              : 0,
        }))
      : [];
  },
  async text(job) {
    const response = await fetch(
      `/api/voice/answers?job=${encodeURIComponent(job)}`,
      { headers: VOICE_HEADERS },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<TakenAnswer> | null;
    return typeof body?.answer === "string" && typeof body.label === "string"
      ? {
          job,
          label: body.label,
          question: body.question ?? "",
          answer: body.answer,
          ...(typeof body.pane === "string" ? { pane: body.pane } : {}),
        }
      : null;
  },
  async mentioned(jobs) {
    await fetch("/api/voice/answers/mentioned", {
      method: "POST",
      headers: { ...VOICE_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ jobs }),
    });
  },
  async heard(job) {
    await fetch("/api/voice/answers/heard", {
      method: "POST",
      headers: { ...VOICE_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ job }),
    });
  },
};

/** The user heard a job's answer (told, read or dismissed): forgotten. */
export function markAnswerHeard(job: string, deps = waitingDeps) {
  return deps.heard(job).catch(() => {});
}

/**
 * What is said of the answers not mentioned yet, in the language the
 * questions were asked in: who answered, briefly, and whether the user
 * wants it. "" when every answer was mentioned already.
 */
export function mentionLine(
  answers: readonly WaitingAnswer[],
  language: string = ackLanguage(
    answers.map((answer) => answer.question).join(" "),
  ),
): string {
  const fresh = answers.filter((answer) => !answer.mentioned);
  if (!fresh.length) return "";
  const french = language === "fr";
  const labels = [...new Set(fresh.map((answer) => answer.label))];
  const named =
    labels.length <= 1
      ? (labels[0] ?? "")
      : `${labels.slice(0, -1).join(", ")} ${french ? "et" : "and"} ${labels[labels.length - 1]}`;
  if (fresh.length === 1)
    return french
      ? `Une réponse de ${named} est arrivée pendant ton absence ; tu la veux ?`
      : `One answer from ${named} arrived while you were away; want it?`;
  return french
    ? `${fresh.length} réponses sont arrivées pendant ton absence, de ${named} ; tu les veux ?`
    : `${fresh.length} answers arrived while you were away, from ${named}; want them?`;
}

/**
 * Whether `said` plainly asks to hear an answer waiting ("lis-la", "lis-la
 * moi", "read it", "je la veux", "la réponse de gst", "read gst's
 * answer"), with the agent named when one is. Only asked of while answers
 * wait: the words are the front's otherwise.
 */
export function readItRequest(said: string): { agent?: string } | null {
  const text = folded(said)
    .replace(/\b(s il te plait|s il vous plait|please|stp|merci)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const named =
    /^(?:(?:oui|yes|ok|okay|vas y|go ahead|d accord)[ ,]+)?(?:(?:lis|lis moi|relis|read|read me|read out)\s+)?(?:la |les |the )?(?:reponses?|answers?)\s+(?:de|du|from|of)\s+(.+)$/.exec(
      text,
    ) ??
    /^(?:(?:oui|yes|ok|okay)[ ,]+)?(?:lis|read)(?: me)?\s+(.+?)\s+s\s+(?:reponse|answer)$/.exec(
      text,
    );
  if (named) return { agent: named[1]!.trim() };
  const plain =
    /^(?:(?:oui|yes|ok|okay|vas y|go ahead|d accord|allez)[ ,]+)*(?:lis|lis la|lis le|lis les|lis la moi|lis le moi|lis les moi|lis moi|lis moi la reponse|lis moi les reponses|lis la reponse|lis les reponses|relis la|read it|read them|read it to me|read them to me|read it out|read the answer|read the answers|read me the answer|read me the answers|je la veux|je les veux|je veux bien l entendre|je veux bien les entendre|i want it|i want them)$/.test(
      text,
    );
  return plain ? {} : null;
}

/**
 * The answer waiting of `agent` (named loosely), or the most recent one
 * with no agent; null with none.
 */
export function pickWaiting(
  answers: readonly WaitingAnswer[],
  agent?: string,
): WaitingAnswer | null {
  const wanted = agent ? folded(agent) : "";
  const matching = wanted
    ? answers.filter((answer) => {
        const name = folded(answer.label);
        return name && (name.includes(wanted) || wanted.includes(name));
      })
    : answers;
  return matching[matching.length - 1] ?? null;
}

/**
 * Takes an answer waiting to read it: the one `job` names, or `agent`'s
 * among `waiting`, or the most recent one with `last` (the call has no
 * answer of its own to read). Taken, it is heard: the server forgets it.
 * Null when none fits, or it is gone.
 */
export async function takeWaiting(
  pick: { job?: string; agent?: string; last?: boolean },
  waiting: readonly WaitingAnswer[],
  deps = waitingDeps,
): Promise<TakenAnswer | null> {
  const job =
    pick.job ??
    (pick.agent || pick.last ? pickWaiting(waiting, pick.agent)?.job : null);
  if (!job) return null;
  const taken = await deps.text(job).catch(() => null);
  if (taken) void markAnswerHeard(job, deps);
  return taken;
}

/**
 * The answers waiting, mentioned once: `say` says what mentionLine makes
 * of those not mentioned yet, and once it was said they are marked so.
 * `got` hears the whole list first, for the page to read from. The list
 * back (what `got` had).
 */
export async function mentionWaitingAnswers(
  hooks: {
    say: (line: string) => Promise<void>;
    got?: (waiting: WaitingAnswer[]) => void;
  },
  deps = waitingDeps,
): Promise<WaitingAnswer[]> {
  const waiting = await deps.list().catch(() => [] as WaitingAnswer[]);
  hooks.got?.(waiting);
  const fresh = waiting.filter((answer) => !answer.mentioned);
  const line = mentionLine(fresh);
  if (!line) return waiting;
  await hooks.say(line);
  for (const answer of fresh) answer.mentioned = true;
  await deps.mentioned(fresh.map((answer) => answer.job)).catch(() => {});
  return waiting;
}

/**
 * The companion's conversation opened without a call: the answers waiting
 * are mentioned there, in writing, once.
 */
export function mentionWaitingInConversation(deps = waitingDeps) {
  return mentionWaitingAnswers(
    {
      say: async (line) => {
        logCompanion({ kind: "said", text: line });
      },
    },
    deps,
  );
}
