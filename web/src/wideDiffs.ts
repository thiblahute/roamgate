import { useSyncExternalStore } from "react";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";

/**
 * Full width diffs: every diff view (Changes, Commits, the Files preview's
 * file changes) draws its files in a centred column, a code width wide,
 * unless this is on. Off unless turned on. The choice lives in the Roamgate
 * server's interface settings, so every browser agrees; this browser keeps a
 * copy so a reload has it before the socket answers. `:set wide`,
 * `:set nowide` and the review's view menu write it.
 */
export const WIDE_DIFFS_SETTING_KEY = "wideDiffs";
/** This browser's copy: "true" or "false", absent while never chosen. */
export const WIDE_DIFFS_STORAGE_KEY = "wideDiffs";
/** A choice made while the server was out of reach, sent once it is back. */
const PENDING_KEY = "wideDiffs.pending";

export type WideDiffsTransport = (on: boolean) => Promise<void>;

let transport: WideDiffsTransport | null = null;
/** The choice when storage refuses it, for this page. */
let pageChoice: boolean | null = null;
const listeners = new Set<() => void>();
let unsubscribeStorage: (() => void) | undefined;

function stored(key: string): string | null {
  try {
    return roamgateLocalStorage.getItem(key);
  } catch {
    return null;
  }
}

function chosen(): boolean | null {
  if (pageChoice !== null) return pageChoice;
  const raw = stored(WIDE_DIFFS_STORAGE_KEY);
  return raw === "true" ? true : raw === "false" ? false : null;
}

function writeCache(on: boolean) {
  try {
    roamgateLocalStorage.setItem(WIDE_DIFFS_STORAGE_KEY, on ? "true" : "false");
    pageChoice = null;
  } catch {
    pageChoice = on;
  }
}

function setPending(pending: boolean) {
  try {
    if (pending) roamgateLocalStorage.setItem(PENDING_KEY, "1");
    else roamgateLocalStorage.removeItem(PENDING_KEY);
  } catch {
    // Without storage the choice is only sent while connected.
  }
}

function publish() {
  for (const listener of listeners) listener();
}

function send(on: boolean) {
  if (!transport) {
    setPending(true);
    return;
  }
  setPending(false);
  void transport(on).catch(() => setPending(true));
}

/** Whether diffs take the whole width of their view: off by default. */
export function wideDiffs(): boolean {
  return chosen() ?? false;
}

/** Turns full width diffs on or off everywhere, on every device. */
export function setWideDiffs(on: boolean) {
  writeCache(on);
  publish();
  send(on);
}

/**
 * Installs the write path with what the server holds: a choice made here
 * while offline is sent, otherwise the server's wins.
 */
export function connectWideDiffs(
  write: WideDiffsTransport,
  serverValue: unknown,
) {
  transport = write;
  const local = chosen();
  if (local !== null && stored(PENDING_KEY) !== null) {
    send(local);
    return;
  }
  if (typeof serverValue === "boolean") adoptWideDiffs(serverValue);
  else if (local !== null) send(local);
}

export function disconnectWideDiffs() {
  transport = null;
}

/** Applies the choice another browser made. */
export function adoptWideDiffs(value: unknown) {
  if (typeof value !== "boolean") return;
  const before = wideDiffs();
  writeCache(value);
  setPending(false);
  if (before !== value) publish();
}

export function subscribeWideDiffs(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1)
    unsubscribeStorage = subscribeLocalStorage((key) => {
      if (key === null || key === WIDE_DIFFS_STORAGE_KEY) publish();
    });
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeStorage?.();
      unsubscribeStorage = undefined;
    }
  };
}

/** Whether diffs take the whole width, rendering again when it changes. */
export function useWideDiffs(): boolean {
  return useSyncExternalStore(subscribeWideDiffs, wideDiffs, () => false);
}

export function __resetWideDiffsForTests() {
  transport = null;
  pageChoice = null;
}
