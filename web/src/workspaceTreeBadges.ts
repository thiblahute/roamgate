import type { GitStatusSummary, Workspace } from "./types";
import type { PullRequestSummary } from "../../shared/pullRequest";

export function workspacePullRequest(status?: PullRequestSummary) {
  const request = status?.state === "ready" ? status.request : undefined;
  if (!request || !status?.provider) return null;
  const state =
    request.state === "merged" || request.state === "closed"
      ? request.state
      : request.state === "open" || request.state === "opened"
        ? request.draft
          ? "draft"
          : "open"
        : null;
  if (!state) return null;
  const label = {
    open: "Open",
    draft: "Draft",
    merged: "Merged",
    closed: "Closed without merge",
  }[state];
  const github = status.provider === "github";
  const stale = status.stale
    ? `\nLast known status from ${new Date(status.refreshedAt).toLocaleString()}; ${status.stale.failedAt ? "refresh failed." : (status.stale.message ?? "awaiting refresh.")}`
    : "";
  return {
    request,
    state,
    stale: !!status.stale,
    id: `${github ? "#" : "!"}${request.number}`,
    title: `${github ? "PR #" : "MR !"}${request.number}: ${label}\n${request.title}${stale}`,
    openLabel: github ? "Open PR on GitHub" : "Open MR on GitLab",
  } as const;
}

export function workspaceDisplayName(workspace: Workspace): string {
  return workspace.label || workspace.workspace_id;
}

export function showWorkspaceBranchBadge(workspace: Workspace): boolean {
  const branch = workspace.worktree?.git_status?.branch;
  if (!branch) return true;
  return !(
    workspace.worktree?.is_linked_worktree === true &&
    workspaceDisplayName(workspace).trim() === branch.trim()
  );
}

const NAME_SEPARATOR = /^[-_./:\s\u00b7\u2022]+/;

/**
 * What a row shows of a workspace's name under `parentName`: a worktree named
 * after its repository ("gstreamer-ocio" under "gstreamer") drops the
 * repeated prefix and keeps what tells it apart ("ocio"). Anything else is
 * shown whole; the end is what gets cut when it does not fit.
 */
export function shortWorkspaceName(name: string, parentName?: string): string {
  const parent = parentName?.trim();
  if (!parent || name.length <= parent.length) return name;
  if (!name.toLowerCase().startsWith(parent.toLowerCase())) return name;
  const rest = name.slice(parent.length);
  const separator = NAME_SEPARATOR.exec(rest);
  if (!separator) return name;
  return rest.slice(separator[0].length) || name;
}

/** The branch line under a name: only when it says something the name does not. */
export function workspaceBranchLine(
  workspace: Workspace,
  shownName?: string,
): string | null {
  const branch = workspace.worktree?.git_status?.branch?.trim();
  if (!branch) return null;
  const name = workspaceDisplayName(workspace).trim();
  return branch === name || branch === shownName?.trim() ? null : branch;
}

/** The single change indicator a row has room for: Δn, else ↑/↓. */
export function workspaceChangeIndicator(
  status?: GitStatusSummary,
): { text: string; kind: "dirty" | "ahead" | "behind" | "error" } | null {
  if (!status) return null;
  if (status.error) return { text: "git?", kind: "error" };
  const changed =
    status.staged + status.unstaged + status.untracked + status.conflicted;
  if (changed > 0) return { text: `Δ${changed}`, kind: "dirty" };
  if (status.ahead > 0 && status.behind > 0)
    return { text: `↑${status.ahead}↓${status.behind}`, kind: "behind" };
  if (status.ahead > 0) return { text: `↑${status.ahead}`, kind: "ahead" };
  if (status.behind > 0) return { text: `↓${status.behind}`, kind: "behind" };
  return null;
}

/** Spread around the colour wheel, apart enough to tell connections apart. */
const HOST_HUES = [210, 30, 140, 280, 350, 180, 60, 250, 100, 320];

/** A connection's dot colour: always the same for the same connection. */
export function connectionDotColor(connectionId: string): string {
  let hash = 0;
  for (const char of connectionId)
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = HOST_HUES[hash % HOST_HUES.length];
  return `hsl(${hue} 70% 58%)`;
}
