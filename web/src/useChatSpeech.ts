import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { markdownToSpeech } from "./markdownToSpeech";
import { useSpeechEngine } from "./speechEngine";
import { type SpeechState, speechPlayback } from "./speechPlayback";
import { useSpeechPreferences } from "./speechPreferences";
import { store } from "./store";
import {
  readingId,
  serverVoice,
  stopReading,
  stopSpeaker,
  subscribeReading,
  toggleReading,
} from "./voiceChat";

/**
 * A chat's Speak buttons, reading with the engine in use (speechEngine.ts):
 * the server's voices a sentence at a time, highlighted as they are read,
 * or the browser's speech synthesis with the voice and rate of Speech
 * settings.
 */
export function useChatSpeech(active: boolean, scopeKey: string) {
  const owner = useRef(Symbol("agent-history-speech")).current;
  const preferences = useSpeechPreferences();
  const { engine } = useSpeechEngine();
  const playback = useSyncExternalStore(
    speechPlayback.subscribe,
    speechPlayback.getSnapshot,
    speechPlayback.getSnapshot,
  );
  const reading = useSyncExternalStore(subscribeReading, readingId, readingId);
  // The message this chat reads with the server's voices, if any.
  const readRef = useRef<string | null>(null);
  const supported = engine !== null;
  useEffect(() => {
    const stop = () => {
      speechPlayback.stop(owner);
      if (readRef.current) stopReading(readRef.current);
      readRef.current = null;
    };
    if (!active) stop();
    return stop;
  }, [active, scopeKey, owner]);
  // Polling history must not invalidate every memoized chat bubble.
  return useMemo(() => {
    const state: SpeechState | null =
      reading !== null && reading === readRef.current
        ? { owner, messageId: reading, status: "speaking", error: "" }
        : playback.owner === owner
          ? playback
          : null;
    return {
      supported,
      state,
      toggle(messageId: string, markdown: string) {
        if (!active) return;
        if (engine === "server") {
          readRef.current = messageId;
          toggleReading(
            messageId,
            markdown,
            (detail) =>
              store.notify({
                kind: "error",
                message: "Reading aloud failed",
                detail,
              }),
            serverVoice,
          );
          return;
        }
        const current = speechPlayback.getSnapshot();
        if (
          current.owner === owner &&
          current.messageId === messageId &&
          current.status === "speaking"
        ) {
          speechPlayback.stop(owner);
        } else {
          // Whatever else reads aloud (voice chat, the server's voices) stops.
          stopSpeaker();
          speechPlayback.start(
            owner,
            messageId,
            markdownToSpeech(markdown),
            preferences,
          );
        }
      },
    };
  }, [active, engine, owner, preferences, playback, reading, supported]);
}
