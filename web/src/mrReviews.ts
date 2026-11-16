import { useEffect, useState } from "react";
import type {
  MrInbox,
  MrReviewsPush,
  MrReviewsSettings,
  MrWorkspaceLink,
} from "../../shared/mrReviews";
import { bridge } from "./api";

/**
 * The reviews inbox for the page: `bridge.mr_reviews.*`, machine-wide. The
 * bridge keeps the inbox fresh within the forges' call budget; the page
 * asks it again every little while when it shows it.
 */

export function mrReviewsCall<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return bridge.call(`bridge.mr_reviews.${method}`, params, 30_000, {
    lane: "background",
  });
}

let latest: MrInbox | null = null;
const listeners = new Set<(inbox: MrInbox) => void>();

/** The inbox as last read on this page, for the command menu. */
export function latestMrInbox(): MrInbox | null {
  return latest;
}

function publish(inbox: MrInbox) {
  latest = inbox;
  for (const listener of listeners) listener(inbox);
}

export async function loadMrInbox(
  options: { fresh?: boolean; viewer?: boolean } = {},
): Promise<MrInbox> {
  let inbox = await mrReviewsCall<MrInbox>("inbox", options);
  // An answer older than a change pushed meanwhile never takes it back.
  if (latest && (inbox.orderVersion ?? 0) < (latest.orderVersion ?? 0))
    inbox = {
      ...inbox,
      order: latest.order ?? [],
      orderVersion: latest.orderVersion ?? 0,
    };
  publish(inbox);
  return inbox;
}

const changeListeners = new Set<(push: MrReviewsPush) => void>();
let following = false;

/** What the agent changed in the user's list, to say so (and offer Undo). */
export function onMrReviewsChange(
  listener: (push: MrReviewsPush) => void,
): () => void {
  follow();
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/**
 * The server pushes every change of the order, the pins and the removals:
 * the list follows at once (the order alone needs no new read), wherever
 * the change was made.
 */
function follow() {
  if (following) return;
  following = true;
  bridge.onMrReviews((push) => {
    if (latest && push.version <= (latest.orderVersion ?? 0)) return;
    if (latest)
      publish({ ...latest, order: push.order, orderVersion: push.version });
    if (push.changed.some((kind) => kind !== "order"))
      void loadMrInbox({ viewer: false }).catch(() => {});
    for (const listener of changeListeners) listener(push);
  });
}

/** How often a shown inbox asks the bridge (it answers from its cache). */
export const INBOX_POLL_MS = 20_000;
/** Sooner while the bridge is refreshing. */
const REFRESHING_POLL_MS = 2_000;

/** The inbox, read now and again while mounted. */
export function useMrInbox(): {
  inbox: MrInbox | null;
  error: string | null;
  reload: (fresh?: boolean) => Promise<void>;
} {
  const [inbox, setInbox] = useState<MrInbox | null>(latest);
  const [error, setError] = useState<string | null>(null);
  const reload = async (fresh = false) => {
    try {
      await loadMrInbox({ fresh });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => {
    follow();
    listeners.add(setInbox);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let live = true;
    const tick = async () => {
      await reload();
      if (!live) return;
      timer = setTimeout(
        tick,
        latest?.refreshing ? REFRESHING_POLL_MS : INBOX_POLL_MS,
      );
    };
    void tick();
    return () => {
      live = false;
      listeners.delete(setInbox);
      if (timer) clearTimeout(timer);
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: mount only
  }, []);
  return { inbox, error, reload };
}

export function loadMrReviewsSettings(): Promise<MrReviewsSettings> {
  return mrReviewsCall<MrReviewsSettings>("settings.get");
}

export function saveMrReviewsSettings(
  settings: Partial<MrReviewsSettings>,
): Promise<MrReviewsSettings> {
  return mrReviewsCall<MrReviewsSettings>("settings.update", { settings });
}

/** Pins a request by URL (or `project!12`): it stays listed. */
export function pinMrRequest(text: string): Promise<{ key: string }> {
  return mrReviewsCall<{ key: string }>("pin", { text });
}

/** An operation on the latest order: move requests, or undo a change. */
export function orderMrRequests(
  operation:
    | { op: "top" | "bottom" | "arrange"; keys: string[] }
    | { op: "before" | "after"; keys: string[]; target: string }
    | { op: "undo"; version: number },
): Promise<{ version: number }> {
  return mrReviewsCall<{ version: number }>("order", operation);
}

/** Takes a request out of the view; a pinned one is unpinned. */
export function hideMrRequest(
  key: string,
): Promise<{ action: "hidden" | "unpinned" }> {
  return mrReviewsCall<{ action: "hidden" | "unpinned" }>("hide", { key });
}

export function unhideMrRequest(key: string): Promise<unknown> {
  return mrReviewsCall("unhide", { key });
}

/** Unpins a request: it stays listed where a query lists it. */
export function unpinMrRequest(key: string): Promise<unknown> {
  return mrReviewsCall("unpin", { key });
}

/** The workspaces that are each request's, on every connection. */
export async function loadMrWorkspaceLinks(
  keys: string[],
): Promise<Record<string, MrWorkspaceLink[]>> {
  if (!keys.length) return {};
  const reply = await mrReviewsCall<{
    links?: Record<string, MrWorkspaceLink[]>;
  }>("links", { keys });
  return reply.links ?? {};
}

/** How long the links of the shown requests stand before they are read again. */
export const LINKS_POLL_MS = 60_000;

/**
 * The workspaces of the requests shown (by key), read when the set of
 * requests changes and every LINKS_POLL_MS while mounted.
 */
export function useMrWorkspaceLinks(
  keys: readonly string[],
): Record<string, MrWorkspaceLink[]> {
  const [links, setLinks] = useState<Record<string, MrWorkspaceLink[]>>({});
  const wanted = [...keys].sort().join("\n");
  useEffect(() => {
    if (!wanted) {
      setLinks({});
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      try {
        const next = await loadMrWorkspaceLinks(wanted.split("\n"));
        if (live) setLinks(next);
      } catch {
        // Kept as they were: a connection may be reconnecting.
      }
      if (live) timer = setTimeout(read, LINKS_POLL_MS);
    };
    void read();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [wanted]);
  return links;
}
