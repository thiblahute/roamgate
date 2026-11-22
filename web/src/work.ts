import { useEffect, useRef, useState } from "react";
import type { WorkBoard, WorkLink, WorkPush } from "../../shared/work";
import { bridge } from "./api";
import { TASK_NOTIFICATION_ACTIVATE_EVENT } from "./taskNotifications";

/**
 * The Work board for the page: `bridge.work.*`, machine-wide. The server
 * pushes every change (`work`), and the page reads the board again then,
 * wherever the change was made (a page, an agent's tool).
 */

export function workCall<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return bridge.call(`bridge.work.${method}`, params, 30_000, {
    lane: "background",
  });
}

let latest: WorkBoard | null = null;
const listeners = new Set<(board: WorkBoard) => void>();
const changeListeners = new Set<(push: WorkPush) => void>();
let following = false;
let loading: Promise<WorkBoard> | null = null;

/** The board as last read on this page (the command menu, the badge). */
export function latestWorkBoard(): WorkBoard | null {
  return latest;
}

function publish(board: WorkBoard) {
  latest = board;
  for (const listener of listeners) listener(board);
}

export function loadWorkBoard(): Promise<WorkBoard> {
  if (loading) return loading;
  loading = workCall<WorkBoard>("board")
    .then((board) => {
      publish(board);
      return board;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

function follow() {
  if (following) return;
  following = true;
  bridge.onWork((push) => {
    void loadWorkBoard().catch(() => {});
    for (const listener of changeListeners) listener(push);
  });
}

/** What changed on the board, to say so. */
export function onWorkChange(listener: (push: WorkPush) => void): () => void {
  follow();
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** The board, read once and kept fresh by the pushes while shown. */
export function useWorkBoard(): {
  board: WorkBoard | null;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [board, setBoard] = useState<WorkBoard | null>(latest);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    follow();
    listeners.add(setBoard);
    void loadWorkBoard().catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
    return () => {
      listeners.delete(setBoard);
    };
  }, []);
  return {
    board,
    error,
    reload: () =>
      loadWorkBoard()
        .then(() => setError(null))
        .catch((cause) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        ),
  };
}

/** The For you items of the board as last read: the badge's count. */
export function workForYouCount(board: WorkBoard | null = latest): number {
  return board ? board.items.filter((item) => item.state === "you").length : 0;
}

/**
 * The board for a badge or a count (the phone menu's Work entry, a
 * chat's items): read once the socket is up, then kept by the pushes,
 * through `select`. Off when not `enabled`: nothing read.
 */
function useWorkBoardCount(
  select: (board: WorkBoard | null) => number,
  enabled: boolean,
  /** Read again when mounted, though read already (the badge: once). */
  fresh: boolean,
): number {
  const selectRef = useRef(select);
  selectRef.current = select;
  const [, setCount] = useState(() => (enabled ? select(latest) : 0));
  useEffect(() => {
    if (!enabled) return;
    follow();
    const listener = (board: WorkBoard) => setCount(selectRef.current(board));
    listeners.add(listener);
    setCount(selectRef.current(latest));
    const load = () => void loadWorkBoard().catch(() => {});
    if (fresh || !latest) load();
    // Before the socket is up the read fails; again once it is, and after
    // a reconnect, whose pushes were missed.
    const offStatus = bridge.onStatus((status) => {
      if (status === "connected") load();
    });
    return () => {
      listeners.delete(listener);
      offStatus();
    };
  }, [enabled, fresh]);
  return enabled ? select(latest) : 0;
}

/** The For you count for a badge (the phone menu's Work entry). */
export function useWorkForYouCount(enabled = true): number {
  return useWorkBoardCount(workForYouCount, enabled, true);
}

/** The live items a session owns (its subagents' too), by its address. */
export function workOwnedCount(
  address: string,
  board: WorkBoard | null = latest,
): number {
  return board
    ? board.items.filter(
        (item) => item.state !== "done" && item.owner?.session === address,
      ).length
    : 0;
}

/** A chat's count: the live items its session owns. */
export function useWorkOwnedCount(address: string | null): number {
  return useWorkBoardCount(
    (board) => (address ? workOwnedCount(address, board) : 0),
    !!address,
    false,
  );
}

/**
 * What an item is added with (`bridge.work.add`), the one way every add
 * form builds it (the board's, a chat's through the board's): the user's
 * words and images, its project, and for an item added from a session's
 * chat that session as its owner (which sorts it) and the message it
 * came from, and where it was added (its workspace's tag).
 */
export function workAddParams(params: {
  text?: string;
  images?: { token: string; type: string; data: string }[];
  project: string;
  owner?: string;
  links?: WorkLink[];
  /** Where it was added: a workspace, or a pane of it (a chat's). */
  workspace?: { connectionId: string; workspaceId?: string; paneId?: string };
}): Record<string, unknown> {
  const { owner, links, ...rest } = params;
  return {
    ...rest,
    ...(owner ? { owner: { session: owner } } : {}),
    ...(links?.length ? { links } : {}),
  };
}

/** Where a session runs, as the server says (owner_target, session_target). */
export type WorkSessionTarget = {
  connectionId: string;
  runtimeGeneration: number;
  workspaceId: string;
  paneId: string;
  task?: string;
};

/** Shows a session's pane (its chat), as a notification's link does. */
export function showWorkSession(target: WorkSessionTarget) {
  window.dispatchEvent(
    new CustomEvent(TASK_NOTIFICATION_ACTIVATE_EVENT, {
      detail: {
        connectionId: target.connectionId,
        runtimeGeneration: target.runtimeGeneration,
        workspaceId: target.workspaceId,
        paneId: target.paneId,
      },
    }),
  );
}

/**
 * A chat's message, once drawn (its pane just shown, its chat loading):
 * scrolled to and marked a moment. Given up after `frames`.
 */
export function revealChatEntry(entry: string, frames = 120) {
  let left = frames;
  const step = () => {
    const found = document.querySelector<HTMLElement>(
      `[data-entry-id="${CSS.escape(entry)}"]`,
    );
    if (found && found.getClientRects().length > 0) {
      found.scrollIntoView({ block: "center" });
      found.classList.add("is-work-linked");
      setTimeout(() => found.classList.remove("is-work-linked"), 2400);
      return;
    }
    if (--left > 0) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * A chat link of an item: the session's chat shown, on the message when
 * the link names one. Answers why it could not, or null.
 */
export async function openWorkChat(
  link: Extract<WorkLink, { kind: "chat" }>,
): Promise<string | null> {
  const { target } = await workCall<{ target: WorkSessionTarget | null }>(
    "session_target",
    { session: link.session },
  );
  if (!target) return `${link.session} is not running in any pane right now`;
  showWorkSession(target);
  if (link.entry) revealChatEntry(link.entry);
  return null;
}

/** Where a file link opens, as the server says (link_target). */
export type WorkFileTarget = {
  connectionId: string | null;
  root: string;
  path: string;
};

/** The workspaces a file link may open in: their ids and checkouts. */
export type WorkFileWorkspace = {
  workspace_id: string;
  focused?: boolean;
  cwd?: string | null;
  worktree?: { checkout_path?: string | null } | null;
};

function pathHolds(root: string, path: string): boolean {
  const base = root.replace(/[\\/]+$/, "");
  return !!base && (path === base || path.startsWith(`${base}/`));
}

/**
 * The workspace whose Files show a file (its absolute path): the focused
 * one when its checkout holds it, else the one whose checkout holds it the
 * most closely, else the focused one (Files read any absolute path).
 */
export function workFileWorkspace(
  workspaces: readonly WorkFileWorkspace[],
  file: string,
): string | null {
  const rootOf = (workspace: WorkFileWorkspace) =>
    workspace.worktree?.checkout_path ?? workspace.cwd ?? null;
  const focused = workspaces.find((workspace) => workspace.focused);
  const focusedRoot = focused ? rootOf(focused) : null;
  if (focused && focusedRoot && pathHolds(focusedRoot, file))
    return focused.workspace_id;
  let best: { id: string; length: number } | null = null;
  for (const workspace of workspaces) {
    const root = rootOf(workspace);
    if (root && pathHolds(root, file) && (!best || root.length > best.length))
      best = { id: workspace.workspace_id, length: root.length };
  }
  return (
    best?.id ?? focused?.workspace_id ?? workspaces[0]?.workspace_id ?? null
  );
}
