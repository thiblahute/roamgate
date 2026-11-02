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
 * is worth saying. The words go to the agents as said. As a companion
 * (front_mode, the default) it is also given the agents' answers and tells
 * them as the conversation goes, from their words only (companionReply
 * keeps a closing question and its choices as written); in "relay" mode
 * the page reads them whole, as without a front.
 */

export const FRONT_SYSTEM_PROMPT = `${ROUTER_SYSTEM_PROMPT}

You are also the one agent the user talks to on a call: a fast, friendly companion in charge of their sessions. You answer them, and you start work on the sessions and tell them how it went; the sessions never talk to the user directly, you do. "Current" is the session work goes to unless another is named (the one on screen, or the one last given work). Speak in the first person, as the one who handles it, never as if handing the user over to someone else. You never do the work yourself. You never run, edit, check or approve anything, never answer for an agent, never claim that something was done, checked or found, and never invent a result, a status or a name. The words said go to the agents exactly as said, never through you: you only say what happens with them. Roamgate marks them as spoken: they reach the session starting with "[Voice] " (or "[Voice, interrupted you at: "<sentence>"] " when the user cut off a reading), so the agent knows they were said aloud, and its chat shows them with a Voice label; words the user types reach it unmarked. Asked whether a voice marker is added, say so.

Add "reply" to the JSON object (beside "say", which stays the short name of a session): what you say aloud right now, one or two short sentences (about 25 words at most, the gist in a first short sentence, as it is read out sentence by sentence), natural and spoken (no lists, no markdown, no ids like "local/p1", never the JSON), in the language the user spoke (often French).

- "current", "send": say in a few words, in the first person, that you start it there and will tell them ("Je lance ça sur la session roamgate.", "Je demande à gst2.", "I'm asking the IGA-184 session, I'll tell you."); never "passing that to" or "je transmets", as if the user went elsewhere. It is read before anything else, so the shorter the sooner. Never answer the request yourself, even partly. When the words start by addressing a session ("demande à la session fvcomp de lire le README", "dis à gst2 que la CI passe", "ask roamgate to rebase", "tell the gst2 session the build is fixed"), add "words": the same words with only that addressing dropped, turned into the instruction itself with the least change ("lis le README", "la CI passe", "rebase", "the build is fixed"): keep every other word as said, never reword, add, explain or translate. No "words" when nothing addresses a session, and never for a yes, a no, an approval or an answer to an agent's question: those go exactly as said.
- "open": say you show it ("Je t'affiche la session gst2."); you stay on the call.
- "ranger", "errand": say that you ask Ranger, or the errands session, in a few words, and will tell them.
- "ask": "reply" is the question.
- "nobody": "reply" is "".
- {"to": "self", "reply": "..."}: what is said is for you, and you can answer it from the State given, which you trust as it is: a greeting, thanks, small talk about what is going on, or a question about what runs, which sessions work, wait or are idle, a Ranger task, a merge request or its CI, when the State holds the answer. Answer in a sentence or two. Look in the State first, Recent answers above all: "is it working now?", "did the tests pass?", "what did roamgate say?" right after a session answered it are yours to answer, from its words, naming the session ("La session roamgate a dit que les tests passent."). A question is forwarded only when the State does not hold the answer and a session must look or work for it; then say you are checking and will tell them. When the State does not hold it, route as above instead ("ranger" for another session, "current" for the agent on screen). Words said to you, the voice on the call, are "self" too, answered in a few words: checking you are there or hear them ("t'es là ?", "can you hear me?"), a remark on how you answer or how the call goes ("tu me réponds vite", "that was quick", "you cut me off"), a short reaction ("ok", "super", "ha ha"). This comes before the rule on talk about Roamgate's voice chat: only a request to change it, a bug report or a feature idea goes to the agents. A request for work is never "self". A yes, a no or an approval is for the agent that asked, never for you: route it, word for word.

- {"to": "read", "agent": "<who wrote it, as named in Recent answers, or empty for the last one>"}: the user asks to hear an agent's answer whole or word for word ("read me the whole answer", "what did it say exactly?", "lis-moi toute la réponse"). It is read to them as written; "reply" is "".
- {"to": "mode", "mode": "relay", "reply": "..."}: the user asks to hear every answer read whole from now on ("read everything", "lis tout"); {"to": "mode", "mode": "companion", "reply": "..."} to go back to you telling them ("just summarize", "arrête de tout lire"). "reply" says it in a few words.

A request marked EVENT tells something that just happened (an agent finished or needs input, a Ranger task ran, CI changed). Reply {"reply": "..."}: a short natural sentence telling the user, in the language they last spoke, when it is worth saying now; "" to stay quiet (the agent on screen, whose answer is read anyway, something already said, or nothing they would care about). Never guess what an agent found or asks beyond the words given.

A request marked ANSWER gives an agent's answer, whole, and who wrote it. The user hears it only through you; it stays on their screen. Reply {"reply": "..."}, in the language the user last spoke: a short spoken summary (one to three short sentences), as the one reporting back, that names the session ("La session roamgate a fini : le déploiement est fait, les tests passent."), or its important part word for word when the exact words matter (a command, a number, a name, an error, a short list), or "" when the user is busy with something else and it can wait. Only say what the answer says: never add a result, a reason, a status or a guess it does not give, and never present it as your own. When it asks the user a question or offers choices, say the question and every choice as written, never reworded, and never answer it yourself. After a summary of a long answer, you may say they can ask to hear it whole. A request marked PROGRESS is something an agent wrote while still working: "" unless it is worth saying now.`;

/** A route, and `reply`: what the front says aloud now. */
export type FrontReply = { words?: string } & (
  | VoiceRoute
  | { to: "self" }
  /** Read an agent's answer (the last, or `agent`'s) word for word. */
  | { to: "read"; agent?: string }
  /** Every answer read whole ("relay") or told by the front ("companion"). */
  | { to: "mode"; mode: "companion" | "relay" }
) & { reply?: string };

/**
 * What happened, for the front to tell when it is worth it: an event, an
 * agent's whole answer ("answer"), or what it wrote while it works
 * ("progress"); `agent` names who wrote it.
 */
export type FrontEvent = {
  text: string;
  kind?: "event" | "answer" | "progress";
  agent?: string;
};

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
/** An answer is longer to tell: past this, it is only said to be in. */
const ANSWER_TIMEOUT_MS = 15000;
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

function fieldOf(text: string, key: string): string {
  try {
    const value = (
      JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as
        | Record<string, unknown>
        | undefined
    )?.[key];
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

/**
 * The questions an answer ends on, as written: the sentences ending in "?"
 * of its last paragraph, with the choices listed under them.
 */
export function closingQuestion(text: string): string {
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  // A question and its choices: the list may come after it.
  for (let index = paragraphs.length - 1; index >= 0; index--) {
    const paragraph = paragraphs[index]!;
    const isList = paragraph
      .split("\n")
      .every((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line));
    if (isList && index === paragraphs.length - 1 && index > 0) continue;
    if (!/\?/.test(paragraph)) return "";
    // The choices may follow the question in its own paragraph too.
    const lines = paragraph.split("\n");
    let last = lines.length - 1;
    while (last > 0 && !lines[last]!.includes("?")) last--;
    const asked = (
      lines
        .slice(0, last + 1)
        .join("\n")
        .match(/[^.!?\n]*\?/g) ?? []
    )
      .map((sentence) => sentence.trim())
      .join(" ");
    const choices = [
      ...lines.slice(last + 1).map((line) => line.trim()),
      ...paragraphs.slice(index + 1),
    ]
      .filter(Boolean)
      .join("\n");
    return choices ? `${asked}\n${choices}` : asked;
  }
  return "";
}

const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[`*_#>]/g, "")
    .replace(/[^\p{L}\p{N}?]+/gu, " ")
    .trim()
    .toLowerCase();

/**
 * What the front says of an agent's answer, kept to the rules it may not
 * break: an answer's closing question and its choices are said as written
 * (added when the front left them out or reworded them), and what it says
 * names who wrote it.
 */
export function companionReply(event: FrontEvent, reply: string): string {
  if (event.kind !== "answer") return reply;
  const agent = event.agent?.trim() || "The agent";
  const question = closingQuestion(event.text);
  let said = reply.trim();
  if (said && !plain(said).includes(plain(agent).split(" ")[0] ?? ""))
    said = `${agent}: ${said}`;
  // Each part said as written: the question, and each choice's words.
  const parts = question
    .split("\n")
    .map((line) => plain(line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")))
    .filter(Boolean);
  if (parts.length && !parts.every((part) => plain(said).includes(part)))
    said = `${said}${said ? " " : ""}${agent} asks: ${question.replace(/^\s*[-*•]\s+/gm, "")}`;
  return said;
}

/** What is said of an answer the front was too slow to tell. */
export function answerArrived(event: FrontEvent): string {
  const agent = event.agent?.trim() || "The agent";
  const french = /\b(le|la|les|est|une|des|pour|avec|dans)\b/i.test(
    event.text.slice(0, 400),
  );
  return companionReply(
    event,
    french ? `${agent} a répondu.` : `${agent} answered.`,
  );
}

const tokens = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'’]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/** A yes, a no or an approval: passed exactly as said, never cut. */
export function isApproval(said: string): boolean {
  const words = tokens(said);
  return (
    words.length > 0 &&
    words.length <= 4 &&
    words.some((word) =>
      /^(yes|yeah|yep|no|nope|ok|okay|sure|allow|deny|approve|approved|oui|ouais|non|d'accord|vas|valide|accepte|refuse|\d+)$/.test(
        word,
      ),
    )
  );
}

/** Words a dropped addressing or a verb's new form may leave out. */
const LINKING = new Set([
  "de",
  "d'",
  "d’",
  "à",
  "a",
  "me",
  "moi",
  "m'",
  "te",
  "toi",
  "lui",
  "leur",
  "que",
  "qu'",
  "qu’",
  "si",
  "to",
  "that",
  "me",
  "us",
  "if",
  "whether",
]);

/**
 * Positions of `a`'s words kept in order in `b` (a longest common run),
 * matched as late in `b` as they can be: `a` is meant to end it.
 */
function aligned(a: string[], b: string[]): [number, number][] {
  const last = (count: number) => (at: number) => count - 1 - at;
  return forward([...a].reverse(), [...b].reverse())
    .map(([x, y]): [number, number] => [last(a.length)(x), last(b.length)(y)])
    .reverse();
}

function forward(a: string[], b: string[]): [number, number][] {
  const table = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let x = a.length - 1; x >= 0; x--)
    for (let y = b.length - 1; y >= 0; y--)
      table[x]![y] =
        a[x] === b[y]
          ? table[x + 1]![y + 1]! + 1
          : Math.max(table[x + 1]![y]!, table[x]![y + 1]!);
  const pairs: [number, number][] = [];
  let x = 0;
  let y = 0;
  while (x < a.length && y < b.length) {
    if (a[x] === b[y]) {
      pairs.push([x, y]);
      x++;
      y++;
    } else if (table[x + 1]![y]! >= table[x]![y + 1]!) x++;
    else y++;
  }
  return pairs;
}

/**
 * The words to give a session: `stripped` (the words said, the session
 * they address dropped, as the front gives them) when it is the rest of
 * what was said, word for word but for verbs now in another form
 * ("de lire le README et de me dire" -> "lis le README et dis-moi") and
 * the linking words they took; else what was said, whole. An approval is
 * always passed whole.
 */
export function forwardedWords(said: string, stripped: unknown): string {
  if (typeof stripped !== "string" || isApproval(said)) return said;
  const kept = stripped.trim();
  const whole = tokens(said);
  const rest = tokens(kept);
  if (rest.length < 2 || rest.length >= whole.length) return said;
  const pairs = aligned(rest, whole);
  if (!pairs.length) return said;
  // It runs to the end of what was said.
  if (pairs[pairs.length - 1]![1] !== whole.length - 1) return said;
  // Its own words (but pronouns a verb took): verbs in another form.
  const matched = new Set(pairs.map(([at]) => at));
  const changed = rest.filter(
    (word, at) => !matched.has(at) && !LINKING.has(word),
  ).length;
  if (changed > Math.max(2, Math.floor(rest.length / 6))) return said;
  // Mostly the words said: twice as many kept as changed.
  if (pairs.length < 2 * changed) return said;
  // What it leaves out after its start: linking words, and the verbs it
  // gives in another form.
  const used = new Set(pairs.map(([, at]) => at));
  const start = Math.min(
    pairs[0]![1],
    changed ? pairs[0]![1] - 1 : pairs[0]![1],
  );
  let left = 0;
  for (let at = Math.max(0, start); at < whole.length; at++)
    if (!used.has(at) && !LINKING.has(whole[at]!)) left++;
  // Each word of its own stands for one left out: nothing added, nothing
  // dropped but the addressing.
  if (left !== changed) return said;
  return kept;
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
  if (to === "read") {
    const agent = fieldOf(text, "agent");
    return agent ? { to: "read", agent: agent.slice(0, 80) } : { to: "read" };
  }
  if (to === "mode") {
    const mode = fieldOf(text, "mode");
    if (mode === "companion" || mode === "relay")
      return reply ? { to: "mode", mode, reply } : { to: "mode", mode };
    return CURRENT;
  }
  const route = parseVoiceRoute(text, ids);
  const routed: FrontReply =
    reply && route.to !== "nobody" ? { ...route, reply } : route;
  // What was said, its addressing dropped, for the session it is for.
  const words = fieldOf(text, "words");
  return (route.to === "current" || route.to === "send") && words
    ? { ...routed, words }
    : routed;
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
  async event(request: {
    current: string;
    event: FrontEvent;
    sessions: VoiceSessionInfo[];
    context?: string;
    timeoutMs?: number;
  }): Promise<string> {
    const { event } = request;
    const agent = event.agent ? `\nAgent: ${event.agent}` : "";
    const head =
      event.kind === "answer"
        ? `ANSWER\nCurrent: ${request.current}${agent}\nAnswer:\n${event.text}`
        : event.kind === "progress"
          ? `PROGRESS\nCurrent: ${request.current}${agent}\nWritten so far:\n${event.text}`
          : `EVENT\nCurrent: ${request.current}\nWhat happened: ${event.text}`;
    const asked = this.ask(request.sessions, request.context ?? "", head).then(
      replyOf,
    );
    if (event.kind !== "answer")
      return within(asked, request.timeoutMs ?? EVENT_TIMEOUT_MS, "");
    const told = await within<string | null>(
      asked,
      request.timeoutMs ?? ANSWER_TIMEOUT_MS,
      null,
    );
    return told === null ? answerArrived(event) : companionReply(event, told);
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
