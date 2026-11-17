import { useSyncExternalStore } from "react";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";

/**
 * Vim keys: one setting for every editor that has them (the review and its
 * comment boxes, the Files preview, the agent chats' and the terminal's
 * message boxes). On unless turned off. The choice lives in the Roamgate
 * server's interface settings, so every browser and phone agrees; this
 * browser keeps a copy so a reload has it before the socket answers.
 * Configuration's switch, `:set vim` and `:set novim` all write it.
 */
export const VIM_KEYS_SETTING_KEY = "vimKeys";
/** This browser's copy: "true" or "false", absent while never chosen. */
export const VIM_KEYS_STORAGE_KEY = "vimKeys";
/** A choice made while the server was out of reach, sent once it is back. */
const PENDING_KEY = "vimKeys.pending";

/** The per-browser choices this setting replaces, read once to migrate. */
const LEGACY_REVIEW_PREFS_KEY = "reviewPrefs";
const LEGACY_CHAT_KEY = "agentChatVimKeys";

export type VimKeysTransport = (on: boolean) => Promise<void>;

let transport: VimKeysTransport | null = null;
let serverKnown = false;
/** The choice when storage refuses it, for this page. */
let pageChoice: boolean | null = null;
let migrated = false;
const listeners = new Set<() => void>();
let unsubscribeStorage: (() => void) | undefined;

function parse(raw: string | null): boolean | null {
  return raw === "true" ? true : raw === "false" ? false : null;
}

function readStored(key: string): string | null {
  try {
    return roamgateLocalStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeCache(on: boolean) {
  try {
    roamgateLocalStorage.setItem(VIM_KEYS_STORAGE_KEY, on ? "true" : "false");
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

/**
 * The choice the old per-browser toggles held, taken once: the review's
 * `:vim` preference first (its Vim keys were on by default and are the ones
 * used most), else the agent chats' switch. Both are then forgotten.
 */
function migrateLegacy() {
  if (migrated) return;
  migrated = true;
  let fromReview: boolean | null = null;
  let prefs: Record<string, unknown> | null = null;
  try {
    const raw = roamgateLocalStorage.getItem(LEGACY_REVIEW_PREFS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      prefs = parsed as Record<string, unknown>;
      if (typeof prefs.vim === "boolean") fromReview = prefs.vim;
    }
  } catch {
    // Damaged preferences hold no choice.
  }
  const fromChat = parse(readStored(LEGACY_CHAT_KEY));
  const legacy = fromReview ?? fromChat;
  // Kept here only: the server's choice, when it has one, still wins.
  if (legacy !== null && parse(readStored(VIM_KEYS_STORAGE_KEY)) === null)
    writeCache(legacy);
  try {
    if (prefs && "vim" in prefs) {
      const rest = { ...prefs };
      delete rest.vim;
      roamgateLocalStorage.setItem(
        LEGACY_REVIEW_PREFS_KEY,
        JSON.stringify(rest),
      );
    }
    if (readStored(LEGACY_CHAT_KEY) !== null)
      roamgateLocalStorage.removeItem(LEGACY_CHAT_KEY);
  } catch {
    // Read again next time; the new setting already holds the choice.
  }
}

/** The choice made here or on another device, when there is one. */
function chosen(): boolean | null {
  migrateLegacy();
  if (pageChoice !== null) return pageChoice;
  return parse(readStored(VIM_KEYS_STORAGE_KEY));
}

/** Whether editors take Vim keys: on unless turned off. */
export function vimKeys(): boolean {
  return chosen() ?? true;
}

function publish() {
  for (const listener of listeners) listener();
}

/** Turns Vim keys on or off everywhere, on every device. */
export function setVimKeys(on: boolean) {
  writeCache(on);
  publish();
  if (!transport) {
    setPending(true);
    return;
  }
  serverKnown = true;
  setPending(false);
  void transport(on).catch(() => {
    // Sent again once the socket is back.
    setPending(true);
  });
}

/**
 * Installs the write path with what the server holds. A choice made here
 * while offline is sent; otherwise the server wins. With nothing on the
 * server, a choice cached here (or taken from the old toggles) is promoted.
 */
export function connectVimKeys(send: VimKeysTransport, stored: unknown) {
  transport = send;
  migrateLegacy();
  const local = chosen();
  const pending = readStored(PENDING_KEY) !== null;
  if (local !== null && (pending || typeof stored !== "boolean")) {
    if (pending || !serverKnown) {
      serverKnown = true;
      setPending(false);
      void send(local).catch(() => setPending(true));
    }
    return;
  }
  if (typeof stored === "boolean") {
    serverKnown = true;
    adoptVimKeys(stored);
  }
}

export function disconnectVimKeys() {
  transport = null;
  serverKnown = false;
}

/** Applies the choice another browser made. */
export function adoptVimKeys(stored: unknown) {
  if (typeof stored !== "boolean") return;
  const before = vimKeys();
  writeCache(stored);
  setPending(false);
  if (before !== stored) publish();
}

export function subscribeVimKeys(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1)
    // Another window's choice applies here too.
    unsubscribeStorage = subscribeLocalStorage((key) => {
      if (key === null || key === VIM_KEYS_STORAGE_KEY) publish();
    });
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeStorage?.();
      unsubscribeStorage = undefined;
    }
  };
}

/** Whether editors take Vim keys, rendering again when it changes. */
export function useVimKeys(): boolean {
  return useSyncExternalStore(subscribeVimKeys, vimKeys, () => true);
}

export function __resetVimKeysForTests() {
  transport = null;
  serverKnown = false;
  pageChoice = null;
  migrated = false;
}
