import { useSyncExternalStore } from "react";
import { bridge } from "./api";

/** A usage window: `5h`, `7d` or a per-model week (`7d opus`). */
export type UsageWindow = {
  label: string;
  utilization: number;
  resets_at?: string;
};

/** One account's last usage reading (agent_profile.account.usage). */
export type AccountUsage = {
  agent: string;
  id: string;
  status:
    | "fresh"
    | "cached"
    | "failed"
    | "rate_limited"
    | "auth_expired"
    | "unknown";
  usage?: {
    windows: UsageWindow[];
    plan?: string;
    email?: string;
    limit_reached?: string;
  };
  read_at?: number;
  error?: string;
};

export type AccountUsageBoard = ReadonlyMap<string, AccountUsage>;

const keyOf = (usage: AccountUsage) => `${usage.agent}/${usage.id}`;

function isUsage(value: unknown): value is AccountUsage {
  const usage = value as AccountUsage | null;
  return (
    !!usage &&
    typeof usage === "object" &&
    typeof usage.agent === "string" &&
    typeof usage.id === "string" &&
    typeof usage.status === "string"
  );
}

/** A board with an `account_usage` push applied (a new map when it
 * changes anything). */
export function applyAccountUsage(
  board: AccountUsageBoard,
  push: unknown,
): AccountUsageBoard {
  const value = push as { accounts?: unknown; removed?: unknown } | null;
  if (!value || typeof value !== "object") return board;
  const next = new Map(board);
  for (const each of Array.isArray(value.accounts) ? value.accounts : [])
    if (isUsage(each)) next.set(keyOf(each), each);
  for (const key of Array.isArray(value.removed) ? value.removed : [])
    if (typeof key === "string") next.delete(key);
  return next;
}

let board: AccountUsageBoard = new Map();
let installed = false;
const listeners = new Set<() => void>();

function set(next: AccountUsageBoard) {
  if (next === board) return;
  board = next;
  for (const listener of listeners) listener();
}

async function hydrate() {
  try {
    const result = (await bridge.call("agent_profile.account.usage")) as {
      accounts?: unknown;
    };
    set(applyAccountUsage(new Map(), { accounts: result?.accounts }));
  } catch {
    // An older server: no usage to show.
  }
}

function install() {
  if (installed) return;
  installed = true;
  bridge.onAccountUsage((push) => set(applyAccountUsage(board, push)));
  bridge.onStatus((status) => {
    if (status === "connected") void hydrate();
  });
  if (bridge.status === "connected") void hydrate();
}

function subscribe(listener: () => void) {
  install();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every account's usage, kept current by the server's pushes. */
export function useAccountUsage(): AccountUsageBoard {
  return useSyncExternalStore(subscribe, () => board);
}
