import { useRef } from "react";
import {
  EMPTY_KEY_STATE,
  feedKey,
  type KeyResult,
  type KeyState,
  REVIEW_KEY_PREFIXES,
  REVIEW_KEY_SEQUENCES,
} from "./reviewNavigation";

/*
 * The one key machine (feedKey: counts, the g / z / d prefixes, modifiers
 * ignored) as something any host runs: the review pane, the inspector's
 * root (gt / gT), Changes' Vim cursor, and every list of threads
 * (useThreadKeys: a chat, the Files preview, Ranger, the agent's history).
 * Each host keeps its own state and gives the resolved command its own
 * meaning; `gg`, `zz`, `gn`, `g;`, `gH`, `dd`, `za` mean the same everywhere.
 */

export type KeyMachine = {
  /** A key pressed: "wait" (a count or a prefix kept) or a command. */
  feed: (key: string) => KeyResult;
  /** Drops a count or a prefix waiting. */
  reset: () => void;
  /** The count and prefix waiting. */
  state: () => KeyState;
};

/**
 * Bumped when a host took a sequence the others had begun (the inspector's
 * `gt`): every machine drops what it kept, so that `g` is not still
 * waiting in the view left.
 */
let epoch = 0;

/** Every machine forgets its count and prefix. */
export function resetKeyMachines() {
  epoch += 1;
}

/** A machine; `sequences` adds two-key commands of the host's own. */
export function createKeyMachine(
  sequences: readonly string[] = [],
): KeyMachine {
  const known = sequences.length
    ? new Set([...REVIEW_KEY_SEQUENCES, ...sequences])
    : REVIEW_KEY_SEQUENCES;
  let state: KeyState = EMPTY_KEY_STATE;
  let seen = epoch;
  return {
    feed(key) {
      if (seen !== epoch) {
        seen = epoch;
        state = EMPTY_KEY_STATE;
      }
      const result = feedKey(state, key, known);
      state = result.state;
      return result;
    },
    reset() {
      state = EMPTY_KEY_STATE;
    },
    state: () => state,
  };
}

/** A machine kept for the component's life. */
export function useKeyMachine(sequences: readonly string[] = []): KeyMachine {
  const machine = useRef<KeyMachine | null>(null);
  machine.current ??= createKeyMachine(sequences);
  return machine.current;
}

/**
 * Runs a command with `handle`; a sequence the host has no meaning for
 * (`gc` in a chat) is its second key alone, as Vim reads it. True when the
 * host did something.
 */
export function runKeyCommand(
  command: { key: string; count: number | null },
  handle: (key: string, count: number | null) => boolean,
): boolean {
  if (handle(command.key, command.count)) return true;
  const [prefix, second] = command.key;
  if (
    command.key.length === 2 &&
    prefix &&
    second &&
    REVIEW_KEY_PREFIXES.has(prefix)
  )
    return handle(second, command.count);
  return false;
}
