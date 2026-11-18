import type {
  AgentChatApiKeyQuestion,
  AgentChatEvent,
} from "../../../shared/agentChat";
import type { ApiKeyAnswer } from "./env";

/**
 * The question about a pane's API key (Claude Code has none filed for
 * it), asked in the chat as the TUI asks it: starts wait for the answer.
 */
export function createApiKeyQuestions(deps: {
  emit: (paneId: string, event: AgentChatEvent) => void;
  log: (message: string, fields?: Record<string, unknown>) => void;
}) {
  const { emit, log } = deps;
  // Starts waiting for the user's answer about the pane's API key (Claude
  // Code has none filed for it): the chat asks the TUI's question.
  const apiKeyQuestions = new Map<
    string,
    {
      question: AgentChatApiKeyQuestion;
      waiters: Set<{
        settle: (answer: ApiKeyAnswer | null) => void;
        fail: (error: Error) => void;
      }>;
    }
  >();

  /**
   * Waits for the user's answer about the pane's API key; null when it
   * came from elsewhere (a terminal on the host answered Claude Code's own
   * question meanwhile). The question shows while a start waits on it.
   */
  function askApiKey(
    paneId: string,
    signal?: AbortSignal,
  ): Promise<ApiKeyAnswer | null> {
    let entry = apiKeyQuestions.get(paneId);
    if (!entry) {
      entry = {
        question: { asked_at: new Date().toISOString() },
        waiters: new Set(),
      };
      apiKeyQuestions.set(paneId, entry);
      log("Claude waits for the user's answer about the pane's API key", {
        pane: paneId,
      });
      emit(paneId, {
        type: "api_key_question",
        api_key_question: { ...entry.question },
      });
    }
    const asked = entry;
    return new Promise((resolve, reject) => {
      const waiter = {
        settle: (answer: ApiKeyAnswer | null) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(answer);
        },
        fail: (error: Error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        asked.waiters.delete(waiter);
        // Nothing waits on it any more: the question goes too.
        if (!asked.waiters.size && apiKeyQuestions.get(paneId) === asked)
          settleApiKey(paneId, null);
        waiter.fail(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Gave up waiting for the API key answer"),
        );
      };
      asked.waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  /**
   * The API key question is answered (or moot: null), or with `error` the
   * starts waiting on it give up; false if none waits.
   */
  function settleApiKey(
    paneId: string,
    answer: ApiKeyAnswer | null,
    error?: Error,
  ) {
    const entry = apiKeyQuestions.get(paneId);
    if (!entry) return false;
    apiKeyQuestions.delete(paneId);
    if (answer)
      log("the user answered the API key question", { pane: paneId, answer });
    for (const waiter of [...entry.waiters])
      if (error) waiter.fail(error);
      else waiter.settle(answer);
    emit(paneId, { type: "api_key_question", api_key_question: null });
    return true;
  }

  return {
    ask: askApiKey,
    settle: settleApiKey,
    /** Whether the question waits for an answer in the pane. */
    has: (paneId: string) => apiKeyQuestions.has(paneId),
    /** The question waiting in the pane, a copy; null: none. */
    question: (paneId: string): AgentChatApiKeyQuestion | null => {
      const entry = apiKeyQuestions.get(paneId);
      return entry ? { ...entry.question } : null;
    },
  };
}
