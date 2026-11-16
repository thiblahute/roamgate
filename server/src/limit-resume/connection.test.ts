import { expect, test } from "bun:test";
import { limitConnection, type LimitRuntime } from "./connection";

function runtime(
  owned: ReturnType<LimitRuntime["conversation"]["ownedPanes"]> = [],
) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const prompted: { paneId: string; text: string }[] = [];
  const value: LimitRuntime = {
    id: "desktop",
    herdr: {
      async call(method, params) {
        calls.push({ method, params });
        if (method === "agent.list")
          return {
            agents: [
              {
                pane_id: "w1:p1",
                agent: "claude",
                agent_status: "idle",
                agent_session: { kind: "id", value: "terminal-session" },
              },
              // Codex, and a Claude Herdr has no session for: not ours.
              {
                pane_id: "w1:p2",
                agent: "codex",
                agent_status: "idle",
                agent_session: { kind: "id", value: "codex-session" },
              },
              { pane_id: "w1:p3", agent: "claude", agent_status: "idle" },
              // The holder's child in a pane conversation mode holds.
              {
                pane_id: "w2:p1",
                agent: "claude",
                agent_status: "working",
                agent_session: { kind: "id", value: "stale" },
              },
            ],
          };
        return {};
      },
    },
    conversation: {
      ownedPanes: () => owned,
      async prompt(paneId, text) {
        if (!owned.some((each) => each.pane_id === paneId)) return false;
        prompted.push({ paneId, text });
        return true;
      },
    },
    transcriptTail: async () => null,
  };
  return { value, calls, prompted };
}

const asleep = {
  pane_id: "w2:p1",
  session_id: "conversation-session",
  phase: "conversation",
  // An asleep conversation is idle: its next message wakes it.
  agent_status: "idle",
  agent: "claude",
};

test("lists terminal and conversation-mode Claude sessions, asleep ones included", async () => {
  const { value } = runtime([
    asleep,
    { ...asleep, pane_id: "w2:p2", session_id: "x", phase: "to_terminal" },
  ]);
  expect(await limitConnection(value).panes()).toEqual([
    {
      paneId: "w1:p1",
      sessionId: "terminal-session",
      owner: "terminal",
      status: "idle",
    },
    {
      paneId: "w2:p1",
      sessionId: "conversation-session",
      owner: "conversation",
      status: "idle",
    },
  ]);
});

test("a conversation gets the message in its queue, a terminal has it typed", async () => {
  const { value, calls, prompted } = runtime([asleep]);
  const connection = limitConnection(value);
  const [terminal, conversation] = await connection.panes();
  await connection.deliver(conversation!, "Go on.");
  expect(prompted).toEqual([{ paneId: "w2:p1", text: "Go on." }]);
  expect(calls.some((call) => call.method === "agent.prompt")).toBe(false);

  await connection.deliver(terminal!, "Go on.");
  expect(calls.at(-1)).toEqual({
    method: "agent.prompt",
    params: { target: "w1:p1", text: "Go on." },
  });
  expect(prompted).toHaveLength(1);
});

test("a terminal Claude running Roamgate's mod: its status and delivery", async () => {
  const { value, calls } = runtime();
  const handed: string[] = [];
  value.claudeMod = {
    pane: (paneId) =>
      paneId === "w1:p1"
        ? {
            connection_id: "desktop",
            pane_id: "w1:p1",
            session_id: "mod-session",
            claude: "2.1.319",
            protocol: 1,
            // Herdr's screen says idle; the turn still runs.
            status: "working",
            waiting: 0,
            held: 0,
            since: "",
            updated_at: "",
          }
        : null,
    deliver: (_paneId, text) => {
      handed.push(text);
      return { id: 1 };
    },
  };
  const connection = limitConnection(value);
  expect((await connection.panes())[0]).toEqual({
    paneId: "w1:p1",
    sessionId: "mod-session",
    owner: "terminal",
    status: "working",
  });
  const [pane] = await connection.panes();
  await connection.deliver(pane!, "Continue");
  expect(handed).toEqual(["Continue"]);
  expect(calls.some((each) => each.method === "agent.prompt")).toBe(false);
});
