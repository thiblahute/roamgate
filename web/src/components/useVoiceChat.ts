import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { nextSpeechRate } from "../../../shared/speechRate";
import type { HistoryEntry } from "./agentHistory";
import { agentStateKind } from "./agentSession";
import {
  fetchVoiceAvailability,
  getSpeechRate,
  type Heard,
  VoiceLink,
  holdAudioFocus,
  replyAfter,
  claimSpeaker,
  conversationContext,
  isStopCommand,
  ongoingReading,
  rememberHeardAs,
  replyEntriesAfter,
  saveSpeechRate,
  stopSpeaker,
  subscribeSpeechRate,
  voiceMessage,
  voiceTrace,
  speak,
} from "../voiceChat";
import { highlightReading } from "../readingHighlight";

export type VoiceState =
  | "off"
  | "listening"
  | "transcribing"
  | "waiting"
  | "speaking";

/** How long a reply must stay unchanged, the agent idle, to be complete. */
const REPLY_SETTLED_MS = 1200;
const REPLY_POLL_MS = 300;
const REPLY_TIMEOUT_MS = 30 * 60_000;

let availability: Promise<boolean> | null = null;

/** Whether the server has voice set up; asked once per page. */
export function useVoiceAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    availability ??= fetchVoiceAvailability().then(
      (status) => status.available,
    );
    let live = true;
    void availability.then((value) => {
      if (live) setAvailable(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return available;
}

/** How fast replies are read, and a step to the next speed (kept). */
export function useSpeechRate(onError: (message: string) => void) {
  const rate = useSyncExternalStore(subscribeSpeechRate, getSpeechRate);
  const cycle = useCallback(() => {
    saveSpeechRate(nextSpeechRate(getSpeechRate())).catch((error) =>
      onError(`The reading speed was not kept: ${(error as Error).message}`),
    );
  }, [onError]);
  return { rate, cycle };
}

/**
 * Hands-free chat with an agent: listen, send what was said, wait for the
 * agent to answer, read the answer aloud, listen again. Saying nothing, or
 * `toggle()`, ends it.
 */
export function useVoiceChat({
  entries,
  agentStatus,
  onSend,
  onError,
}: {
  entries: readonly HistoryEntry[];
  agentStatus: string | undefined;
  onSend: (text: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const available = useVoiceAvailable();
  const speechRate = useSpeechRate(onError);
  const [state, setState] = useState<VoiceState>("off");
  const [level, setLevel] = useState(0);
  // What is being said, as the helper hears it.
  const [heard, setHeard] = useState("");
  // What was said to someone else, by the cleaner's reading: not sent
  // unless asked.
  const [held, setHeld] = useState<Heard[]>([]);
  const hold = useCallback(
    (said: Heard) => setHeld((list) => [...list, said].slice(-5)),
    [],
  );
  const controllerRef = useRef<AbortController | null>(null);
  // Muted: voice chat goes on, replies are read, nothing is listened to.
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  // Ends the listening in progress when muting.
  const muteAbortRef = useRef<AbortController | null>(null);
  const unmutedRef = useRef<(() => void) | null>(null);
  // Ends the recording now, sending what was said.
  const finishRef = useRef<AbortController | null>(null);
  // Stops the reading and listens, as speaking up does.
  const interruptRef = useRef<(() => void) | null>(null);
  const stateRef = useRef<VoiceState>("off");
  stateRef.current = state;
  // The loop reads the latest history and status, not those it started with.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const statusRef = useRef(agentStatus);
  statusRef.current = agentStatus;

  useEffect(
    () => () => {
      if (controllerRef.current) voiceTrace("voice chat ends: unmounted");
      controllerRef.current?.abort();
    },
    [],
  );

  const waitForReply = useCallback(
    async (
      sent: string,
      signal: AbortSignal,
    ): Promise<{ text: string; ids: string[] } | "blocked" | null> => {
      const started = performance.now();
      let reply: string | null = null;
      let settledSince = 0;
      while (
        !signal.aborted &&
        performance.now() - started < REPLY_TIMEOUT_MS
      ) {
        await new Promise((resolve) => setTimeout(resolve, REPLY_POLL_MS));
        const kind = agentStateKind(statusRef.current);
        if (kind === "blocked") return "blocked";
        const latest = replyAfter(entriesRef.current, sent);
        if (latest !== reply || kind === "working") {
          reply = latest;
          settledSince = performance.now();
          continue;
        }
        if (reply && performance.now() - settledSince >= REPLY_SETTLED_MS)
          return {
            text: reply,
            ids: replyEntriesAfter(entriesRef.current, sent).map((e) => e.id),
          };
      }
      return null;
    },
    [],
  );

  const run = useCallback(
    async (
      controller: AbortController,
      carried: ReturnType<typeof ongoingReading>,
    ) => {
      const { signal } = controller;
      // A message read from its button when voice chat started plays on,
      // until it ends or the speaker talks over it.
      let carriedPlaying = carried !== null;
      void carried?.done.then(() => {
        carriedPlaying = false;
      });
      if (carried)
        signal.addEventListener("abort", carried.stop, { once: true });
      // The microphone's way to the voice helper, for this voice chat.
      let link: VoiceLink | null = null;
      // Listening that started while the previous reply played.
      let next: Promise<Heard | null> | null = null;
      // The sentence being read when the speaker cut in.
      let interruptedAt: string | null = null;
      // Waits, unless voice chat ends first.
      const pause = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      // Only the person ends voice chat: a lost connection or a failing
      // helper is retried, more slowly each time, and said once.
      let failures = 0;
      try {
        // Listening stops with the chat, or when muted.
        const listening = () => {
          const mute = new AbortController();
          muteAbortRef.current = mute;
          return AbortSignal.any([signal, mute.signal]);
        };
        const unmuted = async () => {
          while (mutedRef.current && !signal.aborted)
            await new Promise<void>((resolve) => {
              unmutedRef.current = resolve;
              signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
        };
        while (!signal.aborted) {
          try {
            link ??= await VoiceLink.open();
            const voice = link;
            let heard: Heard | null;
            if (next) {
              heard = await next;
              next = null;
            } else {
              await unmuted();
              if (signal.aborted) break;
              setState("listening");
              const finish = new AbortController();
              finishRef.current = finish;
              const over = carriedPlaying ? carried : null;
              heard = await voice.listen(listening(), {
                finish: finish.signal,
                onLevel: setLevel,
                ...(over
                  ? {
                      holding: () => carriedPlaying,
                      onSpeech: () => {
                        if (!carriedPlaying) return;
                        carriedPlaying = false;
                        interruptedAt = over.sentence();
                        voiceTrace(
                          `talked over the reading at: ${interruptedAt}`,
                        );
                        over.stop();
                      },
                    }
                  : {}),
                onSpeechEnd: () => setState("transcribing"),
                onHeard: setHeard,
                conversation: conversationContext(entriesRef.current),
              });
            }
            finishRef.current = null;
            setLevel(0);
            if (signal.aborted) break;
            if (!heard) {
              setHeard("");
              // Muted while listening: wait for the microphone.
              if (mutedRef.current) continue;
              break;
            }
            const { text, raw }: Heard = heard;
            // "Stop", alone, ends voice chat as a tap would.
            if (isStopCommand(raw ?? text)) {
              await speak("Okay, stopping.", signal);
              break;
            }
            // Speech that came to no text: listen again.
            if (!text) {
              setHeard("");
              continue;
            }
            if (heard.forAgent === false) {
              hold(heard);
              setHeard("");
              continue;
            }
            const message = voiceMessage(text, interruptedAt);
            interruptedAt = null;
            await onSend(message);
            if (raw) rememberHeardAs(text, raw);
            setHeard("");
            // Listen while the agent works: each thing said is sent too,
            // queued behind the others, and the answer read is the one to
            // the last of them.
            let sent = message;
            let reply: Awaited<ReturnType<typeof waitForReply>> = null;
            let stopping = false;
            let deaf = false;
            // The agent's messages are read while it works, so its progress
            // is heard: each once something follows it (it is complete).
            const readIds = new Set<string>();
            for (;;) {
              setState("waiting");
              const waiting = new AbortController();
              let speaking = false;
              let progressReading: AbortController | null = null;
              let progressSentence: string | null = null;
              const stopProgress = () => {
                if (!progressReading || progressReading.signal.aborted) return;
                voiceTrace(`progress stopped at: ${progressSentence}`);
                interruptedAt = progressSentence;
                progressReading.abort();
              };
              const finish = new AbortController();
              finishRef.current = finish;
              const heardMeanwhile =
                mutedRef.current || deaf
                  ? null
                  : voice.listen(
                      AbortSignal.any([listening(), waiting.signal]),
                      {
                        finish: finish.signal,
                        onLevel: setLevel,
                        onSpeech: () => {
                          speaking = true;
                          stopProgress();
                          setState("listening");
                        },
                        onSpeechEnd: () => setState("transcribing"),
                        onHeard: setHeard,
                        conversation: conversationContext(entriesRef.current),
                      },
                    );
              heardMeanwhile?.catch(() => {});
              const progress = (async () => {
                while (!waiting.signal.aborted && !signal.aborted) {
                  await pause(REPLY_POLL_MS);
                  if (waiting.signal.aborted || speaking) continue;
                  const all = entriesRef.current;
                  const last = all[all.length - 1]?.id;
                  const ready = replyEntriesAfter(all, sent).find(
                    (entry) => !readIds.has(entry.id) && entry.id !== last,
                  );
                  if (!ready) continue;
                  readIds.add(ready.id);
                  const reading = new AbortController();
                  progressReading = reading;
                  claimSpeaker(reading);
                  setState("speaking");
                  interruptRef.current = () => {
                    stopProgress();
                    setState("waiting");
                  };
                  await speak(
                    ready.text,
                    AbortSignal.any([reading.signal, signal]),
                    (sentence) => {
                      progressSentence = sentence ?? progressSentence;
                      highlightReading([ready.id], sentence);
                    },
                  ).catch(() => {});
                  highlightReading([], null);
                  interruptRef.current = null;
                  progressReading = null;
                  if (!speaking && !signal.aborted) setState("waiting");
                }
              })();
              try {
                const replied = waitForReply(
                  sent,
                  AbortSignal.any([signal, waiting.signal]),
                );
                const first = await Promise.race([
                  replied.then((value) => ({ reply: value })),
                  ...(heardMeanwhile
                    ? [heardMeanwhile.then((value) => ({ heard: value }))]
                    : []),
                ]);
                let heard: Heard | null;
                if ("reply" in first) {
                  // Answered while nothing was being said: read it.
                  if (!speaking || !heardMeanwhile) {
                    reply = first.reply;
                    break;
                  }
                  // Answered mid-sentence: what is said goes next.
                  heard = await heardMeanwhile;
                } else heard = first.heard;
                setLevel(0);
                if (signal.aborted) break;
                if (!heard) {
                  // Muted, or the helper gave up: only wait for the answer.
                  if (!mutedRef.current) deaf = true;
                  continue;
                }
                if (isStopCommand(heard.raw ?? heard.text)) {
                  await speak("Okay, stopping.", signal);
                  stopping = true;
                  break;
                }
                if (!heard.text) {
                  setHeard("");
                  continue;
                }
                if (heard.forAgent === false) {
                  hold(heard);
                  setHeard("");
                  continue;
                }
                sent = voiceMessage(heard.text, interruptedAt);
                interruptedAt = null;
                await onSend(sent);
                if (heard.raw) rememberHeardAs(heard.text, heard.raw);
                setHeard("");
              } finally {
                waiting.abort();
                finishRef.current = null;
                await heardMeanwhile?.catch(() => null);
                // A progress message being read is heard to its end.
                await progress;
              }
            }
            setLevel(0);
            if (stopping || signal.aborted) break;
            // What was read while the agent worked is not read again.
            if (reply && reply !== "blocked") {
              const { ids } = reply;
              const unread = replyEntriesAfter(entriesRef.current, sent).filter(
                (entry) => ids.includes(entry.id) && !readIds.has(entry.id),
              );
              if (!unread.length) {
                setState("listening");
                continue;
              }
              reply = {
                text: unread.map((entry) => entry.text).join("\n\n"),
                ids: unread.map((entry) => entry.id),
              };
            }
            setState("speaking");
            if (reply === "blocked") {
              await speak(
                "The agent is asking something; answer it on the screen.",
                signal,
              );
              // Back to listening once it is answered.
              while (
                !signal.aborted &&
                agentStateKind(statusRef.current) === "blocked"
              )
                await pause(REPLY_POLL_MS);
              continue;
            }
            if (!reply) continue;
            // Listen while reading: speaking up stops the reading and is the
            // next message.
            const reading = new AbortController();
            claimSpeaker(reading);
            const stopReading = () => reading.abort();
            signal.addEventListener("abort", stopReading, { once: true });
            let playing = true;
            let current: string | null = null;
            const finish = new AbortController();
            finishRef.current = finish;
            next = mutedRef.current
              ? null
              : voice.listen(listening(), {
                  finish: finish.signal,
                  holding: () => playing,
                  onLevel: (value) => {
                    if (!playing) setLevel(value);
                  },
                  onSpeech: () => interrupt(),
                  onSpeechEnd: () => setState("transcribing"),
                  onHeard: setHeard,
                  conversation: conversationContext(entriesRef.current),
                });
            const interrupt = () => {
              if (!playing) return;
              voiceTrace(`interrupted by speech or a tap at: ${current}`);
              playing = false;
              interruptedAt = current;
              reading.abort();
              setState("listening");
            };
            interruptRef.current = interrupt;
            // Its failure is the loop's, once it waits for it.
            next?.catch(() => {});
            await speak(reply.text, reading.signal, (sentence) => {
              current = sentence ?? current;
              highlightReading(reply.ids, sentence);
            }).catch((error) => {
              if (!reading.signal.aborted) throw error;
            });
            highlightReading([], null);
            interruptRef.current = null;
            signal.removeEventListener("abort", stopReading);
            playing = false;
            if (!signal.aborted) setState("listening");
            failures = 0;
          } catch (error) {
            if (signal.aborted) break;
            if (failures === 0)
              onError(
                `${error instanceof Error ? error.message : String(error)}; retrying`,
              );
            failures += 1;
            link?.close();
            link = null;
            next = null;
            finishRef.current = null;
            interruptRef.current = null;
            highlightReading([], null);
            setLevel(0);
            setHeard("");
            await pause(Math.min(10_000, 1000 * 2 ** (failures - 1)));
          }
        }
      } finally {
        // Nothing keeps the microphone once the loop is over.
        controller.abort();
        link?.close();
        highlightReading([], null);
        setHeard("");
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setState("off");
          setLevel(0);
        }
      }
    },
    [hold, onError, onSend, waitForReply],
  );

  const toggle = useCallback(() => {
    // While a reply is read, a tap stops it and listens, as speaking up does.
    if (stateRef.current === "speaking" && interruptRef.current) {
      interruptRef.current();
      return;
    }
    // While listening, a tap sends what was said without waiting for the
    // pause; with nothing said yet, it stops like any other tap.
    if (stateRef.current === "listening" && finishRef.current) {
      finishRef.current.abort();
      return;
    }
    if (controllerRef.current) {
      voiceTrace(`voice chat ends: a tap while ${stateRef.current}`);
      controllerRef.current.abort();
      controllerRef.current = null;
      setState("off");
      setLevel(0);
      return;
    }
    // Voice chat starts by listening; a message being read plays on until
    // the speaker talks over it, anything else reading stops.
    const carried = ongoingReading();
    if (!carried) stopSpeaker();
    const controller = new AbortController();
    controllerRef.current = controller;
    holdAudioFocus(controller.signal);
    void run(controller, carried);
  }, [run]);

  const stop = useCallback(() => {
    if (controllerRef.current) voiceTrace("voice chat ends: stopped");
    controllerRef.current?.abort();
  }, []);

  const toggleMute = useCallback(() => {
    const mute = !mutedRef.current;
    mutedRef.current = mute;
    setMuted(mute);
    // What is being said goes, as a tap would send it; then nothing more
    // is heard.
    if (mute) (finishRef.current ?? muteAbortRef.current)?.abort();
    else {
      unmutedRef.current?.();
      unmutedRef.current = null;
    }
  }, []);

  // A new voice chat starts with the microphone on.
  useEffect(() => {
    if (state !== "off" || !mutedRef.current) return;
    mutedRef.current = false;
    setMuted(false);
  }, [state]);

  /** Sends a held message after all, or lets it go. */
  const sendHeld = useCallback(
    (said: Heard) => {
      setHeld((list) => list.filter((item) => item !== said));
      void onSend(voiceMessage(said.text))
        .then(() => {
          if (said.raw) rememberHeardAs(said.text, said.raw);
        })
        .catch((error: Error) => onError(error.message));
    },
    [onError, onSend],
  );
  const dropHeld = useCallback(
    (said: Heard) => setHeld((list) => list.filter((item) => item !== said)),
    [],
  );

  return {
    available,
    state,
    level,
    muted,
    heard,
    held,
    sendHeld,
    dropHeld,
    toggle,
    toggleMute,
    stop,
    speechRate: speechRate.rate,
    cycleSpeechRate: speechRate.cycle,
  };
}
