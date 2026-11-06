import {
  companionCallState,
  companionTeller,
  logCompanion,
  updateCompanionWeb,
} from "./companionCall";
import { ackLanguage } from "./voiceAck";
import {
  answerHeldTool,
  type ResearchJob,
  researchState,
  toolState,
} from "./voiceRoute";

/** How often a search is asked about while it runs. */
const POLL_MS = 1500;
/** Failed reads in a row before the search is given up on. */
const MISSES = 5;
/**
 * How often a call held for the user's yes is asked about, and how many
 * times: about the 5 minutes the server keeps it (voice-tools.ts HELD_MS).
 */
const HELD_POLL_MS = 3000;
const HELD_POLLS = 100;

/**
 * Follows a web search the companion started (server voice-research.ts),
 * in its conversation view: its steps while it searches, then its answer
 * with its links. What it found is told aloud by the voice chat that runs
 * then (companionCall.ts setCompanionTeller), once the user is not
 * talking; without one, it is only written. It is web data: it is shown
 * and said, never sent anywhere. The search as it ended back, or null.
 */
export async function followCompanionWeb(
  job: string,
  question: string,
  deps: {
    state?: (job: string) => Promise<ResearchJob | null>;
    wait?: (ms: number) => Promise<void>;
    /** A job of its MCP tools (followCompanionTool), not a search. */
    tool?: boolean;
  } = {},
): Promise<ResearchJob | null> {
  const tool = deps.tool === true;
  const read = deps.state ?? (tool ? toolState : researchState);
  const wait =
    deps.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const id = logCompanion({
    kind: "web",
    job,
    ...(tool ? { tool: true } : {}),
    question,
    status: "searching",
    steps: [],
  });
  const french = ackLanguage(question) === "fr";
  let misses = 0;
  let steps = 0;
  for (;;) {
    await wait(POLL_MS);
    const state = await read(job);
    if (!state) {
      misses += 1;
      if (misses < MISSES) continue;
      updateCompanionWeb(id, {
        status: "failed",
        error: tool ? "Lost track of this job." : "Lost track of this search.",
      });
      return null;
    }
    misses = 0;
    if (state.status === "searching") {
      if (state.steps.length !== steps) {
        steps = state.steps.length;
        updateCompanionWeb(id, { steps: state.steps });
      }
      continue;
    }
    // A call held for the user's yes: its buttons show until it is answered.
    const held =
      tool && state.status === "done" && !!state.held && !state.heldOutcome;
    updateCompanionWeb(id, {
      status: state.status,
      steps: state.steps,
      ...(state.spoken ? { spoken: state.spoken } : {}),
      ...(state.answer ? { answer: state.answer } : {}),
      ...(state.sources ? { sources: state.sources } : {}),
      ...(state.error ? { error: state.error } : {}),
      ...(held ? { held: true } : {}),
    });
    if (held) void watchHeld(id, job, read, wait);
    if (state.status === "done" && state.spoken) tellCompanion(state.spoken);
    else if (state.status === "failed")
      tellCompanion(
        tool
          ? french
            ? `Ça n'a pas marché : ${question}`
            : `That didn't work: ${question}`
          : french
            ? `Je n'ai pas réussi à trouver ça sur le web : ${question}`
            : `I couldn't find that on the web: ${question}`,
      );
    return state;
  }
}

/**
 * Follows a request done with the companion's MCP tools (server
 * voice-tools.ts) as a web search is: its steps, then its result, told
 * aloud. A call it held for the user's yes is said as its result asks.
 */
export function followCompanionTool(
  job: string,
  task: string,
): Promise<ResearchJob | null> {
  return followCompanionWeb(job, task, { tool: true });
}

/** The conversation's entry of a held call, while it is one. */
function heldEntry(id: number) {
  const entry = companionCallState().log.find((each) => each.id === id);
  return entry?.kind === "web" && entry.held ? entry : null;
}

/**
 * The held call a plain yes or no typed now answers: the newest still
 * waiting, when the user said or typed nothing since it (else the front,
 * which knows what came since, decides what the words are for).
 */
export function waitingHeldCall(): number | null {
  const log = companionCallState().log;
  for (let index = log.length - 1; index >= 0; index--) {
    const entry = log[index]!;
    if (entry.kind === "heard") return null;
    if (entry.kind === "web" && entry.held && !entry.heldOutcome)
      return entry.id;
  }
  return null;
}

const folded = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/ (please|merci|s il te plait|s il vous plait)$/, "");

const PLAIN_YES =
  /^(yes|yeah|yep|ok|okay|sure|go|go ahead|do it|send it|send|confirm|confirmed|oui|ouais|vas y|ok vas y|oui vas y|d accord|envoie|envoie le|envoie la|confirme|fais le|valide)$/;
const PLAIN_NO =
  /^(no|nope|no thanks|don t|do not|dont|cancel|non|non merci|annule|n envoie pas|pas question|surtout pas)$/;

/**
 * Whether typed words are a plain yes or a plain no, nothing else, as a
 * held call's buttons give; null for anything more ("non, dis plutôt
 * vingt minutes" is a change, for the front).
 */
export function plainHeldAnswer(text: string): "yes" | "no" | null {
  const words = folded(text);
  if (PLAIN_YES.test(words)) return "yes";
  if (PLAIN_NO.test(words)) return "no";
  return null;
}

/**
 * Watches a held call until it is answered, wherever that is (said on a
 * call, typed, or clicked here) or forgotten, so its buttons go then.
 */
async function watchHeld(
  id: number,
  job: string,
  read: (job: string) => Promise<ResearchJob | null>,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  let misses = 0;
  for (let poll = 0; poll < HELD_POLLS; poll++) {
    await wait(HELD_POLL_MS);
    // Gone from the conversation, or known to wait no more.
    const entry = heldEntry(id);
    if (!entry || entry.heldOutcome === "expired") return;
    // The server's word, a click here included (its answer may not be
    // through yet, or come back to try again).
    const state = await read(job);
    if (state?.heldOutcome) {
      updateCompanionWeb(id, { heldOutcome: state.heldOutcome });
      return;
    }
    misses = state ? 0 : misses + 1;
    if (misses >= MISSES) break;
  }
  const entry = heldEntry(id);
  if (entry && !entry.heldOutcome)
    updateCompanionWeb(id, { heldOutcome: "expired" });
}

/**
 * The user's click on a held call's button in the companion's
 * conversation: "yes" makes that call (a job that does, followed as any),
 * "no" forgets it; the server checks it still waits. What the companion
 * says of it is said on a call, else written.
 */
export async function answerCompanionTool(
  id: number,
  answer: "yes" | "no",
  deps: {
    /** The words typed, when the answer was typed rather than clicked. */
    said?: string;
    answer?: typeof answerHeldTool;
    follow?: typeof followCompanionTool;
  } = {},
): Promise<void> {
  const entry = heldEntry(id);
  if (!entry || entry.heldOutcome) return;
  // The request's language: a bare "ok" says nothing of it.
  const french = ackLanguage(entry.question) === "fr";
  logCompanion({
    kind: "heard",
    text: deps.said || (answer === "yes" ? "Yes, do it." : "No, don't."),
  });
  // Its buttons go at once: a second click sends nothing.
  updateCompanionWeb(id, {
    heldOutcome: answer === "yes" ? "confirmed" : "declined",
  });
  const answered = await (deps.answer ?? answerHeldTool)(entry.job, answer);
  if (answered === null) {
    // Not through: the buttons come back, to try again.
    updateCompanionWeb(id, { heldOutcome: undefined });
    tellCompanion(
      french
        ? "Ça n'est pas passé, réessaie."
        : "That did not go through, try again.",
    );
    return;
  }
  if (answered === "gone") {
    updateCompanionWeb(id, { heldOutcome: "expired" });
    tellCompanion(
      french
        ? "Rien n'attend de confirmation."
        : "Nothing is waiting for a yes.",
    );
    return;
  }
  if ("declined" in answered) {
    tellCompanion(
      french ? "D'accord, je n'envoie rien." : "OK, I won't send anything.",
    );
    return;
  }
  tellCompanion(french ? "C'est parti." : "Doing it.");
  void (deps.follow ?? followCompanionTool)(
    answered.job.id,
    answered.job.question,
  );
}

/** What the companion says at once of a tool request it starts. */
export function toolAck(reply: string | undefined, said: string): string {
  return (
    reply?.trim() || (ackLanguage(said) === "fr" ? "Je m'en occupe." : "On it.")
  );
}

/**
 * What the companion says at once of a web search it starts: the front's
 * own line (it may give a provisional answer first), or that it looks.
 */
export function webAck(reply: string | undefined, said: string): string {
  return (
    reply?.trim() ||
    (ackLanguage(said) === "fr"
      ? "Je regarde ça sur le web, je te redis."
      : "Let me look that up, I'll tell you.")
  );
}

/** Said by the voice chat that runs, or written in the conversation. */
function tellCompanion(text: string) {
  const tell = companionTeller();
  if (tell) tell(text);
  else logCompanion({ kind: "said", text });
}
