import { useEffect } from "react";
import type { ConnectionClient } from "./api";
import { recordLocalSeen } from "./localSeen";
import { activePaneIdForSnapshot } from "./paneJump";
import { store } from "./store";
import { useConnectionClient } from "./useConnectionClient";

type Snapshot = ReturnType<typeof store.get>;

/**
 * The agents the user is looking at: every agent of the workspace on screen,
 * in every tab, as Herdr counts its focused Space seen. Focusing a workspace
 * by any path (the tree, the switcher, Find, a jump) shows it, so its agents
 * are seen there, whatever pane is displayed.
 */
export function panesOnScreen(snapshot: Snapshot): string[] {
  const active = activePaneIdForSnapshot(snapshot);
  if (!active) return [];
  const workspaceId = snapshot.panes.find(
    (pane) => pane.pane_id === active,
  )?.workspace_id;
  if (workspaceId === undefined) return [active];
  return snapshot.panes
    .filter((pane) => pane.workspace_id === workspaceId)
    .map((pane) => pane.pane_id);
}

/**
 * Tells the server which agents the user looks at, in a visible and focused
 * window: when one comes on screen and when it leaves (when they last
 * looked), and each finished state seen, which is then no longer Done on any
 * device until the next turn ends (server agent-seen.ts). Herdr's own Done
 * depends on where Herdr is focused, which a browser does not follow.
 * `seenLocally` gets each check's marks as they are sent, so the page's
 * lists can show them at once. Returns the function that stops watching.
 */
export function watchAgentsSeen({
  client,
  getSnapshot,
  subscribe,
  refresh,
  win,
  doc,
  seenLocally,
}: {
  client: Pick<ConnectionClient, "call">;
  getSnapshot: () => Snapshot;
  subscribe: (listener: () => void) => () => void;
  refresh: () => unknown;
  win: Pick<Window, "addEventListener" | "removeEventListener">;
  doc: Pick<
    Document,
    "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener"
  >;
  seenLocally?: (
    looks: readonly { paneId: string; terminalId: string; seq?: number }[],
  ) => void;
}): () => void {
  /** Agents on screen, and the finished state each was last seen in. */
  let shown = new Map<string, { paneId: string; terminalId: string }>();
  const finished = new Map<string, number>();
  let looks: { paneId: string; terminalId: string; seq?: number }[] = [];
  const mark = (
    key: string,
    paneId: string,
    terminalId: string,
    seq?: number,
    wasDone = false,
  ) => {
    looks.push({ paneId, terminalId, ...(seq === undefined ? {} : { seq }) });
    void client
      .call("agent_seen.mark", {
        pane_id: paneId,
        terminal_id: terminalId,
        ...(seq === undefined ? {} : { seq }),
      })
      .then((result) => {
        // Its Done label goes now rather than with the next refresh.
        if (wasDone && (result as { marked?: boolean })?.marked) void refresh();
      })
      .catch(() => {
        if (seq !== undefined) finished.delete(key);
      });
  };
  const check = () => {
    const snapshot = getSnapshot();
    const looking = doc.visibilityState === "visible" && doc.hasFocus();
    const now = new Map<string, { paneId: string; terminalId: string }>();
    for (const paneId of looking ? panesOnScreen(snapshot) : []) {
      const pane = snapshot.panes.find((each) => each.pane_id === paneId);
      if (!pane?.agent || !pane.terminal_id) continue;
      const key = `${paneId}\u0000${pane.terminal_id}`;
      now.set(key, { paneId, terminalId: pane.terminal_id });
      const seq = pane.state_change_seq;
      const done =
        (pane.agent_status === "idle" || pane.agent_status === "done") &&
        seq !== undefined;
      // Herdr can restart while preserving terminal IDs and resetting seq.
      if (done && finished.get(key) !== seq) {
        finished.set(key, seq);
        mark(key, paneId, pane.terminal_id, seq, pane.agent_status === "done");
      } else if (!shown.has(key)) mark(key, paneId, pane.terminal_id);
    }
    // Gone from the screen: looked at until now.
    for (const [key, { paneId, terminalId }] of shown)
      if (!now.has(key)) mark(key, paneId, terminalId);
    shown = now;
    if (looks.length === 0) return;
    const sent = looks;
    looks = [];
    seenLocally?.(sent);
  };
  check();
  const off = subscribe(check);
  win.addEventListener("focus", check);
  win.addEventListener("blur", check);
  doc.addEventListener("visibilitychange", check);
  return () => {
    off();
    win.removeEventListener("focus", check);
    win.removeEventListener("blur", check);
    doc.removeEventListener("visibilitychange", check);
  };
}

/**
 * Marks agents seen while `onScreen` (watchAgentsSeen), and shows the marks
 * in this page's lists at once.
 */
export function useMarkAgentsSeen(onScreen: boolean) {
  const client = useConnectionClient();
  useEffect(() => {
    if (!onScreen) return;
    return watchAgentsSeen({
      client,
      getSnapshot: () => store.get(),
      subscribe: (listener) => store.subscribe(listener),
      refresh: () => store.refresh(),
      win: window,
      doc: document,
      seenLocally: (looks) => {
        const at = Date.now();
        for (const look of looks)
          recordLocalSeen(
            client.connectionId,
            look.paneId,
            look.terminalId,
            look.seq,
            at,
          );
        store.applyLocalSeen(client.connectionId);
      },
    });
  }, [client, onScreen]);
}
