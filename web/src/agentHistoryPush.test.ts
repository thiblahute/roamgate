import { expect, test } from "bun:test";
import type { ConnectionClient } from "./api";
import { watchAgentHistory } from "./agentHistoryPush";

const params = {
  pane_id: "p1",
  workspace_id: "w1",
  tab_id: "t1",
  agent: "claude",
};

function clientAnswering(answers: (() => Promise<unknown>)[]) {
  const calls: string[] = [];
  const client = {
    connectionId: "local",
    generation: calls.length,
    isCurrent: () => true,
    call: (method: string) => {
      calls.push(method);
      return answers.shift()?.() ?? Promise.resolve({ ok: true });
    },
  } as unknown as ConnectionClient;
  return { client, calls };
}

test("a subscription that timed out is asked again, and pushes", async () => {
  const { client, calls } = clientAnswering([
    () => Promise.reject(new Error("timeout: agent_history.subscribe")),
    () => Promise.resolve({ pane_id: "p1", path: "/s.jsonl" }),
  ]);
  const watch = watchAgentHistory(client, params, () => {});
  try {
    // Taken as no push, the chat would poll every few seconds for good.
    expect(await watch.pushed).toBe(true);
    expect(calls).toEqual([
      "agent_history.subscribe",
      "agent_history.subscribe",
    ]);
  } finally {
    watch.close();
  }
});

test("a bridge that cannot push is polled", async () => {
  const { client, calls } = clientAnswering([
    () => Promise.reject(new Error("unknown method: agent_history.subscribe")),
  ]);
  const watch = watchAgentHistory(
    client,
    { ...params, pane_id: "p2" },
    () => {},
  );
  try {
    expect(await watch.pushed).toBe(false);
    expect(calls).toEqual(["agent_history.subscribe"]);
  } finally {
    watch.close();
  }
});
