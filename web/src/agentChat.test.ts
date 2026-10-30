import { describe, expect, jest, test } from "bun:test";
import type { AgentChatState } from "../../shared/agentChat";
import {
  agentChatSnapshot,
  applyStateEvent,
  cutOffNotice,
  DEPARTING_MS,
  type DepartingQueued,
  departingAfterEvent,
  historyUserUuids,
  liveAfterSubscribe,
  queuedEntries,
  queuedEntryId,
  SUBSCRIBE_RETRY_MS,
  watchAgentChat,
} from "./agentChat";
import type { ConnectionClient } from "./api";
import { EMPTY_LIVE_TURN, type LiveTurn } from "./components/liveTurn";

const state: AgentChatState = {
  pane_id: "p1",
  owner: "conversation",
  phase: "conversation",
  session_id: "s1",
  cwd: "/w",
  status: "idle",
  tools_running: false,
  activity: null,
  queue: [],
  interrupted: null,
};

describe("conversation mode's state in the browser", () => {
  test("follows status, queue, lease and session events", () => {
    let next = applyStateEvent(state, {
      type: "status",
      status: "working",
      tools_running: true,
      activity: "Bash",
    });
    expect(next).toMatchObject({ status: "working", activity: "Bash" });
    next = applyStateEvent(next, {
      type: "queue",
      queue: [{ id: "q1", text: "later", images: [], queued_at: "t" }],
    });
    expect(next?.queue.length).toBe(1);
    next = applyStateEvent(next, {
      type: "session",
      session_id: "s2",
      previous: "s1",
    });
    expect(next?.session_id).toBe("s2");
    next = applyStateEvent(next, {
      type: "lease",
      owner: "terminal",
      phase: "terminal",
      session_id: null,
    });
    expect(next).toMatchObject({
      owner: "terminal",
      phase: "terminal",
      status: "stopped",
      queue: [],
    });
  });

  test("an event it does not track leaves it as it is", () => {
    expect(
      applyStateEvent(state, {
        type: "delta",
        message_id: "m",
        index: 0,
        text: "x",
      }),
    ).toBe(state);
    expect(applyStateEvent(null, { type: "queue", queue: [] })).toBeNull();
  });

  test("the queue shows as queued user messages, known by their ids", () => {
    const entries = queuedEntries([
      { id: "q1", text: "look", images: ["/tmp/a.png"], queued_at: "t" },
    ]);
    expect(entries).toEqual([
      {
        id: "queue:q1",
        role: "user",
        kind: "message",
        text: "look\n/tmp/a.png",
        sent_at: "t",
        queued: true,
      },
    ]);
    expect(queuedEntryId(entries[0]!)).toBe("q1");
    expect(queuedEntryId({ id: "abc" })).toBeNull();
  });
});

describe("a turn cut short", () => {
  const cut = { at: "2026-10-30T10:00:00.000Z", reason: "restart" } as const;

  test("follows the bridge's notice, and the terminal taking over ends it", () => {
    let next = applyStateEvent(state, {
      type: "interrupted",
      interrupted: cut,
    });
    expect(next?.interrupted).toEqual(cut);
    next = applyStateEvent(next, { type: "interrupted", interrupted: null });
    expect(next?.interrupted).toBeNull();
    next = applyStateEvent(
      { ...state, interrupted: cut },
      {
        type: "lease",
        owner: "terminal",
        phase: "terminal",
        session_id: "s1",
      },
    );
    expect(next?.interrupted).toBeNull();
  });

  test("says why, only while no turn runs in conversation mode", () => {
    expect(cutOffNotice(null)).toBeNull();
    expect(cutOffNotice(state)).toBeNull();
    expect(cutOffNotice({ ...state, interrupted: cut })).toBe(
      "Cut off by a Roamgate restart",
    );
    expect(
      cutOffNotice({
        ...state,
        interrupted: { ...cut, reason: "process_exited" },
      }),
    ).toBe("Claude stopped unexpectedly");
    for (const status of ["working", "blocked", "starting"] as const)
      expect(cutOffNotice({ ...state, status, interrupted: cut })).toBeNull();
    expect(
      cutOffNotice({ ...state, phase: "to_terminal", interrupted: cut }),
    ).toBeNull();
    // An older bridge says nothing of it.
    const older: Partial<AgentChatState> = { ...state, interrupted: cut };
    delete older.interrupted;
    expect(cutOffNotice(older as AgentChatState)).toBeNull();
  });
});

describe("messages on their way out of the queue", () => {
  const q1 = { id: "q1", text: "first", images: [], queued_at: "t" };
  const q2 = { id: "q2", text: "second", images: [], queued_at: "t" };
  const none: readonly DepartingQueued[] = [];
  const noWithdrawn = new Set<string>();

  test("stay shown as queued until their replay comes", () => {
    // The bridge empties its queue as it writes it to Claude.
    const left = departingAfterEvent(
      none,
      [q1],
      { type: "queue", queue: [] },
      noWithdrawn,
      1000,
    );
    expect(left).toEqual([{ ...q1, left_at: 1000 }]);
    // Deltas and status in between change nothing.
    expect(
      departingAfterEvent(
        left,
        [],
        {
          type: "status",
          status: "working",
          tools_running: false,
          activity: null,
        },
        noWithdrawn,
        1100,
      ),
    ).toBe(left);
    // Its replay draws it in the live turn, in the same update.
    expect(
      departingAfterEvent(
        left,
        [],
        { type: "user", uuid: "q1", text: "first", images: 0 },
        noWithdrawn,
        1200,
      ),
    ).toEqual([]);
  });

  test("several sent as one turn go with its replay under a new uuid", () => {
    const left = departingAfterEvent(
      none,
      [q1, q2],
      { type: "queue", queue: [] },
      noWithdrawn,
      1000,
    );
    expect(left.map((item) => item.id)).toEqual(["q1", "q2"]);
    expect(
      departingAfterEvent(
        left,
        [],
        { type: "user", uuid: "fresh", text: "first\n\nsecond", images: 0 },
        noWithdrawn,
        1200,
      ),
    ).toEqual([]);
  });

  test("a message taken back is not on its way", () => {
    expect(
      departingAfterEvent(
        none,
        [q1, q2],
        { type: "queue", queue: [q2] },
        new Set(["q1"]),
        1000,
      ),
    ).toBe(none);
  });

  test("one put back in the queue (not delivered) is queued again", () => {
    const left = departingAfterEvent(
      none,
      [q1],
      { type: "queue", queue: [] },
      noWithdrawn,
      1000,
    );
    expect(
      departingAfterEvent(
        left,
        [],
        { type: "queue", queue: [q1] },
        noWithdrawn,
        1100,
      ),
    ).toEqual([]);
  });

  test("the terminal taking the session back, or no replay in time, ends them", () => {
    const left = departingAfterEvent(
      none,
      [q1],
      { type: "queue", queue: [] },
      noWithdrawn,
      1000,
    );
    expect(
      departingAfterEvent(
        left,
        [],
        {
          type: "lease",
          owner: "terminal",
          phase: "terminal",
          session_id: null,
        },
        noWithdrawn,
        1100,
      ),
    ).toEqual([]);
    expect(
      departingAfterEvent(
        left,
        [],
        { type: "delta", message_id: "m", index: 0, text: "x" },
        noWithdrawn,
        1000 + DEPARTING_MS,
      ),
    ).toEqual([]);
  });

  test("the transcript's user messages are known by uuid", () => {
    expect(
      historyUserUuids([
        {
          id: "a",
          role: "user",
          kind: "message",
          text: "x",
          sent_at: "t",
          uuid: "u1",
        },
        {
          id: "b",
          role: "assistant",
          kind: "message",
          text: "y",
          sent_at: "t",
          uuid: "u2",
        },
        { id: "c", role: "user", kind: "message", text: "z", sent_at: "t" },
      ]),
    ).toEqual(new Set(["u1"]));
  });
});

describe("following a pane", () => {
  test("a subscription refused while the socket comes back is asked again", async () => {
    jest.useFakeTimers();
    try {
      let refusals = 2;
      const calls: string[] = [];
      const client: ConnectionClient = {
        connectionId: "c-retry",
        generation: 1,
        serverRuntimeGeneration: 1,
        call: async (method) => {
          calls.push(method);
          if (refusals-- > 0)
            throw new Error("connection runtime generation is unavailable");
          return { ...state, queue: [] };
        },
        isCurrent: () => true,
        acceptsServerGeneration: () => true,
      };
      const stop = watchAgentChat(client, "p-retry");
      const flush = async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      };
      await flush();
      expect(calls).toHaveLength(1);
      jest.advanceTimersByTime(SUBSCRIBE_RETRY_MS[0]!);
      await flush();
      jest.advanceTimersByTime(SUBSCRIBE_RETRY_MS[1]!);
      await flush();
      expect(calls).toEqual([
        "agent_chat.subscribe",
        "agent_chat.subscribe",
        "agent_chat.subscribe",
      ]);
      expect(agentChatSnapshot("c-retry", "p-retry").state?.status).toBe(
        "idle",
      );
      stop();
      jest.advanceTimersByTime(2000);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a subscription in the middle of a turn draws what already streamed", async () => {
    const client: ConnectionClient = {
      connectionId: "c-reload",
      generation: 1,
      serverRuntimeGeneration: 1,
      call: async () => ({
        ...state,
        status: "working",
        queue: [],
        streamed: [
          { message_id: "m1", index: 1, text: "Rain falls", done: false },
        ],
      }),
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
    };
    const stop = watchAgentChat(client, "p-reload");
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const snapshot = agentChatSnapshot("c-reload", "p-reload");
    expect(snapshot.live.items).toEqual([
      expect.objectContaining({ key: "m1:1", text: "Rain falls" }),
    ]);
    expect(snapshot.live.endedAt).toBeNull();
    // Only the subscription carries it: the state kept has none.
    expect(snapshot.state && "streamed" in snapshot.state).toBe(false);
    stop();
  });

  test("a turn the bridge no longer runs is ended on a new subscription", () => {
    const running: LiveTurn = { ...EMPTY_LIVE_TURN, endedAt: null };
    const ended = liveAfterSubscribe(running, state, 42);
    expect(ended.endedAt).toBe(42);
    const working = { ...state, status: "working" as const };
    expect(liveAfterSubscribe(running, working, 42)).toBe(running);
    expect(liveAfterSubscribe(EMPTY_LIVE_TURN, state, 42)).toBe(
      EMPTY_LIVE_TURN,
    );
  });
});
