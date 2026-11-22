import type { HistoryStatus } from "../../shared/history";

/**
 * Local history (server/src/http/history.ts): its status, where it is and
 * whether it is written, a pass now.
 */

const WRITE_HEADERS = {
  "content-type": "application/json",
  "x-roamgate-settings": "1",
};

async function answer(response: Response): Promise<HistoryStatus> {
  const body = (await response.json().catch(() => ({}))) as HistoryStatus & {
    error?: string;
  };
  if (!response.ok) throw new Error(body.error ?? response.statusText);
  return body;
}

export async function fetchHistory(): Promise<HistoryStatus> {
  return answer(await fetch("/api/history", { cache: "no-store" }));
}

/** `location` null: the default place. */
export async function setHistory(change: {
  location?: string | null;
  enabled?: boolean;
}): Promise<HistoryStatus> {
  return answer(
    await fetch("/api/history", {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify(change),
    }),
  );
}

export async function commitHistory(): Promise<HistoryStatus> {
  return answer(
    await fetch("/api/history/commit", {
      method: "POST",
      headers: WRITE_HEADERS,
      body: "{}",
    }),
  );
}
