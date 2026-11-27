import { describe, expect, jest, test } from "bun:test";
import type { AgentChatState } from "../../shared/agentChat";
import { frameAgentMessage } from "../../shared/agentMessage";
import {
  agentChatSnapshot,
  applyStateEvent,
  cutOffNotice,
  DEPARTING_MS,
  deliveryNotice,
  queueWaiting,
  type DepartingQueued,
  departingAfterEvent,
  historyUserUuids,
  lastUserUuid,
  liveAfterSubscribe,
  queuedEntries,
  queuedEntryId,
  listAgentChatMcp,
  rewindAgentChat,
  runAgentChatMcpAction,
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
  test("keeps the predicted next message until a turn starts", () => {
    const guess = { uuid: "g-1", text: "run the tests" };
    let next = applyStateEvent(state, {
      type: "next_prompt",
      next_prompt: guess,
    });
    expect(next?.next_prompt).toEqual(guess);
    expect(
      applyStateEvent(next, { type: "user", uuid: "u", text: "x", images: 0 })
        ?.next_prompt,
    ).toBeNull();
    expect(
      applyStateEvent(next, {
        type: "lease",
        owner: "terminal",
        phase: "terminal",
        session_id: "s1",
      })?.next_prompt,
    ).toBeNull();
    next = applyStateEvent(next, { type: "next_prompt", next_prompt: null });
    expect(next?.next_prompt).toBeNull();
  });

  test("follows the conversation to the agent it moved to", () => {
    const capabilities = {
      steer: false,
      questions: false,
      alwaysAllow: true,
      rewind: null,
      promptSuggestions: false,
      shellLines: "prelude" as const,
      backgroundTasks: false,
      images: "base64" as const,
      slashCommands: "agy" as const,
      models: true,
      mcp: false,
      backgroundTools: false,
    };
    const next = applyStateEvent(
      { ...state, agent: "claude", handoff_phase: "starting_replacement" },
      {
        type: "backend_switched",
        from_agent: "claude",
        to_agent: "agy",
        work_session_id: "ws-1",
        session_id: null,
        reason: "usage_limit",
        capabilities,
        at: "2026-11-26T10:00:00.000Z",
      },
    );
    expect(next?.agent).toBe("agy");
    expect(next?.capabilities).toEqual(capabilities);
    expect(next?.session_id).toBeNull();
    expect(next?.work_session_id).toBe("ws-1");
    expect(next?.handoff_phase).toBeUndefined();
  });

  test("says what the last /model did until it goes, or the terminal has the session", () => {
    const notice = {
      at: "2026-11-06T10:00:00.000Z",
      ok: true,
      requested: "sonnet",
      model: "claude-sonnet-5-5",
      text: "Model set to sonnet (claude-sonnet-5-5)",
    };
    const next = applyStateEvent(state, {
      type: "model_notice",
      model_notice: notice,
    });
    expect(next?.model_notice).toEqual(notice);
    expect(
      applyStateEvent(next, { type: "model_notice", model_notice: null })
        ?.model_notice,
    ).toBeNull();
    expect(
      applyStateEvent(next, {
        type: "lease",
        owner: "terminal",
        phase: "terminal",
        session_id: "s1",
      })?.model_notice,
    ).toBeNull();
  });

  test("follows a `!` line until Claude has it", () => {
    const shell = {
      id: "sh1",
      command: "echo hi",
      status: "running" as const,
      stdout: "",
      stderr: "",
      truncated: false,
      exit_code: null,
      started_at: "2026-11-01T00:00:00Z",
    };
    let next = applyStateEvent(state, { type: "shell", shell });
    expect(next?.shells).toEqual([shell]);
    next = applyStateEvent(next, {
      type: "shell",
      shell: { ...shell, status: "done", stdout: "hi\n", exit_code: 0 },
    });
    expect(next?.shells).toMatchObject([
      { id: "sh1", status: "done", stdout: "hi\n", exit_code: 0 },
    ]);
    next = applyStateEvent(next, {
      type: "shell",
      shell: { ...shell, id: "sh2" },
    });
    expect(next?.shells?.map((each) => each.id)).toEqual(["sh1", "sh2"]);
    // Sent to Claude: the transcript shows it from now on; the browser
    // keeps it, marked, for how it ended.
    next = applyStateEvent(next, {
      type: "shell",
      shell: { ...shell, status: "done", exit_code: 3, delivered: true },
    });
    expect(
      next?.shells?.map((each) => [each.id, !!each.delivered, each.exit_code]),
    ).toEqual([
      ["sh1", true, 3],
      ["sh2", false, null],
    ]);
    // Only the last 20 sent are kept.
    for (let index = 0; index < 25; index += 1)
      next = applyStateEvent(next, {
        type: "shell",
        shell: { ...shell, id: `old${index}`, delivered: true },
      });
    expect(next?.shells?.filter((each) => each.delivered)).toHaveLength(20);
    expect(next?.shells?.some((each) => each.id === "sh2")).toBe(true);
  });

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

  test("another agent session's queued message shows as one from it", () => {
    const framed = frameAgentMessage(
      {
        address: "desktop/w5:p1",
        name: "Merge checks",
        workspace: "gst2",
        agent: "claude",
      },
      "Rebase please",
    );
    expect(
      queuedEntries([{ id: "q2", text: framed, images: [], queued_at: "t" }]),
    ).toEqual([
      {
        id: "queue:q2",
        role: "user",
        kind: "message",
        text: "Rebase please",
        sent_at: "t",
        queued: true,
        injected: { kind: "session", label: "From Merge checks" },
      },
    ]);
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

  test("a rewind leaves none on its way: the bridge rewinds with nothing queued", () => {
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
        { type: "rewound", uuid: "u1" },
        noWithdrawn,
        1100,
      ),
    ).toEqual([]);
    expect(
      departingAfterEvent(
        none,
        [],
        { type: "rewound", uuid: "u1" },
        noWithdrawn,
        1100,
      ),
    ).toBe(none);
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

describe("/mcp", () => {
  const client = (call: ConnectionClient["call"]): ConnectionClient => ({
    connectionId: "c-mcp",
    generation: 1,
    serverRuntimeGeneration: 1,
    call,
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
  });

  test("asks the bridge for the servers and for an action", async () => {
    const calls: [string, unknown][] = [];
    const call: ConnectionClient["call"] = async (method, params) => {
      calls.push([method, params]);
      return method === "agent_chat.mcp" ? { servers: [] } : { ok: true };
    };
    expect(await listAgentChatMcp(client(call), "p1")).toEqual({ servers: [] });
    expect(
      await runAgentChatMcpAction(client(call), "p1", {
        action: "enable",
        server: "docs",
      }),
    ).toEqual({ ok: true });
    expect(calls).toEqual([
      ["agent_chat.mcp", { pane_id: "p1" }],
      [
        "agent_chat.mcp.action",
        { pane_id: "p1", action: "enable", server: "docs" },
      ],
    ]);
  });

  test("an action the bridge cannot reach is a failure, not a throw", async () => {
    expect(
      await runAgentChatMcpAction(
        client(async () => {
          throw new Error("offline");
        }),
        "p1",
        { action: "reconnect", server: "docs" },
      ),
    ).toEqual({ ok: false, reason: "offline" });
  });
});

describe("rewinding", () => {
  const client = (call: ConnectionClient["call"]): ConnectionClient => ({
    connectionId: "c-rewind",
    generation: 1,
    serverRuntimeGeneration: 1,
    call,
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
  });

  test("asks the bridge, with the latest message the chat shows", async () => {
    const calls: [string, unknown][] = [];
    const result = await rewindAgentChat(
      client(async (method, params) => {
        calls.push([method, params]);
        return { ok: true, prefill: "again" };
      }),
      "p1",
      { uuid: "u2", mode: "both", lastSeen: "u3", interrupt: true },
    );
    expect(result).toEqual({ ok: true, prefill: "again" });
    expect(calls).toEqual([
      [
        "agent_chat.rewind",
        {
          pane_id: "p1",
          uuid: "u2",
          mode: "both",
          last_seen: "u3",
          interrupt: true,
        },
      ],
    ]);
  });

  test("a failed call is a refusal with its reason", async () => {
    expect(
      await rewindAgentChat(
        client(async () => {
          throw new Error("socket closed");
        }),
        "p1",
        { uuid: "u2", mode: "conversation" },
      ),
    ).toEqual({ ok: false, reason: "socket closed" });
  });

  test("the latest user message with a uuid, not a queued one", () => {
    const message = (
      id: string,
      role: "user" | "assistant",
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      role,
      kind: "message" as const,
      text: id,
      sent_at: "2026-10-31T00:00:00Z",
      ...extra,
    });
    expect(
      lastUserUuid([
        message("a", "user", { uuid: "u1" }),
        message("b", "assistant", { uuid: "a1" }),
        message("c", "user", { uuid: "u2" }),
        message("d", "user"),
        message("e", "user", { uuid: "q1", queued: true }),
        message("f", "assistant", { uuid: "a2" }),
      ]),
    ).toBe("u2");
    expect(lastUserUuid([])).toBeUndefined();
  });
});

describe("a conversation whose messages do not go out", () => {
  const queued = {
    id: "q1",
    text: "OK, open the PR",
    images: [],
    queued_at: "2026-11-03T18:02:50.256Z",
  };
  const lost = {
    at: "2026-11-03T18:31:59.504Z",
    reason: "The pane holder's log could not be read",
  };

  test("a lost process says so, with why and what waits", () => {
    expect(deliveryNotice({ ...state, lost }, false)).toEqual({
      text: "Lost the conversation process",
      detail: "The pane holder's log could not be read",
    });
    expect(
      deliveryNotice(
        { ...state, status: "starting", lost, queue: [queued] },
        false,
      ),
    ).toEqual({
      text: "Lost the conversation process",
      detail:
        "The pane holder's log could not be read; A queued message waits for it",
    });
    // The event sets and clears it; a hand-back drops it.
    const shown = applyStateEvent(state, { type: "lost", lost })!;
    expect(shown.lost).toEqual(lost);
    expect(
      applyStateEvent(shown, { type: "lost", lost: null })!.lost,
    ).toBeNull();
    expect(
      applyStateEvent(shown, {
        type: "lease",
        owner: "terminal",
        phase: "terminal",
        session_id: "s1",
      })!.lost,
    ).toBeNull();
    expect(
      deliveryNotice({ ...state, phase: "terminal", lost }, true),
    ).toBeNull();
  });

  test("the API key question speaks for itself: no stalled-queue notice beside it", () => {
    const api_key_question = { asked_at: "2026-11-04T10:00:00.000Z" };
    expect(
      deliveryNotice(
        { ...state, status: "starting", queue: [queued], api_key_question },
        true,
      ),
    ).toBeNull();
    const asked = applyStateEvent(state, {
      type: "api_key_question",
      api_key_question,
    })!;
    expect(asked.api_key_question).toEqual(api_key_question);
    expect(
      applyStateEvent(asked, {
        type: "api_key_question",
        api_key_question: null,
      })!.api_key_question,
    ).toBeNull();
    expect(
      applyStateEvent(asked, {
        type: "lease",
        owner: "terminal",
        phase: "terminal",
        session_id: "s1",
      })!.api_key_question,
    ).toBeNull();
  });

  test("a turn that seems stuck says since when, with what waits; a lost process comes first", () => {
    const since = "2026-11-03T23:18:45.000Z";
    const at = new Date(since).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const working = { ...state, status: "working" as const };
    expect(
      deliveryNotice(
        { ...working, stuck: { since, reason: "silent" }, queue: [queued] },
        false,
      ),
    ).toEqual({
      text: `Claude seems stuck since ${at}`,
      detail: "Nothing came from it since then; A queued message waits for it",
      stuck: "silent",
    });
    expect(
      deliveryNotice(
        { ...working, stuck: { since, reason: "stop_unanswered" } },
        false,
      ),
    ).toEqual({
      text: "Claude did not answer Stop",
      detail: `Nothing came from it since ${at}; restarting it resumes the session in a new process`,
      stuck: "stop_unanswered",
    });
    expect(
      deliveryNotice(
        { ...working, lost, stuck: { since, reason: "silent" } },
        false,
      )?.text,
    ).toBe("Lost the conversation process");
    // The event sets and clears it; a hand-back drops it.
    const shown = applyStateEvent(working, {
      type: "stuck",
      stuck: { since, reason: "silent" },
    })!;
    expect(shown.stuck).toEqual({ since, reason: "silent" });
    expect(
      applyStateEvent(shown, { type: "stuck", stuck: null })!.stuck,
    ).toBeNull();
    expect(
      applyStateEvent(shown, {
        type: "lease",
        owner: "terminal",
        phase: "terminal",
        session_id: "s1",
      })!.stuck,
    ).toBeNull();
  });

  test("a queue waiting with nothing at work warns once it has stalled", () => {
    const waiting = { ...state, queue: [queued] };
    expect(queueWaiting(waiting)).toBe(true);
    expect(queueWaiting({ ...waiting, status: "starting" })).toBe(true);
    // Messages typed during a turn wait for its end: no fault.
    expect(queueWaiting({ ...waiting, status: "working" })).toBe(false);
    expect(queueWaiting({ ...waiting, status: "blocked" })).toBe(false);
    expect(queueWaiting(state)).toBe(false);
    expect(deliveryNotice(waiting, false)).toBeNull();
    expect(deliveryNotice(waiting, true)).toEqual({
      text: "The queued message is not going out",
      detail: "Claude is not taking them",
    });
    expect(
      deliveryNotice(
        {
          ...waiting,
          status: "starting",
          queue: [queued, { ...queued, id: "q2" }],
        },
        true,
      ),
    ).toEqual({
      text: "The queued messages are not going out",
      detail: "Claude has not started",
    });
    expect(deliveryNotice({ ...waiting, status: "working" }, true)).toBeNull();
  });
});
