import { roamgateSessionStorage } from "./browserStorage";
import { type ComponentType, lazy } from "react";

// After an in-app update, the restarted server only embeds the new build's
// hashed chunks, so a lazy import from an older open tab 404s and crashes the
// root error boundary. Reload each lazy component once to fetch fresh assets;
// other components loading successfully must not reset its retry guard.
export async function importWithReload<T>(
  componentKey: string,
  factory: () => Promise<T>,
): Promise<T> {
  const reloadKey = `herdr:lazy-chunk-reload:${componentKey}`;
  try {
    const module = await factory();
    roamgateSessionStorage.removeItem(reloadKey);
    return module;
  } catch (error) {
    if (roamgateSessionStorage.getItem(reloadKey)) throw error;
    roamgateSessionStorage.setItem(reloadKey, "1");
    window.location.reload();
    // Keep the lazy boundary suspended while the page unloads.
    return new Promise<T>(() => {});
  }
}

export function lazyWithReload<C extends ComponentType<any>>(
  componentKey: string,
  factory: () => Promise<{ default: C }>,
) {
  return lazy(() => importWithReload(componentKey, factory));
}

/**
 * A lazy component that can be loaded ahead (`preload`): once loaded, it
 * renders at once. React suspends a lazy component the first time it
 * renders even when its chunk is in, then holds the content back for its
 * fallback's minimum time (some 300 ms). A preload that fails does nothing:
 * the first render loads it as lazyWithReload does, reload included.
 */
export function preloadableLazy<C extends ComponentType<any>>(
  componentKey: string,
  factory: () => Promise<{ default: C }>,
) {
  let loaded: { default: C } | null = null;
  const component = lazy(() =>
    loaded ? Promise.resolve(loaded) : importWithReload(componentKey, factory),
  );
  return Object.assign(component, {
    preload: async () => {
      if (loaded) return;
      loaded = await factory();
      // React's lazy payload, started as its first render would: resolved
      // by the time the component renders.
      const internals = component as unknown as {
        _init?: (payload: unknown) => unknown;
        _payload?: unknown;
      };
      try {
        internals._init?.(internals._payload);
      } catch {
        // Pending for a microtask: React throws the promise it waits on.
      }
    },
  });
}
