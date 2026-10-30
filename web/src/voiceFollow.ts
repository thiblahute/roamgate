import { useSyncExternalStore } from "react";
import type { Pane, Workspace } from "./types";
import { handOffVoice, voiceHandoffPending } from "./voiceRoute";

/**
 * Voice chat follows the user from workspace to workspace: the workspace
 * focused next hands it to its agent, or, with no agent there, the move is
 * held and asked about first.
 */

type FollowPane = Pick<
  Pane,
  "pane_id" | "workspace_id" | "tab_id" | "focused" | "agent"
>;

function isAgent(pane: FollowPane) {
  return typeof pane.agent === "string" && pane.agent.trim().length > 0;
}

/**
 * The agent pane of `workspace` voice chat goes on with: the pane asked for
 * when it is an agent, else the pane the workspace shows when it is one,
 * else its most recently used agent pane; null when it has none.
 */
export function voiceFollowPane(
  workspace: Pick<Workspace, "workspace_id" | "active_tab_id">,
  panes: readonly FollowPane[],
  options: { recentPaneIds?: readonly string[]; chosenPaneId?: string } = {},
): string | null {
  const agents = panes.filter(
    (pane) => pane.workspace_id === workspace.workspace_id && isAgent(pane),
  );
  if (!agents.length) return null;
  const chosen = agents.find((pane) => pane.pane_id === options.chosenPaneId);
  if (chosen) return chosen.pane_id;
  const shown = agents.find(
    (pane) =>
      pane.focused &&
      (!workspace.active_tab_id || pane.tab_id === workspace.active_tab_id),
  );
  if (shown) return shown.pane_id;
  const recent = options.recentPaneIds ?? [];
  const rank = (pane: FollowPane) => {
    const index = recent.indexOf(pane.pane_id);
    return index < 0 ? recent.length : index;
  };
  const inShownTab = (pane: FollowPane) =>
    pane.tab_id === workspace.active_tab_id ? 0 : 1;
  return [...agents].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      inShownTab(a) - inShownTab(b) ||
      Number(b.focused) - Number(a.focused),
  )[0]!.pane_id;
}

/** The pane `workspace` shows once focused, when it is known. */
export function shownPane(
  workspace: Pick<Workspace, "workspace_id" | "active_tab_id">,
  panes: readonly FollowPane[],
): string | null {
  return (
    panes.find(
      (pane) =>
        pane.workspace_id === workspace.workspace_id &&
        pane.focused &&
        (!workspace.active_tab_id || pane.tab_id === workspace.active_tab_id),
    )?.pane_id ?? null
  );
}

const YES = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "ok",
  "okay",
  "move",
  "go",
  "go ahead",
  "do it",
  "just move",
  "move anyway",
  "yes move",
  "yes please",
  "yes just move",
  "yeah just move",
  "yeah move",
  "oui",
  "ouais",
  "ouai",
  "vas y",
  "allez",
  "d'accord",
  "oui vas y",
  "ouais vas y",
  "bouge",
  "oui bouge",
]);
const FILLERS = /^(?:uh|um|euh|well|bon|so|alors)\s+/;
const NO = /\b(?:no|nope|non|stay|don't|do not|cancel|reste|wait)\b/;

/** Whether the answer to "do you still want to move?" is a yes. */
export function isMoveYes(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}'\s-]/gu, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(FILLERS, "");
  if (!words || NO.test(words)) return false;
  if (YES.has(words)) return true;
  // "yes, just move there", "okay move": a yes word first, no "no" after.
  return /^(?:yes|yeah|yep|sure|ok|okay|oui|ouais|just move|move)\b/.test(
    words,
  );
}

/** What voice chat does about a focus change, by `voiceWorkspaceMove`. */
export type VoiceMove =
  /** Voice is off, or the workspace is the same: nothing to do. */
  | { to: "free" }
  /** Voice chat goes on with this agent pane of the new workspace. */
  | { to: "pane"; paneId: string; shown: boolean }
  /** No agent there: the move waits for the user's yes. */
  | { to: "ask" };

/** What a focus change from `from` to `workspace` does to voice chat. */
export function voiceWorkspaceMove({
  voiceOn,
  from,
  workspace,
  panes,
  recentPaneIds,
  chosenPaneId,
}: {
  voiceOn: boolean;
  /** The workspace focused now, on the connection the voice chat is on. */
  from: string | null;
  workspace: Pick<Workspace, "workspace_id" | "active_tab_id">;
  panes: readonly FollowPane[];
  recentPaneIds?: readonly string[];
  chosenPaneId?: string;
}): VoiceMove {
  if (!voiceOn || from === workspace.workspace_id) return { to: "free" };
  const paneId = voiceFollowPane(workspace, panes, {
    ...(recentPaneIds ? { recentPaneIds } : {}),
    ...(chosenPaneId ? { chosenPaneId } : {}),
  });
  if (!paneId) return { to: "ask" };
  const shown = chosenPaneId
    ? chosenPaneId === paneId
    : shownPane(workspace, panes) === paneId;
  return { to: "pane", paneId, shown };
}

/** The voice chat running now: only one listens at a time. */
export type VoiceOwner = {
  connectionId: string;
  paneId: string;
  /** Ends it at once, as the voice chat moves elsewhere. */
  handAway: () => void;
  /** Asks the user about moving to a workspace with no agent. */
  ask: (question: MoveQuestion) => void;
};

let owner: VoiceOwner | null = null;

/**
 * Makes `next` the one voice chat, ending any other; its release, which
 * lets it go only while it still is the one.
 */
export function claimVoice(next: VoiceOwner): () => void {
  const previous = owner;
  owner = next;
  if (previous && previous !== next) previous.handAway();
  return () => {
    if (owner !== next) return;
    owner = null;
    if (question) answerMoveQuestion(question, null);
  };
}

export function currentVoice(): VoiceOwner | null {
  return owner;
}

/** A move held because the workspace has no agent, waiting for an answer. */
export type MoveQuestion = {
  workspace: string;
  /** What is said and shown. */
  text: string;
  /** Does the move, once voice chat is off. */
  move: () => void;
  /** Yes, no, or null when it no longer stands (another took its place). */
  answered: Promise<boolean | null>;
};

const answers = new Map<MoveQuestion, (yes: boolean | null) => void>();
let question: MoveQuestion | null = null;
const questionListeners = new Set<() => void>();

function setQuestion(next: MoveQuestion | null) {
  question = next;
  for (const listener of questionListeners) listener();
}

export function moveQuestionText(workspace: string) {
  return `There is no agent in ${workspace}, so voice can't go there. Do you still want to move?`;
}

/** Holds the move to `workspace` and asks the voice chat's user about it. */
export function askToMove(workspace: string, move: () => void): MoveQuestion {
  if (question) answerMoveQuestion(question, null);
  let resolve: (yes: boolean | null) => void = () => {};
  const answered = new Promise<boolean | null>((done) => {
    resolve = done;
  });
  const asked: MoveQuestion = {
    workspace,
    text: moveQuestionText(workspace),
    move,
    answered,
  };
  answers.set(asked, resolve);
  setQuestion(asked);
  owner?.ask(asked);
  return asked;
}

/** Answers `asked`, by voice or a tap; null drops it unanswered. */
export function answerMoveQuestion(asked: MoveQuestion, yes: boolean | null) {
  const resolve = answers.get(asked);
  if (!resolve) return;
  answers.delete(asked);
  if (question === asked) setQuestion(null);
  resolve(yes);
}

export function currentMoveQuestion(): MoveQuestion | null {
  return question;
}

export function useMoveQuestion(): MoveQuestion | null {
  return useSyncExternalStore(
    (listener) => {
      questionListeners.add(listener);
      return () => questionListeners.delete(listener);
    },
    () => question,
  );
}

/**
 * Hands the voice chat running to `target`: the one running ends first, so
 * nothing more of its agent is read, then `target` picks it up when shown.
 * A handoff already on its way there (the router's, with words to send)
 * stays as it is.
 */
export function handVoiceTo(target: { connectionId: string; paneId: string }) {
  if (voiceHandoffPending(target.connectionId, target.paneId)) return;
  const running = owner;
  if (
    running &&
    running.connectionId === target.connectionId &&
    running.paneId === target.paneId
  )
    return;
  running?.handAway();
  handOffVoice({ ...target, message: null });
}
