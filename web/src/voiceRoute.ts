import { useSyncExternalStore } from "react";
import { voiceMessage } from "../../shared/voiceMessage";
import { withAgentActivity } from "./agentOrder";
import type { State } from "./store";
import type { Pane, Workspace } from "./types";
import {
  type ConnectionAgentSessions,
  latestServerAgentSessions,
} from "./useAllServerAgentSessions";

/** Sent with voice requests; the server refuses them without it. */
const VOICE_HEADERS = { "x-roamgate-voice": "1" };

/** An agent session the user may name aloud (server voice-router.ts). */
export type VoiceSessionInfo = {
  /** `<connection>/<pane>`. */
  id: string;
  machine: string;
  workspace: string;
  title: string;
  folder: string;
  agent: string;
  status: string;
  /** Minutes since its session last changed, when known. */
  active?: number;
};

export type VoiceRoute = (
  | { to: "current" }
  | { to: "nobody" }
  | { to: "open" | "send"; pane: string; say: string }
  /** A question or request for Ranger, sent by the page. */
  | { to: "ranger" }
  /** A question for the reviews agent (Reviews' chat), sent by the page. */
  | { to: "reviews" }
  /** An errand handed to the errands session, followed by `job`. */
  | { to: "errand"; pane: string; say: string; job?: string }
  | { to: "ask"; panes: string[]; question: string }
  /** The front answered it itself, in `reply`: nothing is sent. */
  | { to: "self" }
  /** Read an agent's answer (the last, or `agent`'s) word for word. */
  | { to: "read"; agent?: string }
  /** Answers read whole from now on ("relay"), or told ("companion"). */
  | { to: "mode"; mode: "companion" | "relay" }
  /** Forget everything and start over; the server has done it (voice-memory.ts). */
  | { to: "reset" }
  /**
   * Looked up on the web in the background (server voice-research.ts):
   * `query`, followed by `job` (followResearch).
   */
  | { to: "web"; query: string; job?: string }
  /**
   * Done with the companion's MCP tools in the background (server
   * voice-tools.ts): `task`, followed by `job` as a web search is.
   */
  | { to: "tool"; task: string; job?: string }
) & {
  /** With a front (voiceFront.ts): what it says aloud now. */
  reply?: string;
  /**
   * Work for a session: what was said with only the session it addressed
   * dropped (checked by the server), for the companion to give it.
   */
  words?: string;
  /**
   * Work handed to an agent: the front's short note of what the words
   * refer to on the call ("ask it again" after which answer), sent after
   * them, quoted (voiceMessage).
   */
  context?: string;
  /**
   * Words the user said earlier that went to nobody, routed now since the
   * user said they were for the front (server recoveredWords): what is
   * handled, in place of what was just said.
   */
  recovered?: string;
};

/**
 * The routes this page knows, sent with each question: the server gives a
 * page of an older build only routes it knows.
 */
export const KNOWN_ROUTES: readonly VoiceRoute["to"][] = [
  "current",
  "nobody",
  "open",
  "send",
  "ranger",
  "reviews",
  "errand",
  "ask",
  "self",
  "read",
  "mode",
  "reset",
  "web",
  "tool",
];

/**
 * Ranger's chat as voice chat knows it: the session on screen for the
 * router (where a question for Ranger is for the one on screen), and the
 * voice chat's key, which does not follow the user to a workspace's agent.
 */
export const REVIEWS_VOICE_SESSION = "reviews";
/** The reviews agent's chat, in the Reviews panel: as Ranger's. */
export const REVIEWS_VOICE_KEY = {
  connectionId: "@reviews",
  paneId: "@reviews",
} as const;
export const RANGER_VOICE_SESSION = "ranger";
export const RANGER_VOICE_KEY = {
  connectionId: "@ranger",
  paneId: "@ranger",
} as const;

/** Whether a voice chat's key is Ranger's chat. */
export function isRangerVoice(
  key: { connectionId: string; paneId: string } | null | undefined,
): boolean {
  return (
    key?.connectionId === RANGER_VOICE_KEY.connectionId &&
    key.paneId === RANGER_VOICE_KEY.paneId
  );
}

export function voiceSessionId(connectionId: string, paneId: string) {
  return `${connectionId}/${paneId}`;
}

/** `<connection>/<pane>` back into its parts. */
export function parseVoiceSessionId(id: string | undefined) {
  // A route from a newer server may carry no session.
  if (typeof id !== "string") return null;
  const slash = id.indexOf("/");
  return slash < 0
    ? null
    : { connectionId: id.slice(0, slash), paneId: id.slice(slash + 1) };
}

function sessionsOf(
  connectionId: string,
  machine: string,
  workspaces: readonly Workspace[],
  panes: readonly Pane[],
): VoiceSessionInfo[] {
  const labels = new Map(
    workspaces.map((workspace) => [workspace.workspace_id, workspace.label]),
  );
  return panes
    .filter((pane) => pane.agent)
    .map((pane) => ({
      id: voiceSessionId(connectionId, pane.pane_id),
      machine,
      workspace: labels.get(pane.workspace_id) ?? "",
      title: pane.terminal_title_stripped ?? "",
      folder: (pane.foreground_cwd || pane.cwd || "").replace(
        / \(deleted\)$/,
        "",
      ),
      agent: pane.agent ?? "",
      status: pane.agent_status,
      ...(pane.last_activity_at
        ? { active: (Date.now() - pane.last_activity_at) / 60_000 }
        : {}),
    }));
}

/**
 * Every agent session on every connection, as `agent_sessions` lists them:
 * the displayed connection from the page's state, another one from the
 * topology the page read for it, else from the server's summary of all
 * connections (`connections.agent_sessions`, `others`). The page reads
 * another connection's topology only while "show all connections" is on,
 * so without the summary a call heard only the displayed connection's.
 */
export function voiceSessions(
  state: State,
  others:
    | readonly ConnectionAgentSessions[]
    | null = latestServerAgentSessions(),
): VoiceSessionInfo[] {
  const machine = (id: string) =>
    state.connections.find((connection) => connection.id === id)?.label || id;
  const sessions = sessionsOf(
    state.activeConnectionId,
    machine(state.activeConnectionId),
    state.workspaces,
    state.panes,
  );
  const ids = new Set([
    ...Object.keys(state.sessionsByConnectionId),
    ...state.connections.map((connection) => connection.id),
  ]);
  for (const id of ids) {
    if (id === state.activeConnectionId) continue;
    const session = state.sessionsByConnectionId[id];
    if (session && session.lastRefresh > 0 && !session.error) {
      sessions.push(
        ...sessionsOf(id, machine(id), session.workspaces, session.panes),
      );
      continue;
    }
    const connection = state.connections.find((each) => each.id === id);
    const summary = others?.find(
      (each) =>
        each.connection_id === id &&
        each.connection_generation === connection?.generation,
    );
    if (connection?.state === "ready" && summary && !summary.error) {
      sessions.push(
        ...sessionsOf(
          id,
          machine(id),
          summary.workspaces,
          withAgentActivity(summary.panes, summary.agents),
        ),
      );
    } else if (session) {
      sessions.push(
        ...sessionsOf(id, machine(id), session.workspaces, session.panes),
      );
    }
  }
  return sessions;
}

/** Who `said` is for, by the server's router; the current agent if unsure. */
export async function routeSpeech(
  said: string,
  current: string,
  sessions: VoiceSessionInfo[],
  /** With a front: Roamgate's state beyond the sessions (voiceFront.ts). */
  context?: string,
  /**
   * How the words came: said (by default), with the sentence being read
   * when the user cut in, or "typed". An errand gets words said marked
   * `[Voice]` as voice chat sends them, words typed as typed.
   */
  how: { interruptedAt?: string | null } | "typed" = {},
  /** On a companion call: what was heard and said on it lately. */
  recent?: string,
  /**
   * Hears what the front says as soon as it has written it, before the
   * route is decided (the server's `early`): said at once, it is the
   * turn's first answer.
   */
  onEarly?: (early: EarlyReply) => void,
  /**
   * With a front: what the user said lately that it routed to nobody,
   * for it to route after all when they say it was for it.
   */
  skipped?: readonly { text: string; at: number }[],
): Promise<VoiceRoute> {
  try {
    const response = await fetch("/api/voice/route", {
      method: "POST",
      headers: { ...VOICE_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        said,
        current,
        sessions,
        routes: KNOWN_ROUTES,
        ...(context ? { context } : {}),
        ...(recent ? { recent } : {}),
        ...(skipped?.length ? { skipped } : {}),
        ...(onEarly ? { stream: true } : {}),
        ...(how === "typed"
          ? { typed: true }
          : how.interruptedAt
            ? { interrupted_at: how.interruptedAt }
            : {}),
      }),
    });
    if (!response.ok) return { to: "current" };
    const route = (
      onEarly &&
      response.body &&
      response.headers.get("content-type")?.startsWith("application/x-ndjson")
        ? await streamedRoute(response.body, onEarly)
        : await response.json()
    ) as VoiceRoute;
    return KNOWN_ROUTES.includes(route?.to) ? route : { to: "current" };
  } catch {
    return { to: "current" };
  }
}

/** What the front says of a turn, written before its route is decided. */
export type EarlyReply = { to: string; reply: string };

/**
 * A streamed route (NDJSON): `{"early": {to, reply}}` lines as they come,
 * told to `onEarly`, then the route itself, last.
 */
export async function streamedRoute(
  body: ReadableStream<Uint8Array>,
  onEarly: (early: EarlyReply) => void,
): Promise<unknown> {
  const decoder = new TextDecoder();
  let buffered = "";
  let last: unknown = null;
  const take = (line: string) => {
    if (!line.trim()) return;
    const value = JSON.parse(line) as { early?: unknown };
    const early = value?.early as Partial<EarlyReply> | undefined;
    if (
      early &&
      typeof early.to === "string" &&
      typeof early.reply === "string"
    ) {
      try {
        onEarly({ to: early.to, reply: early.reply });
      } catch {
        // Its listener's trouble: the route still comes.
      }
      return;
    }
    last = value;
  };
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      take(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
    if (done) break;
  }
  take(buffered);
  return last;
}

/**
 * What the front tells of `event` now; "" to stay quiet. `kind` "answer"
 * gives it an agent's whole answer, "progress" what one wrote while it
 * works; `agent` names who wrote it.
 */
export async function tellVoiceEvent(
  event: string,
  current: string,
  sessions: VoiceSessionInfo[],
  context: string,
  about: { kind?: "event" | "answer" | "progress"; agent?: string } = {},
): Promise<string> {
  try {
    const response = await fetch("/api/voice/event", {
      method: "POST",
      headers: { ...VOICE_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ event, current, sessions, context, ...about }),
    });
    if (!response.ok) return "";
    const { reply } = (await response.json()) as { reply?: unknown };
    return typeof reply === "string" ? reply : "";
  } catch {
    return "";
  }
}

/**
 * Gives the words, as said, to a session for the voice companion: a job
 * whose answer followErrand follows; null when it could not be sent. Words `spoken`
 * go marked `[Voice]` as voice chat sends them, with the sentence the user
 * cut off and the front's note of what they refer to; words typed go as
 * typed.
 */
export async function forwardWork(
  pane: string,
  words: string,
  spoken?: { interruptedAt?: string | null; context?: string | null },
): Promise<{ job: string } | null> {
  try {
    const response = await fetch("/api/voice/forward", {
      method: "POST",
      headers: { ...VOICE_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        pane,
        words: spoken
          ? voiceMessage(words, spoken.interruptedAt, spoken.context)
          : words,
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      job?: unknown;
    } | null;
    if (!response.ok) return null;
    return typeof body?.job === "string" ? { job: body.job } : null;
  } catch {
    return null;
  }
}

/** What the companion says when work could not start on a session. */
export function forwardFailedLine(label: string, french: boolean): string {
  return french
    ? `Je n'ai pas pu lancer ça sur ${label}.`
    : `I could not start that on ${label}.`;
}

/** What is worth telling of a job that runs (server voice-errands.ts). */
export type ErrandNotice =
  | { seq: number; kind: "waiting"; what: string | null }
  | { seq: number; kind: "working"; minutes: number };

export type ErrandState = {
  done: boolean;
  answer: string | null;
  notice: ErrandNotice | null;
};

/**
 * What a notice says of `label`, plainly: still working and for how long,
 * or waiting for the user's OK and on what.
 */
export function errandNoticeText(label: string, notice: ErrandNotice): string {
  if (notice.kind === "waiting")
    return notice.what
      ? `${label} is waiting for your OK: ${notice.what}`
      : `${label} is waiting for your OK`;
  const minutes = Math.max(1, notice.minutes);
  return `${label} is still working (${minutes} min since its last message)`;
}

/**
 * Follows an errand until its answer is in, telling each new notice, and
 * when one no longer holds (null); the answer, or null without one.
 */
export async function followErrand(
  job: string,
  onState: (state: ErrandState) => void,
): Promise<string | null> {
  let told: number | null = null;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    let state: ErrandState;
    try {
      const response = await fetch(
        `/api/voice/errand?job=${encodeURIComponent(job)}`,
      );
      if (!response.ok) return null;
      state = (await response.json()) as ErrandState;
    } catch {
      continue;
    }
    if (state.done) return state.answer;
    const seq = state.notice?.seq ?? null;
    if (seq !== told) {
      told = seq;
      onState(state);
    }
  }
}

/** A web search the companion started (server voice-research.ts). */
export type ResearchJob = {
  id: string;
  question: string;
  status: "searching" | "done" | "failed" | "cancelled";
  /** What it did so far: "Searching: ...", "Reading example.org". */
  steps: string[];
  started: number;
  finished?: number;
  /** What is said of it. */
  spoken?: string;
  /** The whole answer, Markdown with links. */
  answer?: string;
  sources?: { title: string; url: string }[];
  error?: string;
  /**
   * A tool job's call held for the user's yes (server voice-tools.ts): the
   * tool and its exact input, not made; and whether it was made or not.
   */
  held?: { tool: string; input: unknown };
  heldOutcome?: "confirmed" | "declined";
};

/** A web search as it is now; null when it is gone or unreachable. */
export async function researchState(job: string): Promise<ResearchJob | null> {
  return jobState("research", job);
}

/**
 * A job of the companion's tools as it is now (server voice-tools.ts),
 * shaped as a web search; null when it is gone or unreachable.
 */
export async function toolState(job: string): Promise<ResearchJob | null> {
  return jobState("tools", job);
}

async function jobState(
  kind: "research" | "tools",
  job: string,
): Promise<ResearchJob | null> {
  try {
    const response = await fetch(
      `/api/voice/${kind}?job=${encodeURIComponent(job)}`,
    );
    if (!response.ok) return null;
    return (await response.json()) as ResearchJob;
  } catch {
    return null;
  }
}

/** Stops a web search, or all those running; whether any was. */
export async function cancelResearch(job?: string): Promise<boolean> {
  return cancelJob("research", job);
}

/** Stops a job of the companion's tools; whether it was running. */
export async function cancelTool(job: string): Promise<boolean> {
  return cancelJob("tools", job);
}

/**
 * The user's click on a call a tool job holds for their yes: "yes" makes
 * it (the job that does, back), "no" forgets it. "gone" when nothing of
 * that job waits any more (answered, or forgotten after 5 minutes); null
 * when the server could not be reached or refused.
 */
export async function answerHeldTool(
  job: string,
  answer: "yes" | "no",
): Promise<{ job: ResearchJob } | { declined: true } | "gone" | null> {
  try {
    const response = await fetch("/api/voice/tools/answer", {
      method: "POST",
      headers: { ...VOICE_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ job, answer }),
    });
    if (response.status === 409) return "gone";
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as {
      job?: ResearchJob;
      declined?: unknown;
    } | null;
    if (answer === "no") return body?.declined ? { declined: true } : null;
    return typeof body?.job?.id === "string" ? { job: body.job } : null;
  } catch {
    return null;
  }
}

async function cancelJob(
  kind: "research" | "tools",
  job?: string,
): Promise<boolean> {
  try {
    const response = await fetch(`/api/voice/${kind}/cancel`, {
      method: "POST",
      headers: { ...VOICE_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(job ? { job } : {}),
    });
    if (!response.ok) return false;
    const { cancelled } = (await response.json()) as { cancelled?: unknown };
    return Array.isArray(cancelled) && cancelled.length > 0;
  } catch {
    return false;
  }
}

/** A voice chat going on in another pane, which picks it up when shown. */
type Handoff = {
  connectionId: string;
  paneId: string;
  /** What to send it first, as said. */
  message: string | null;
  /** Rather, the voice chat of this very pane, shown again (a reconnect). */
  resume?: VoiceResume;
  at: number;
};

/** Where a voice chat was: the message whose answer it awaited. */
export type VoiceResume = {
  sent: string;
  /** The agent's messages already read out. */
  read: string[];
};

/** A handoff not taken by then is dropped: that pane never showed. */
const HANDOFF_MS = 30_000;
let handoff: Handoff | null = null;

export function handOffVoice(next: Omit<Handoff, "at">) {
  handoff = { ...next, at: Date.now() };
}

/** Whether a voice chat is on its way to this pane, not yet taken. */
export function voiceHandoffPending(connectionId: string, paneId: string) {
  return (
    !!handoff &&
    handoff.connectionId === connectionId &&
    handoff.paneId === paneId &&
    Date.now() - handoff.at <= HANDOFF_MS
  );
}

/** The voice chat handed to this pane, once. */
export function takeVoiceHandoff(
  connectionId: string,
  paneId: string,
): { message: string | null; resume?: VoiceResume } | null {
  const taken = handoff;
  if (
    !taken ||
    taken.connectionId !== connectionId ||
    taken.paneId !== paneId ||
    Date.now() - taken.at > HANDOFF_MS
  )
    return null;
  handoff = null;
  return { message: taken.message, resume: taken.resume };
}

/**
 * What the router itself last said (a switch, its question), or Ranger's
 * answer to a question said aloud, shown apart from the conversation with
 * the agent.
 */
export type RouterNote = {
  text: string;
  at: number;
  /** Who says it: Roamgate's router, or Ranger answering. */
  from: string;
  /** Where the full answer is: Ranger's chat, or a session's. */
  open?: RouterNoteTarget;
};
export type RouterNoteTarget =
  | { ranger: true }
  | { reviews: true }
  | { connectionId: string; paneId: string };

let note: RouterNote | null = null;
const noteListeners = new Set<() => void>();

/** Markdown marks an answer may carry, gone: the card shows plain text. */
export function plainText(text: string) {
  return text
    .replace(/```[\w-]*\n?/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ");
}

export function showRouterNote(
  text: string | null,
  from = "Roamgate",
  open?: RouterNoteTarget,
) {
  note = text
    ? { text: plainText(text), at: Date.now(), from, ...(open ? { open } : {}) }
    : null;
  for (const listener of noteListeners) listener();
}

export function useRouterNote(): RouterNote | null {
  return useSyncExternalStore(
    (listener) => {
      noteListeners.add(listener);
      return () => noteListeners.delete(listener);
    },
    () => note,
  );
}
