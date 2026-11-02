import type { AssistantTask } from "../../shared/assistant";
import type { ForgeStatus } from "../../shared/forge";
import type { AckSpeech } from "./voiceAck";
import { ackLanguage } from "./voiceAck";
import type { VoiceEvent } from "./voiceEvents";

/**
 * Voice chat's front (server voice-front.ts), on the page: what it is told
 * of Roamgate's state beyond the sessions, how long its words are waited
 * for before a canned ack says the message was heard, and its voice, which
 * speaking up stops.
 */

/** No word from the front by then: a canned ack says it was heard. */
export const FRONT_SLOW_MS = 1500;

/**
 * Waits for the front's answer; past `slowMs` without it, `onSlow` runs
 * once (it says a canned ack). `slow` tells whether it did.
 */
export async function awaitFront<T>(
  answer: Promise<T>,
  { slowMs = FRONT_SLOW_MS, onSlow }: { slowMs?: number; onSlow: () => void },
): Promise<{ value: T; slow: boolean }> {
  let slow = false;
  const timer = setTimeout(() => {
    slow = true;
    onSlow();
  }, slowMs);
  try {
    const value = await answer;
    return { value, slow };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The front's voice: one thing said at a time, each after the one before;
 * speaking up stops it all.
 */
export type FrontVoice = {
  /** Says `text` (in its own language); resolves when it ends or stops. */
  say(text: string, signal: AbortSignal): Promise<void>;
  /** Stops what it says now, and what waits to be said. */
  hush(): void;
  /** Whether it says something now (or is about to). */
  playing(): boolean;
};

export function createFrontVoice<Speech>(
  speech: AckSpeech<Speech>,
  /** Takes the speaker from whatever reads (voiceChat.ts claimSpeaker). */
  claim: (owner: AbortController) => void = () => {},
): FrontVoice {
  let hushed = new AbortController();
  let pending = 0;
  let chain: Promise<void> = Promise.resolve();
  return {
    say(text, signal) {
      const stop = AbortSignal.any([hushed.signal, signal]);
      const language = ackLanguage(text);
      pending += 1;
      // Each sentence is made at once, the first playing as soon as it is
      // ready and what is said before it ends: a long answer starts early.
      const audio = spokenSentences(text).map((sentence) => {
        const made = speech.fetchAudio(sentence, language, stop);
        made.catch(() => {});
        return made;
      });
      const said = chain.then(async () => {
        try {
          for (const made of audio) {
            if (stop.aborted) return;
            const ready = await made;
            if (stop.aborted) return;
            const owner = new AbortController();
            stop.addEventListener("abort", () => owner.abort(), {
              once: true,
            });
            claim(owner);
            await speech.playAudio(ready, owner.signal);
          }
        } catch {
          // Unsaid: voice chat goes on.
        } finally {
          pending -= 1;
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
  now = Date.now(),
}: {
  tasks: readonly AssistantTask[];
  requests: readonly ForgeStatus[];
  events: readonly VoiceEvent[];
  now?: number;
}): string {
  const sections: string[] = [];
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
