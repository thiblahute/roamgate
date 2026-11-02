import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  COMPANION_VOICE_KEY,
  companionCallState,
  endCompanionCall,
  setCompanionControls,
  setCompanionPresence,
  setCompanionVoice,
  subscribeCompanionCall,
} from "../companionCall";
import { focusedPaneIdForSnapshot } from "../paneJump";
import { answerAgentPrompt, useReviewState } from "../review";
import { setPaneView } from "../paneView";
import { type State, store } from "../store";
import {
  answerPromptByVoice,
  questionFromPermission,
  type QuestionAnswer,
  sessionLabel,
  type VoiceQuestion,
} from "../voiceCompanion";
import {
  voiceSessionId,
  voiceSessions,
  type VoiceSessionInfo,
} from "../voiceRoute";
import type { HistoryEntry } from "./agentHistory";
import { useVoiceChat } from "./useVoiceChat";

const NO_ENTRIES: readonly HistoryEntry[] = [];

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

/**
 * The call with the voice companion itself (companionCall.ts), floating
 * over the app wherever the user goes: it belongs to no pane.
 */
export function CompanionCall() {
  const call = useSyncExternalStore(subscribeCompanionCall, companionCallState);
  const review = useReviewState();
  const promptsRef = useRef(review.prompts);
  promptsRef.current = review.prompts;
  const targetRef = useRef(call.target);
  targetRef.current = call.target;
  const sessions = (): VoiceSessionInfo[] => voiceSessions(store.get());
  const question = useCallback((): VoiceQuestion | null => {
    // A question or a permission any session waits on.
    const all = [...promptsRef.current.values()].flat();
    const target = targetRef.current;
    const first =
      all.find(
        (prompt) =>
          target === voiceSessionId(prompt.connectionId, prompt.paneId),
      ) ?? all[0];
    if (!first) return null;
    return questionFromPermission(
      first,
      sessionLabel(
        voiceSessionId(first.connectionId, first.paneId),
        sessions(),
      ),
    );
  }, []);
  const answerQuestion = useCallback(
    async (asked: VoiceQuestion, answer: QuestionAnswer) => {
      const prompt = [...promptsRef.current.values()]
        .flat()
        .find((entry) => asked.key === `permission:${entry.id}`);
      if (!prompt) return false;
      return answerPromptByVoice(prompt, asked, answer, answerAgentPrompt);
    },
    [],
  );
  const voice = useVoiceChat({
    entries: NO_ENTRIES,
    agentStatus: undefined,
    // Work goes out as jobs (useVoiceChat companionCall): never sent here.
    onSend: async () => {},
    onError: (detail) =>
      store.notify({ kind: "error", message: "The call stopped", detail }),
    routeContext: () => {
      const state = store.get();
      return {
        current: targetRef.current ?? shownSession(state) ?? "",
        sessions: voiceSessions(state),
      };
    },
    onSwitch: (connectionId, paneId) => {
      setPaneView(connectionId, paneId, "chat");
      void store.jumpToConnectionPane(connectionId, paneId);
    },
    voiceKey: COMPANION_VOICE_KEY,
    question,
    answerQuestion,
    companionCall: true,
  });
  // Each start listens, once voice chat can.
  const { available, state, toggle } = voice;
  const startedRef = useRef(0);
  useEffect(() => {
    if (!call.open || !available || startedRef.current === call.started) return;
    startedRef.current = call.started;
    if (state === "off") toggle();
  }, [available, call.open, call.started, state, toggle]);
  // Hung up: the call is over.
  const wasOn = useRef(false);
  useEffect(() => {
    if (state !== "off") wasOn.current = true;
    else if (wasOn.current) {
      wasOn.current = false;
      endCompanionCall();
    }
  }, [state]);
  // Ended from its chip or its conversation view.
  const stop = voice.stop;
  useEffect(() => {
    if (!call.open && state !== "off") stop();
  }, [call.open, state, stop]);
  // What it does now, for its chip.
  const heard = voice.heard;
  useEffect(() => {
    if (!call.open) return;
    setCompanionPresence(
      state === "off"
        ? "off"
        : state === "speaking"
          ? "speaking"
          : state === "listening"
            ? heard
              ? "hearing"
              : "listening"
            : state === "waiting"
              ? "waiting"
              : "thinking",
    );
  }, [call.open, heard, state]);
  // Its state and controls go to the top bar (CompanionChip): the call
  // takes no room over the app's content.
  const { muted, toggleMute } = voice;
  const sinceRef = useRef<number | null>(null);
  if (state === "off") sinceRef.current = null;
  else sinceRef.current ??= Date.now();
  useEffect(() => {
    setCompanionVoice({ heard, muted, since: sinceRef.current });
  });
  useEffect(() => {
    setCompanionControls({ toggleMute, tap: toggle });
    return () => setCompanionControls(null);
  }, [toggle, toggleMute]);
  return null;
}
