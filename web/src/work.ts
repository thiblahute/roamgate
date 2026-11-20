import { useEffect, useState } from "react";
import type { WorkBoard, WorkPush } from "../../shared/work";
import { bridge } from "./api";

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
