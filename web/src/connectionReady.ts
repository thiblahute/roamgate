import { bridge } from "./api";
import { store } from "./store";

/**
 * Whether calls on a connection go through now: the bridge's socket said
 * hello and the connection's runtime is known. A load that failed for want
 * of it can be made again once it is.
 */
export function connectionReady(connectionId: string): boolean {
  const runtime =
    store.get().connections.find((connection) => connection.id === connectionId)
      ?.generation ?? null;
  return bridge.connection(connectionId, runtime).isCurrent();
}

/** Calls `listener` whenever a connection's readiness may have changed. */
export function onConnectionChange(listener: () => void): () => void {
  const off = store.subscribe(listener);
  return () => {
    off();
  };
}
