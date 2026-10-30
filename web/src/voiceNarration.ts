/**
 * Voice chat's spoken progress: while Claude works on a message, now and
 * then a short sentence says what it does ("Running a command: restack the
 * voice layers", "Reading voice ack"), taken from the tool calls of the
 * conversation-mode stream. Sparse, never over a reply or an ack, in the
 * language of what was said. Only played: never sent, never shown.
 */

import type { AgentChatEvent } from "../../shared/agentChat";
import {
  ACK_CUT_MS,
  type AckLanguage,
  type AckSpeech,
  ackLanguage,
} from "./voiceAck";

/** At most one update this often. */
export const NARRATION_GAP_MS = 5_000;
/** An agent or a long command waits this long after anything said. */
export const NARRATION_BREATH_MS = 5_000;
/** A quick read or search waits this long after anything said. */
export const NARRATION_QUIET_MS = 5_000;
/** A command still running this long is worth saying. */
export const LONG_COMMAND_MS = 3_000;
/** A quick tool is news this long after it started, or while it runs. */
export const QUICK_FRESH_MS = 8_000;
/** An agent or a workflow is news this long after it started. */
export const LONG_FRESH_MS = 20_000;
/** How often whether an update is due is looked at. */
const NARRATION_TICK_MS = 250;
/** A description longer than this many words is cut. */
const MAX_WORDS = 12;

type Phrases = {
  command: string;
  commandBare: string;
  agent: string;
  agentBare: string;
  workflow: string;
  workflowBare: string;
  watching: string;
  read: string;
  edit: string;
  write: string;
  search: string;
  web: string;
  page: string;
};

// `{}` is the description or the file's name.
const PHRASES: Record<AckLanguage, Phrases> = {
  en: {
    command: "Running a command: {}.",
    commandBare: "Running a command.",
    agent: "I started an agent: {}.",
    agentBare: "I started an agent.",
    workflow: "I started a workflow: {}.",
    workflowBare: "I started a workflow.",
    watching: "Watching: {}.",
    read: "Reading {}.",
    edit: "Editing {}.",
    write: "Writing {}.",
    search: "Searching the code.",
    web: "Searching the web.",
    page: "Reading a web page.",
  },
  fr: {
    command: "Je lance une commande : {}.",
    commandBare: "Je lance une commande.",
    agent: "J'ai lancé un agent : {}.",
    agentBare: "J'ai lancé un agent.",
    workflow: "J'ai lancé un workflow : {}.",
    workflowBare: "J'ai lancé un workflow.",
    watching: "Je surveille : {}.",
    read: "Je lis {}.",
    edit: "Je modifie {}.",
    write: "J'écris {}.",
    search: "Je cherche dans le code.",
    web: "Je cherche sur le web.",
    page: "Je lis une page web.",
  },
  es: {
    command: "Ejecuto un comando: {}.",
    commandBare: "Ejecuto un comando.",
    agent: "He lanzado un agente: {}.",
    agentBare: "He lanzado un agente.",
    workflow: "He lanzado un flujo de trabajo: {}.",
    workflowBare: "He lanzado un flujo de trabajo.",
    watching: "Vigilo: {}.",
    read: "Leo {}.",
    edit: "Edito {}.",
    write: "Escribo {}.",
    search: "Busco en el código.",
    web: "Busco en la web.",
    page: "Leo una página web.",
  },
};

const field = (input: unknown, key: string): string => {
  if (!input || typeof input !== "object") return "";
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
};

/**
 * A tool's description as said after a prefix: on one line, no code marks,
 * a few words at most, no final stop, its first letter lowercased unless it
 * starts a name or an acronym ("GStreamer", "CI").
 */
export function spokenDescription(description: string): string {
  const words = description
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?;:,\s]+$/, "")
    .split(" ")
    .filter(Boolean);
  const text = words.slice(0, MAX_WORDS).join(" ");
  return /^\p{Lu}\p{Ll}/u.test(text)
    ? text[0]!.toLowerCase() + text.slice(1)
    : text;
}

/**
 * A file's name as it is said: no folders, no extension, words apart
 * ("useVoiceChat.ts" is "use voice chat", "voiceAck.test.ts" is "voice ack
 * test"), so speech does not spell "dot t s" or run words together.
 */
export function spokenFileName(path: string): string {
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const stem = base.includes(".", 1)
    ? base.slice(0, base.lastIndexOf("."))
    : base;
  return stem
    .replace(/^\./, "")
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) =>
      // Long capitals are words ("README"); short ones are spelled ("HTML").
      /^\p{Lu}{5,}$/u.test(word) || /^\p{Lu}\p{Ll}/u.test(word)
        ? word.toLowerCase()
        : word,
    )
    .join(" ");
}

/** What is said of a tool call, in `language`; null for a tool not told. */
export function narrationLine(
  name: string,
  input: unknown,
  language: AckLanguage = "en",
): string | null {
  const phrases = PHRASES[language];
  const withText = (phrase: string, bare: string | null, text: string) =>
    text ? phrase.replace("{}", text) : bare;
  const file = () =>
    spokenFileName(field(input, "file_path") || field(input, "notebook_path"));
  const described = spokenDescription(field(input, "description"));
  switch (name) {
    case "Bash":
      return withText(phrases.command, phrases.commandBare, described);
    case "Agent":
    case "Task":
      return withText(phrases.agent, phrases.agentBare, described);
    case "Workflow":
      return withText(phrases.workflow, phrases.workflowBare, described);
    case "Monitor":
      return withText(phrases.watching, null, described);
    case "Read":
      return withText(phrases.read, null, file());
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return withText(phrases.edit, null, file());
    case "Write":
      return withText(phrases.write, null, file());
    case "Grep":
    case "Glob":
      return phrases.search;
    case "WebSearch":
      return phrases.web;
    case "WebFetch":
      return phrases.page;
    default:
      return null;
  }
}

/** A tool call seen in the turn. */
export type NarratedTool = {
  name: string;
  input: unknown;
  startedAt: number;
  running: boolean;
};

/**
 * Whether a tool is worth saying even soon after something else was said:
 * an agent, a workflow, a monitor, or a command running for a while.
 */
export function isLongTool(tool: NarratedTool, now: number): boolean {
  switch (tool.name) {
    case "Agent":
    case "Task":
    case "Workflow":
    case "Monitor":
      return true;
    case "Bash":
      return tool.running && now - tool.startedAt >= LONG_COMMAND_MS;
    default:
      return false;
  }
}

/** Whether a tool is still news: it runs, or started a moment ago. */
export function isFresh(tool: NarratedTool, now: number): boolean {
  if (tool.running) return true;
  const fresh =
    tool.name === "Agent" || tool.name === "Task" || tool.name === "Workflow"
      ? LONG_FRESH_MS
      : QUICK_FRESH_MS;
  return now - tool.startedAt < fresh;
}

/** Whether an update about a tool, long or quick, is to be said now. */
export function narrationDue(state: {
  /** Something plays, or the user talks: not now. */
  busy: boolean;
  /** Since anything was said (or the message sent). */
  sinceSaid: number;
  /** Since the last update; Infinity before the first. */
  sinceNarrated: number;
  long: boolean;
}): boolean {
  if (state.busy || state.sinceNarrated < NARRATION_GAP_MS) return false;
  return (
    state.sinceSaid >= (state.long ? NARRATION_BREATH_MS : NARRATION_QUIET_MS)
  );
}

/**
 * The tool to tell of now, if any: the latest long one not told yet that is
 * still news, else the latest one if it is still news and not told.
 */
export function pickTool<T extends NarratedTool & { told: boolean }>(
  tools: readonly T[],
  now: number,
): { tool: T; long: boolean } | null {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index]!;
    if (!tool.told && isLongTool(tool, now) && isFresh(tool, now))
      return { tool, long: true };
  }
  const latest = tools[tools.length - 1];
  if (latest && !latest.told && isFresh(latest, now))
    return { tool: latest, long: false };
  return null;
}

export type TurnNarration = {
  /** The stream's events: tool calls starting and ending. */
  handle(event: AgentChatEvent): void;
  /** The reply is fetched or read now: an update on its way is dropped. */
  activity(): void;
  /** Whether an update plays now. */
  playing(): boolean;
  /** The user talks over it: the update playing stops. */
  hush(): void;
  /** Resolves when no update plays: the one playing ends, cut past ACK_CUT_MS. */
  quiet(): Promise<void>;
  /** No update anymore this turn; resolves as quiet() does. */
  end(): Promise<void>;
};

/**
 * The spoken updates of one turn, from the message sent (`said`, its words)
 * until end() or `signal` aborts. `onSpoken` hears each update as it starts
 * playing (so "still working" knows something was said).
 */
export function startTurnNarration<Speech>({
  said,
  signal,
  busy,
  speech,
  onSpoken,
  now = () => performance.now(),
}: {
  said: string;
  signal: AbortSignal;
  /** Something else plays (a sentence, an ack) or the user talks. */
  busy: () => boolean;
  speech: AckSpeech<Speech>;
  onSpoken?: () => void;
  now?: () => number;
}): TurnNarration {
  const language = ackLanguage(said);
  let saidAt = now();
  let narratedAt = Number.NEGATIVE_INFINITY;
  let activityAt = saidAt;
  let ended = signal.aborted;
  const life = new AbortController();
  const stopLife = () => life.abort();
  if (ended) life.abort();
  else signal.addEventListener("abort", stopLife, { once: true });
  type Tool = NarratedTool & { id: string; told: boolean };
  const tools: Tool[] = [];
  const byId = new Map<string, Tool>();
  let fetching: AbortController | null = null;
  let playing: { controller: AbortController; done: Promise<void> } | null =
    null;

  const say = (tool: Tool, text: string, long: boolean) => {
    tool.told = true;
    const chosenAt = now();
    const toolsThen = tools.length;
    const controller = new AbortController();
    fetching = controller;
    const stop = AbortSignal.any([controller.signal, life.signal]);
    speech
      .fetchAudio(text, language, stop)
      .then((audio) => {
        if (fetching === controller) fetching = null;
        // Stale news is worse than none: the reply started meanwhile, a
        // newer tool did (an agent or a workflow started is still news),
        // or something else plays now.
        const newer =
          tools.length > toolsThen &&
          !(
            long &&
            (tool.name === "Agent" ||
              tool.name === "Task" ||
              tool.name === "Workflow")
          );
        if (stop.aborted || activityAt > chosenAt || newer || busy()) return;
        narratedAt = saidAt = now();
        onSpoken?.();
        const done = speech
          .playAudio(audio, stop)
          .catch(() => {})
          .finally(() => {
            if (playing?.controller === controller) playing = null;
            saidAt = now();
          });
        playing = { controller, done };
      })
      .catch(() => {
        if (fetching === controller) fetching = null;
      });
  };

  const tick = () => {
    if (ended || life.signal.aborted || playing || fetching) return;
    const at = now();
    // Whatever plays, and the user talking, count as said.
    if (busy()) {
      saidAt = at;
      return;
    }
    const picked = pickTool(tools, at);
    if (!picked) return;
    if (
      !narrationDue({
        busy: false,
        sinceSaid: at - saidAt,
        sinceNarrated: at - narratedAt,
        long: picked.long,
      })
    )
      return;
    const text = narrationLine(picked.tool.name, picked.tool.input, language);
    if (!text) {
      picked.tool.told = true;
      return;
    }
    say(picked.tool, text, picked.long);
  };
  const timer = setInterval(tick, NARRATION_TICK_MS);
  const stopTimer = () => clearInterval(timer);
  life.signal.addEventListener("abort", stopTimer, { once: true });

  const quiet = async () => {
    const current = playing;
    if (!current) return;
    let cut: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      current.done,
      new Promise<void>((resolve) => {
        cut = setTimeout(() => {
          current.controller.abort();
          resolve();
        }, ACK_CUT_MS);
      }),
    ]);
    clearTimeout(cut);
  };

  return {
    handle(event) {
      if (ended) return;
      if (event.type === "tool_use") {
        if (byId.has(event.tool_use_id)) return;
        const tool: Tool = {
          id: event.tool_use_id,
          name: event.name,
          input: event.input,
          startedAt: now(),
          running: true,
          told: false,
        };
        tools.push(tool);
        byId.set(tool.id, tool);
      } else if (event.type === "tool_result") {
        const tool = byId.get(event.tool_use_id);
        if (tool) tool.running = false;
      }
    },
    activity() {
      activityAt = saidAt = now();
      fetching?.abort();
      fetching = null;
    },
    playing: () => playing !== null,
    hush() {
      fetching?.abort();
      fetching = null;
      playing?.controller.abort();
    },
    quiet,
    async end() {
      ended = true;
      stopTimer();
      fetching?.abort();
      fetching = null;
      await quiet();
      signal.removeEventListener("abort", stopLife);
      life.abort();
    },
  };
}
