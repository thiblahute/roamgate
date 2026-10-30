import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AgentChatPhase } from "../../shared/agentChat";
import { requestAgentChatHandover } from "./agentChat";
import type { ConnectionClient } from "./api";
import { agentStateKind } from "./components/agentSession";

/**
 * The user's "Switch to conversation mode" on a terminal-mode Claude pane:
 * the only way a session goes to conversation mode, besides the bridge's
 * own recovery. Asked at once when Claude is not busy; while a turn runs
 * or a question waits, it is armed instead and goes once Herdr reports the
 * turn over, unless cancelled. Claude idle with background work running (a
 * shell, a monitor) is not idle: exiting would stop it. The bridge says so,
 * and the switch waits on, asking again a while later, each time later.
 *
 * Kept per pane outside React: the phone's bottom bar, the pane's toolbar
 * and the History inspector all ask for the same switch, and the pane's
 * terminal strip shows it.
 */
export const BACKGROUND_RETRY_MS = 5000;
export const BACKGROUND_RETRY_MAX_MS = 60_000;

type Pending = {
  /** The bridge said background work still runs: asked again later. */
  waiting: boolean;
  /** The next wait after a background-work refusal. */
  delay: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** A request is out: nothing more is asked until it answers. */
  asking: boolean;
  /** Bumped each time the wait is over: the drivers look again. */
  tick: number;
  /**
   * The other pane whose idle claude runs the session too, which the user
   * chose to quit first: asked with the first request only.
   */
  quitWriter?: string;
};

export type ConversationSwitchState = "none" | "armed" | "waiting" | "asking";

const pending = new Map<string, Pending>();
const listeners = new Set<() => void>();

const keyOf = (connectionId: string, paneId: string) =>
  `${connectionId}\u0000${paneId}`;

function changed() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The user asked for the switch: armed until it goes or is cancelled.
 * `quitWriter`: quit the idle claude that other pane runs the session in
 * first (the strip's "Quit it and switch").
 */
export function requestConversationSwitch(
  connectionId: string,
  paneId: string,
  retryMs = BACKGROUND_RETRY_MS,
  quitWriter?: string,
) {
  const key = keyOf(connectionId, paneId);
  if (pending.has(key)) return;
  pending.set(key, {
    waiting: false,
    delay: retryMs,
    timer: null,
    asking: false,
    tick: 0,
    ...(quitWriter ? { quitWriter } : {}),
  });
  changed();
}

/** Cancelled: an answer to a request already out arms nothing. */
export function cancelConversationSwitch(connectionId: string, paneId: string) {
  const key = keyOf(connectionId, paneId);
  const entry = pending.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pending.delete(key);
  changed();
}

function snapshotOf(key: string): string {
  const entry = pending.get(key);
  if (!entry) return "none";
  const state: ConversationSwitchState = entry.asking
    ? "asking"
    : entry.waiting
      ? "waiting"
      : "armed";
  return `${state}#${entry.tick}`;
}

/** What the user's switch on a pane does now, outside React. */
export function conversationSwitchState(
  connectionId: string,
  paneId: string,
): ConversationSwitchState {
  return snapshotOf(keyOf(connectionId, paneId)).split(
    "#",
  )[0] as ConversationSwitchState;
}

/** What the user's switch on a pane does now, for its buttons and strip. */
export function useConversationSwitchState(
  connectionId: string | null | undefined,
  paneId: string | null | undefined,
): ConversationSwitchState {
  const key = connectionId && paneId ? keyOf(connectionId, paneId) : null;
  const read = () => (key ? snapshotOf(key) : "none");
  const value = useSyncExternalStore(subscribe, read, read);
  return value.split("#")[0] as ConversationSwitchState;
}

/**
 * Drives the user's switch for one pane: asks the bridge once Claude is
 * not busy, and again after a background-work refusal. Several views may
 * drive the same pane: one request is out at a time.
 */
export function useConversationSwitch({
  client,
  paneId,
  phase,
  handing,
  agentStatus,
  retryMs = BACKGROUND_RETRY_MS,
  retryMaxMs = BACKGROUND_RETRY_MAX_MS,
}: {
  client: ConnectionClient;
  paneId: string | null | undefined;
  /** The session's phase, null while not known. */
  phase: AgentChatPhase | null | undefined;
  /** A handover this browser asked for is out. */
  handing: boolean;
  /** Herdr's status of the pane's agent: whether the terminal is busy. */
  agentStatus: string | undefined;
  /** The first wait after a background-work refusal. */
  retryMs?: number;
  retryMaxMs?: number;
}): {
  state: ConversationSwitchState;
  /** Claude works or waits on a question in the terminal. */
  busy: boolean;
  request: () => void;
  /**
   * The switch, once the idle claude the other pane runs the session in
   * has quit (the strip's "Quit it and switch").
   */
  quitAndSwitch: (writerPaneId: string) => void;
  cancel: () => void;
} {
  const connectionId = client.connectionId;
  const key = paneId ? keyOf(connectionId, paneId) : null;
  const read = () => (key ? snapshotOf(key) : "none");
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const kind = agentStateKind(agentStatus);
  const busy = kind === "working" || kind === "blocked";
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot carries the tick that asks again
  useEffect(() => {
    if (!key || !paneId) return;
    const entry = pending.get(key);
    if (!entry || !phase) return;
    // Someone else moved the session (the user's switch on another
    // device): nothing left to switch.
    if (phase !== "terminal") {
      cancelConversationSwitch(connectionId, paneId);
      return;
    }
    if (entry.timer || entry.asking || handing || busy) return;
    entry.asking = true;
    const quitWriter = entry.quitWriter;
    // The quit is the user's one choice: never asked again by itself.
    delete entry.quitWriter;
    changed();
    void requestAgentChatHandover(client, paneId, "conversation", {
      quitWriter,
    }).then((result) => {
      // Cancelled meanwhile.
      if (pending.get(key) !== entry) return;
      entry.asking = false;
      if (!result.ok && result.waiting === "background_tasks") {
        // Not idle after all: waiting for the work to end.
        entry.waiting = true;
        const wait = entry.delay;
        entry.delay = Math.min(retryMaxMs, wait * 2);
        entry.timer = setTimeout(() => {
          entry.timer = null;
          entry.tick += 1;
          changed();
        }, wait);
        changed();
        return;
      }
      // Done, or refused for another reason (kept on the snapshot).
      pending.delete(key);
      changed();
    });
  }, [
    busy,
    client,
    connectionId,
    handing,
    key,
    paneId,
    phase,
    retryMaxMs,
    snapshot,
  ]);
  const request = useCallback(() => {
    if (paneId) requestConversationSwitch(connectionId, paneId, retryMs);
  }, [connectionId, paneId, retryMs]);
  const quitAndSwitch = useCallback(
    (writerPaneId: string) => {
      if (paneId)
        requestConversationSwitch(connectionId, paneId, retryMs, writerPaneId);
    },
    [connectionId, paneId, retryMs],
  );
  const cancel = useCallback(() => {
    if (!paneId) return;
    cancelConversationSwitch(connectionId, paneId);
    // A Claude asked to exit that did not is no longer waited for: the
    // next switch asks again.
    void client
      .call("agent_chat.handover.cancel", { pane_id: paneId })
      .catch(() => undefined);
  }, [client, connectionId, paneId]);
  return {
    state: snapshot.split("#")[0] as ConversationSwitchState,
    busy,
    request,
    quitAndSwitch,
    cancel,
  };
}

/** For tests: forgets every switch asked. */
export function __resetConversationSwitchesForTests() {
  for (const entry of pending.values())
    if (entry.timer) clearTimeout(entry.timer);
  pending.clear();
  changed();
}
