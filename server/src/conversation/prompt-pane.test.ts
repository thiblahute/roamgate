import { describe, expect, test } from "bun:test";
import { promptPaneAgent } from "./prompt-pane";

function runtime(conversationHolds: boolean) {
  const messages: [string, string][] = [];
  const calls: [string, Record<string, unknown>][] = [];
  return {
    messages,
    calls,
    conversation: {
      async prompt(paneId: string, text: string) {
        if (!conversationHolds) return false;
        messages.push([paneId, text]);
        return true;
      },
    },
    herdr: {
      async call(method: string, params: Record<string, unknown>) {
        calls.push([method, params]);
        return {};
      },
    },
  };
}

describe("text for a pane's agent", () => {
  test("conversation mode: a message in the conversation, nothing typed", async () => {
    const rt = runtime(true);
    expect(await promptPaneAgent(rt, "w1:p1", "A comment")).toBe(
      "conversation",
    );
    expect(rt.messages).toEqual([["w1:p1", "A comment"]]);
    expect(rt.calls).toEqual([]);
  });

  test("terminal mode: typed into the pane through Herdr", async () => {
    const rt = runtime(false);
    expect(await promptPaneAgent(rt, "w1:p1", "A comment")).toBe("terminal");
    expect(rt.messages).toEqual([]);
    expect(rt.calls).toEqual([
      ["agent.prompt", { target: "w1:p1", text: "A comment" }],
    ]);
  });

  test("a failure says so: the review records it as not delivered", async () => {
    const rt = runtime(false);
    rt.herdr.call = async () => {
      throw new Error("agent_blocked");
    };
    await expect(promptPaneAgent(rt, "w1:p1", "A comment")).rejects.toThrow(
      "agent_blocked",
    );
  });
});
