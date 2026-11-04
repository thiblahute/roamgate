import { useEffect, useState } from "react";
import type { MrAgentSnapshot, MrItem } from "../../shared/mrReviews";
import { mrReviewsCall } from "./mrReviews";

/**
 * The reviews agent's chat for the page (`bridge.mr_reviews.agent.*`):
 * read while something shows it or waits for an answer, often while it
 * answers. Its `opens` asked from this page (its own request ids) show
 * the request's review here, through the Reviews panel's own flow.
 */

/** How often the chat is read while the agent answers. */
const RUNNING_POLL_MS = 500;
/** And otherwise, while shown. */
const IDLE_POLL_MS = 10_000;
/** How long a spoken question waits for its answer. */
const ASK_TIMEOUT_MS = 10 * 60_000;

let snapshot: MrAgentSnapshot | null = null;
let lastError: string | null = null;
const listeners = new Set<() => void>();
const ownRequests = new Set<string>();
const opened = new Set<string>();
/** Requests the agent showed, for the panel to open by key. */
const items = new Map<string, MrItem>();
let watchers = 0;
/** The Reviews panel's own open, while it is shown. */
let opener: ((item: MrItem) => void) | null = null;

/** The panel shows the agent's reviews itself while it is mounted. */
export function setMrAgentOpener(open: ((item: MrItem) => void) | null) {
  opener = open;
}
let timer: ReturnType<typeof setTimeout> | null = null;
let reading: Promise<void> | null = null;

export function readMrAgent(): MrAgentSnapshot | null {
  return snapshot;
}

export function mrAgentError(): string | null {
  return lastError;
}

/** A request the agent showed, by key. */
export function mrAgentItem(key: string): MrItem | undefined {
  return items.get(key);
}

export function subscribeMrAgent(listener: () => void): () => void {
  listeners.add(listener);
  watchers++;
  schedule(0);
  return () => {
    listeners.delete(listener);
    watchers--;
  };
}

function emit() {
  for (const listener of [...listeners]) listener();
}

function take(next: MrAgentSnapshot) {
  snapshot = next;
  lastError = null;
  for (const message of next.messages)
    for (const item of message.opens ?? []) {
      items.set(item.key, item);
      const once = `${message.id}:${item.key}`;
      if (
        message.request_id &&
        ownRequests.has(message.request_id) &&
        !opened.has(once)
      ) {
        opened.add(once);
        if (opener) opener(item);
        else
          void import("./mrReviewsOpen").then((module) =>
            module.openMrReviewByKey(item.key),
          );
      }
    }
  emit();
}

async function read(): Promise<void> {
  reading ??= mrReviewsCall<MrAgentSnapshot>("agent.get")
    .then(take, (error) => {
      lastError = error instanceof Error ? error.message : String(error);
      emit();
    })
    .finally(() => {
      reading = null;
    });
  return reading;
}

function schedule(ms?: number) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!watchers) return;
  timer = setTimeout(
    () => {
      timer = null;
      void read().finally(() => schedule());
    },
    ms ?? (snapshot?.running ? RUNNING_POLL_MS : IDLE_POLL_MS),
  );
}

/** Sends a question; while it answers, it waits (`queue`). */
export async function sendMrAgent(
  text: string,
  options: { whenBusy?: "queue"; requestId?: string } = {},
): Promise<{ queued: boolean; requestId: string }> {
  const requestId = options.requestId ?? crypto.randomUUID();
  ownRequests.add(requestId);
  const reply = await mrReviewsCall<{
    queued: boolean;
    snapshot: MrAgentSnapshot;
  }>("agent.send", {
    text,
    request_id: requestId,
    ...(options.whenBusy ? { when_busy: options.whenBusy } : {}),
  });
  take(reply.snapshot);
  schedule(RUNNING_POLL_MS);
  return { queued: reply.queued, requestId };
}

export async function stopMrAgent() {
  take(await mrReviewsCall<MrAgentSnapshot>("agent.stop"));
}

export async function resetMrAgent() {
  take(await mrReviewsCall<MrAgentSnapshot>("agent.reset"));
}

export async function unqueueMrAgent(id: string): Promise<boolean> {
  const reply = await mrReviewsCall<{ removed: boolean }>("agent.unqueue", {
    id,
  });
  await read();
  return reply.removed;
}

/** The chat, read while mounted. */
export function useMrAgent(): {
  snapshot: MrAgentSnapshot | null;
  error: string | null;
} {
  const [state, setState] = useState(() => ({
    snapshot,
    error: lastError,
  }));
  useEffect(
    () => subscribeMrAgent(() => setState({ snapshot, error: lastError })),
    [],
  );
  return state;
}

/**
 * A question said aloud: asked as if typed (queued behind a running one),
 * resolved with its answer once the agent has finished it.
 */
export async function askReviewsAgent(text: string): Promise<string> {
  const unsubscribe = subscribeMrAgent(() => {});
  try {
    const { requestId } = await sendMrAgent(text, { whenBusy: "queue" });
    const deadline = Date.now() + ASK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const current = snapshot;
      const reply = current?.messages.find(
        (message) =>
          message.role === "assistant" && message.request_id === requestId,
      );
      const last = current?.messages[current.messages.length - 1];
      if (reply && !(current?.running && last === reply)) {
        if (reply.failed && !reply.text)
          throw new Error(
            current?.error ?? "The reviews agent could not answer.",
          );
        return reply.text || "The reviews agent gave no answer.";
      }
      await new Promise((resolve) => setTimeout(resolve, RUNNING_POLL_MS));
      await read();
    }
    return "The reviews agent is still answering; see its chat in Reviews.";
  } finally {
    unsubscribe();
  }
}
