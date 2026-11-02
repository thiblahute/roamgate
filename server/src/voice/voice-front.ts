import { type ClaudeProcess, spawnClaude, Worker } from "./voice-cleaner";
import type { VoiceConfig } from "./voice-helper";
import {
  parseVoiceRoute,
  ROUTER_SYSTEM_PROMPT,
  type VoiceRoute,
  type VoiceSessionInfo,
  voiceSessionLine,
} from "./voice-router";

/**
 * Voice chat's front: one small model, kept running, hears each thing said
 * as soon as it is written down and answers at once, aloud. It talks; it
 * never works. It decides who the words are for (as the router does, in
 * the same call) and says a few natural words about it: that it passes
 * them on, or the answer to a question Roamgate's state already answers
 * (what runs, who waits, a Ranger task, a merge request). Between turns it
 * hears what happens (an agent done or blocked, a task run) and says what
 * is worth saying. The words go to the agents as said; the agents' answers
 * are read as they come, never by it.
 */

export const FRONT_SYSTEM_PROMPT = `${ROUTER_SYSTEM_PROMPT}

You are also the voice the user hears first: a fast, friendly companion who keeps the conversation going while the agents work. You never do the work. You never run, edit, check or approve anything, never answer for an agent, never claim that something was done, checked or found, and never invent a result, a status or a name. The words said go to the agents exactly as said, never through you: you only say what happens with them.

Add "reply" to the JSON object (beside "say", which stays the short name of a session): what you say aloud right now, one or two short sentences (about 25 words at most, the gist in a first short sentence, as it is read out sentence by sentence), natural and spoken (no lists, no markdown, no ids like "local/p1", never the JSON), in the language the user spoke (often French).

- "current", "send", "open": say in a few words, specifically, that you pass it on or go there ("Je transmets à Roamgate.", "Over to GStreamer."); it is read before anything else, so the shorter the sooner. Never answer the request yourself, even partly.
- "ranger", "errand": say that you ask Ranger, or the errands session, in a few words.
- "ask": "reply" is the question.
- "nobody": "reply" is "".
- {"to": "self", "reply": "..."}: what is said is for you, and you can answer it from the State given, which you trust as it is: a greeting, thanks, small talk about what is going on, or a question about what runs, which sessions work, wait or are idle, a Ranger task, a merge request or its CI, when the State holds the answer. Answer in a sentence or two. When the State does not hold it, route as above instead ("ranger" for another session, "current" for the agent on screen). A request for work is never "self". A yes, a no or an approval is for the agent that asked, never for you: route it, word for word.

A request marked EVENT tells something that just happened (an agent finished or needs input, a Ranger task ran, CI changed). Reply {"reply": "..."}: a short natural sentence telling the user, in the language they last spoke, when it is worth saying now; "" to stay quiet (the agent on screen, whose answer is read anyway, something already said, or nothing they would care about). Never guess what an agent found or asks beyond the words given.`;

/** A route, and `reply`: what the front says aloud now. */
export type FrontReply = (VoiceRoute | { to: "self" }) & { reply?: string };

/** What happened, for the front to tell when it is worth it. */
export type FrontEvent = { text: string };

const CURRENT: FrontReply = { to: "current" };
/**
 * A route not decided by then goes to the agent on screen, unsaid. Words
 * for another session went there when the front took longer: give it the
 * time, as the page says it heard them after FRONT_SLOW_MS meanwhile.
 * Sending them to a named session took Opus 10 to 14 s at its default
 * effort, 2 to 6 s at low effort (spawnClaude).
 */
const FRONT_TIMEOUT_MS = 15_000;
/** An event not said by then is not said. */
const EVENT_TIMEOUT_MS = 6000;
const MAX_REPLY_CHARS = 400;

function replyOf(text: string): string {
  try {
    const answer = JSON.parse(
      text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
    ) as { reply?: unknown };
    return typeof answer.reply === "string"
      ? answer.reply.trim().slice(0, MAX_REPLY_CHARS)
      : "";
  } catch {
    return "";
  }
}

/** The model's answer to a turn: a route of those sessions, and what to say. */
export function parseFrontReply(text: string, ids: Set<string>): FrontReply {
  const reply = replyOf(text);
  let to: unknown;
  try {
    to = (
      JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as {
        to?: unknown;
      }
    ).to;
  } catch {
    to = undefined;
  }
  // Answering itself with nothing to say would leave the user unanswered.
  if (to === "self") return reply ? { to: "self", reply } : CURRENT;
  const route = parseVoiceRoute(text, ids);
  return reply && route.to !== "nobody" ? { ...route, reply } : route;
}

/** The state the front answers from, as given to it. */
function stateText(sessions: VoiceSessionInfo[], context: string): string {
  return [
    "Sessions:",
    ...sessions.map(voiceSessionLine),
    ...(context.trim() ? ["", context.trim()] : []),
  ].join("\n");
}

/**
 * The front, in one background Claude Code session: it keeps what was said
 * before, so "and the other one?" makes sense to it. The state goes with a
 * request only when it changed since the last one.
 */
export class VoiceFront {
  private worker: Worker;
  private chain: Promise<unknown> = Promise.resolve();
  private given: { generation: number; state: string } | null = null;

  constructor(spawn: () => ClaudeProcess) {
    this.worker = new Worker(spawn);
  }

  warm() {
    this.worker.warm();
  }

  /** Who `said` is for, and what to say now; "current" unsaid when slow. */
  turn(request: {
    current: string;
    said: string;
    sessions: VoiceSessionInfo[];
    context?: string;
    timeoutMs?: number;
  }): Promise<FrontReply> {
    const ids = new Set(request.sessions.map((session) => session.id));
    const asked = this.ask(
      request.sessions,
      request.context ?? "",
      `Current: ${request.current}\nSaid: ${JSON.stringify(request.said)}`,
    ).then((answer) => parseFrontReply(answer, ids));
    return within(asked, request.timeoutMs ?? FRONT_TIMEOUT_MS, CURRENT);
  }

  /** What to tell of `event` now; "" to stay quiet. */
  event(request: {
    current: string;
    event: FrontEvent;
    sessions: VoiceSessionInfo[];
    context?: string;
    timeoutMs?: number;
  }): Promise<string> {
    const asked = this.ask(
      request.sessions,
      request.context ?? "",
      `EVENT\nCurrent: ${request.current}\nWhat happened: ${request.event.text}`,
    ).then(replyOf);
    return within(asked, request.timeoutMs ?? EVENT_TIMEOUT_MS, "");
  }

  private ask(
    sessions: VoiceSessionInfo[],
    context: string,
    request: string,
  ): Promise<string> {
    const state = stateText(sessions, context);
    const asked = this.chain.then(async () => {
      const send = async (withState: boolean) => {
        const generation = this.worker.generation;
        const answer = await this.worker.ask(
          withState ? `State:\n${state}\n\n${request}` : request,
        );
        // A new background session started for it: it never saw the state.
        if (!withState && this.worker.generation !== generation) return null;
        this.given = { generation: this.worker.generation, state };
        return answer;
      };
      const known =
        this.worker.running &&
        this.given?.state === state &&
        this.given.generation === this.worker.generation;
      return (await send(!known)) ?? (await send(true)) ?? "";
    });
    this.chain = asked.catch(() => {});
    return asked;
  }

  stop() {
    this.worker.stop();
  }
}

function within<T>(asked: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([asked.catch(() => fallback), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

/** The front `front_model` in voice.json sets up, or null without one. */
export function configuredFront(
  config: () => VoiceConfig | { error: string },
  spawn: (model: string, command?: string) => ClaudeProcess = (
    model,
    command,
  ) => spawnClaude(model, command, FRONT_SYSTEM_PROMPT),
): () => VoiceFront | null {
  let current: { key: string; front: VoiceFront } | null = null;
  return () => {
    const read = config();
    const model = "error" in read ? undefined : read.front_model;
    const command = "error" in read ? undefined : read.claude_command;
    const key = model ? `${model} ${command ?? ""}` : "";
    if (current?.key !== key) {
      current?.front.stop();
      current = model
        ? { key, front: new VoiceFront(() => spawn(model, command)) }
        : null;
    }
    return current?.front ?? null;
  };
}
