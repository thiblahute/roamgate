import { mrCacheSettings, peekGuiSettings } from "../config/gui-settings";
import { type MrCache, type MrCacheChange, createMrCache } from "./cache";

/**
 * The one cache of merge and pull request answers of this server. Answers
 * are kept across restarts, except in tests, which never touch the user's
 * data directory.
 */
let instance: MrCache | null = null;
let publisher: ((change: MrCacheChange) => void) | null = null;

export function sharedMrCache(): MrCache {
  instance ??= createMrCache({
    path: process.env.NODE_ENV === "test" ? null : undefined,
    settings: () => mrCacheSettings(peekGuiSettings()),
    publish: (change) => publisher?.(change),
  });
  return instance;
}

/** Where the answers that change go: every connected client. */
export function onMrCacheChange(
  publish: ((change: MrCacheChange) => void) | null,
) {
  publisher = publish;
}
