import { setPaneView } from "./paneView";
import { type FocusGuardRequest, type FocusVerdict, store } from "./store";
import { voiceTrace } from "./voiceChat";
import {
  askToMove,
  currentVoice,
  handVoiceTo,
  planVoiceFocus,
} from "./voiceFollow";
import { voiceArrives } from "./voiceArrival";

/**
 * Judges a change of the focused workspace while voice chat runs: it goes
 * on with the new workspace's agent, shown as a chat; with no agent there,
 * the move is held and the user asked whether to move anyway.
 */
export function voiceFocusGuard(request: FocusGuardRequest): FocusVerdict {
  const plan = planVoiceFocus(store.get(), currentVoice(), request);
  if (plan.to === "free") return "go";
  if (plan.to === "ask") {
    const name = plan.workspace;
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
  voiceTrace(
    `voice follows to ${plan.workspace}, pane ${plan.paneId} on ${plan.connectionId}`,
  );
  setPaneView(plan.connectionId, plan.paneId, "chat");
  voiceArrives(plan.connectionId, plan.workspaceId);
  handVoiceTo({ connectionId: plan.connectionId, paneId: plan.paneId });
  return plan.shown ? "go" : { paneId: plan.paneId };
}

let installed = false;

/** Lets voice chat follow the focused workspace; once per page. */
export function installVoiceFollow() {
  if (installed) return;
  installed = true;
  store.setFocusGuard(voiceFocusGuard);
}
