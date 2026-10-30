import {
  useCallback,
  useEffect,
  useMemo,
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
  voiceRouting,
  voiceTrace,
  speak,
} from "../voiceChat";
import { highlightReading } from "../readingHighlight";
import {
  handOffVoice,
  parseVoiceSessionId,
  followErrand,
  plainText,
  routeSpeech,
  showRouterNote,
  type VoiceSessionInfo,
} from "../voiceRoute";
import {
  answerMoveQuestion,
  claimVoice,
  isMoveYes,
  type MoveQuestion,
} from "../voiceFollow";
import { installVoiceFollow } from "../voiceFollowGuard";

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
/** How long the answer to "do you still want to move?" is waited for. */
const MOVE_ANSWER_MS = 20_000;

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
  routeContext,
  onSwitch,
  voiceKey,
}: {
  entries: readonly HistoryEntry[];
  agentStatus: string | undefined;
  onSend: (text: string) => Promise<void>;
  onError: (message: string) => void;
  /** This session and all those the user may name, for the router. */
  routeContext?: () => { current: string; sessions: VoiceSessionInfo[] };
  /** Shows another session, which picks up the voice chat. */
  onSwitch?: (connectionId: string, paneId: string) => void;
  /**
   * The pane this voice chat talks to: it is then the one voice chat
   * running, and follows the user to the agent of the workspace focused
   * next.
   */
  voiceKey?: { connectionId: string; paneId: string };
}) {
  const available = useVoiceAvailable();
  const speechRate = useSpeechRate(onError);
  const [state, setState] = useState<VoiceState>("off");
  const [level, setLevel] = useState(0);
  // What is being said, as the helper hears it.
  const [heard, setHeard] = useState("");
  // What was said to someone else, by the cleaner's reading: not sent
  // unless asked.
  // Each with its pane: it stays there when voice chat moves on.
  const [heldByPane, setHeld] = useState<{ pane: string; said: Heard }[]>([]);
  const voiceKeyRef = useRef(voiceKey);
  voiceKeyRef.current = voiceKey;
  const heldPane = voiceKey
    ? `${voiceKey.connectionId}/${voiceKey.paneId}`
    : "";
  const held = useMemo(
    () =>
      heldByPane
        .filter((item) => item.pane === heldPane)
        .map((item) => item.said),
    [heldByPane, heldPane],
  );
  const hold = useCallback((said: Heard) => {
    const key = voiceKeyRef.current;
    const pane = key ? `${key.connectionId}/${key.paneId}` : "";
    setHeld((list) => [...list, { pane, said }].slice(-10));
  }, []);
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
  // A move to a workspace with no agent, waiting for the user's answer.
  const moveRef = useRef<MoveQuestion | null>(null);
  // Ends the listening in progress when that question comes.
  const askRef = useRef(new AbortController());
  // The same question, for the card's Move and Stay.
  const [moveQuestion, setMoveQuestion] = useState<MoveQuestion | null>(null);
  const stateRef = useRef<VoiceState>("off");
  stateRef.current = state;
  // The loop reads the latest history and status, not those it started with.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const statusRef = useRef(agentStatus);
  statusRef.current = agentStatus;
  const routeContextRef = useRef(routeContext);
  routeContextRef.current = routeContext;
  const onSwitchRef = useRef(onSwitch);
  onSwitchRef.current = onSwitch;

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
      handedOver: string | null = null,
    ) => {
      const { signal } = controller;
      installVoiceFollow();
      moveRef.current = null;
      askRef.current = new AbortController();
      // The one voice chat running: another starting, or the user moving
      // to another workspace's agent, ends this one at once.
      const key = voiceKeyRef.current;
      const release = key
        ? claimVoice({
            ...key,
            handAway: () => {
              if (signal.aborted) return;
              voiceTrace("voice chat ends: it moved to another pane");
              controller.abort();
              if (controllerRef.current === controller) {
                controllerRef.current = null;
                setState("off");
                setLevel(0);
              }
            },
            ask: (question) => {
              moveRef.current = question;
              setMoveQuestion(question);
              void question.answered.then(() =>
                setMoveQuestion((shown) => (shown === question ? null : shown)),
              );
              askRef.current.abort();
              interruptRef.current?.();
              unmutedRef.current?.();
              unmutedRef.current = null;
            },
          })
        : () => {};
      // The workspace the user said yes to moving to: moved to once voice
      // chat is over.
      const moving: { to: MoveQuestion | null } = { to: null };
      // Words another pane's voice chat routed here: sent first, unheard.
      let forwarded = handedOver;
      // What was said when the router asked which session: what to send
      // once the answer names one.
      let asked: string | null = null;
      /**
       * Who what was said is for, by the router when the server has one:
       * this agent ("here"), nobody (held, or the router's question asked),
       * or another session, which now has the voice chat ("left").
       */
      const routed = async (
        heard: Heard,
      ): Promise<"here" | "nobody" | "left"> => {
        const context = routeContextRef.current?.();
        if (!context || !voiceRouting()) return "here";
        setState("transcribing");
        const route = await routeSpeech(
          heard.text,
          context.current,
          context.sessions,
        );
        voiceTrace(`routed ${JSON.stringify(route)}: ${heard.text}`);
        const words = asked ?? heard.text;
        asked = null;
        switch (route.to) {
          case "current":
            return "here";
          case "nobody":
            hold(heard);
            return "nobody";
          case "ask":
            asked = words;
            showRouterNote(route.question);
            await speak(route.question, signal).catch(() => {});
            return "nobody";
          case "errand": {
            const name = route.say || "the errands session";
            if (!route.job) return "nobody";
            showRouterNote(`Asked ${name}: ${words}`);
            // Its answer comes when it comes: voice chat goes on meanwhile.
            void followErrand(route.job, (state) =>
              showRouterNote(
                state.stalled
                  ? `${name} waits on its screen, perhaps for your OK.`
                  : `Asked ${name}: ${words}`,
              ),
            ).then((answer) => {
              const said = answer ?? `${name} gave no answer.`;
              showRouterNote(said);
              if (!signal.aborted)
                void speak(plainText(said), signal).catch(() => {});
            });
            return "nobody";
          }
          case "overview":
          case "status": {
            const answer =
              route.answer ||
              (route.to === "status"
                ? `Nothing to say about ${route.say}.`
                : "Nothing to say about your sessions.");
            showRouterNote(answer);
            await speak(answer, signal).catch(() => {});
            return "nobody";
          }
          default: {
            const target = parseVoiceSessionId(route.pane);
            if (!target) return "here";
            if (route.pane === context.current)
              return route.to === "send" ? "here" : "nobody";
            const switched = `Switched to ${route.say || "that session"}.`;
            showRouterNote(switched);
            await speak(switched, signal).catch(() => {});
            handOffVoice({
              ...target,
              message: route.to === "send" ? words : null,
            });
            onSwitchRef.current?.(target.connectionId, target.paneId);
            return "left";
          }
        }
      };
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
          return AbortSignal.any([signal, mute.signal, askRef.current.signal]);
        };
        const unmuted = async () => {
          while (mutedRef.current && !signal.aborted && !moveRef.current)
            await new Promise<void>((resolve) => {
              unmutedRef.current = resolve;
              signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
        };
        /**
         * Asks whether to move to the workspace with no agent the user
         * went for, and takes the answer, said or tapped; nothing of it is
         * sent to the agent. True when it is a yes: voice chat ends and the
         * move is made.
         */
        const askMove = async (voice: VoiceLink): Promise<boolean> => {
          const asked = moveRef.current;
          moveRef.current = null;
          askRef.current = new AbortController();
          if (!asked) return false;
          if (carriedPlaying) {
            carriedPlaying = false;
            carried?.stop();
          }
          setHeard("");
          setLevel(0);
          let open = true;
          void asked.answered.then(() => {
            open = false;
          });
          // A tap answers at once, cutting the question short.
          const answering = new AbortController();
          void asked.answered.then(() => answering.abort());
          const timer = setTimeout(() => answering.abort(), MOVE_ANSWER_MS);
          try {
            showRouterNote(asked.text);
            setState("speaking");
            const reading = new AbortController();
            claimSpeaker(reading);
            await speak(
              asked.text,
              AbortSignal.any([signal, reading.signal, answering.signal]),
            ).catch(() => {});
            if (open && !signal.aborted) {
              if (mutedRef.current)
                // Nothing is listened to: only a tap answers.
                await new Promise<void>((resolve) => {
                  answering.signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
              else {
                setState("listening");
                const answer = await voice
                  .listen(AbortSignal.any([listening(), answering.signal]), {
                    onLevel: setLevel,
                    onSpeechEnd: () => setState("transcribing"),
                    onHeard: setHeard,
                  })
                  .catch(() => null);
                if (answer)
                  answerMoveQuestion(
                    asked,
                    isMoveYes(answer.raw ?? answer.text),
                  );
              }
            }
          } finally {
            clearTimeout(timer);
            setHeard("");
            setLevel(0);
          }
          // Not answered by then, or by something else: no.
          answerMoveQuestion(asked, false);
          const yes = await asked.answered;
          if (signal.aborted) return false;
          if (yes) {
            const said = `Moving to ${asked.workspace}. Voice is off: carry on with the keyboard.`;
            showRouterNote(said);
            setState("speaking");
            await speak(said, signal).catch(() => {});
            moving.to = asked;
            return true;
          }
          // Replaced by a newer question: that one is asked next.
          if (yes === null) return false;
          showRouterNote("Staying here.");
          setState("speaking");
          await speak("Okay, staying here.", signal).catch(() => {});
          return false;
        };
        while (!signal.aborted) {
          try {
            link ??= await VoiceLink.open();
            const voice = link;
            // The user went for a workspace with no agent: asked first.
            if (moveRef.current && forwarded === null) {
              await next?.catch(() => null);
              next = null;
              if (await askMove(voice)) break;
              continue;
            }
            let heard: Heard | null;
            const handed = forwarded;
            forwarded = null;
            if (handed !== null) heard = { text: handed, speechMs: 0 };
            else if (next) {
              heard = await next;
              next = null;
            } else {
              await unmuted();
              if (signal.aborted) break;
              if (moveRef.current) continue;
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
              // Cut short by the question about moving: asked next.
              if (moveRef.current) continue;
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
            const route = handed !== null ? "here" : await routed(heard);
            if (route === "left") break;
            if (route === "nobody") {
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
                const askSignal = askRef.current.signal;
                const asked = new Promise<{ asked: true }>((resolve) => {
                  const done = () => resolve({ asked: true });
                  if (askSignal.aborted) done();
                  else
                    askSignal.addEventListener("abort", done, { once: true });
                });
                const first = await Promise.race([
                  replied.then((value) => ({ reply: value })),
                  ...(heardMeanwhile
                    ? [heardMeanwhile.then((value) => ({ heard: value }))]
                    : []),
                  asked,
                ]);
                let heard: Heard | null;
                if ("asked" in first) heard = null;
                else if ("reply" in first) {
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
                if (!heard && moveRef.current) {
                  // The user went for a workspace with no agent: nothing
                  // more is read meanwhile, the question is asked, and the
                  // answer is waited for again after.
                  waiting.abort();
                  await heardMeanwhile?.catch(() => null);
                  await progress;
                  if (await askMove(voice)) {
                    stopping = true;
                    break;
                  }
                  continue;
                }
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
                const route = await routed(heard);
                if (route === "left") {
                  stopping = true;
                  break;
                }
                if (route === "nobody") {
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
                !moveRef.current &&
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
        release();
        moveRef.current = null;
        // Said yes to a workspace with no agent: moved there, voice off.
        moving.to?.move();
      }
    },
    [hold, onError, onSend, waitForReply],
  );

  /** Picks up a voice chat another pane routed here, sending its words. */
  const takeOver = useCallback(
    (message: string | null) => {
      if (controllerRef.current && !controllerRef.current.signal.aborted)
        return;
      voiceTrace(`voice chat handed over${message ? `: ${message}` : ""}`);
      stopSpeaker();
      const controller = new AbortController();
      controllerRef.current = controller;
      holdAudioFocus(controller.signal);
      void run(controller, null, message);
    },
    [run],
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
      setHeld((list) => list.filter((item) => item.said !== said));
      void onSend(voiceMessage(said.text))
        .then(() => {
          if (said.raw) rememberHeardAs(said.text, said.raw);
        })
        .catch((error: Error) => onError(error.message));
    },
    [onError, onSend],
  );
  const dropHeld = useCallback(
    (said: Heard) =>
      setHeld((list) => list.filter((item) => item.said !== said)),
    [],
  );

  const answerMove = useCallback(
    (yes: boolean) => {
      if (moveQuestion) answerMoveQuestion(moveQuestion, yes);
    },
    [moveQuestion],
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
    takeOver,
    /** A move to a workspace with no agent, held until answered. */
    moveQuestion,
    answerMove,
  };
}
