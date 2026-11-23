/**
 * The owners table, `<data>/runtime/owners.json` (contract/wire/
 * core-channel.md): which side owns each family, and the shadow reads'
 * settings. Read at start and whenever the file changes; the server never
 * writes it.
 */
import { type FSWatcher, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { REAL_TIMERS, type Timers } from "./channel";
import type { Owners } from "./protocol";

export type ShadowSettings = { enabled: boolean; rate: number };
export type OwnersTable = {
  owners: Owners;
  shadow: ShadowSettings;
  /** The core binary that last wrote the table (`roamgate owners`). */
  core?: string;
};

export const OWNERS_FILE = "owners.json";
export const DEFAULT_SHADOW: ShadowSettings = { enabled: true, rate: 0.1 };
export const DEFAULT_TABLE: OwnersTable = {
  owners: {},
  shadow: DEFAULT_SHADOW,
};

/** The table a file's text holds; throws on what is not one. */
export function parseOwners(text: string): OwnersTable {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("not a JSON object");
  const { version, owners, shadow, core } = value as Record<string, unknown>;
  if (version !== 1) throw new Error(`unknown version ${String(version)}`);
  const table: OwnersTable = { owners: {}, shadow: { ...DEFAULT_SHADOW } };
  if (owners !== undefined) {
    if (!owners || typeof owners !== "object" || Array.isArray(owners))
      throw new Error("owners is not an object");
    for (const [family, side] of Object.entries(owners)) {
      if (side !== "rust" && side !== "bun")
        throw new Error(`owner of ${family} is not "rust" or "bun"`);
      table.owners[family] = side;
    }
  }
  if (shadow !== undefined) {
    if (!shadow || typeof shadow !== "object" || Array.isArray(shadow))
      throw new Error("shadow is not an object");
    const { enabled, rate } = shadow as Record<string, unknown>;
    if (enabled !== undefined) {
      if (typeof enabled !== "boolean")
        throw new Error("shadow.enabled is not a boolean");
      table.shadow.enabled = enabled;
    }
    if (rate !== undefined) {
      if (typeof rate !== "number" || !(rate >= 0 && rate <= 1))
        throw new Error("shadow.rate is not a number from 0 to 1");
      table.shadow.rate = rate;
    }
  }
  if (typeof core === "string" && core) table.core = core;
  return table;
}

/** The table in `directory`: the default when missing or invalid. */
export function readOwners(
  directory: string,
  warn: (message: string) => void = () => {},
): OwnersTable {
  let text: string;
  try {
    text = readFileSync(join(directory, OWNERS_FILE), "utf8");
  } catch {
    return DEFAULT_TABLE;
  }
  try {
    return parseOwners(text);
  } catch (error) {
    warn(
      `${join(directory, OWNERS_FILE)} is invalid, every family stays with Bun: ${(error as Error).message}`,
    );
    return DEFAULT_TABLE;
  }
}

/**
 * Keeps the table of `directory` current: `onChange` gets each new one
 * (after a 200 ms quiet spell, so an editor's write lands whole).
 */
export function watchOwners(
  directory: string,
  options: {
    onChange: (table: OwnersTable) => void;
    warn?: (message: string) => void;
    timers?: Timers;
  },
): { table: () => OwnersTable; stop: () => void } {
  const timers = options.timers ?? REAL_TIMERS;
  let lastWarning = "";
  const warn = (message: string) => {
    // Once per change of what is wrong.
    if (message === lastWarning) return;
    lastWarning = message;
    options.warn?.(message);
  };
  let current = readOwners(directory, warn);
  let pending: unknown = null;
  const reload = () => {
    pending = null;
    let warned = false;
    const next = readOwners(directory, (message) => {
      warned = true;
      warn(message);
    });
    if (!warned) lastWarning = "";
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    options.onChange(current);
  };
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(directory, (_event, name) => {
      if (name !== null && name !== OWNERS_FILE) return;
      if (pending) timers.clearTimeout(pending);
      pending = timers.setTimeout(reload, 200);
    });
    watcher.unref();
  } catch (error) {
    options.warn?.(
      `cannot watch ${directory} for owners.json: ${(error as Error).message}`,
    );
  }
  return {
    table: () => current,
    stop: () => {
      if (pending) timers.clearTimeout(pending);
      watcher?.close();
    },
  };
}

let ownsCheck: ((family: string) => boolean) | null = null;
const ownershipListeners = new Set<() => void>();

/**
 * Calls `listener` whenever what bunOwns answers may have changed (the
 * table changed, the core connected or went away): a family's background
 * work starts or stops with it. Returns the unsubscribe.
 */
export function onOwnershipChanged(listener: () => void): () => void {
  ownershipListeners.add(listener);
  return () => ownershipListeners.delete(listener);
}

/** Tells the listeners of onOwnershipChanged. */
export function ownershipChanged(): void {
  for (const listener of ownershipListeners) {
    try {
      listener();
    } catch {
      // A listener's own failure is its own to report.
    }
  }
}

/** Sets what bunOwns asks (the core facade, while it runs). */
export function setOwnershipCheck(
  check: ((family: string) => boolean) | null,
): void {
  ownsCheck = check;
}

/**
 * Whether Bun owns `family` now: its handlers answer and its background
 * writers write. Always true without a core.
 */
export function bunOwns(family: string): boolean {
  return ownsCheck ? ownsCheck(family) : true;
}
