import { askRanger, readAssistantState } from "./assistant";
import {
  companionCallState,
  companionName,
  logCompanion,
  setCompanionTarget,
  updateCompanionJob,
} from "./companionCall";
import { followCompanionWeb, webAck } from "./companionWeb";
import { forgeStore } from "./forgeStore";
import { setPaneView } from "./paneView";
import { type State, store } from "./store";
import { ackLanguage } from "./voiceAck";
import {
  answersContext,
  companionRouteAction,
  findAnswer,
  sessionLabel,
} from "./voiceCompanion";
import { recentVoiceEvents } from "./voiceEvents";
import { frontContext } from "./voiceFront";
import { focusedPaneIdForSnapshot } from "./paneJump";
import {
  followErrand,
  forwardFailedLine,
  forwardWork,
  parseVoiceSessionId,
  plainText,
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
  ranger: typeof askRanger;
  /** Where work goes by default, and the sessions the user may name. */
  context: () => { current: string; sessions: VoiceSessionInfo[] };
  show: (connectionId: string, paneId: string) => void;
};

const defaults: CompanionTextDeps = {
  route: routeSpeech,
  forward: forwardWork,
  follow: followErrand,
  followWeb: followCompanionWeb,
  ranger: askRanger,
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
 * it is handled; work and searches go on after.
 */
export async function sendCompanionText(
  text: string,
  overrides: Partial<CompanionTextDeps> = {},
): Promise<VoiceRoute | null> {
  const deps = { ...defaults, ...overrides };
  const said = text.trim();
  if (!said) return null;
  logCompanion({ kind: "heard", text: said });
  const { current, sessions } = deps.context();
  // Typed, not said: no `[Voice]` note on what reaches a session.
  const route = await deps.route(
    said,
    current,
    sessions,
    stateForFront(current, sessions),
    "typed",
  );
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
    const started = await deps.forward(action.pane, given);
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
    case "read": {
      const answer = findAnswer(route.agent);
      say(
        answer
          ? `${answer.agent}: ${answer.text}`
          : french
            ? "Je n'ai pas encore de réponse à lire."
            : "There is no answer to read yet.",
      );
      return route;
    }
    case "ranger":
      if (reply) say(reply);
      void deps.ranger(said).then(
        (answer) => say(`Ranger: ${plainText(answer)}`),
        (error: Error) => say(`Ranger: ${error.message}`),
      );
      return route;
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
