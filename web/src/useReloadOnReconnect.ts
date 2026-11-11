import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ConnectionClient } from "./api";
import { connectionReady, onConnectionChange } from "./connectionReady";
import { isReconnectRetryableError } from "./reconnectRetry";
import { useConnectionClient } from "./useConnectionClient";

/** Whether a load failed for want of the connection, not for its own fault. */
export function failedForConnection(error: unknown): boolean {
  if (error === null || error === undefined || error === "") return false;
  return isReconnectRetryableError(
    error instanceof Error ? error : new Error(String(error)),
  );
}

/** Whether calls on the connection go through now, kept up to date. */
export function useConnectionReadyFor(connectionId: string): boolean {
  return useSyncExternalStore(onConnectionChange, () =>
    connectionReady(connectionId),
  );
}

/**
 * Makes a load again once the connection is back, when it failed for want
 * of it (`error`, the load's error or null). One try each time the
 * connection comes back: a load that fails again while it is up waits for
 * the next time, or for its Retry, rather than loop. A load failed for
 * another reason is left to its Retry.
 */
export function useReloadOnReconnect(
  error: unknown,
  connectionId: string,
  reload: () => void,
): void {
  const ready = useConnectionReadyFor(connectionId);
  const failed = failedForConnection(error);
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });
  // Armed again each time the connection goes down.
  const armed = useRef(true);
  useEffect(() => {
    if (!ready) {
      armed.current = true;
      return;
    }
    if (!failed || !armed.current) return;
    armed.current = false;
    reloadRef.current();
  }, [ready, failed]);
}

/**
 * The client, a new one each time its connection comes back: what waits
 * on the client (the effects that load with it, which skip or fail while
 * the connection is down) runs again then, where it was.
 */
export function useLiveClient(client: ConnectionClient): ConnectionClient {
  const ready = useSyncExternalStore(onConnectionChange, client.isCurrent);
  // The same client under a new identity: what it answers stays its own.
  return useMemo(
    () => (ready ? (Object.create(client) as ConnectionClient) : client),
    [client, ready],
  );
}

/** useConnectionClient, a new client each time the connection comes back. */
export function useLiveConnectionClient(): ConnectionClient {
  return useLiveClient(useConnectionClient());
}
