import { askRanger, readAssistantState } from "./assistant";
import { askReviewsAgent } from "./mrReviewsAgent";
import {
  companionCallState,
  companionName,
  companionRecent,
  companionTypedTurn,
  logCompanion,
  setCompanionTarget,
  updateCompanionJob,
} from "./companionCall";
import {
  answerCompanionTool,
  followCompanionTool,
  followCompanionWeb,
  plainHeldAnswer,
  toolAck,
  waitingHeldCall,
  webAck,
} from "./companionWeb";
import { wordsWithImages } from "./companionImages";
import { forgeStore } from "./forgeStore";
import { forgetCompanionLocally } from "./companionMemory";
import { setPaneView } from "./paneView";
import { type State, store } from "./store";
import { ackLanguage } from "./voiceAck";
import {
  answersContext,
  askCompanionAgent,
  companionRouteAction,
  findAnswer,
  sessionLabel,
} from "./voiceCompanion";
import { recentVoiceEvents } from "./voiceEvents";
import { frontContext } from "./voiceFront";
import { takeWaiting, type WaitingDeps, waitingDeps } from "./voiceWaiting";
import { focusedPaneIdForSnapshot } from "./paneJump";
import {
  followErrand,
  forwardFailedLine,
  forwardWork,
  parseVoiceSessionId,
  plainText,
  RANGER_VOICE_SESSION,
  REVIEWS_VOICE_SESSION,
  routeSpeech,
  type VoiceRoute,
  type VoiceSessionInfo,
  voiceSessionId,
  voiceSessions,
} from "./voiceRoute";

/** The agent session on screen, else the last one used: work's default. */
export function shownSession(state: State): string | null {
  const agentPane = (paneId: string | undefined) =>
    paneId
      ? state.panes.find((pane) => pane.pane_id === paneId && pane.agent)
      : undefined;
  const pane =
    agentPane(focusedPaneIdForSnapshot(state)) ??
    state.recentPaneIds.map(agentPane).find(Boolean) ??
    state.panes.find((pane) => pane.agent);
  return pane ? voiceSessionId(state.activeConnectionId, pane.pane_id) : null;
}

export type CompanionTextDeps = {
  route: typeof routeSpeech;
  forward: typeof forwardWork;
  follow: typeof followErrand;
  followWeb: typeof followCompanionWeb;
  followTool: typeof followCompanionTool;
  /** A plain yes or no typed to a held call: as its buttons answer it. */
  answerHeld: typeof answerCompanionTool;
  ranger: typeof askRanger;
  reviews: typeof askReviewsAgent;
  /** Where work goes by default, and the sessions the user may name. */
  context: () => { current: string; sessions: VoiceSessionInfo[] };
  show: (connectionId: string, paneId: string) => void;
  /** The words for a session, with the images given (wordsWithImages). */
  withImages: typeof wordsWithImages;
  /** The answers that came while the user was away (voiceWaiting.ts). */
  waiting: WaitingDeps;
};

const defaults: CompanionTextDeps = {
  route: routeSpeech,
  forward: forwardWork,
  waiting: waitingDeps,
  follow: followErrand,
  followWeb: followCompanionWeb,
  followTool: followCompanionTool,
  answerHeld: answerCompanionTool,
  ranger: askRanger,
  reviews: askReviewsAgent,
  context: () => {
    const state = store.get();
    return {
      current: companionCallState().target ?? shownSession(state) ?? "",
      sessions: voiceSessions(state),
    };
  },
  show: (connectionId, paneId) => {
    setPaneView(connectionId, paneId, "chat");
    void store.jumpToConnectionPane(connectionId, paneId);
  },
  withImages: wordsWithImages,
};

/** Roamgate's state for the front, as a call gives it, typed this time. */
function stateForFront(current: string, sessions: VoiceSessionInfo[]) {
  return frontContext({
    tasks: readAssistantState().snapshot?.tasks ?? [],
    requests: forgeStore.known(),
    events: recentVoiceEvents(),
    answers: [
      `The user types to you in your conversation view, as ${companionName()}, rather than talking; "Current" is ${
        current ? sessionLabel(current, sessions) : "no session yet"
      }.`,
      answersContext(),
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
}

/**
 * Something typed to the companion in its conversation view, outside a
 * call or during one: it goes to the front as words said would, and what
 * it does shows there. It answers itself, looks things up on the web in
 * the background (its result written there, and told aloud on a call),
 * starts work on a session as a job, or asks Ranger. The route back once
 * it is handled; work and searches go on after. A plain yes or no while
 * its tools hold a call for one answers that call, as its buttons do,
 * without the front (anything more, a change, goes to the front); null
 * then, as when nothing was typed.
 */
export async function sendCompanionText(
  text: string,
  overrides: Partial<CompanionTextDeps> = {},
): Promise<VoiceRoute | null> {
  const deps = { ...defaults, ...overrides };
  const said = text.trim();
  if (!said) return null;
  const held = waitingHeldCall();
  const answer = held === null ? null : plainHeldAnswer(said);
  if (held !== null && answer) {
    await deps.answerHeld(held, answer, { said });
    return null;
  }
  // The conversation so far, before these words: what they may lean on.
  const recent = companionRecent();
  logCompanion({ kind: "heard", text: said });
  const { current, sessions } = deps.context();
  // Thinking, outside a call, until the front decides.
  const back = companionTypedTurn();
  let route: VoiceRoute;
  try {
    // Typed, not said: no `[Voice]` note on what reaches a session.
    route = await deps.route(
      said,
      current,
      sessions,
      stateForFront(current, sessions),
      "typed",
      recent || undefined,
    );
  } finally {
    back();
  }
  const french = ackLanguage(said) === "fr";
  const reply = route.reply?.trim();
  const say = (line: string) => logCompanion({ kind: "said", text: line });
  const action = companionRouteAction(route, current);
  if (action) {
    if (reply) say(reply);
    if (action.kind === "show") {
      const target = parseVoiceSessionId(action.pane);
      if (target) deps.show(target.connectionId, target.paneId);
      return route;
    }
    setCompanionTarget(action.pane);
    const label = sessionLabel(action.pane, sessions);
    const given = route.words?.trim() || said;
    const logged = logCompanion({
      kind: "job",
      session: action.pane,
      label,
      words: given,
      ...(given !== said ? { said } : {}),
      status: "running",
    });
    // The images given go with the words, wherever the session runs. The
    // session's name goes too, kept with its answer (voiceWaiting.ts).
    const started = await deps.forward(
      action.pane,
      await deps.withImages(given, said, action.pane),
      undefined,
      label,
    );
    const job = started?.job ?? null;
    if (!job) {
      updateCompanionJob(logged, { status: "not started" });
      say(forwardFailedLine(label, french));
      return route;
    }
    void deps
      .follow(job, () => {})
      .then((answer) =>
        updateCompanionJob(
          logged,
          answer
            ? { status: "answered", answer: plainText(answer) }
            : { status: "no answer" },
        ),
      );
    return route;
  }
  switch (route.to) {
    case "web":
      say(webAck(reply, said));
      if (route.job) void deps.followWeb(route.job, route.query || said);
      return route;
    case "tool":
      say(toolAck(reply, said));
      if (route.job) void deps.followTool(route.job, route.task || said);
      return route;
    case "reset":
      // Forgotten on the server already: only the last line stays.
      forgetCompanionLocally();
      if (reply) say(reply);
      return route;
    case "read": {
      const own = findAnswer(route.agent);
      // An answer that came while the user was away: the one named, the
      // agent's, or the latest when none was kept here. Taken, it is heard.
      const taken =
        route.job || route.agent || !own
          ? await takeWaiting(
              { job: route.job, agent: route.agent, last: !own },
              route.job ? [] : await deps.waiting.list().catch(() => []),
              deps.waiting,
            )
          : null;
      const answer = taken
        ? { agent: taken.label, text: plainText(taken.answer) }
        : own;
      say(
        answer
          ? `${answer.agent}: ${answer.text}`
          : french
            ? "Je n'ai pas encore de réponse à lire."
            : "There is no answer to read yet.",
      );
      return route;
    }
    case "dismiss":
      // The server dropped the answer waiting already: said here.
      say(
        reply || (french ? "D'accord, je la laisse." : "Okay, I'll leave it."),
      );
      return route;
    case "ranger":
    case "reviews": {
      // Shown as work given to a session is: asked, then its answer or
      // why it was not asked.
      if (reply) say(reply);
      const chat =
        route.to === "ranger" ? RANGER_VOICE_SESSION : REVIEWS_VOICE_SESSION;
      const ask = route.to === "ranger" ? deps.ranger : deps.reviews;
      void askCompanionAgent(chat, said, () => ask(said)).catch(() => {});
      return route;
    }
    case "errand":
      if (reply) say(reply);
      if (route.job)
        void deps
          .follow(route.job, () => {})
          .then((answer) =>
            say(
              answer
                ? `${route.say || "Errands"}: ${plainText(answer)}`
                : french
                  ? `${route.say || "La session des courses"} n'a pas répondu.`
                  : `${route.say || "The errands session"} gave no answer.`,
            ),
          );
      return route;
    case "ask":
      say(route.question);
      return route;
    case "current":
      // Nowhere to start it: no session yet.
      say(
        french
          ? "Je n'ai pas de session où lancer ça : dis-moi laquelle."
          : "I have no session to start that on: tell me which one.",
      );
      return route;
    default:
      if (reply) say(reply);
      return route;
  }
}
