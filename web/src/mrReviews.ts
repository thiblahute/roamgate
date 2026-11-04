import { useEffect, useState } from "react";
import type { MrInbox, MrReviewsSettings } from "../../shared/mrReviews";
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

export async function loadMrInbox(
  options: { fresh?: boolean; viewer?: boolean } = {},
): Promise<MrInbox> {
  const inbox = await mrReviewsCall<MrInbox>("inbox", options);
  latest = inbox;
  for (const listener of listeners) listener(inbox);
  return inbox;
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
