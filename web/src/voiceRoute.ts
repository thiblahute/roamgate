import { useSyncExternalStore } from "react";
import { voiceMessage } from "../../shared/voiceMessage";
import type { State } from "./store";
import type { Pane, Workspace } from "./types";

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
  /**
   * Looked up on the web in the background (server voice-research.ts):
   * `query`, followed by `job` (followResearch).
   */
  | { to: "web"; query: string; job?: string }
) & {
  /** With a front (voiceFront.ts): what it says aloud now. */
  reply?: string;
  /**
   * Work for a session: what was said with only the session it addressed
   * dropped (checked by the server), for the companion to give it.
   */
  words?: string;
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
  "web",
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

/** Every agent session the page knows, on every connection it reads. */
export function voiceSessions(state: State): VoiceSessionInfo[] {
  const machine = (id: string) =>
    state.connections.find((connection) => connection.id === id)?.label || id;
  const sessions = sessionsOf(
    state.activeConnectionId,
    machine(state.activeConnectionId),
    state.workspaces,
    state.panes,
  );
  for (const [id, session] of Object.entries(state.sessionsByConnectionId)) {
    if (id === state.activeConnectionId) continue;
    sessions.push(
      ...sessionsOf(id, machine(id), session.workspaces, session.panes),
    );
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
        ...(how === "typed"
          ? { typed: true }
          : how.interruptedAt
            ? { interrupted_at: how.interruptedAt }
            : {}),
      }),
    });
    if (!response.ok) return { to: "current" };
    const route = (await response.json()) as VoiceRoute;
    return KNOWN_ROUTES.includes(route?.to) ? route : { to: "current" };
  } catch {
    return { to: "current" };
  }
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
 * cut off; words typed go as typed.
 */
export async function forwardWork(
  pane: string,
  words: string,
  spoken?: { interruptedAt?: string | null },
): Promise<{ job: string } | null> {
  try {
    const response = await fetch("/api/voice/forward", {
      method: "POST",
      headers: { ...VOICE_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        pane,
        words: spoken ? voiceMessage(words, spoken.interruptedAt) : words,
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

export type ErrandState = {
  done: boolean;
  answer: string | null;
  stalled: boolean;
};

/**
 * Follows an errand until its answer is in, telling each change of state;
 * the answer, or null without one.
 */
export async function followErrand(
  job: string,
  onState: (state: ErrandState) => void,
): Promise<string | null> {
  let stalled = false;
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
    if (state.stalled !== stalled) {
      stalled = state.stalled;
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
};

/** A web search as it is now; null when it is gone or unreachable. */
export async function researchState(job: string): Promise<ResearchJob | null> {
  try {
    const response = await fetch(
      `/api/voice/research?job=${encodeURIComponent(job)}`,
    );
    if (!response.ok) return null;
    return (await response.json()) as ResearchJob;
  } catch {
    return null;
  }
}

/** Stops a web search, or all those running; whether any was. */
export async function cancelResearch(job?: string): Promise<boolean> {
  try {
    const response = await fetch("/api/voice/research/cancel", {
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
