import { useEffect } from "react";
import { store } from "./store";
import { useConnectionClient } from "./useConnectionClient";

/**
 * Reports this browser's attention to the activity log
 * (activityPresence.ts, loaded on its own: most bridges do not record).
 */
export function useActivityPresence(paneShown: boolean) {
  const client = useConnectionClient();
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("./activityPresence")
      .then((presence) => {
        if (cancelled) return;
        stop = presence.watchActivityPresence({
          client,
          clientId: presence.activityClientId(),
          clientKind: presence.activityClientKind(),
          paneShown,
          getSnapshot: () => store.get(),
          subscribe: (listener) => store.subscribe(listener),
          win: window,
          doc: document,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [client, paneShown]);
}
