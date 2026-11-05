import {
  companionTeller,
  logCompanion,
  updateCompanionWeb,
} from "./companionCall";
import { ackLanguage } from "./voiceAck";
import { type ResearchJob, researchState, toolState } from "./voiceRoute";

/** How often a search is asked about while it runs. */
const POLL_MS = 1500;
/** Failed reads in a row before the search is given up on. */
const MISSES = 5;

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
    updateCompanionWeb(id, {
      status: state.status,
      steps: state.steps,
      ...(state.spoken ? { spoken: state.spoken } : {}),
      ...(state.answer ? { answer: state.answer } : {}),
      ...(state.sources ? { sources: state.sources } : {}),
      ...(state.error ? { error: state.error } : {}),
    });
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
