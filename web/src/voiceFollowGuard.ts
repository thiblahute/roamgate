import { setPaneView } from "./paneView";
import { type FocusGuardRequest, type FocusVerdict, store } from "./store";
import { voiceTrace } from "./voiceChat";
import {
  askToMove,
  currentVoice,
  handVoiceTo,
  voiceWorkspaceMove,
} from "./voiceFollow";

/**
 * Judges a change of the focused workspace while voice chat runs: it goes
 * on with the new workspace's agent, shown as a chat; with no agent there,
 * the move is held and the user asked whether to move anyway.
 */
export function voiceFocusGuard(request: FocusGuardRequest): FocusVerdict {
  const voice = currentVoice();
  if (!voice) return "go";
  const state = store.get();
  const session =
    request.connectionId === state.activeConnectionId
      ? state
      : state.sessionsByConnectionId[request.connectionId];
  if (!session) return "go";
  const workspace = session.workspaces.find(
    (each) => each.workspace_id === request.workspaceId,
  );
  if (!workspace) return "go";
  const focused =
    session.layout?.workspace_id ??
    session.workspaces.find((each) => each.focused)?.workspace_id ??
    null;
  const move = voiceWorkspaceMove({
    voiceOn: true,
    // A workspace on another connection is always a move away.
    from: request.connectionId === voice.connectionId ? focused : null,
    workspace,
    panes: session.panes,
    recentPaneIds: session.recentPaneIds,
    ...(request.paneId ? { chosenPaneId: request.paneId } : {}),
  });
  if (move.to === "free") return "go";
  const name = workspace.label || `workspace ${workspace.number}`;
  if (move.to === "ask") {
    voiceTrace(`voice holds the move to ${name}: no agent there`);
    askToMove(name, () => {
      store.notify({
        kind: "info",
        message: "Voice is off",
        detail: `No agent in ${name}: carry on with the keyboard. Voice comes back from an agent's chat.`,
      });
      request.retry();
    });
    return "block";
  }
  voiceTrace(`voice follows to ${name}, pane ${move.paneId}`);
  setPaneView(request.connectionId, move.paneId, "chat");
  handVoiceTo({ connectionId: request.connectionId, paneId: move.paneId });
  return move.shown ? "go" : { paneId: move.paneId };
}

let installed = false;

/** Lets voice chat follow the focused workspace; once per page. */
export function installVoiceFollow() {
  if (installed) return;
  installed = true;
  store.setFocusGuard(voiceFocusGuard);
}
