import { bridge, type ConnectionClient, type HerdrEventMsg } from "./api";

/**
 * `agent_history.changed`: the bridge watches a pane's session file and
 * says when it changed, for every agent kind; the chat then fetches its
 * delta. One subscription per pane on this socket, however many views
 * follow it.
 */
type Watch = {
  key: string;
  client: ConnectionClient;
  paneId: string;
  params: Record<string, unknown>;
  listeners: Set<() => void>;
  /** Whether the bridge pushes: false asks for the old poll. */
  pushed: Promise<boolean>;
};

const watches = new Map<string, Watch>();
let unlisten: (() => void) | null = null;

/** Whether a bridge event says this pane's history changed. */
export function historyChangedPane(
  message: Pick<HerdrEventMsg, "event" | "data">,
): string | null {
  if (message.event !== "agent_history.changed") return null;
  const pane = message.data?.pane_id;
  return typeof pane === "string" ? pane : null;
}

function onEvent(message: HerdrEventMsg) {
  const paneId = historyChangedPane(message);
  if (!paneId) return;
  for (const watch of watches.values())
    if (
      watch.paneId === paneId &&
      watch.client.connectionId === message.connection_id
    )
      for (const listener of watch.listeners) listener();
}

/**
 * Calls `onChange` when the pane's history changes. `pushed` resolves false
 * when the bridge cannot push (an older one, a Windows host): poll then.
 */
export function watchAgentHistory(
  client: ConnectionClient,
  params: {
    pane_id: string;
    workspace_id: string;
    tab_id: string;
    agent: string;
  },
  onChange: () => void,
): { pushed: Promise<boolean>; close: () => void } {
  // A test's stand-in bridge may have no events.
  if (!unlisten && typeof bridge.onEvent === "function") {
    unlisten = bridge.onEvent(onEvent);
    // A new socket has no subscriptions: each pane followed asks again,
    // and reads its history in case it changed meanwhile.
    bridge.onHello?.(() => {
      for (const watch of watches.values()) {
        void watch.client
          .call("agent_history.subscribe", watch.params)
          .catch(() => {});
        for (const listener of watch.listeners) listener();
      }
    });
  }
  const key = JSON.stringify([
    client.connectionId,
    client.generation,
    params.pane_id,
  ]);
  let watch = watches.get(key);
  if (!watch) {
    const created: Watch = {
      key,
      client,
      paneId: params.pane_id,
      params,
      listeners: new Set(),
      pushed: Promise.resolve()
        .then(() => client.call("agent_history.subscribe", params))
        .then(
          () => true,
          () => false,
        ),
    };
    watches.set(key, created);
    watch = created;
  }
  const current = watch;
  current.listeners.add(onChange);
  return {
    pushed: current.pushed,
    close() {
      current.listeners.delete(onChange);
      if (current.listeners.size || watches.get(key) !== current) return;
      watches.delete(key);
      void current.pushed.then((pushed) => {
        if (pushed && !watches.has(key) && current.client.isCurrent())
          void current.client
            .call("agent_history.unsubscribe", { pane_id: current.paneId })
            .catch(() => {});
      });
    },
  };
}
