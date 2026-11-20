import type { AssistantTask } from "../../shared/assistant";
import type { ForgeStatus } from "../../shared/forge";
import type { AckSpeech } from "./voiceAck";
import { ackLanguage } from "./voiceAck";
import type { VoiceEvent } from "./voiceEvents";

/**
 * Voice chat's front (server voice-front.ts), on the page: what it is told
 * of Roamgate's state beyond the sessions and of what it skipped, and its
 * voice, which speaking up stops. Only its own words are said: no canned
 * ack while it is slow, and no "not for me" line.
 */

/**
 * The routes whose words the page says as soon as the front has written
 * them (routeSpeech's `onEarly`), before the route is decided: those whose
 * words are said as written whatever comes with them. On a companion call,
 * words starting work on a session too; elsewhere those are the turn's
 * opening, said with its acks.
 */
export function earlyReplySaid(to: string, companionCall: boolean): boolean {
  return (
    to === "self" ||
    to === "reset" ||
    to === "web" ||
    to === "tool" ||
    to === "ranger" ||
    to === "reviews" ||
    (companionCall && (to === "current" || to === "send"))
  );
}

/**
 * Whether the line saying a sentence was taken as not for the agent is
 * said (voiceNotForMe.ts): only by the router alone. With a front, words
 * not for it get silence; the card shows them, and they stay listed for
 * the front (skippedWords) so "c'était pour toi" brings them back.
 */
export function notForMeSpoken(fronted: boolean): boolean {
  return !fronted;
}

/**
 * What the user said lately that the front routed to nobody, sent with
 * each turn (server voice-front.ts skippedWords): the front may route it
 * after all when the user says it was for it.
 */
export type SkippedWords = {
  text: string;
  at: number;
  /** Who said them (the server's voice label), when voices are told apart. */
  voice?: string;
};

/** Skipped words kept, at most, and for how long. */
export const SKIPPED_KEPT = 5;
export const SKIPPED_MAX_AGE_MS = 15 * 60_000;

/**
 * `list` with `text` skipped now, with who said it (`voice`, its label),
 * recent ones only, oldest first.
 */
export function withSkipped(
  list: readonly SkippedWords[],
  text: string,
  now = Date.now(),
  voice?: string,
): SkippedWords[] {
  const said = text.trim();
  const kept = list.filter((each) => now - each.at <= SKIPPED_MAX_AGE_MS);
  return (
    said
      ? [...kept, { text: said, at: now, ...(voice ? { voice } : {}) }]
      : kept
  ).slice(-SKIPPED_KEPT);
}

/**
 * `list` with words taken as not for the agent (`forAgent` false: the
 * speaker check doubted the voice, or they sounded said to someone else),
 * when a front listens: kept as what it routed to nobody, so "it was for
 * you" brings them back. Never dropped unheard.
 */
export function withNotForAgent(
  list: readonly SkippedWords[],
  heard: { text: string; forAgent?: boolean; voiceLabel?: string },
  fronted: boolean,
  now = Date.now(),
): SkippedWords[] {
  return fronted && heard.forAgent === false
    ? withSkipped(list, heard.text, now, heard.voiceLabel)
    : [...list];
}

/** `list` without the skipped words the front routed now, and old ones. */
export function withoutRecovered(
  list: readonly SkippedWords[],
  recovered: string | undefined,
  now = Date.now(),
): SkippedWords[] {
  return list.filter(
    (each) => each.text !== recovered && now - each.at <= SKIPPED_MAX_AGE_MS,
  );
}

/**
 * The front's voice: one thing said at a time, each after the one before;
 * speaking up stops it all.
 */
export type FrontVoice = {
  /**
   * Says `text` (in its own language); resolves when it ends or stops.
   * `onSentence` hears which of its sentences (spokenSentences, each made
   * and played on its own) starts playing, then null once it is over.
   */
  say(text: string, signal: AbortSignal, options?: SayOptions): Promise<void>;
  /** Stops what it says now, and what waits to be said. */
  hush(): void;
  /** Whether it says something now (or is about to). */
  playing(): boolean;
};

/** What hears where a `say` is, as its sentences play. */
export type SayOptions = {
  onSentence?: (index: number | null, sentences: readonly string[]) => void;
  /**
   * An agent's answer read word for word: whose, and its chat entries, for
   * whoever shows the reading (a companion call highlights it in its chat).
   */
  answer?: { agent: string; ids: readonly string[] };
};

export function createFrontVoice<Speech>(
  speech: AckSpeech<Speech>,
  /** Takes the speaker from whatever reads (voiceChat.ts claimSpeaker). */
  claim: (owner: AbortController) => void = () => {},
  /**
   * Resolves once the user is not in the middle of an utterance
   * (voiceChat.ts VoiceLink.untilTurnEnds): nothing is said over them. Each
   * sentence is made only then: in a call, made is played (its mix).
   */
  turn: (signal: AbortSignal) => Promise<void> = async () => {},
): FrontVoice {
  let hushed = new AbortController();
  let pending = 0;
  let chain: Promise<void> = Promise.resolve();
  return {
    say(text, signal, options) {
      const stop = AbortSignal.any([hushed.signal, signal]);
      const language = ackLanguage(text);
      pending += 1;
      // Each sentence is made at once, the first playing as soon as it is
      // ready and what is said before it ends: a long answer starts early.
      // Where the reading is shown (companionReading.ts) these same
      // sentences mark it, one per piece of speech.
      const sentences = spokenSentences(text);
      let started = false;
      const turnOver = turn(stop);
      turnOver.catch(() => {});
      const audio = sentences.map((sentence) => {
        const made = turnOver.then(() => {
          stop.throwIfAborted();
          return speech.fetchAudio(sentence, language, stop);
        });
        made.catch(() => {});
        return made;
      });
      const said = chain.then(async () => {
        try {
          for (const [index, made] of audio.entries()) {
            if (stop.aborted) return;
            const ready = await made;
            if (stop.aborted) return;
            const owner = new AbortController();
            stop.addEventListener("abort", () => owner.abort(), {
              once: true,
            });
            claim(owner);
            started = true;
            options?.onSentence?.(index, sentences);
            await speech.playAudio(ready, owner.signal);
          }
        } catch {
          // Unsaid: voice chat goes on.
        } finally {
          pending -= 1;
          if (started) options?.onSentence?.(null, sentences);
        }
      });
      chain = said;
      return said;
    },
    hush() {
      hushed.abort();
      hushed = new AbortController();
    },
    playing: () => pending > 0,
  };
}

/**
 * A spoken reply's sentences, each made and played on its own; a colon or
 * a semicolon, where the voice pauses anyway, ends one too.
 */
export function spokenSentences(text: string): string[] {
  const found = text
    .split(/(?<=[.!?…])\s+|(?<=\S\s?[:;])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return found.length ? found : [text];
}

function ago(at: number, now: number) {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes} min ago`
      : `${Math.round(minutes / 60)} h ago`;
}

function taskLine(task: AssistantTask): string {
  const parts = [`"${task.title}": ${task.status}`];
  const run = task.current_run ?? task.last_run;
  if (task.current_run) parts.push(`running now (${task.current_run.status})`);
  else if (run)
    parts.push(
      `last run ${run.status}${run.error ? ` (${run.error.slice(0, 120)})` : ""}`,
    );
  if (task.next_run_at && task.status === "active")
    parts.push(`next run ${task.next_run_at}`);
  return `- ${parts.join(", ")}`;
}

function requestLine(status: ForgeStatus): string | null {
  const request = status.request;
  if (status.state !== "ready" || !request) return null;
  const mark = status.ref.provider === "gitlab" ? "!" : "#";
  const parts = [
    `${request.project} ${mark}${status.ref.number} "${request.title}" ${request.draft ? "draft " : ""}${request.state}`,
  ];
  if (request.pipeline) {
    const failed = request.pipeline.failed
      .filter((job) => !job.allowFailure)
      .map((job) => job.name);
    parts.push(
      `CI ${request.pipeline.status}${failed.length ? ` (failed: ${failed.join(", ")})` : ""}`,
    );
  }
  if (request.approvals?.approved) parts.push("approved");
  if (request.unresolved) parts.push(`${request.unresolved} open threads`);
  return `- ${parts.join(", ")}`;
}

/**
 * What the front knows beyond the sessions: Ranger's tasks, the merge and
 * pull requests the page knows, and what happened lately.
 */
export function frontContext({
  tasks,
  requests,
  events,
  answers = "",
  now = Date.now(),
}: {
  tasks: readonly AssistantTask[];
  requests: readonly ForgeStatus[];
  events: readonly VoiceEvent[];
  /** The agents' recent answers, shortened (voiceCompanion.ts). */
  answers?: string;
  now?: number;
}): string {
  const sections: string[] = [];
  if (answers) sections.push(answers);
  const shownTasks = tasks.filter((task) => task.status !== "cancelled");
  if (shownTasks.length)
    sections.push(
      ["Ranger tasks:", ...shownTasks.slice(0, 20).map(taskLine)].join("\n"),
    );
  const lines = requests
    .map(requestLine)
    .filter((line): line is string => line !== null);
  if (lines.length)
    sections.push(["Merge requests:", ...lines.slice(0, 30)].join("\n"));
  if (events.length)
    sections.push(
      [
        "Lately:",
        ...events.map((event) => `- ${ago(event.at, now)}: ${event.text}`),
      ].join("\n"),
    );
  return sections.join("\n\n");
}

/**
 * Whether an event is for the front to tell: not about the session the
 * voice chat talks to, whose answer is read anyway.
 */
export function eventForFront(
  event: VoiceEvent,
  key: { connectionId: string; paneId: string } | null | undefined,
): boolean {
  return !(
    key &&
    event.paneId === key.paneId &&
    (event.connectionId === undefined ||
      event.connectionId === key.connectionId)
  );
}
