import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { nextSpeechRate } from "../../../shared/speechRate";
import type {
  AgentChatEvent,
  AgentChatVoiceAction,
} from "../../../shared/agentChat";
import { messageUuid } from "../agentChat";
import { askRanger } from "../assistant";
import { askReviewsAgent } from "../mrReviewsAgent";
import type { HistoryEntry } from "./agentHistory";
import { agentStateKind } from "./agentSession";
import {
  getSpeechRate,
  getVoiceReader,
  getVoiceSurprise,
  saveVoiceSurprise,
  subscribeVoiceReader,
  subscribeVoiceSurprise,
  type Heard,
  VoiceLink,
  parkVoiceLink,
  playReconnectCue,
  takeParkedVoiceLink,
  holdAudioFocus,
  replyAfter,
  claimSpeaker,
  conversationContext,
  isStopCommand,
  ongoingReading,
  rememberHeardAs,
  replyEntriesAfter,
  rewindCount,
  saveSpeechRate,
  sentences,
  stopSpeaker,
  subscribeSpeechRate,
  voiceMessage,
  voiceFronting,
  voiceFrontMode,
  voiceRouting,
  voiceTiming,
  voiceTrace,
  speakStream,
  parseVoiceMessage,
} from "../voiceChat";
import {
  ackSpeech,
  canListen,
  engineVoice,
  prepareReading,
  speak,
  useSpeechEngine,
} from "../speechEngine";
import {
  getSpeechPreferences,
  updateSpeechPreferences,
  useSpeechPreferences,
} from "../speechPreferences";
import { readAssistantState } from "../assistant";
import { forgeStore } from "../forgeStore";
import { ackLanguage, startTurnAck, type TurnAck } from "../voiceAck";
import { createVoiceActions } from "../voiceActions";
import {
  companionName,
  companionRecent,
  logCompanion,
  setCompanionTarget,
  setCompanionTeller,
  updateCompanionJob,
} from "../companionCall";
import {
  followCompanionTool,
  followCompanionWeb,
  toolAck,
  webAck,
} from "../companionWeb";
import {
  answerDelivery,
  answersContext,
  askCompanionAgent,
  companionRouteAction,
  sessionLabel,
  answerText,
  type FrontMode,
  isReadWholeRequest,
  isDismissRequest,
  matchAnswer,
  modeRequest,
  noteAgentAnswer,
  type QuestionAnswer,
  relayText,
  type VoiceQuestion,
} from "../voiceCompanion";
import { forgetCompanionLocally } from "../companionMemory";
import { onVoiceEvent, recentVoiceEvents } from "../voiceEvents";
import {
  earlyReplySaid,
  createFrontVoice,
  eventForFront,
  frontContext,
  notForMeSpoken,
  type SkippedWords,
  withoutRecovered,
  withNotForAgent,
  withSkipped,
} from "../voiceFront";
import { companionFrontVoice } from "../companionSay";
import { createNotForMeNotice } from "../voiceNotForMe";
import { startTurnNarration, type TurnNarration } from "../voiceNarration";
import {
  type ClaudeTurn,
  createTurnFeed,
  type TurnFeed,
  watchClaudeTurns,
} from "./voiceStream";
import { highlightReading } from "../readingHighlight";
import { markdownToSpeech } from "../markdownToSpeech";
import {
  type CutOutcome,
  createReadingPlace,
  type ReadingCut,
  type ReadingPlace,
  resumeAfter,
} from "../voiceResume";
import {
  handOffVoice,
  parseVoiceSessionId,
  RANGER_VOICE_SESSION,
  REVIEWS_VOICE_SESSION,
  errandNoticeText,
  followErrand,
  forwardFailedLine,
  forwardWork,
  plainText,
  type EarlyReply,
  routeSpeech,
  showRouterNote,
  tellVoiceEvent,
  type VoiceResume,
  type VoiceRoute,
  type VoiceSessionInfo,
} from "../voiceRoute";
import {
  answerMoveQuestion,
  claimVoice,
  isMoveYes,
  type MoveQuestion,
} from "../voiceFollow";
import { setVoiceCallPhase } from "../voiceCallReload";
import { checkFrontendFreshness } from "../frontendFreshness";
import { installVoiceFollow } from "../voiceFollowGuard";
import { useAllServerAgentSessions } from "../useAllServerAgentSessions";

/** A reply cut short by speaking up, and where. */
type CutReply = ReadingCut & { text: string; ids: string[] };

/**
 * Conversation mode's stream, when it owns the session: replies are read
 * as they are written, and what is said goes through the bridge's barge-in
 * mix (interrupt a reply being written, steer a turn running tools, "stop"
 * interrupts).
 */
export type VoiceStream = {
  /** Whether conversation mode owns the session now. */
  active: () => boolean;
  /** Whether a turn runs now. */
  busy: () => boolean;
  subscribe: (listener: (event: AgentChatEvent) => void) => () => void;
  send: (
    text: string,
    options: { uuid: string; stop?: boolean },
  ) => Promise<AgentChatVoiceAction>;
};

export type VoiceState =
  | "off"
  | "listening"
  | "transcribing"
  /** The router (or the front) decides who it was said to. */
  | "routing"
  | "waiting"
  | "speaking";

/** How long a reply must stay unchanged, the agent idle, to be complete. */
const REPLY_SETTLED_MS = 1200;
const REPLY_POLL_MS = 300;
const REPLY_TIMEOUT_MS = 30 * 60_000;
/** Something that happened, not told by then, is not told. */
const EVENT_STALE_MS = 2 * 60_000;
/** An agent blocked this long, its question unread, is said to wait. */
const BLOCKED_SAY_MS = 3000;
/** At most one progress message told by the companion in this long. */
const PROGRESS_TOLD_MS = 90_000;
/** How long the answer to "do you still want to move?" is waited for. */
const MOVE_ANSWER_MS = 20_000;

/**
 * How fast a call's replies are read, and a step to the next speed (kept):
 * the server's `speech_rate` with its engine, this browser's rate (Speech
 * settings) with the browser's voices, when they read in calls here.
 */
export function useSpeechRate(onError: (message: string) => void) {
  const browser = useSpeechEngine().callEngine === "browser";
  const serverRate = useSyncExternalStore(subscribeSpeechRate, getSpeechRate);
  const browserRate = useSpeechPreferences().rate;
  const cycle = useCallback(() => {
    if (browser) {
      updateSpeechPreferences({
        rate: nextSpeechRate(getSpeechPreferences().rate),
      });
      return;
    }
    saveSpeechRate(nextSpeechRate(getSpeechRate())).catch((error) =>
      onError(`The reading speed was not kept: ${(error as Error).message}`),
    );
  }, [browser, onError]);
  return { rate: browser ? browserRate : serverRate, cycle };
}

/**
 * Surprise (each reply read by one of the voices at random; null when the
 * server has no voices to pick from) and a toggle (kept), and who reads
 * the sentence playing when the server says.
 */
export function useVoiceSurprise(onError: (message: string) => void) {
  const on = useSyncExternalStore(subscribeVoiceSurprise, getVoiceSurprise);
  const reader = useSyncExternalStore(subscribeVoiceReader, getVoiceReader);
  const toggle = useCallback(() => {
    saveVoiceSurprise(getVoiceSurprise() !== true).catch((error) =>
      onError(`Surprise was not changed: ${(error as Error).message}`),
    );
  }, [onError]);
  return { on, toggle, reader };
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
  stream,
  question,
  answerQuestion,
  companionCall = false,
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
  /** Conversation mode's stream, read when it owns the session. */
  stream?: VoiceStream;
  /**
   * What the agent asks the user now (its permission hook, its terminal's
   * menu), named `agent`: the companion relays it as written.
   */
  question?: (agent: string) => VoiceQuestion | null;
  /** Answers it, with a choice or the words said. */
  answerQuestion?: (
    question: VoiceQuestion,
    answer: QuestionAnswer,
  ) => Promise<boolean>;
  /**
   * A call with the companion itself (companionCall.ts): work said starts
   * as a job on the session (the route's "current", the default, or one
   * named) and its answer comes back through the companion; nothing is
   * sent from here, and the call stays.
   */
  companionCall?: boolean;
}) {
  // Listening needs the server's voice engine; reading uses either.
  const engine = useSpeechEngine();
  const available = engine.listen;
  const speechRate = useSpeechRate(onError);
  const surprise = useVoiceSurprise(onError);
  const [state, setState] = useState<VoiceState>("off");
  // Every connection's sessions, for the router and the front to name
  // (voiceSessions): read while voice is on, whatever the page shows.
  useAllServerAgentSessions(state !== "off");
  const [level, setLevel] = useState(0);
  // What is being said, as the helper hears it.
  const [heard, setHeard] = useState("");
  const heardRef = useRef(heard);
  heardRef.current = heard;
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
  // The last sentence the router took as not for the agent: on the card,
  // not sent, until something else is said.
  const [notSent, setNotSent] = useState<Heard | null>(null);
  // Saying so aloud, at most once in a while.
  const notForMeRef = useRef(createNotForMeNotice());
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
  // While an answer is awaited: the message, and what was read of it.
  const awaitingRef = useRef<(() => VoiceResume) | null>(null);
  // The loop reads the latest history and status, not those it started with.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const statusRef = useRef(agentStatus);
  statusRef.current = agentStatus;
  const routeContextRef = useRef(routeContext);
  routeContextRef.current = routeContext;
  const onSwitchRef = useRef(onSwitch);
  onSwitchRef.current = onSwitch;
  const streamRef = useRef(stream);
  streamRef.current = stream;
  const questionRef = useRef(question);
  questionRef.current = question;
  const answerQuestionRef = useRef(answerQuestion);
  answerQuestionRef.current = answerQuestion;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  /** Who the call talks to, as said aloud. */
  const agentName = useCallback(() => {
    const context = routeContextRef.current?.();
    if (!context) return "The agent";
    if (context.current === RANGER_VOICE_SESSION) return "Ranger";
    const session = context.sessions.find(
      (entry) => entry.id === context.current,
    );
    return (
      session?.workspace || session?.title || session?.agent || "The agent"
    );
  }, []);
  // What the companion does (voiceActions.ts): what a phone's assistant
  // could do too.
  const actions = useMemo(
    () =>
      createVoiceActions({
        sessions: () => routeContextRef.current?.().sessions ?? [],
        current: () => routeContextRef.current?.().current ?? "",
        send: (words) => onSendRef.current(words),
        moveTo: (session, words) => {
          const target = parseVoiceSessionId(session);
          if (!target) return;
          handOffVoice({ ...target, message: words });
          onSwitchRef.current?.(target.connectionId, target.paneId);
        },
        question: () => questionRef.current?.(agentName()) ?? null,
        answer: async (asked, answer) =>
          (await answerQuestionRef.current?.(asked, answer)) ?? false,
      }),
    [agentName],
  );

  // The voice link of the voice chat running, for keeping what it is
  // listening to when the chat is rebuilt.
  const linkRef = useRef<VoiceLink | null>(null);
  useEffect(
    () => () => {
      if (controllerRef.current) {
        // Rebuilt for the same pane (a reconnect of the page's connection
        // does it): the listening goes on, for the chat built next.
        const key = voiceKeyRef.current;
        const link = linkRef.current;
        if (key && link)
          parkVoiceLink(`${key.connectionId}/${key.paneId}`, link);
        voiceTrace("voice chat ends: unmounted");
      }
      controllerRef.current?.abort();
    },
    [],
  );

  const waitForReply = useCallback(
    async (
      sent: string,
      signal: AbortSignal,
      /** Whether a blocked agent ends the wait; else it is still at work. */
      blockedEnds: () => boolean = () => true,
    ): Promise<{ text: string; ids: string[] } | "blocked" | null> => {
      const started = performance.now();
      // A rewind meanwhile may have taken the message and its answer.
      const rewound = rewindCount();
      let reply: string | null = null;
      let settledSince = 0;
      let awaitingTrace = "";
      while (
        !signal.aborted &&
        performance.now() - started < REPLY_TIMEOUT_MS
      ) {
        await new Promise((resolve) => setTimeout(resolve, REPLY_POLL_MS));
        if (rewindCount() !== rewound) {
          voiceTrace("a rewind: the answer awaited is not read");
          return null;
        }
        const kind = agentStateKind(statusRef.current);
        if (kind === "blocked") {
          if (blockedEnds()) return "blocked";
          // Its question is relayed apart: its answer is still to come.
          settledSince = performance.now();
          continue;
        }
        const latest = replyAfter(entriesRef.current, sent);
        // The agent may show working after its answer, for a task left
        // running in the background: the turn's end says it is over.
        const replies = replyEntriesAfter(entriesRef.current, sent);
        const ended =
          replies.length > 0 &&
          replies[replies.length - 1]!.turn_end === true &&
          entriesRef.current[entriesRef.current.length - 1] ===
            replies[replies.length - 1];
        const seen = `agent ${kind}, ${replies.length} replies, turn ended ${ended}, last entry ${entriesRef.current[entriesRef.current.length - 1]?.kind ?? "none"}`;
        if (seen !== awaitingTrace) {
          awaitingTrace = seen;
          voiceTrace(`awaiting the answer: ${seen}`);
        }
        if (latest !== reply || (kind === "working" && !ended)) {
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
      resumed: VoiceResume | null = null,
    ) => {
      const { signal } = controller;
      installVoiceFollow();
      moveRef.current = null;
      askRef.current = new AbortController();
      // The one voice chat running: another starting, or the user moving
      // to another workspace's agent, ends this one at once.
      // Over at once when it goes to another pane: nothing of it is left
      // for this pane to pick up again (a reconnect's resume).
      const leave = () => {
        if (signal.aborted) return;
        voiceTrace("voice chat ends: it moved to another pane");
        controller.abort();
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setState("off");
          setLevel(0);
        }
      };
      const key = voiceKeyRef.current;
      const release = key
        ? claimVoice({
            ...key,
            handAway: leave,
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
      // This pane's voice chat, shown again: its answer is awaited again,
      // nothing sent.
      let resuming = resumed;
      // What was said when the router asked which session: what to send
      // once the answer names one.
      let asked: string | null = null;
      // What the front routed to nobody lately: sent with each turn, so
      // "c'était pour toi" has it routed after all (recovered).
      let skipped: SkippedWords[] = [];
      // Skipped words the front routed to this agent after all: sent in
      // place of what was just said.
      let recoveredSend: string | null = null;
      const wordsToSend = (text: string) => {
        const recovered = recoveredSend;
        recoveredSend = null;
        return recovered ?? text;
      };
      /**
       * Who what was said is for, by the router when the server has one:
       * this agent ("here"), nobody ("held": shown, not sent), nothing to
       * send ("nobody": the router's question asked, an errand), or another
       * session, which now has the voice chat ("left").
       */
      // The front (voiceFront.ts): it says at once what it does with what
      // was said, or answers it. Off, voice chat goes as it always did.
      const made = voiceFronting()
        ? createFrontVoice(ackSpeech, claimSpeaker)
        : null;
      // A call with the companion: what it says shows in its strip, a
      // sentence at a time, and in its conversation view, not in a bar over
      // the chat (companionSay.ts).
      const front = made && companionCall ? companionFrontVoice(made) : made;
      /** Words not for the agent, kept for the front to bring back. */
      const skipNotForAgent = (heard: Heard) => {
        skipped = withNotForAgent(skipped, heard, !!front);
      };
      const note = (
        text: string | null,
        from?: string,
        open?: Parameters<typeof showRouterNote>[2],
      ) => {
        if (!companionCall) showRouterNote(text, from, open);
      };
      signal.addEventListener("abort", () => front?.hush(), { once: true });
      // Said aloud on this call: answers read whole, or told; the setting
      // otherwise.
      let callMode: FrontMode | null = null;
      // Which build runs: a page left open across a deploy runs the old one.
      voiceTrace(
        `voice chat starts: ${companionCall ? "companion call, " : ""}${front ? `front, answers ${voiceFrontMode() ?? "relay"}` : "no front"}, build ${
          document
            .querySelector<HTMLScriptElement>(
              'script[type="module"][src*="/assets/index-"]',
            )
            ?.src.replace(/^.*\/assets\//, "") ?? "dev"
        }`,
      );
      /** Whether answers go to the companion rather than being read. */
      const companion = () =>
        front !== null &&
        answerDelivery(callMode ?? voiceFrontMode()) === "tell";
      /** What the companion is to say, once the user is not talking. */
      type Telling = {
        text: string;
        at: number;
        kind: "event" | "answer" | "progress";
        agent?: string;
        /** Said as written (an agent's question), not told by the front. */
        verbatim?: boolean;
        /** An event's session (`<connection>/<pane>`) and its turn. */
        pane?: string;
        turnMs?: number;
        looking?: boolean;
      };
      let tellFront: (item: Telling) => void = () => {};
      /** An agent's answer: kept, and given to the companion to tell. */
      const tellAnswer = (text: string, ids: string[], agent = agentName()) => {
        const clean = answerText(text);
        if (!clean) {
          voiceTrace(`companion: ${agent}'s turn ended with no text to tell`);
          return;
        }
        noteAgentAnswer({
          agent,
          text: clean,
          ids,
          session: routeContextRef.current?.().current,
        });
        // Every answer read whole on this call: the companion reads it.
        if (!companion()) {
          if (front) {
            voiceTrace(`companion: reads ${agent}'s answer whole`);
            void front.say(`${agent} : ${markdownToSpeech(clean)}`, signal, {
              answer: { agent, ids },
            });
          }
          return;
        }
        voiceTrace(
          `companion: answer captured from ${agent} (${clean.length} chars): ${clean.slice(0, 80)}`,
        );
        tellFront({ text: clean, at: Date.now(), kind: "answer", agent });
      };
      // The agent's question the companion relayed, answered by voice.
      let relayed: VoiceQuestion | null = null;
      // Sessions given work on this call, whose answer comes back as such:
      // their "done" notification is not told apart.
      const working = new Map<string, number>();
      /** Reads an agent's answer kept on the call, word for word. */
      const readAnswer = (agent: string | undefined, said: string) => {
        if (!front) return;
        const answer = actions.lastAnswer(agent);
        const french = ackLanguage(said) === "fr";
        if (!answer) {
          void front.say(
            french
              ? "Je n'ai pas encore de réponse à lire."
              : "There is no answer to read yet.",
            signal,
          );
          return;
        }
        note(answer.text, answer.agent);
        void front.say(
          `${answer.agent}: ${markdownToSpeech(answer.text)}`,
          signal,
          { answer: { agent: answer.agent, ids: answer.ids } },
        );
      };
      const switchMode = (mode: FrontMode, said: string, reply?: string) => {
        if (!front) return;
        callMode = mode;
        const french = ackLanguage(said) === "fr";
        const line =
          reply ||
          (mode === "relay"
            ? french
              ? "D'accord, je lis tout à partir de maintenant."
              : "Okay, I'll read everything from now on."
            : french
              ? "D'accord, je te dis l'essentiel."
              : "Okay, I'll just tell you what matters.");
        voiceTrace(`answers on this call: ${mode}`);
        note(line);
        void front.say(line, signal);
      };
      // What the front said it does with words routed "here": the turn's
      // first words, said at once.
      let opening: { text: string } | null = null;
      const takeOpening = (): { opening?: string } => {
        const taken = opening;
        opening = null;
        return taken ? { opening: taken.text } : {};
      };
      // Words sent while a turn's acks are over: its opening is said now.
      const sayOpening = () => {
        const taken = opening;
        opening = null;
        if (front && taken) void front.say(taken.text, signal);
      };
      /** Roamgate's state beyond the sessions, for the front. */
      const stateForFront = () =>
        frontContext({
          tasks: readAssistantState().snapshot?.tasks ?? [],
          requests: forgeStore.known(),
          events: recentVoiceEvents(),
          answers: [
            companionCall
              ? `You are on a call with the user, as ${companionName()}; "Current" is ${
                  routeContextRef.current?.().current
                    ? sessionLabel(
                        routeContextRef.current().current,
                        routeContextRef.current().sessions,
                      )
                    : "no session yet"
                }.`
              : "",
            answersContext(),
          ]
            .filter(Boolean)
            .join("\n\n"),
        });
      const routed = async (
        heard: Heard,
      ): Promise<"here" | "held" | "nobody" | "left"> => {
        const context = routeContextRef.current?.();
        if (!context || !voiceRouting()) return "here";
        // The call so far, before these words: what they may lean on.
        const recent = companionCall ? companionRecent() : "";
        if (companionCall) logCompanion({ kind: "heard", text: heard.text });
        if (front) {
          // The answer to the question relayed: to its agent, as said.
          // "Dismiss it" also puts away a question not relayed yet.
          const pending = actions.pendingQuestion();
          const asked =
            relayed ??
            (pending && isDismissRequest(heard.text) ? pending : null);
          if (asked && pending?.key === asked.key) {
            const answer = matchAnswer(heard.text, asked);
            if (answer) {
              setNotSent(null);
              setHeard("");
              // Words of the user's own go marked as said, like any other;
              // a choice goes as its label.
              const done = await actions.answerQuestion(
                asked,
                "words" in answer
                  ? { words: voiceMessage(answer.words, interruptedAt) }
                  : answer,
              );
              interruptedAt = null;
              relayed = null;
              const french = ackLanguage(heard.text) === "fr";
              const label =
                "option" in answer
                  ? asked.options[answer.option]!.label
                  : "words" in answer
                    ? answer.words
                    : "";
              void front.say(
                done && "dismiss" in answer
                  ? french
                    ? "Question laissée de côté, sans réponse."
                    : "Dismissed, without an answer."
                  : done
                    ? french
                      ? `C'est noté : ${label}.`
                      : `Answered: ${label}.`
                    : french
                      ? "La réponse n'est pas passée, réponds à l'écran."
                      : "That answer did not go through; answer on the screen.",
                signal,
              );
              return "nobody";
            }
          }
          const mode = modeRequest(heard.text);
          if (mode) {
            setHeard("");
            switchMode(mode, heard.text);
            return "nobody";
          }
          if (isReadWholeRequest(heard.text)) {
            setHeard("");
            readAnswer(undefined, heard.text);
            return "nobody";
          }
        }
        setNotSent(null);
        setState("routing");
        opening = null;
        recoveredSend = null;
        const routeAt = performance.now();
        // Once per turn: when its first words were heard, from the route.
        let timingTold = false;
        const reportTiming = (how: string) => {
          if (timingTold) return;
          timingTold = true;
          voiceTiming({
            how,
            route_ms: Math.round(performance.now() - routeAt),
            ...(earlyAt === null
              ? {}
              : { early_ms: Math.round(earlyAt - routeAt) }),
            chars: heard.text.length,
          });
        };
        // The front's words, said as soon as it has written them: the
        // turn's first answer, before its route is decided.
        let earlySaid: string | null = null;
        let earlyAt: number | null = null;
        const onEarly = front
          ? (early: EarlyReply) => {
              if (earlySaid !== null) return;
              if (!earlyReplySaid(early.to, companionCall)) return;
              earlySaid = early.reply;
              earlyAt = performance.now();
              voiceTrace(
                `the front said first (${Math.round(earlyAt - routeAt)} ms): ${early.reply}`,
              );
              note(early.reply);
              void front.say(early.reply, signal, {
                onSentence: (index) => {
                  if (index === 0) reportTiming("early");
                },
              });
            }
          : undefined;
        const asking = routeSpeech(
          heard.text,
          context.current,
          context.sessions,
          front ? stateForFront() : undefined,
          { interruptedAt, ...(heard.voice ? { voice: heard.voice } : {}) },
          recent || undefined,
          onEarly,
          front && skipped.length ? skipped : undefined,
        );
        // Only the front's own words are said: slow, it is waited for in
        // silence; failing, the words go to the agent on screen.
        const route: VoiceRoute = await asking;
        voiceTrace(`routed ${JSON.stringify(route)}: ${heard.text}`);
        if (route.recovered) {
          voiceTrace(`the front took back what it skipped: ${route.recovered}`);
          skipped = withoutRecovered(skipped, route.recovered);
          setNotSent(null);
        }
        // Said already, as soon as it was written: not again.
        const reply =
          front && route.reply && route.reply !== earlySaid
            ? route.reply
            : null;
        if (earlySaid === null && !reply) reportTiming("routed");
        /** The front's words for this turn, noted and said. */
        const sayReply = (text: string) => {
          if (!front) return;
          note(text);
          void front.say(text, signal, {
            onSentence: (index) => {
              if (index === 0) reportTiming("reply");
            },
          });
        };
        const words = route.recovered ?? asked ?? heard.text;
        asked = null;
        if (companionCall && front) {
          const action = companionRouteAction(route, context.current);
          if (!action && route.to === "current") {
            const line =
              ackLanguage(heard.text) === "fr"
                ? "Je n'ai pas de session où lancer ça : dis-moi laquelle."
                : "I have no session to start that on: tell me which one.";
            note(line);
            void front.say(line, signal);
            return "nobody";
          }
          if (action) {
            const label = sessionLabel(action.pane, context.sessions);
            setCompanionTarget(action.pane);
            if (reply) sayReply(reply);
            if (action.kind === "show") {
              const target = parseVoiceSessionId(action.pane);
              if (target)
                onSwitchRef.current?.(target.connectionId, target.paneId);
              return "nobody";
            }
            // The words said, only the session they addressed dropped.
            const given = route.words?.trim() || words;
            const logged = logCompanion({
              kind: "job",
              session: action.pane,
              label,
              words: given,
              ...(given !== words ? { said: words } : {}),
              ...(route.context ? { context: route.context } : {}),
              status: "running",
            });
            // Marked as said, as voice chat sends it: the session knows the
            // user talks live, where the reading was cut, and what the
            // words refer to on the call.
            const started = await forwardWork(action.pane, given, {
              interruptedAt,
              context: route.context,
            });
            interruptedAt = null;
            const job = started?.job ?? null;
            voiceTrace(
              `companion: job ${job ?? "not started"} on ${action.pane} (${label}): ${given}`,
            );
            if (!job) {
              updateCompanionJob(logged, { status: "not started" });
              const line = forwardFailedLine(
                label,
                ackLanguage(heard.text) === "fr",
              );
              note(line);
              void front.say(line, signal);
              return "nobody";
            }
            const target = parseVoiceSessionId(action.pane);
            note(`${label}: ${given}`, companionName(), target ?? undefined);
            working.set(action.pane, (working.get(action.pane) ?? 0) + 1);
            void followErrand(job, (state) => {
              if (state.notice)
                tellFront({
                  text: errandNoticeText(label, state.notice),
                  at: Date.now(),
                  kind: "event",
                });
            }).then((answer) => {
              const left = (working.get(action.pane) ?? 1) - 1;
              if (left > 0) working.set(action.pane, left);
              else working.delete(action.pane);
              if (signal.aborted) return;
              voiceTrace(
                `companion: job ${job} on ${label} ${answer ? "answered" : "gave no answer"}`,
              );
              updateCompanionJob(
                logged,
                answer
                  ? { status: "answered", answer: plainText(answer) }
                  : { status: "no answer" },
              );
              if (answer) tellAnswer(plainText(answer), [], label);
              else
                tellFront({
                  text: `${label} gave no answer to: ${given}`,
                  at: Date.now(),
                  kind: "event",
                });
            });
            return "nobody";
          }
        }
        switch (route.to) {
          case "current":
            if (front) opening = reply ? { text: reply } : null;
            recoveredSend = route.recovered ?? null;
            return "here";
          case "read":
            if (!front) return "here";
            readAnswer(route.agent, heard.text);
            return "nobody";
          case "reset":
            // Forgotten on the server already; said, then forgotten here.
            if (!front) return "here";
            if (reply) sayReply(reply);
            forgetCompanionLocally();
            return "nobody";
          case "mode":
            if (!front) return "here";
            switchMode(route.mode, heard.text, reply ?? undefined);
            return "nobody";
          case "self":
            // The front answered it (said already, maybe): nothing is sent.
            if (!front || !(reply || earlySaid)) return "here";
            if (reply) sayReply(reply);
            return "nobody";
          case "nobody": {
            hold(heard);
            setNotSent(heard);
            setHeard("");
            // With a front, silence: the card shows it, and the front keeps
            // it in mind should the user say it was for it.
            if (front)
              skipped = withSkipped(
                skipped,
                heard.text,
                undefined,
                heard.voiceLabel,
              );
            // Said briefly by the router alone, so it does not look like the
            // voice went unheard.
            const line = notForMeSpoken(front !== null)
              ? notForMeRef.current.next(heard.text)
              : null;
            if (line) {
              voiceTrace(`said it was not for the agent: ${line.text}`);
              await ackSpeech
                .fetchAudio(line.text, line.language, signal)
                .then((audio) => ackSpeech.playAudio(audio, signal))
                .catch(() => {});
            }
            return "held";
          }
          case "ask":
            asked = words;
            note(route.question);
            await speak(route.question, signal).catch(() => {});
            return "nobody";
          case "errand": {
            const name = route.say || "the errands session";
            if (!route.job) return "nobody";
            // Its note carried the sentence cut off (routeSpeech).
            interruptedAt = null;
            note(`Asked ${name}: ${words}`);
            if (front && reply) void front.say(reply, signal);
            // Its answer comes when it comes: voice chat goes on meanwhile.
            void followErrand(route.job, (state) =>
              note(
                state.notice
                  ? `${errandNoticeText(name, state.notice)}.`
                  : `Asked ${name}: ${words}`,
              ),
            ).then((answer) => {
              const said = answer ?? `${name} gave no answer.`;
              // The answer is read; the card points at the session it is in.
              const session = parseVoiceSessionId(route.pane);
              note(
                answer ? `${name} answered.` : said,
                "Roamgate",
                session ?? undefined,
              );
              if (signal.aborted) return;
              if (answer && companion())
                tellAnswer(plainText(answer), [], name);
              else void speak(plainText(said), signal).catch(() => {});
            });
            return "nobody";
          }
          case "web": {
            // Looked up in the background: said at once, its result told
            // when it comes (tellFront through the companion's teller).
            if (!front) return "nobody";
            const line = webAck(route.reply, heard.text);
            if (line !== earlySaid) sayReply(line);
            if (route.job)
              void followCompanionWeb(route.job, route.query || words);
            return "nobody";
          }
          case "tool": {
            // Done in the background with the companion's MCP tools: said
            // at once, its result told when it comes, as a web search's.
            if (!front) return "nobody";
            const line = toolAck(route.reply, heard.text);
            if (line !== earlySaid) sayReply(line);
            if (route.job)
              void followCompanionTool(route.job, route.task || words);
            return "nobody";
          }
          case "ranger": {
            // Ranger's own chat: a question for Ranger is for it.
            if (context.current === RANGER_VOICE_SESSION) return "here";
            note(`Asked Ranger: ${words}`, "Ranger");
            const cut = interruptedAt;
            interruptedAt = null;
            if (front && reply) void front.say(reply, signal);
            // Ranger answers when it has read what it needs: voice chat
            // goes on meanwhile, and its answer is read when it comes.
            const toRanger = () =>
              askRanger(voiceMessage(words, cut, route.context));
            voiceTrace(`asking Ranger: ${words}`);
            // On a call with the companion, shown in its conversation as
            // work given to a session is, and in the front's recent context.
            void (
              companionCall
                ? askCompanionAgent(
                    RANGER_VOICE_SESSION,
                    words,
                    toRanger,
                    route.context,
                  )
                : toRanger()
            ).then(
              (answer) => {
                voiceTrace("Ranger answered");
                // The answer is read; the card points at Ranger's chat.
                note("Ranger answered.", "Ranger", { ranger: true });
                if (signal.aborted) return;
                if (companion()) tellAnswer(plainText(answer), [], "Ranger");
                else void speak(plainText(answer), signal).catch(() => {});
              },
              (error: Error) => {
                voiceTrace(`Ranger was not asked: ${error.message}`);
                note(error.message, "Ranger");
                if (!signal.aborted)
                  void speak(error.message, signal).catch(() => {});
              },
            );
            return "nobody";
          }
          case "reviews": {
            // Its own chat: a question for it is for the one on screen.
            if (context.current === REVIEWS_VOICE_SESSION) return "here";
            // The reviews agent answers in its chat, in Reviews; voice
            // chat goes on meanwhile and its answer is read when it comes.
            note(`Asked the reviews agent: ${words}`, "Reviews");
            if (front && reply) void front.say(reply, signal);
            // Marked as said, as in its own chat by voice.
            const cutReviews = interruptedAt;
            interruptedAt = null;
            const toReviews = () =>
              askReviewsAgent(voiceMessage(words, cutReviews, route.context));
            voiceTrace(`asking the reviews agent: ${words}`);
            void (
              companionCall
                ? askCompanionAgent(
                    REVIEWS_VOICE_SESSION,
                    words,
                    toReviews,
                    route.context,
                  )
                : toReviews()
            ).then(
              (answer) => {
                note("The reviews agent answered.", "Reviews", {
                  reviews: true,
                });
                if (signal.aborted) return;
                if (companion()) tellAnswer(plainText(answer), [], "Reviews");
                else void speak(plainText(answer), signal).catch(() => {});
              },
              (error: Error) => {
                note(error.message, "Reviews");
                if (!signal.aborted)
                  void speak(error.message, signal).catch(() => {});
              },
            );
            return "nobody";
          }
          default: {
            const target = parseVoiceSessionId(route.pane);
            if (!target) return "here";
            if (route.pane === context.current) {
              if (route.to === "send" && front)
                opening = reply ? { text: reply } : null;
              if (route.to === "send") recoveredSend = route.recovered ?? null;
              return route.to === "send" ? "here" : "nobody";
            }
            const switched =
              reply || `Switched to ${route.say || "that session"}.`;
            note(switched);
            await speak(switched, signal).catch(() => {});
            handOffVoice({
              ...target,
              message: route.to === "send" ? words : null,
            });
            leave();
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
      let next = null as Promise<Heard | null> | null;
      // The sentence being read when the speaker cut in.
      let interruptedAt: string | null = null;
      // A reply cut short by speaking up: read on from there when nothing
      // is sent.
      let cutReply: CutReply | null = null;
      // The few words saying a message was heard, while its answer is slow.
      let turnAck: TurnAck | null = null;
      // Conversation mode: the turn being read, and a turn Claude started
      // by itself (a subagent's report or a task ending came) waiting to be
      // read. Those are read too, as long as voice chat is on.
      let currentFeed: TurnFeed | null = null;
      let claudeTurn: ClaudeTurn | null = null;
      let onClaudeTurn: (() => void) | null = null;
      let watched: VoiceStream | null = null;
      let unwatch: (() => void) | null = null;
      const dropClaudeTurn = () => {
        claudeTurn?.unsubscribe();
        claudeTurn = null;
      };
      const watchStream = () => {
        const live = streamRef.current?.active() ? streamRef.current : null;
        if (live === watched) return;
        unwatch?.();
        dropClaudeTurn();
        watched = live;
        unwatch = live
          ? watchClaudeTurns(
              live.subscribe,
              () =>
                currentFeed && !currentFeed.ended()
                  ? currentFeed
                  : (claudeTurn?.feed ?? null),
              (turn) => {
                dropClaudeTurn();
                claudeTurn = turn;
                voiceTrace("Claude started a turn by itself: reading it");
                onClaudeTurn?.();
                // Muted, voice still reads.
                unmutedRef.current?.();
              },
            )
          : null;
      };
      signal.addEventListener(
        "abort",
        () => {
          unwatch?.();
          dropClaudeTurn();
        },
        { once: true },
      );
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
      // What happened elsewhere (an agent done or waiting, a Ranger task
      // run): the front tells what is worth it, never over the user nor
      // over what is read.
      if (front) {
        const told: Telling[] = [];
        let telling = false;
        const quiet = () =>
          (stateRef.current === "listening" ||
            stateRef.current === "waiting") &&
          !heardRef.current &&
          !front.playing();
        const tell = async () => {
          if (telling) return;
          telling = true;
          try {
            while (told.length && !signal.aborted) {
              if (!quiet()) {
                await pause(1000);
                // Old news by then; an answer or a question is never lost.
                const first = told[0]!;
                if (
                  !first.verbatim &&
                  first.kind !== "answer" &&
                  Date.now() - first.at > EVENT_STALE_MS
                )
                  told.shift();
                continue;
              }
              const item = told.shift()!;
              if (item.verbatim) {
                voiceTrace(`companion: relays as written: ${item.text}`);
                note(item.text, item.agent);
                await front.say(item.text, signal);
                voiceTrace("companion: relayed");
                continue;
              }
              const context = routeContextRef.current?.();
              const started = performance.now();
              voiceTrace(
                `companion: ${item.kind} of ${item.agent ?? "Roamgate"} sent to the front`,
              );
              const reply = await tellVoiceEvent(
                item.text,
                context?.current ?? "",
                context?.sessions ?? [],
                stateForFront(),
                {
                  kind: item.kind,
                  ...(item.agent ? { agent: item.agent } : {}),
                  ...(item.pane
                    ? {
                        pane: item.pane,
                        ...(item.turnMs !== undefined
                          ? { turn_ms: item.turnMs }
                          : {}),
                        looking: item.looking === true,
                      }
                    : {}),
                },
              );
              voiceTrace(
                `companion: the front's reply to the ${item.kind} in ${Math.round(performance.now() - started)} ms: ${JSON.stringify(reply)}`,
              );
              if (!reply || signal.aborted) continue;
              // An answer is told once the user is not talking, however
              // long that takes; an event only if nothing else goes on.
              if (item.kind === "answer")
                while (!quiet() && !signal.aborted) await pause(500);
              else if (!quiet()) {
                voiceTrace("companion: not said, the user is busy");
                continue;
              }
              if (signal.aborted) continue;
              note(reply);
              voiceTrace(`companion: says: ${reply}`);
              await front.say(reply, signal);
              voiceTrace("companion: said (or stopped by speaking up)");
            }
          } finally {
            telling = false;
          }
        };
        tellFront = (item) => {
          // An agent's question goes before what waits.
          if (item.verbatim && item.kind === "event") told.unshift(item);
          else told.push(item);
          void tell();
        };
        // A web search's result, said as it was written for the voice
        // (server voice-research.ts), once the user is not talking. It is
        // web data: told, never routed.
        signal.addEventListener(
          "abort",
          setCompanionTeller((text) =>
            tellFront({
              text,
              at: Date.now(),
              kind: "answer",
              agent: "Web",
              verbatim: true,
            }),
          ),
          { once: true },
        );
        const stopTelling = onVoiceEvent((event) => {
          if (!eventForFront(event, voiceKeyRef.current)) return;
          // A session given work on this call: its answer is told instead.
          if (
            event.paneId &&
            [...working.keys()].some((pane) =>
              pane.endsWith(`/${event.paneId}`),
            )
          )
            return;
          tellFront({
            text: event.text,
            at: event.at,
            kind: "event",
            ...(event.connectionId && event.paneId
              ? {
                  pane: `${event.connectionId}/${event.paneId}`,
                  ...(event.turnMs !== undefined
                    ? { turnMs: event.turnMs }
                    : {}),
                  looking: event.looking === true,
                }
              : {}),
          });
        });
        signal.addEventListener("abort", stopTelling, { once: true });
        // The agent's questions, relayed as written as soon as they come;
        // one the page cannot read is said to wait on the screen.
        void (async () => {
          let blockedSince = 0;
          let saidBlocked = false;
          while (!signal.aborted) {
            await pause(REPLY_POLL_MS);
            if (!companion()) continue;
            const asked = actions.pendingQuestion();
            const blocked = agentStateKind(statusRef.current) === "blocked";
            if (!blocked && !asked) {
              blockedSince = 0;
              saidBlocked = false;
              relayed = null;
              continue;
            }
            if (asked) {
              if (relayed?.key === asked.key) continue;
              relayed = asked;
              saidBlocked = true;
              tellFront({
                text: relayText(asked),
                at: Date.now(),
                kind: "event",
                agent: asked.agent,
                verbatim: true,
              });
              continue;
            }
            blockedSince ||= Date.now();
            if (!saidBlocked && Date.now() - blockedSince > BLOCKED_SAY_MS) {
              saidBlocked = true;
              tellFront({
                text: `${agentName()} is asking something; answer it on the screen.`,
                at: Date.now(),
                kind: "event",
                verbatim: true,
              });
            }
          }
        })();
      }
      // Only the person ends voice chat: a lost connection or a failing
      // helper is retried, more slowly each time, and said once.
      let failures = 0;
      // Listening stops with the chat, when muted, or for a move question.
      const listening = () => {
        const mute = new AbortController();
        muteAbortRef.current = mute;
        return AbortSignal.any([signal, mute.signal, askRef.current.signal]);
      };
      /**
       * Conversation mode: sends `first`, reads the answer as it is written
       * and listens meanwhile. Speaking up stops the reading and goes to the
       * bridge, which interrupts a reply being written, steers a turn running
       * tools, or sends it once the turn is over; "stop" interrupts while a
       * turn runs, and ends voice chat otherwise, as it always did.
       */
      const streamedTurns = async (
        live: VoiceStream,
        voice: VoiceLink,
        first: string | null,
        own: ClaudeTurn | null = null,
      ): Promise<"listen" | "stop"> => {
        let text: string | null = first;
        let stopTurn = false;
        let deaf = false;
        // A turn Claude started: read, nothing sent.
        let ownTurn = own;
        while (!signal.aborted && (text !== null || stopTurn || ownTurn)) {
          const uuid = messageUuid();
          const sentText = text;
          const reads = ownTurn;
          ownTurn = null;
          // Something said now: a turn Claude started meanwhile is not read.
          if (!reads) dropClaudeTurn();
          const feed =
            reads?.feed ??
            createTurnFeed(sentText === null ? {} : { uuid, text: sentText });
          const unsubscribe = reads?.unsubscribe ?? live.subscribe(feed.handle);
          currentFeed = feed;
          awaitingRef.current = () => ({
            sent: sentText ?? first ?? "",
            read: [],
          });
          // Stopped by speaking up or a tap; a new one when the reading
          // goes on after speech that came to nothing.
          let reading = new AbortController();
          claimSpeaker(reading);
          // Where the reading is, and where speaking up cut it.
          let place = createReadingPlace();
          let cut: ReadingCut | null = null;
          let current: string | null = null;
          // A sentence is playing: only a louder voice counts then.
          let sounding = false;
          // A message said, its answer slow to start: a few words say it
          // was heard. Not for a turn Claude started, nor a stop.
          const acked =
            reads || stopTurn || sentText === null ? null : sentText;
          // While it works, now and then what it does ("Running a command:
          // ..."), from its tool calls; an update counts as something said
          // for the ack's "still working".
          let narration: TurnNarration | null = null;
          const ack =
            acked === null
              ? null
              : startTurnAck({
                  said: parseVoiceMessage(acked).text,
                  // Stopped with the reading: talked over, or another one.
                  signal: AbortSignal.any([reading.signal, signal]),
                  started: () => sounding || feed.ids().length > 0,
                  busy: () =>
                    sounding ||
                    stateRef.current !== "waiting" ||
                    !!narration?.playing(),
                  working: () => live.busy(),
                  speech: ackSpeech,
                  fronted: front !== null,
                  ...takeOpening(),
                });
          narration =
            acked === null
              ? null
              : startTurnNarration({
                  said: parseVoiceMessage(acked).text,
                  signal: AbortSignal.any([reading.signal, signal]),
                  busy: () =>
                    sounding ||
                    stateRef.current !== "waiting" ||
                    !!ack?.playing(),
                  speech: ackSpeech,
                  onSpoken: () => ack?.activity(),
                });
          const narrated = narration;
          // Tool calls before the message's replay belong to the turn before.
          const unsubscribeNarration = narrated
            ? live.subscribe((event) => {
                if (feed.started()) narrated.handle(event);
              })
            : null;
          const stopReading = () => {
            if (reading.signal.aborted) return;
            if (sounding) interruptedAt = current;
            voiceTrace(`streamed reading stopped at: ${current}`);
            sounding = false;
            reading.abort();
          };
          interruptRef.current = () => {
            stopReading();
            setState("listening");
          };
          setState("waiting");
          const startSpeaking = (source: AsyncIterable<string>, skip: number) =>
            speakStream(
              source,
              AbortSignal.any([reading.signal, signal]),
              (sentence) => {
                place.sentence(sentence);
                sounding = sentence !== null;
                if (sentence) {
                  ack?.activity();
                  narration?.activity();
                  current = sentence;
                  setState("speaking");
                } else if (!signal.aborted && stateRef.current === "speaking")
                  setState("waiting");
                highlightReading(feed.ids(), sentence);
              },
              {
                skip,
                voice: {
                  // An ack or an update playing ends its few words before
                  // the answer; an update still on its way is dropped.
                  prepare: async (text, stop, options) => {
                    ack?.activity();
                    narration?.activity();
                    const speech = await engineVoice.prepare(
                      text,
                      stop,
                      options,
                    );
                    await ack?.quiet();
                    await narration?.quiet();
                    return speech;
                  },
                  play: engineVoice.play,
                  begin: engineVoice.begin,
                },
              },
            ).catch((error) => {
              if (!reading.signal.aborted)
                voiceTrace(`reading failed: ${error}`);
            });
          // A companion is given the whole answer once the turn is over,
          // and tells it; nothing of it is read meanwhile.
          let closedHere = false;
          const telling = companion();
          const collect = async () => {
            await feed.done;
            if (closedHere) return;
            let whole = "";
            for await (const chunk of feed.replay()) whole += chunk;
            tellAnswer(whole, [...feed.ids()]);
          };
          let spoken = telling ? collect() : startSpeaking(feed.text, 0);
          /**
           * Speech that cut the reading came to nothing sent (`outcome`):
           * the reading goes on from the sentence it was cut at, or from
           * its start when none had played. True when it does.
           */
          const readOn = (outcome: CutOutcome): boolean => {
            if (telling) return false;
            const from = resumeAfter(cut, outcome);
            cut = null;
            if (!from || signal.aborted) return false;
            voiceTrace(
              `nothing was sent: streamed reading goes on from: ${from.sentence ?? "the start"}`,
            );
            interruptedAt = null;
            reading = new AbortController();
            claimSpeaker(reading);
            place = createReadingPlace(from.skip);
            setState("waiting");
            spoken = startSpeaking(feed.replay(), from.skip);
            return true;
          };
          text = null;
          try {
            if (stopTurn) {
              stopTurn = false;
              closedHere = true;
              feed.close();
              await live.send("stop", { uuid, stop: true });
              await speak("Stopped.", signal).catch(() => {});
              break;
            }
            if (!reads) {
              const action = await live.send(sentText!, { uuid });
              voiceTrace(`conversation mode took the speech: ${action}`);
              if (action === "steered") feed.start();
              else if (action === "interrupted") {
                closedHere = true;
                feed.close();
              }
            }
            // Listen while the answer comes and is read.
            for (;;) {
              const waiting = new AbortController();
              let speaking = false;
              const finish = new AbortController();
              finishRef.current = finish;
              const heardMeanwhile =
                mutedRef.current || deaf
                  ? null
                  : voice.listen(
                      AbortSignal.any([listening(), waiting.signal]),
                      {
                        finish: finish.signal,
                        holding: () => sounding,
                        onLevel: (value) => {
                          if (!sounding) setLevel(value);
                        },
                        onSpeech: () => {
                          speaking = true;
                          if (!reading.signal.aborted) cut = place.cut();
                          stopReading();
                          setState("listening");
                        },
                        onSpeechEnd: () => setState("transcribing"),
                        onHeard: setHeard,
                        conversation: conversationContext(entriesRef.current),
                      },
                    );
              heardMeanwhile?.catch(() => {});
              let heard: Heard | null = null;
              try {
                const firstDone = await Promise.race([
                  spoken.then(() => "read" as const),
                  ...(heardMeanwhile
                    ? [heardMeanwhile.then(() => "heard" as const)]
                    : []),
                ]);
                // Read to its end with nothing said: listen as usual.
                if (firstDone === "read" && !speaking) return "listen";
                heard = heardMeanwhile ? await heardMeanwhile : null;
              } finally {
                waiting.abort();
                finishRef.current = null;
              }
              setLevel(0);
              if (signal.aborted) return "stop";
              if (!heard) {
                // Muted, or the helper gave up: the answer is still read.
                if (!mutedRef.current) deaf = true;
                readOn("nothing");
                await spoken;
                return "listen";
              }
              if (isStopCommand(heard.raw ?? heard.text)) {
                setHeard("");
                stopReading();
                // A turn running: "stop" stops it, and voice chat goes on.
                if (live.busy()) {
                  stopTurn = true;
                  break;
                }
                await speak("Okay, stopping.", signal);
                return "stop";
              }
              if (!heard.text) {
                setHeard("");
                readOn("noise");
                continue;
              }
              if (heard.forAgent === false) {
                hold(heard);
                skipNotForAgent(heard);
                setHeard("");
                readOn("not-for-agent");
                continue;
              }
              const route = await routed(heard);
              if (route === "left") return "stop";
              if (route === "nobody") {
                cut = null;
                setHeard("");
                continue;
              }
              // Taken as not for the agent: shown, not sent.
              if (route === "held") {
                readOn("not-for-agent");
                continue;
              }
              stopReading();
              text = voiceMessage(wordsToSend(heard.text), interruptedAt);
              interruptedAt = null;
              if (heard.raw) rememberHeardAs(heard.text, heard.raw);
              setHeard("");
              break;
            }
          } finally {
            void ack?.end();
            void narration?.end();
            unsubscribeNarration?.();
            interruptRef.current = null;
            // Cut short (something said, a stop): not an answer to tell.
            if (!feed.ended()) closedHere = true;
            feed.close();
            unsubscribe();
            if (currentFeed === feed) currentFeed = null;
            stopReading();
            await spoken;
            highlightReading([], null);
            awaitingRef.current = null;
          }
        }
        return "listen";
      };
      try {
        const unmuted = async () => {
          while (
            mutedRef.current &&
            !signal.aborted &&
            !claudeTurn &&
            !moveRef.current
          )
            await new Promise<void>((resolve) => {
              unmutedRef.current = resolve;
              signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
        };
        /**
         * Reads a reply aloud from its `skip`th sentence, listening
         * meanwhile: speaking up stops the reading and is the next message
         * (`next`), a tap only stops it.
         */
        const readAloud = async (
          voice: VoiceLink,
          reply: { text: string; ids: string[] },
          skip: number,
        ) => {
          const reading = new AbortController();
          claimSpeaker(reading);
          const stopReading = () => reading.abort();
          signal.addEventListener("abort", stopReading, { once: true });
          let playing = true;
          let current: string | null = null;
          const place = createReadingPlace(skip);
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
                onSpeech: () => {
                  if (playing)
                    cutReply = {
                      text: reply.text,
                      ids: reply.ids,
                      ...place.cut(),
                    };
                  interrupt();
                },
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
          await speak(
            reply.text,
            reading.signal,
            (sentence) => {
              place.sentence(sentence);
              current = sentence ?? current;
              highlightReading(reply.ids, sentence);
            },
            { skip },
          ).catch((error) => {
            if (!reading.signal.aborted) throw error;
          });
          highlightReading([], null);
          interruptRef.current = null;
          signal.removeEventListener("abort", stopReading);
          playing = false;
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
            note(asked.text);
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
            note(said);
            setState("speaking");
            await speak(said, signal).catch(() => {});
            moving.to = asked;
            return true;
          }
          // Replaced by a newer question: that one is asked next.
          if (yes === null) return false;
          note("Staying here.");
          setState("speaking");
          await speak("Okay, staying here.", signal).catch(() => {});
          return false;
        };
        while (!signal.aborted) {
          try {
            if (!link) {
              // The listening of this pane's chat before it was rebuilt:
              // what is being said goes on, never cut.
              const key = voiceKeyRef.current;
              const kept = key
                ? takeParkedVoiceLink(`${key.connectionId}/${key.paneId}`)
                : null;
              if (kept) {
                link = kept;
                const finish = new AbortController();
                finishRef.current = finish;
                const adopted = kept.adopt(listening(), {
                  finish: finish.signal,
                  onLevel: setLevel,
                  onSpeechEnd: () => setState("transcribing"),
                  onHeard: setHeard,
                });
                voiceTrace(
                  `voice chat goes on after the chat was rebuilt${adopted ? ", still listening" : ""}`,
                );
                playReconnectCue();
                if (adopted) {
                  setState("listening");
                  next = adopted;
                }
              }
            }
            // A call that cannot connect says so; the chat goes on. A
            // microphone the phone pauses (its screen off) is said aloud:
            // nothing else reaches with the screen off.
            link ??= await VoiceLink.open({
              call: {
                notice: (text) => showRouterNote(text),
                microphonePaused: (paused) => {
                  if (paused)
                    void speak(
                      "I can't hear you: the phone paused the microphone. Turn the screen on.",
                      controller.signal,
                    ).catch(() => {});
                },
              },
            });
            const voice = link;
            if (controllerRef.current === controller) linkRef.current = voice;
            voice.onReconnected = () => playReconnectCue();
            if (front) {
              // Speaking up stops the front, as it stops a reply.
              voice.onAnySpeech = () => front.hush();
              voice.alsoHolding = () => front.playing();
            }
            // The user went for a workspace with no agent: asked first.
            if (moveRef.current && forwarded === null) {
              await next?.catch(() => null);
              next = null;
              if (await askMove(voice)) break;
              continue;
            }
            watchStream();
            // A turn Claude started by itself, while nothing was said: read.
            const own = claudeTurn;
            const ownLive = streamRef.current;
            if (own && !forwarded && !resuming && !next && ownLive?.active()) {
              claudeTurn = null;
              const outcome = await streamedTurns(ownLive, voice, null, own);
              if (outcome === "stop") break;
              failures = 0;
              continue;
            }
            let heard: Heard | null;
            const handed = forwarded;
            forwarded = null;
            const back = resuming;
            resuming = null;
            if (back) heard = { text: back.sent, speechMs: 0 };
            else if (handed !== null) heard = { text: handed, speechMs: 0 };
            else if (next) {
              heard = await next;
              next = null;
            } else {
              await unmuted();
              if (signal.aborted) break;
              if (moveRef.current || claudeTurn) continue;
              setState("listening");
              const finish = new AbortController();
              finishRef.current = finish;
              const over = carriedPlaying ? carried : null;
              // A turn Claude starts by itself ends the listening, unless
              // the person is speaking: then what they say goes first.
              const ownTurnCame = new AbortController();
              let talking = false;
              onClaudeTurn = () => {
                if (!talking) ownTurnCame.abort();
              };
              try {
                heard = await voice.listen(
                  AbortSignal.any([listening(), ownTurnCame.signal]),
                  {
                    finish: finish.signal,
                    onLevel: setLevel,
                    ...(over ? { holding: () => carriedPlaying } : {}),
                    onSpeech: () => {
                      talking = true;
                      if (!over || !carriedPlaying) return;
                      carriedPlaying = false;
                      interruptedAt = over.sentence();
                      voiceTrace(
                        `talked over the reading at: ${interruptedAt}`,
                      );
                      over.stop();
                    },
                    onSpeechEnd: () => setState("transcribing"),
                    onHeard: setHeard,
                    conversation: conversationContext(entriesRef.current),
                  },
                );
              } finally {
                onClaudeTurn = null;
              }
              if (ownTurnCame.signal.aborted && !signal.aborted) {
                finishRef.current = null;
                setLevel(0);
                setHeard("");
                continue;
              }
            }
            finishRef.current = null;
            setLevel(0);
            if (signal.aborted) break;
            // The reply this speech cut short, read on when nothing is sent.
            const cut = cutReply as CutReply | null;
            cutReply = null;
            const readOn = async (outcome: CutOutcome) => {
              const from = resumeAfter(cut, outcome);
              if (!from || signal.aborted) return;
              voiceTrace(
                `nothing was sent: reading on from: ${from.sentence ?? "the start"}`,
              );
              interruptedAt = null;
              setState("speaking");
              await readAloud(voice, from, from.skip);
              if (!signal.aborted) setState("listening");
            };
            if (!heard) {
              setHeard("");
              // Cut short by the question about moving: asked next.
              if (moveRef.current) continue;
              // Muted while listening: wait for the microphone.
              if (mutedRef.current) {
                await readOn("nothing");
                continue;
              }
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
              await readOn("noise");
              continue;
            }
            if (heard.forAgent === false) {
              hold(heard);
              skipNotForAgent(heard);
              setHeard("");
              await readOn("not-for-agent");
              continue;
            }
            const route =
              handed !== null || back ? "here" : await routed(heard);
            if (route === "left") break;
            if (route === "nobody") {
              setHeard("");
              continue;
            }
            if (route === "held") {
              await readOn("not-for-agent");
              continue;
            }
            const message = back
              ? back.sent
              : voiceMessage(wordsToSend(text), interruptedAt);
            interruptedAt = null;
            const live = streamRef.current;
            if (!back && live?.active()) {
              if (raw) rememberHeardAs(text, raw);
              setHeard("");
              const outcome = await streamedTurns(live, voice, message);
              if (outcome === "stop") break;
              failures = 0;
              continue;
            }
            if (!back) await onSend(message);
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
            const readIds = new Set<string>(back?.read);
            awaitingRef.current = () => ({ sent, read: [...readIds] });
            // Those cut short by speaking up that came to nothing: read
            // again, from the sentence they were cut at.
            const skipped = new Map<string, number>();
            // A companion tells what an agent writes while it works now
            // and then, not each message.
            let progressToldAt = Date.now();
            turnAck = startTurnAck({
              ...takeOpening(),
              fronted: front !== null,
              said: text,
              // Shown again with its answer awaited: it was heard long ago.
              signal: back ? AbortSignal.abort() : signal,
              // Being read, or written already and about to be.
              started: () =>
                readIds.size > 0 ||
                (agentStateKind(statusRef.current) !== "working" &&
                  replyAfter(entriesRef.current, sent) !== null),
              busy: () => stateRef.current !== "waiting",
              working: () => agentStateKind(statusRef.current) === "working",
              // Whatever reads aloud next (a message's button) stops it.
              speech: {
                ...ackSpeech,
                playAudio: (audio, stop) => {
                  const owner = new AbortController();
                  claimSpeaker(owner);
                  return ackSpeech.playAudio(
                    audio,
                    AbortSignal.any([stop, owner.signal]),
                  );
                },
              },
            });
            const ack = turnAck;
            for (;;) {
              setState("waiting");
              const waiting = new AbortController();
              let speaking = false;
              let progressReading: AbortController | null = null;
              let progressSentence: string | null = null;
              let progressAt: { id: string; place: ReadingPlace } | null = null;
              // The progress message this speech cut short.
              let progressCut: (ReadingCut & { id: string }) | null = null;
              const readProgressOn = (outcome: CutOutcome) => {
                const from = resumeAfter(progressCut, outcome);
                progressCut = null;
                if (!from) return;
                voiceTrace(
                  `nothing was sent: progress read on from: ${from.sentence ?? "the start"}`,
                );
                interruptedAt = null;
                readIds.delete(from.id);
                skipped.set(from.id, from.skip);
              };
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
                          ack.hush();
                          if (
                            progressAt &&
                            progressReading &&
                            !progressReading.signal.aborted
                          )
                            progressCut = {
                              id: progressAt.id,
                              ...progressAt.place.cut(),
                            };
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
                  if (companion()) {
                    readIds.add(ready.id);
                    if (Date.now() - progressToldAt < PROGRESS_TOLD_MS)
                      continue;
                    progressToldAt = Date.now();
                    tellFront({
                      text: ready.text,
                      at: Date.now(),
                      kind: "progress",
                      agent: agentName(),
                    });
                    continue;
                  }
                  // An ack saying the message was heard ends its words first.
                  ack.activity();
                  await ack.quiet();
                  if (waiting.signal.aborted || speaking) continue;
                  readIds.add(ready.id);
                  const skip = skipped.get(ready.id) ?? 0;
                  skipped.delete(ready.id);
                  const place = createReadingPlace(skip);
                  progressAt = { id: ready.id, place };
                  progressSentence = null;
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
                      place.sentence(sentence);
                      progressSentence = sentence ?? progressSentence;
                      highlightReading([ready.id], sentence);
                    },
                    { skip },
                  ).catch(() => {});
                  highlightReading([], null);
                  ack.activity();
                  interruptRef.current = null;
                  progressReading = null;
                  progressAt = null;
                  if (!speaking && !signal.aborted) setState("waiting");
                }
              })();
              try {
                const replied = waitForReply(
                  sent,
                  AbortSignal.any([signal, waiting.signal]),
                  () => !companion(),
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
                  readProgressOn("nothing");
                  continue;
                }
                if (isStopCommand(heard.raw ?? heard.text)) {
                  await speak("Okay, stopping.", signal);
                  stopping = true;
                  break;
                }
                if (!heard.text) {
                  setHeard("");
                  readProgressOn("noise");
                  continue;
                }
                if (heard.forAgent === false) {
                  hold(heard);
                  skipNotForAgent(heard);
                  setHeard("");
                  readProgressOn("not-for-agent");
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
                if (route === "held") {
                  readProgressOn("not-for-agent");
                  continue;
                }
                sent = voiceMessage(wordsToSend(heard.text), interruptedAt);
                interruptedAt = null;
                await onSend(sent);
                sayOpening();
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
            await ack.end();
            turnAck = null;
            if (stopping || signal.aborted) break;
            awaitingRef.current = null;
            // A companion tells the whole answer, in the conversation's
            // flow; it is not read.
            if (companion()) {
              if (reply && reply !== "blocked")
                tellAnswer(reply.text, reply.ids);
              setState("listening");
              failures = 0;
              continue;
            }
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
              // One cut short and not read since: from where it was cut.
              const from = (entry: HistoryEntry) => {
                const skip = skipped.get(entry.id);
                return skip
                  ? sentences(markdownToSpeech(entry.text))
                      .slice(skip)
                      .join("\n")
                  : entry.text;
              };
              reply = {
                text: unread.map(from).join("\n\n"),
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
            await readAloud(voice, reply, 0);
            if (!signal.aborted) setState("listening");
            failures = 0;
          } catch (error) {
            if (signal.aborted) break;
            // Old code against a newer server fails this way too: the
            // page then takes the newer build, between turns.
            checkFrontendFreshness();
            if (failures === 0)
              onError(
                `${error instanceof Error ? error.message : String(error)}; retrying`,
              );
            failures += 1;
            void turnAck?.end();
            turnAck = null;
            link?.close();
            link = null;
            next = null;
            finishRef.current = null;
            interruptRef.current = null;
            highlightReading([], null);
            setLevel(0);
            // What was heard and not sent stays, to send by hand.
            const unsent = heardRef.current.trim();
            if (unsent) {
              voiceTrace(`kept as a draft, the voice link failed: ${unsent}`);
              hold({ text: unsent, speechMs: 0 });
            }
            setHeard("");
            await pause(Math.min(10_000, 1000 * 2 ** (failures - 1)));
          }
        }
      } finally {
        // Nothing keeps the microphone once the loop is over.
        controller.abort();
        void turnAck?.end();
        if (controllerRef.current === controller) awaitingRef.current = null;
        link?.close();
        if (linkRef.current === link) linkRef.current = null;
        highlightReading([], null);
        setHeard("");
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setState("off");
          setLevel(0);
        }
        release();
        moveRef.current = null;
        setNotSent(null);
        // Said yes to a workspace with no agent: moved there, voice off.
        moving.to?.move();
      }
    },
    [actions, agentName, companionCall, hold, onError, onSend, waitForReply],
  );

  /**
   * Picks up a voice chat another pane routed here, sending its words, or
   * this pane's own, back from a reconnect, awaiting its answer again.
   */
  const takeOver = useCallback(
    (message: string | null, resume?: VoiceResume) => {
      if (controllerRef.current && !controllerRef.current.signal.aborted)
        return;
      voiceTrace(
        resume
          ? `voice chat resumed, awaiting the answer to: ${resume.sent}`
          : `voice chat handed over${message ? `: ${message}` : ""}`,
      );
      stopSpeaker();
      const controller = new AbortController();
      controllerRef.current = controller;
      holdAudioFocus(controller.signal);
      void run(controller, null, message, resume ?? null);
    },
    [run],
  );

  /**
   * Where the voice chat is, if on: what a reconnected pane needs to go on
   * with it (takeOver).
   */
  const resumePoint = useCallback((): { resume?: VoiceResume } | null => {
    // Unmounting aborts it first (the effect above); on until its loop ends
    // or a tap stops it.
    if (!controllerRef.current) return null;
    const awaiting = awaitingRef.current?.();
    return awaiting ? { resume: awaiting } : {};
  }, []);

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
    // Only the server's voice engine listens.
    if (!canListen()) return;
    // Voice chat starts by listening; a message being read plays on until
    // the speaker talks over it, anything else reading stops.
    prepareReading();
    const carried = ongoingReading();
    if (!carried) stopSpeaker();
    const controller = new AbortController();
    controllerRef.current = controller;
    holdAudioFocus(controller.signal);
    void run(controller, carried);
  }, [run]);

  /**
   * Sends what is being said now, without waiting for the pause that ends
   * it; nothing else (no stop, no tap) when not listening to anything.
   */
  const sendNow = useCallback(() => {
    if (stateRef.current === "listening" && finishRef.current)
      finishRef.current.abort();
  }, []);

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

  // A newer build reloads the page between turns only (voiceCallReload.ts).
  const callConnection = voiceKey?.connectionId;
  const callPane = voiceKey?.paneId;
  useEffect(() => {
    if (!callConnection || !callPane) return;
    const pane = { connectionId: callConnection, paneId: callPane };
    setVoiceCallPhase(
      pane,
      state === "off"
        ? null
        : state === "listening" && !heard
          ? "safe"
          : "busy",
    );
  }, [state, heard, callConnection, callPane]);
  useEffect(() => {
    if (!callConnection || !callPane) return;
    const pane = { connectionId: callConnection, paneId: callPane };
    return () => setVoiceCallPhase(pane, null);
  }, [callConnection, callPane]);

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
  /** Sends the sentence the router held back, to this agent after all. */
  const sendNotSent = useCallback(() => {
    if (!notSent) return;
    setNotSent(null);
    sendHeld(notSent);
  }, [notSent, sendHeld]);
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
    /**
     * The server said it has no voice engine, or did not answer: voice chat
     * cannot listen, and a tap asks again (listenOrSayWhy).
     */
    unavailable: engine.server === false || engine.unreachable,
    state,
    level,
    muted,
    heard,
    held,
    /** The last sentence taken as not for the agent, shown on the card. */
    notSent: notSent?.text ?? null,
    sendNotSent,
    sendHeld,
    dropHeld,
    toggle,
    toggleMute,
    sendNow,
    stop,
    speechRate: speechRate.rate,
    cycleSpeechRate: speechRate.cycle,
    /** Each reply read by a voice at random; null: not offered. */
    /** Who reads the sentence playing, when the server says. */
    reader: surprise.reader,
    takeOver,
    /** A move to a workspace with no agent, held until answered. */
    moveQuestion,
    answerMove,
    resumePoint,
  };
}
