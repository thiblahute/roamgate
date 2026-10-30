import { useSyncExternalStore } from "react";
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

export type VoiceRoute =
  | { to: "current" }
  | { to: "nobody" }
  | { to: "open" | "send"; pane: string; say: string }
  /** A question about another session, with the summary to say. */
  | { to: "status"; pane: string; say: string; answer?: string }
  /** A question about the sessions in general, with the summary to say. */
  | { to: "overview"; answer?: string }
  /** An errand handed to the errands session, followed by `job`. */
  | { to: "errand"; pane: string; say: string; job?: string }
  | { to: "ask"; panes: string[]; question: string };

export function voiceSessionId(connectionId: string, paneId: string) {
  return `${connectionId}/${paneId}`;
}

/** `<connection>/<pane>` back into its parts. */
export function parseVoiceSessionId(id: string) {
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
): Promise<VoiceRoute> {
  try {
    const response = await fetch("/api/voice/route", {
      method: "POST",
      headers: { ...VOICE_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ said, current, sessions }),
    });
    if (!response.ok) return { to: "current" };
    return (await response.json()) as VoiceRoute;
  } catch {
    return { to: "current" };
  }
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

/** A voice chat going on in another pane, which picks it up when shown. */
type Handoff = {
  connectionId: string;
  paneId: string;
  /** What to send it first, as said. */
  message: string | null;
  at: number;
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
): { message: string | null } | null {
  const taken = handoff;
  if (
    !taken ||
    taken.connectionId !== connectionId ||
    taken.paneId !== paneId ||
    Date.now() - taken.at > HANDOFF_MS
  )
    return null;
  handoff = null;
  return { message: taken.message };
}

/**
 * What the router itself last said (a switch, its question, a summary of
 * another session), shown apart from the conversation with the agent.
 */
export type RouterNote = { text: string; at: number };

let note: RouterNote | null = null;
const noteListeners = new Set<() => void>();

/** Markdown marks an answer may carry, gone: the card shows plain text. */
export function plainText(text: string) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ");
}

export function showRouterNote(text: string | null) {
  note = text ? { text: plainText(text), at: Date.now() } : null;
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
