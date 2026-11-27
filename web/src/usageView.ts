import type { AccountChain } from "../../shared/agentProfiles";
import type {
  AccountUsage,
  AccountUsageBoard,
  UsageWindow,
} from "./accountUsage";

/** From this percent a window shows the warning colour. */
export const WARN_PERCENT = 80;
/** From this percent it shows the alarm colour. */
export const HIGH_PERCENT = 95;

export type WarnLevel = "ok" | "warn" | "high";

export function warnLevel(percent: number): WarnLevel {
  if (percent >= HIGH_PERCENT) return "high";
  if (percent >= WARN_PERCENT) return "warn";
  return "ok";
}

/** Whether a window still counts: its reset is ahead (or unknown). */
function live(window: UsageWindow, now: number) {
  if (!window.resets_at) return true;
  const at = Date.parse(window.resets_at);
  return Number.isNaN(at) || at > now;
}

/** An account's tightest live window: the one most used. */
export function tightestWindow(
  usage: AccountUsage | undefined,
  now = Date.now(),
): UsageWindow | null {
  let tightest: UsageWindow | null = null;
  for (const window of usage?.usage?.windows ?? []) {
    if (!live(window, now)) continue;
    if (!tightest || window.utilization > tightest.utilization)
      tightest = window;
  }
  return tightest;
}

/** A profile row as settings.profiles.get lists it (what the view needs). */
export type UsageProfile = {
  name: string;
  agent: string;
  account?: { id: string; auth?: string; clauth?: string };
};

/** The board's reading of an account profile. */
export function usageOf(
  board: AccountUsageBoard,
  profile: UsageProfile,
): AccountUsage | undefined {
  return profile.account
    ? board.get(`${profile.agent}/${profile.account.id}`)
    : undefined;
}

/** The chip's words: the default account and its tightest window
 * ("Work 61% 7d"); null when the default is no account. */
export function chipText(
  profiles: readonly UsageProfile[],
  defaultName: string,
  board: AccountUsageBoard,
  now = Date.now(),
): { name: string; window: UsageWindow | null; level: WarnLevel } | null {
  const profile = profiles.find(
    (each) => each.name === defaultName && each.account,
  );
  if (!profile) return null;
  const window = tightestWindow(usageOf(board, profile), now);
  return {
    name: profile.name,
    window,
    level: window ? warnLevel(window.utilization) : "ok",
  };
}

/** The account the chain would move to next: the first of its order,
 * other than the default, signed in, whose live windows are all below its
 * lines. A sketch of the server's walk, for the summary. */
export function nextInChain(
  chain: AccountChain | undefined,
  profiles: readonly UsageProfile[],
  defaultName: string,
  board: AccountUsageBoard,
  now = Date.now(),
): string | null {
  if (!chain) return null;
  for (const name of chain.accounts) {
    if (name === defaultName || name === chain.last_resort) continue;
    const profile = profiles.find((each) => each.name === name);
    if (!profile?.account || profile.account.auth === "signed_out") continue;
    if (profile.account.auth === "needs_relogin") continue;
    const own = chain.lines?.[name];
    const crossed = (usageOf(board, profile)?.usage?.windows ?? []).some(
      (window) =>
        live(window, now) &&
        window.utilization >=
          (window.label === "5h" || window.label.startsWith("5h ")
            ? (own?.five_hour ?? chain.five_hour_line)
            : (own?.weekly ?? chain.weekly_line)),
    );
    if (!crossed) return name;
  }
  return chain.last_resort && chain.last_resort !== defaultName
    ? chain.last_resort
    : null;
}

/** A session's run on an account (agent_profile.account.sessions). */
export type SessionRun = {
  session_id: string;
  profile: string;
  started_at: number;
  ended_at: number | null;
  tokens: { input_tokens?: number; output_tokens?: number } | null;
  title?: string | null;
  cwd?: string | null;
  pane?: { connection_id: string; pane_id: string } | null;
  /** The account chain leaves it on its profile. */
  pinned?: boolean;
};

/** A pane running now, as the session list names it. */
export type LivePane = {
  connectionId: string;
  runtimeGeneration: number;
  pane_id: string;
  workspace_id: string;
  serverLabel: string;
  workspaceLabel: string;
  tabLabel: string;
  terminal_title_stripped?: string;
};

/** A session as the Usage view shows it. */
export type NamedSession = SessionRun & {
  name: string;
  /** Workspace (and connection) it runs in, or its directory. */
  place: string;
  live: LivePane | null;
  tokensIn: number;
  tokensOut: number;
};

function basename(path: string) {
  return (
    path
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? path
  );
}

/** Names a session as the session list does: its pane's title in its
 * workspace when it runs now, else its transcript's title, else its
 * directory; never its id unless nothing else is known. */
export function nameSession(
  run: SessionRun,
  panes: readonly LivePane[],
): NamedSession {
  const live =
    (run.pane &&
      panes.find(
        (pane) =>
          pane.connectionId === run.pane!.connection_id &&
          pane.pane_id === run.pane!.pane_id,
      )) ||
    null;
  const name =
    live?.terminal_title_stripped?.trim() ||
    run.title?.trim() ||
    live?.tabLabel ||
    (run.cwd ? basename(run.cwd) : "") ||
    `Session ${run.session_id.slice(0, 8)}`;
  const place = live
    ? [live.workspaceLabel, live.serverLabel].filter(Boolean).join(" · ")
    : run.cwd
      ? basename(run.cwd)
      : "";
  return {
    ...run,
    name,
    place,
    live,
    tokensIn: run.tokens?.input_tokens ?? 0,
    tokensOut: run.tokens?.output_tokens ?? 0,
  };
}

/** Sessions most spent first; the same session's runs stay apart. */
export function sortSessions(sessions: readonly NamedSession[]) {
  return [...sessions].sort(
    (a, b) =>
      b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut) ||
      b.started_at - a.started_at,
  );
}

/** "12.3k", "1.2M": a token count in a few characters. */
export function shortCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/** The window's start for a period: today or this week (from Monday). */
export function periodStart(period: "today" | "week", now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === "week")
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start.getTime();
}

/** When a window resets, in a few words ("resets 5:20 PM", "resets Tue 9:00"). */
export function resetWords(at: string | undefined, now = new Date()) {
  if (!at) return "";
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  const sameDay = when.toDateString() === now.toDateString();
  return `resets ${when.toLocaleString(
    undefined,
    sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { weekday: "short", hour: "numeric", minute: "2-digit" },
  )}`;
}
