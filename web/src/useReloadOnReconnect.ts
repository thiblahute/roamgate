import { useEffect, useRef, useSyncExternalStore } from "react";
import { connectionReady, onConnectionChange } from "./connectionReady";
import { isReconnectRetryableError } from "./reconnectRetry";

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
