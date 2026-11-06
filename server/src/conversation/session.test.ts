import { describe, expect, jest, test } from "bun:test";
import type { AgentChatEvent } from "../../../shared/agentChat";
import {
  type AgentPromptAnswer,
  DISMISSED_PERMISSION_MESSAGE,
  DISMISSED_QUESTION_MESSAGE,
} from "../../../shared/review";
import {
  type ConversationPrompt,
  type ConversationSessionOptions,
  createConversationSession,
} from "./session";
import { isSpokenStop } from "./session-voice";
import {
  answerInterrupts,
  answerModels,
  answerRewinds,
  type FakeClaude,
  fakeClaudeProcess,
  fakeSpawner,
  RESULT,
  settle,
} from "./testing";

const stream = (event: unknown) => ({
  type: "stream_event",
  event,
  parent_tool_use_id: null,
});

function setup(
  options: Partial<ConversationSessionOptions> & {
    answer?: (prompt: ConversationPrompt) => Promise<AgentPromptAnswer | null>;
    /** The fake claude each start gets. */
    make?: () => FakeClaude;
  } = {},
) {
  const events: AgentChatEvent[] = [];
  const prompts: ConversationPrompt[] = [];
  const spawner = fakeSpawner(options.make);
  const sessionIds: string[] = [];
  const session = createConversationSession({
    paneId: "p1",
    sessionId: "s1",
    cwd: "/work",
    spawn: spawner.spawn,
    emit: (event) => events.push(event),
    ask: (prompt) => {
      prompts.push(prompt);
      return options.answer?.(prompt) ?? Promise.resolve("allow");
    },
    readImage: async (path) => ({
      media_type: "image/png",
      data: `b64:${path}`,
    }),
    onSessionId: (id) => sessionIds.push(id),
    interruptWaitMs: 50,
    stopWaitMs: 50,
    ...options,
  });
  const proc = (): FakeClaude => spawner.spawned.at(-1)!.fake;
  const users = () =>
    proc().written.filter((message) => message.type === "user");
  const statuses = () =>
    events.flatMap((event) => (event.type === "status" ? [event.status] : []));
  return {
    session,
    events,
    prompts,
    spawner,
    proc,
    users,
    statuses,
    sessionIds,
  };
}

async function startTurn(context: ReturnType<typeof setup>, text = "hi") {
  const sent = await context.session.send({ text });
  expect(sent.status).toBe("sent");
  await settle();
  return sent;
}

describe("sending", () => {
  test("starts the process on demand and writes a stream-json user message", async () => {
    const context = setup();
    await startTurn(context, "hello");
    expect(context.spawner.spawned.map((each) => each.options)).toEqual([
      {
        paneId: expect.any(String),
        sessionId: "s1",
        cwd: "/work",
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(context.users()).toEqual([
      {
        type: "user",
        uuid: expect.any(String),
        message: { role: "user", content: "hello" },
      },
    ]);
    expect(context.session.state().status).toBe("working");
  });

  test("images go as base64 content blocks after the text", async () => {
    const context = setup();
    await context.session.send({ text: "look", images: ["/tmp/a.png"] });
    expect(context.users()[0]!.message).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "b64:/tmp/a.png",
          },
        },
      ],
    });
  });

  test("the user's replay settles the outbox with its uuid", async () => {
    const context = setup();
    const sent = await context.session.send({ text: "hi", uuid: "u-1" });
    expect(sent.id).toBe("u-1");
    context.proc().push({
      type: "user",
      message: { role: "user", content: "hi" },
      uuid: "u-1",
      isReplay: true,
    });
    await settle();
    expect(context.events).toContainEqual({
      type: "user",
      uuid: "u-1",
      text: "hi",
      images: 0,
    });
  });

  test("typed messages wait in Roamgate's queue and go as one turn at its end", async () => {
    const context = setup();
    await startTurn(context);
    expect((await context.session.send({ text: "second" })).status).toBe(
      "queued",
    );
    const third = await context.session.send({ text: "third" });
    expect(context.session.editQueued(third.id, "third, edited")).toBe(true);
    const fourth = await context.session.send({ text: "drop me" });
    expect(context.session.removeQueued(fourth.id)?.text).toBe("drop me");
    expect(context.session.state().queue.map((item) => item.text)).toEqual([
      "second",
      "third, edited",
    ]);
    expect(context.users()).toHaveLength(1);
    context.proc().push(RESULT);
    await settle();
    expect(context.users()).toHaveLength(2);
    expect(context.users()[1]!.message).toEqual({
      role: "user",
      content: "second\n\nthird, edited",
    });
    expect(context.session.state().queue).toEqual([]);
  });

  test("nothing to send is an error", async () => {
    const context = setup();
    expect(context.session.send({ text: "  " })).rejects.toThrow(
      "Nothing to send",
    );
  });
});

describe("the barge-in mix", () => {
  test("speech while idle is a new turn", async () => {
    const context = setup();
    expect(await context.session.voice({ text: "hello" })).toMatchObject({
      action: "sent",
    });
  });

  test("speech while only writing text interrupts, then becomes the next turn", async () => {
    const context = setup();
    await startTurn(context);
    context
      .proc()
      .push(stream({ type: "message_start", message: { id: "m1" } }));
    context.proc().push(
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    );
    await settle();
    const result = await context.session.voice({ text: "actually, no" });
    expect(result.action).toBe("interrupted_then_sent");
    const kinds = context
      .proc()
      .written.map((message) =>
        message.type === "control_request"
          ? (message.request as { subtype: string }).subtype
          : String(message.type),
      );
    expect(kinds).toEqual(["user", "interrupt", "user"]);
    expect(context.users()[1]!.message).toEqual({
      role: "user",
      content: "actually, no",
    });
  });

  test("speech while a tool runs steers the same turn", async () => {
    const context = setup();
    await startTurn(context);
    context.proc().push({
      type: "assistant",
      message: {
        id: "m1",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
      },
    });
    await settle();
    expect(context.session.state().tools_running).toBe(true);
    expect(
      await context.session.voice({ text: "also check tests" }),
    ).toMatchObject({
      action: "steered",
    });
    expect(
      context
        .proc()
        .written.some((message) => message.type === "control_request"),
    ).toBe(false);
    expect(context.users().at(-1)!.message).toEqual({
      role: "user",
      content: "also check tests",
    });
    context.proc().push({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
        ],
      },
    });
    await settle();
    expect(context.session.state().tools_running).toBe(false);
  });

  test("speech between two tool steps, or while thinking, steers", async () => {
    const context = setup();
    await startTurn(context);
    // A tool ran and returned: the model is between two steps.
    context.proc().push({
      type: "assistant",
      message: {
        id: "m1",
        content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }],
      },
    });
    context.proc().push({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
        ],
      },
    });
    await settle();
    expect(context.session.state().tools_running).toBe(false);
    expect(await context.session.voice({ text: "use tabs" })).toMatchObject({
      action: "steered",
    });
    // Thinking about the next step.
    context
      .proc()
      .push(stream({ type: "message_start", message: { id: "m2" } }));
    context.proc().push(
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
    );
    await settle();
    expect(await context.session.voice({ text: "and spaces" })).toMatchObject({
      action: "steered",
    });
    expect(
      context
        .proc()
        .written.some((message) => message.type === "control_request"),
    ).toBe(false);
  });

  test("a spoken stop, or the Stop button, always interrupts", async () => {
    expect(isSpokenStop("Stop.")).toBe(true);
    expect(isSpokenStop("stop the server and restart")).toBe(false);
    const context = setup();
    await startTurn(context);
    expect(await context.session.voice({ text: "stop!" })).toEqual({
      action: "interrupted",
    });
    expect(context.users()).toHaveLength(1);
    await settle();
    expect(context.session.state().status).toBe("idle");
    const again = setup();
    await startTurn(again);
    expect(await again.session.voice({ text: "", stop: true })).toEqual({
      action: "interrupted",
    });
  });

  test("speech sent twice with one uuid is taken once", async () => {
    const context = setup();
    expect(await context.session.voice({ text: "hello", uuid: "v1" })).toEqual({
      action: "sent",
      id: "v1",
    });
    expect(await context.session.voice({ text: "hello", uuid: "v1" })).toEqual({
      action: "sent",
      id: "v1",
    });
    expect(context.users()).toHaveLength(1);
  });

  test("speech while a permission waits is queued", async () => {
    const pending = Promise.withResolvers<AgentPromptAnswer | null>();
    const context = setup({ answer: () => pending.promise });
    await startTurn(context);
    context.proc().push({
      type: "control_request",
      request_id: "r1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: {} },
    });
    await settle();
    expect(await context.session.voice({ text: "later" })).toMatchObject({
      action: "queued",
    });
    pending.resolve("allow");
  });
});

describe("permissions", () => {
  async function ask(
    answer: AgentPromptAnswer | null,
    request: Record<string, unknown>,
  ) {
    const context = setup({ answer: async () => answer });
    await startTurn(context);
    context.proc().push({
      type: "control_request",
      request_id: "r1",
      request: { subtype: "can_use_tool", ...request },
    });
    await settle();
    const response = context
      .proc()
      .written.find((message) => message.type === "control_response");
    return { context, response };
  }

  const bash = {
    tool_name: "Bash",
    input: { command: "echo hi > f" },
    permission_suggestions: [{ type: "addRules" }],
  };

  test("allow", async () => {
    const { context, response } = await ask("allow", bash);
    expect(context.prompts[0]).toMatchObject({
      tool: "Bash",
      input: bash.input,
      canAlways: true,
    });
    expect(response).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "r1",
        response: { behavior: "allow", updatedInput: bash.input },
      },
    });
  });

  test("always adds the suggested rules", async () => {
    const { response } = await ask("always", bash);
    expect((response!.response as { response: unknown }).response).toEqual({
      behavior: "allow",
      updatedInput: bash.input,
      updatedPermissions: bash.permission_suggestions,
    });
  });

  test("deny, and no answer in time, deny", async () => {
    for (const answer of ["deny", null] as const) {
      const { response } = await ask(answer, bash);
      expect(
        (response!.response as { response: unknown }).response,
      ).toMatchObject({
        behavior: "deny",
        interrupt: false,
      });
    }
  });

  test("AskUserQuestion answers go in updatedInput.answers", async () => {
    const questions = [
      {
        question: "Which colour?",
        header: "Colour",
        options: [{ label: "Red" }, { label: "Blue" }],
        multiSelect: false,
      },
    ];
    const { context, response } = await ask(
      { answers: { "Which colour?": "Blue" } },
      {
        tool_name: "AskUserQuestion",
        input: { questions },
        requires_user_interaction: true,
      },
    );
    expect(context.prompts[0]).toMatchObject({
      tool: "AskUserQuestion",
      canAlways: false,
      questions,
    });
    expect((response!.response as { response: unknown }).response).toEqual({
      behavior: "allow",
      updatedInput: { questions, answers: { "Which colour?": "Blue" } },
    });
  });

  test("a dismissed question or permission denies it, saying so; the turn goes on", async () => {
    const questions = [
      {
        question: "What should I delete?",
        options: [{ label: "Worktree" }, { label: "Images" }],
        multiSelect: true,
      },
    ];
    for (const [request, message] of [
      [
        { tool_name: "AskUserQuestion", input: { questions } },
        DISMISSED_QUESTION_MESSAGE,
      ],
      [bash, DISMISSED_PERMISSION_MESSAGE],
    ] as const) {
      const pending = Promise.withResolvers<AgentPromptAnswer | null>();
      const context = setup({ answer: () => pending.promise });
      await startTurn(context);
      context.proc().push({
        type: "control_request",
        request_id: "r1",
        request: { subtype: "can_use_tool", ...request },
      });
      await settle();
      expect(context.session.state().status).toBe("blocked");
      pending.resolve("dismiss");
      await settle();
      const response = context
        .proc()
        .written.find((each) => each.type === "control_response");
      expect(response).toEqual({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "r1",
          response: { behavior: "deny", message, interrupt: false },
        },
      });
      // Nothing of the question's choices went, and Claude's turn runs on.
      expect(JSON.stringify(response)).not.toContain("Worktree");
      expect(context.session.state().status).toBe("working");
      expect(context.session.busy()).toBe(true);
    }
  });

  test("blocked while it waits; a cancel answers nothing", async () => {
    const pending = Promise.withResolvers<AgentPromptAnswer | null>();
    const context = setup({ answer: () => pending.promise });
    await startTurn(context);
    context.proc().push({
      type: "control_request",
      request_id: "r1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: {} },
    });
    await settle();
    expect(context.session.state().status).toBe("blocked");
    expect(context.session.busy()).toBe(true);
    context.proc().push({ type: "control_cancel_request", request_id: "r1" });
    await settle();
    expect(context.prompts[0]!.signal.aborted).toBe(true);
    pending.resolve("allow");
    await settle();
    expect(
      context
        .proc()
        .written.some((message) => message.type === "control_response"),
    ).toBe(false);
    expect(context.session.state().status).toBe("working");
  });
});

describe("stream events", () => {
  test("deltas are coalesced to about a frame", async () => {
    jest.useFakeTimers();
    try {
      const context = setup({ coalesceMs: 16 });
      await startTurn(context);
      context
        .proc()
        .push(stream({ type: "message_start", message: { id: "m1" } }));
      for (const text of ["a", "b", "c"])
        context.proc().push(
          stream({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          }),
        );
      await settle();
      expect(context.events.filter((event) => event.type === "delta")).toEqual(
        [],
      );
      jest.advanceTimersByTime(16);
      expect(context.events.filter((event) => event.type === "delta")).toEqual([
        { type: "delta", message_id: "m1", index: 0, text: "abc" },
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("an interrupt keeps the partial reply it cut", async () => {
    // What the CLI sends for an interrupted reply (headless-report-cli 3):
    // the message's blocks abandoned, then the confirmation and the result.
    const context = setup({
      make: () =>
        fakeClaudeProcess({
          respond: (message, fake) => {
            if (message.type === "control_request")
              fake.push({
                type: "stream_event",
                event: { type: "message_stop" },
                abandoned_blocks: { api_message_id: "m1", from_block_index: 0 },
              });
            answerInterrupts(message, fake);
          },
        }),
    });
    await startTurn(context);
    context
      .proc()
      .push(stream({ type: "message_start", message: { id: "m1" } }));
    context.proc().push(
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    );
    context.proc().push(
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "One, two" },
      }),
    );
    await settle();
    expect(await context.session.interrupt()).toBe(true);
    await settle(60);
    expect(context.events.some((event) => event.type === "abandoned")).toBe(
      false,
    );
    expect(context.events).toContainEqual({
      type: "delta",
      message_id: "m1",
      index: 0,
      text: "One, two",
    });
  });

  test("abandoned blocks drop their held deltas", async () => {
    jest.useFakeTimers();
    try {
      const context = setup({ coalesceMs: 16 });
      await startTurn(context);
      context
        .proc()
        .push(stream({ type: "message_start", message: { id: "m1" } }));
      context.proc().push(
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "half" },
        }),
      );
      context.proc().push({
        type: "stream_event",
        event: { type: "message_stop" },
        abandoned_blocks: { api_message_id: "m1", from_block_index: 0 },
      });
      await settle();
      jest.advanceTimersByTime(16);
      expect(context.events.filter((event) => event.type === "delta")).toEqual(
        [],
      );
      expect(context.events).toContainEqual({
        type: "abandoned",
        message_id: "m1",
        from_index: 0,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test("/clear moves the session to its new id", async () => {
    const context = setup();
    await startTurn(context, "/clear");
    context.proc().push({
      type: "conversation_reset",
      new_conversation_id: "s2",
      session_id: "s1",
    });
    context.proc().push({ type: "system", subtype: "init", session_id: "s2" });
    await settle();
    expect(context.session.sessionId()).toBe("s2");
    expect(context.sessionIds).toEqual(["s2"]);
    expect(context.events).toContainEqual({
      type: "session",
      session_id: "s2",
      previous: "s1",
    });
  });

  test("the reply text streamed so far is kept for a browser coming in", async () => {
    const context = setup({ coalesceMs: 0 });
    await startTurn(context);
    const proc = context.proc();
    proc.push(stream({ type: "message_start", message: { id: "m1" } }));
    proc.push(
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    );
    for (const text of ["Rain ", "falls"])
      proc.push(
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        }),
      );
    await settle();
    // The deltas wait about a frame before they go out.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(context.session.streamed()).toEqual([
      { message_id: "m1", index: 0, text: "Rain falls", done: false },
    ]);
    proc.push({
      type: "assistant",
      message: { id: "m1", content: [{ type: "text", text: "Rain falls." }] },
      parent_tool_use_id: null,
    });
    await settle();
    expect(context.session.streamed()).toEqual([
      { message_id: "m1", index: 0, text: "Rain falls.", done: true },
    ]);
    // The turn is over: the transcript has it.
    proc.push(RESULT);
    await settle();
    expect(context.session.streamed()).toEqual([]);
  });

  test("status follows the turn, its tools and compaction", async () => {
    const context = setup();
    await startTurn(context);
    context
      .proc()
      .push({ type: "system", subtype: "status", status: "compacting" });
    await settle();
    expect(context.session.state()).toMatchObject({
      status: "working",
      activity: "compacting",
    });
    context.proc().push(RESULT);
    await settle();
    expect(context.session.state()).toMatchObject({
      status: "idle",
      activity: null,
    });
    // Compacting changes the activity, not the status.
    expect(context.statuses()).toEqual([
      "starting",
      "idle",
      "working",
      "working",
      "idle",
    ]);
  });
});

describe("the process", () => {
  test("an idle process lives on, like the terminal's claude", async () => {
    jest.useFakeTimers();
    try {
      const context = setup();
      await startTurn(context);
      context.proc().push(RESULT);
      await settle();
      // A day without a message: only a hand-back or a stop ends it.
      jest.advanceTimersByTime(24 * 60 * 60_000);
      await settle();
      expect(context.proc().ended).toBe(false);
      expect(context.session.state().status).toBe("idle");
      await context.session.send({ text: "again" });
      expect(context.spawner.spawned).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a message sent while the process closes waits for the next one", async () => {
    const context = setup({
      make: () => fakeClaudeProcess({ respond: answerInterrupts }),
    });
    const session = context.session;
    await session.warm();
    const first = context.proc();
    // Over SSH a kill says nothing of the claude on the host: it may
    // still be on its way out (hooks run) once the stop gives up.
    first.process.kill = () => {};
    expect(await session.stop()).toBe(false);
    expect(first.ended).toBe(true);
    const sent = session.send({ text: "late" });
    await settle();
    // Not written to the closing process, nor lost.
    expect(first.written).toEqual([]);
    first.exit(0);
    expect(await sent).toMatchObject({ status: "sent" });
    expect(context.spawner.spawned).toHaveLength(2);
    expect(context.proc().written).toEqual([
      expect.objectContaining({
        type: "user",
        message: { role: "user", content: "late" },
      }),
    ]);
  });

  test("a process started ahead of any turn does not look busy", async () => {
    const spawned = Promise.withResolvers<void>();
    const spawner = fakeSpawner();
    const events: AgentChatEvent[] = [];
    const session = createConversationSession({
      paneId: "p1",
      sessionId: "s1",
      cwd: "/w",
      spawn: async (options) => {
        await spawned.promise;
        return spawner.spawn(options);
      },
      emit: (event) => events.push(event),
      ask: async () => null,
      readImage: async () => ({ media_type: "image/png", data: "" }),
    });
    const warming = session.warm();
    await settle();
    // A takeover warms it up: nothing was sent, nothing is working.
    expect(session.state().status).toBe("idle");
    // A message typed meanwhile waits on it.
    expect(await session.send({ text: "first" })).toMatchObject({
      status: "queued",
    });
    expect(session.state().status).toBe("starting");
    spawned.resolve();
    await warming;
    await settle();
    expect(session.state().status).toBe("working");
    const statuses = events.flatMap((event) =>
      event.type === "status" ? [event.status] : [],
    );
    expect(statuses[0]).toBe("idle");
    expect(statuses).not.toContain("stopped");
  });

  test("a message on its way to stdin counts as busy for a hand-back", async () => {
    const image = Promise.withResolvers<{ media_type: string; data: string }>();
    const context = setup({ readImage: () => image.promise });
    await context.session.warm();
    const sent = context.session.send({ text: "look", images: ["/a.png"] });
    await settle();
    expect(context.session.busy()).toBe(true);
    // A second one queues behind it instead of racing it.
    expect(await context.session.send({ text: "and this" })).toMatchObject({
      status: "queued",
    });
    image.resolve({ media_type: "image/png", data: "x" });
    expect(await sent).toMatchObject({ status: "sent" });
  });

  test("messages left by a start that failed go first with the next one", async () => {
    let fail = true;
    const spawner = fakeSpawner();
    const events: AgentChatEvent[] = [];
    const session = createConversationSession({
      paneId: "p1",
      sessionId: "s1",
      cwd: "/w",
      spawn: async (options) => {
        await Promise.resolve();
        if (fail) throw new Error("Claude runs in the pane's terminal");
        return spawner.spawn(options);
      },
      emit: (event) => events.push(event),
      ask: async () => null,
      readImage: async () => ({ media_type: "image/png", data: "" }),
    });
    const warming = session.warm();
    expect(await session.send({ text: "first" })).toMatchObject({
      status: "queued",
    });
    await expect(warming).rejects.toThrow();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "notice", kind: "error" }),
    );
    expect(session.queueLength()).toBe(1);
    fail = false;
    expect(await session.send({ text: "second" })).toMatchObject({
      status: "sent",
    });
    expect(session.queueLength()).toBe(0);
    expect(spawner.spawned[0]!.fake.written).toEqual([
      expect.objectContaining({
        message: { role: "user", content: "first\n\nsecond" },
      }),
    ]);
  });

  test("a stop gives up a start still waiting for its process", async () => {
    let aborted = false;
    const session = createConversationSession({
      paneId: "p1",
      sessionId: "s1",
      cwd: "/w",
      // Waits for the holder, until told to give up.
      spawn: (options) =>
        new Promise((_, reject) =>
          options.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("gave up"));
          }),
        ),
      emit: () => {},
      ask: async () => null,
      readImage: async () => ({ media_type: "image/png", data: "" }),
    });
    void session.warm().catch(() => undefined);
    await settle();
    expect(await session.stop()).toBe(true);
    expect(aborted).toBe(true);
  });

  test("a process dying mid-turn ends the turn and sends the queue on", async () => {
    const context = setup();
    await startTurn(context);
    await context.session.send({ text: "queued" });
    context.proc().exit(1);
    await settle();
    expect(context.events).toContainEqual(
      expect.objectContaining({ type: "result", subtype: "process_exited" }),
    );
    // A new process takes what waited: nothing blocks a hand-back.
    expect(context.spawner.spawned).toHaveLength(2);
    expect(context.users().map((each) => each.message)).toEqual([
      { role: "user", content: "queued" },
    ]);
    expect(context.session.queueLength()).toBe(0);
  });

  test("a message claude never got goes again, with no cut-off notice", async () => {
    const context = setup();
    await context.session.warm();
    const first = context.proc();
    await startTurn(context, "lost one");
    // The holder had closed its stdin (a stop): it dropped the message.
    const line = JSON.stringify(first.written[0]);
    first.process.undelivered = () => [line];
    first.exit(0);
    await settle();
    expect(
      context.events.filter(
        (event) => event.type === "notice" && event.kind === "process_exited",
      ),
    ).toEqual([]);
    expect(context.spawner.spawned).toHaveLength(2);
    expect(context.users().map((message) => message.message)).toEqual([
      { role: "user", content: "lost one" },
    ]);
    expect(context.users()[0]!.uuid).toBe(first.written[0]!.uuid);
  });

  test("a process that dies again keeps the queue for the next message", async () => {
    const context = setup();
    await startTurn(context);
    await context.session.send({ text: "queued" });
    context.proc().exit(1);
    await settle();
    await context.session.send({ text: "again" });
    context.proc().exit(1);
    await settle();
    expect(context.spawner.spawned).toHaveLength(2);
    expect(context.session.state()).toMatchObject({
      status: "stopped",
      queue: [expect.objectContaining({ text: "again" })],
    });
    expect(context.events).toContainEqual(
      expect.objectContaining({
        type: "notice",
        text: expect.stringMatching(/stopped again/),
      }),
    );
  });

  test("a message steered in as the turn ends keeps the session working", async () => {
    const context = setup();
    await startTurn(context);
    // The CLI ends the turn and runs the steered message as its own.
    context.proc().push({ ...RESULT, queued_turn_count: 1 });
    await settle();
    expect(context.session.busy()).toBe(true);
    await context.session.send({ text: "after" });
    expect(context.session.queueLength()).toBe(1);
    context.proc().push(RESULT);
    await settle();
    expect(context.session.queueLength()).toBe(0);
    context.proc().push(RESULT);
    await settle();
    expect(context.session.busy()).toBe(false);
  });

  test("a message sent twice with one id is taken once", async () => {
    const context = setup();
    await startTurn(context);
    const first = await context.session.send({ text: "x", uuid: "u-1" });
    const again = await context.session.send({ text: "x", uuid: "u-1" });
    expect(first).toEqual({ status: "queued", id: "u-1" });
    expect(again).toEqual({ status: "queued", id: "u-1" });
    expect(context.session.queueLength()).toBe(1);
    context.proc().push(RESULT);
    await settle();
    expect(await context.session.send({ text: "x", uuid: "u-1" })).toEqual({
      status: "sent",
      id: "u-1",
    });
    expect(context.users()).toHaveLength(2);
  });

  test("a single queued message goes out under its own uuid", async () => {
    const context = setup();
    await startTurn(context);
    await context.session.send({ text: "next", uuid: "u-9" });
    context.proc().push(RESULT);
    await settle();
    expect(context.users()[1]).toMatchObject({
      uuid: "u-9",
      message: { role: "user", content: "next" },
    });
    // A resend with that uuid is not written again.
    expect(await context.session.send({ text: "next", uuid: "u-9" })).toEqual({
      status: "sent",
      id: "u-9",
    });
    expect(context.users()).toHaveLength(2);
  });

  test("a carried queued message keeps its id when the process starts", async () => {
    const context = setup({
      queue: [{ id: "q1", text: "left", images: [], queued_at: "t" }],
    });
    await context.session.warm();
    await settle();
    expect(context.users()[0]!.uuid).toBe("q1");
  });

  test("several queued messages go as one turn under a new uuid", async () => {
    const context = setup();
    await startTurn(context);
    await context.session.send({ text: "a", uuid: "u-a" });
    await context.session.send({ text: "b", uuid: "u-b" });
    context.proc().push(RESULT);
    await settle();
    expect(context.users()[1]!.uuid).not.toBe("u-a");
    expect(context.users()[1]!.uuid).not.toBe("u-b");
  });

  test("a queue carried from an earlier process is kept and taken whole", async () => {
    const context = setup({
      queue: [{ id: "q1", text: "left", images: [], queued_at: "t" }],
    });
    expect(context.session.state().queue).toEqual([
      { id: "q1", text: "left", images: [], queued_at: "t" },
    ]);
    await context.session.warm();
    await settle();
    expect(context.users().map((each) => each.message)).toEqual([
      { role: "user", content: "left" },
    ]);
    const other = setup({
      queue: [{ id: "q2", text: "kept", images: [], queued_at: "t" }],
    });
    expect(other.session.takeQueue()).toEqual([
      { id: "q2", text: "kept", images: [], queued_at: "t" },
    ]);
    expect(other.session.queueLength()).toBe(0);
  });

  test("stop closes stdin and waits for the exit, killing a stuck one", async () => {
    const context = setup();
    await startTurn(context);
    context.proc().push(RESULT);
    await settle();
    expect(await context.session.stop()).toBe(true);
    expect(context.proc().ended).toBe(true);

    const stuck = createConversationSession({
      paneId: "p2",
      sessionId: "s",
      cwd: "/w",
      spawn: async () => stuckProcess.process,
      emit: () => {},
      ask: async () => null,
      readImage: async () => ({ media_type: "image/png", data: "" }),
      stopWaitMs: 10,
    });
    const stuckProcess = fakeClaudeProcess({ respond: answerInterrupts });
    await stuck.warm();
    expect(await stuck.stop()).toBe(true);
    expect(stuckProcess.killed).toBe(true);
  });
});

describe("waiting for a turn's result", () => {
  test("idle: at once; a turn: when its result comes, or false past the wait", async () => {
    const context = setup();
    expect(await context.session.waitForResult(10)).toBe(true);
    await startTurn(context);
    expect(await context.session.waitForResult(10)).toBe(false);
    const waiting = context.session.waitForResult(1000);
    context.proc().push(RESULT);
    expect(await waiting).toBe(true);
  });
});

describe("rewinding", () => {
  const rewinds = (fake: FakeClaude) =>
    fake.written.filter((message) => message.type === "control_request");
  const withRewinds = (answers?: Parameters<typeof answerRewinds>[0]) => () =>
    fakeClaudeProcess({ exitOnEnd: true, respond: answerRewinds(answers) });

  test("the conversation: one control request to the process, no restart", async () => {
    const context = setup({ make: withRewinds() });
    await startTurn(context);
    context.proc().push(RESULT);
    await settle();
    const result = await context.session.rewind({
      uuid: "u2",
      lastSeen: "u3",
      mode: "conversation",
    });
    expect(result).toEqual({ ok: true, prefill: "the message" });
    expect(context.spawner.spawned).toHaveLength(1);
    expect(context.proc().ended).toBe(false);
    // Every browser hears of it, to drop what it streamed of the turns cut.
    expect(context.events).toContainEqual({ type: "rewound", uuid: "u2" });
    expect(rewinds(context.proc()).map((each) => each.request)).toEqual([
      {
        subtype: "rewind_conversation",
        target_message_uuid: "u2",
        last_seen_user_message_uuid: "u3",
      },
    ]);
  });

  test("code and conversation: the code is checked, the conversation cut, then the code restored", async () => {
    const context = setup({ make: withRewinds() });
    const result = await context.session.rewind({ uuid: "u2", mode: "both" });
    expect(result).toEqual({
      ok: true,
      prefill: "the message",
      files: ["/work/a.txt"],
      code: "restored",
    });
    // Nothing ran: the process was started for it.
    expect(context.spawner.spawned).toHaveLength(1);
    expect(rewinds(context.proc()).map((each) => each.request)).toEqual([
      { subtype: "rewind_files", user_message_id: "u2", dry_run: true },
      { subtype: "rewind_conversation", target_message_uuid: "u2" },
      { subtype: "rewind_files", user_message_id: "u2" },
    ]);
  });

  test("the code only leaves the conversation alone", async () => {
    const context = setup({ make: withRewinds() });
    expect(await context.session.rewind({ uuid: "u2", mode: "code" })).toEqual({
      ok: true,
      files: ["/work/a.txt"],
      code: "restored",
    });
    expect(
      rewinds(context.proc()).map(
        (each) => (each.request as { subtype: string }).subtype,
      ),
    ).toEqual(["rewind_files", "rewind_files"]);
    // The conversation is untouched: nothing to drop.
    expect(context.events.some((event) => event.type === "rewound")).toBe(
      false,
    );
  });

  test("a process without checkpoints is replaced by one that has them", async () => {
    let starts = 0;
    const context = setup({
      make: () => {
        starts += 1;
        return fakeClaudeProcess({
          exitOnEnd: true,
          respond: answerRewinds(
            starts === 1
              ? {
                  files: {
                    canRewind: false,
                    error: "File rewinding is not enabled.",
                  },
                }
              : {},
          ),
        });
      },
    });
    await context.session.warm();
    const result = await context.session.rewind({ uuid: "u2", mode: "both" });
    expect(result.ok).toBe(true);
    expect(context.spawner.spawned).toHaveLength(2);
    // The first one was ended (one writer at a time) before the next began.
    expect(context.spawner.spawned[0]!.fake.ended).toBe(true);
    expect(context.spawner.spawned[0]!.fake.alive).toBe(false);
    expect(rewinds(context.spawner.spawned[0]!.fake)).toHaveLength(1);
    expect(rewinds(context.proc())).toHaveLength(3);
  });

  test("no checkpoint of the code: nothing is rewound", async () => {
    const context = setup({
      make: withRewinds({
        files: {
          canRewind: false,
          error: "No file checkpoint found for this message.",
        },
      }),
    });
    expect(await context.session.rewind({ uuid: "u2", mode: "both" })).toEqual({
      ok: false,
      no_checkpoint: true,
      reason:
        "Claude Code has no code checkpoint for these changes (made before checkpoints were on)",
    });
    expect(rewinds(context.proc())).toHaveLength(1);
  });

  describe("with the transcript", () => {
    const line = (record: Record<string, unknown>) => JSON.stringify(record);
    const prompt = (uuid: string, parentUuid: string | null) =>
      line({
        type: "user",
        uuid,
        parentUuid,
        message: { role: "user", content: `message ${uuid}` },
      });
    const toolUse = (
      uuid: string,
      parentUuid: string,
      name: string,
      input: Record<string, unknown>,
    ) =>
      line({
        type: "assistant",
        uuid,
        parentUuid,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: `t-${uuid}`, name, input }],
        },
      });
    const snapshot = (messageId: string) =>
      line({
        type: "file-history-snapshot",
        messageId,
        snapshot: { messageId, trackedFileBackups: {} },
        isSnapshotUpdate: false,
      });
    // u1 edited two files; u2 and u3 ran commands only.
    const transcript = (checkpoints: string[] = []) =>
      [
        ...checkpoints.map(snapshot),
        prompt("u1", null),
        toolUse("a1", "u1", "Edit", { file_path: "/work/a.txt" }),
        toolUse("a2", "a1", "Write", { file_path: "/work/b.txt" }),
        prompt("u2", "a2"),
        toolUse("a3", "u2", "Bash", { command: "rm -rf build" }),
        prompt("u3", "a3"),
        toolUse("a4", "u3", "Bash", { command: "ls" }),
      ].join("\n");
    const notEnabled = {
      files: { canRewind: false, error: "File rewinding is not enabled." },
    };
    const counted = (answers: (start: number) => Record<string, unknown>) => {
      let starts = 0;
      return () => {
        starts += 1;
        return fakeClaudeProcess({
          exitOnEnd: true,
          respond: answerRewinds(answers(starts)),
        });
      };
    };

    test("nothing edited after the message: the conversation alone, no restart", async () => {
      const context = setup({
        make: withRewinds(notEnabled),
        readTranscript: async () => transcript(),
      });
      await context.session.warm();
      const both = await context.session.rewind({ uuid: "u2", mode: "both" });
      expect(both).toEqual({
        ok: true,
        prefill: "the message",
        code: "none",
      });
      expect(context.spawner.spawned).toHaveLength(1);
      expect(context.proc().ended).toBe(false);
      expect(rewinds(context.proc()).map((each) => each.request)).toEqual([
        { subtype: "rewind_files", user_message_id: "u2", dry_run: true },
        { subtype: "rewind_conversation", target_message_uuid: "u2" },
      ]);
      expect(
        await context.session.rewind({ uuid: "u2", mode: "code" }),
      ).toEqual({ ok: true, code: "none" });
      expect(context.spawner.spawned).toHaveLength(1);
    });

    test("edits with no checkpoint: refused with the files, no restart, nothing rewound", async () => {
      const context = setup({
        make: withRewinds(notEnabled),
        readTranscript: async () => transcript(["u2", "u3"]),
      });
      await context.session.warm();
      expect(
        await context.session.rewind({ uuid: "u1", mode: "both" }),
      ).toEqual({
        ok: false,
        no_checkpoint: true,
        reason:
          "Claude Code has no code checkpoint for these changes (made before checkpoints were on)",
        files: ["/work/a.txt", "/work/b.txt"],
      });
      expect(context.spawner.spawned).toHaveLength(1);
      expect(rewinds(context.proc())).toHaveLength(1);
    });

    test("edits whose checkpoint the new process lacks: refused with the files", async () => {
      const context = setup({
        make: withRewinds({
          files: {
            canRewind: false,
            error: "No file checkpoint found for this message.",
          },
        }),
        readTranscript: async () => transcript(["u1"]),
      });
      const result = await context.session.rewind({ uuid: "u1", mode: "both" });
      expect(result).toMatchObject({
        ok: false,
        no_checkpoint: true,
        files: ["/work/a.txt", "/work/b.txt"],
      });
      expect(rewinds(context.proc())).toHaveLength(1);
    });

    test("edits with a checkpoint: the old process restarts once, the code is restored", async () => {
      const context = setup({
        make: counted((start) => (start === 1 ? notEnabled : {})),
        readTranscript: async () => transcript(["u1"]),
      });
      await context.session.warm();
      const result = await context.session.rewind({ uuid: "u1", mode: "both" });
      expect(result).toEqual({
        ok: true,
        prefill: "the message",
        files: ["/work/a.txt"],
        code: "restored",
      });
      expect(context.spawner.spawned).toHaveLength(2);
      expect(rewinds(context.proc())).toHaveLength(3);
    });

    test("an unreadable transcript: the dry run decides, as before", async () => {
      const context = setup({
        make: counted((start) => (start === 1 ? notEnabled : {})),
        readTranscript: async () => {
          throw new Error("gone");
        },
      });
      await context.session.warm();
      expect(
        (await context.session.rewind({ uuid: "u2", mode: "both" })).ok,
      ).toBe(true);
      expect(context.spawner.spawned).toHaveLength(2);
    });

    test("the check: from the transcript alone, nothing started", async () => {
      const context = setup({
        make: withRewinds(),
        readTranscript: async () => transcript(["u1"]),
      });
      expect(await context.session.rewindCheck("u2")).toEqual({ code: "none" });
      expect(await context.session.rewindCheck("u3")).toEqual({ code: "none" });
      expect(await context.session.rewindCheck("u1")).toEqual({
        code: "restorable",
        files: ["/work/a.txt", "/work/b.txt"],
      });
      expect(await context.session.rewindCheck("u9")).toEqual({
        code: "unknown",
      });
      expect(context.spawner.spawned).toHaveLength(0);
      const before = setup({ readTranscript: async () => transcript() });
      expect(await before.session.rewindCheck("u1")).toEqual({
        code: "no_checkpoint",
        files: ["/work/a.txt", "/work/b.txt"],
      });
    });
  });

  test("Claude Code's refusal is said, and the code is left alone", async () => {
    const context = setup({
      make: withRewinds({
        conversation: {
          rewound: false,
          error: "stale target",
          reason: "stale_target",
        },
      }),
    });
    const result = await context.session.rewind({ uuid: "u2", mode: "both" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("moved on");
    expect(
      rewinds(context.proc()).map(
        (each) => (each.request as { dry_run?: boolean }).dry_run ?? false,
      ),
    ).toEqual([true, false]);
  });

  test("refused while a turn runs, unless it is interrupted first", async () => {
    const context = setup({ make: withRewinds() });
    await startTurn(context);
    expect(
      await context.session.rewind({ uuid: "u1", mode: "conversation" }),
    ).toEqual({ ok: false, reason: "A turn is running; stop it first" });
    expect(rewinds(context.proc())).toHaveLength(0);
    const result = await context.session.rewind({
      uuid: "u1",
      mode: "conversation",
      interrupt: true,
    });
    expect(result.ok).toBe(true);
    expect(
      rewinds(context.proc()).map(
        (each) => (each.request as { subtype: string }).subtype,
      ),
    ).toEqual(["interrupt", "rewind_conversation"]);
  });

  test("refused while messages wait in the queue", async () => {
    const context = setup({ make: withRewinds() });
    await startTurn(context);
    await context.session.send({ text: "later" });
    expect(context.session.queueLength()).toBe(1);
    const result = await context.session.rewind({
      uuid: "u1",
      mode: "conversation",
      interrupt: true,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("queue");
    expect(rewinds(context.proc())).toHaveLength(0);
  });

  test("a message sent during a rewind waits for it, then goes", async () => {
    let release: (() => void) | null = null;
    const context = setup({
      make: () =>
        fakeClaudeProcess({
          exitOnEnd: true,
          respond: (message, fake) => {
            const request = message.request as { subtype?: string } | undefined;
            if (request?.subtype === "rewind_conversation")
              release = () => answerRewinds()(message, fake);
          },
        }),
    });
    await context.session.warm();
    const rewound = context.session.rewind({
      uuid: "u1",
      mode: "conversation",
    });
    await settle();
    expect(context.session.busy()).toBe(true);
    expect((await context.session.send({ text: "next" })).status).toBe(
      "queued",
    );
    expect(context.users()).toHaveLength(0);
    release!();
    expect((await rewound).ok).toBe(true);
    await settle();
    expect(context.users()).toHaveLength(1);
  });

  test("no answer from Claude: the rewind fails, the process stays", async () => {
    const context = setup({
      make: () => fakeClaudeProcess({ exitOnEnd: true }),
      rewindWaitMs: 20,
    });
    await context.session.warm();
    expect(
      await context.session.rewind({ uuid: "u1", mode: "conversation" }),
    ).toEqual({ ok: false, reason: "Claude did not answer" });
    expect(context.session.busy()).toBe(false);
    expect(context.proc().ended).toBe(false);
  });
});

describe("reading again what the holder runs", () => {
  const permission = (id: string) => ({
    type: "control_request",
    request_id: id,
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: id },
    },
  });

  test("rebuilds the turn from the replayed head, asks open prompts once", async () => {
    const context = setup();
    const running = fakeClaudeProcess({ respond: answerInterrupts });
    running.process.replayed = 6;
    running.push({ type: "roamgate_input", seq: 1, child: 1, kind: "user" });
    running.push(stream({ type: "message_start", message: { id: "m1" } }));
    running.push(
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    );
    running.push(
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Half a reply" },
      }),
    );
    // Answered before the runtime went (the holder noted the answer).
    running.push(permission("old"));
    running.push({
      type: "roamgate_input",
      seq: 2,
      child: 1,
      kind: "control_response",
      request_id: "old",
    });
    // Live from here.
    running.push(permission("open"));
    context.spawner.running.push(running);
    expect(await context.session.attach()).toBe(true);
    await settle();
    expect(context.spawner.spawned).toHaveLength(0);
    // Nothing replayed was sent; the reply so far is there for a reload.
    expect(context.events.filter((event) => event.type === "delta")).toEqual(
      [],
    );
    expect(context.session.streamed()).toEqual([
      { message_id: "m1", index: 0, text: "Half a reply", done: false },
    ]);
    expect(context.prompts.map((prompt) => prompt.input)).toEqual([
      { command: "open" },
    ]);
    expect(running.written).toEqual([
      expect.objectContaining({
        type: "control_response",
        response: expect.objectContaining({ request_id: "open" }),
      }),
    ]);
    expect(context.session.busy()).toBe(true);
    running.push(RESULT);
    await settle();
    expect(context.session.state().status).toBe("idle");
  });

  test("takes up a saved state and reads only the lines after it", async () => {
    // The runtime before: a turn with half a reply and a prompt not
    // answered yet.
    const before = setup({ answer: () => new Promise(() => {}) });
    const first = fakeClaudeProcess();
    first.process.position = () => ({ child: 1, epoch_offset: 0, offset: 900 });
    before.spawner.running.push(first);
    expect(await before.session.attach()).toBe(true);
    first.push({ type: "roamgate_input", seq: 1, child: 1, kind: "user" });
    first.push(stream({ type: "message_start", message: { id: "m1" } }));
    first.push(
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    );
    first.push(
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Half a reply" },
      }),
    );
    first.push(permission("open"));
    await settle();
    expect(before.prompts).toHaveLength(1);
    const saved = before.session.resumeState()!;
    expect(saved).toMatchObject({ child: 1, epoch_offset: 0, offset: 900 });
    // A save is plain JSON (it goes on the lease).
    const state = JSON.parse(JSON.stringify(saved.state));
    before.session.dispose({ detach: true });

    // This runtime: only what came after.
    const context = setup({ coalesceMs: 0 });
    const running = fakeClaudeProcess({ respond: answerInterrupts });
    running.process.resume = state;
    running.push(
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " and more" },
      }),
    );
    context.spawner.running.push(running);
    expect(await context.session.attach()).toBe(true);
    // Deltas go out at the next timer turn.
    await Bun.sleep(5);
    expect(context.session.busy()).toBe(true);
    // The new text continues the reply so far, under the same block.
    expect(context.session.streamed()).toEqual([
      {
        message_id: "m1",
        index: 0,
        text: "Half a reply and more",
        done: false,
      },
    ]);
    expect(
      context.events.flatMap((event) =>
        event.type === "delta" ? [event.text] : [],
      ),
    ).toEqual([" and more"]);
    // The prompt still open is asked again, once.
    expect(context.prompts.map((prompt) => prompt.input)).toEqual([
      { command: "open" },
    ]);
    running.push(RESULT);
    await settle();
    expect(context.session.state().status).toBe("idle");
  });

  test("gives no state to save while it replays, none without a process", async () => {
    const context = setup();
    expect(context.session.resumeState()).toBeNull();
    const running = fakeClaudeProcess();
    running.process.replayed = 2;
    running.process.position = () => ({ child: 1, epoch_offset: 0, offset: 9 });
    running.push({ type: "roamgate_input", seq: 1, child: 1, kind: "user" });
    context.spawner.running.push(running);
    const attaching = context.session.attach();
    // Replaying: an earlier save still holds.
    expect(context.session.resumeState()).toBeUndefined();
    running.push({ type: "system", subtype: "status", status: "requesting" });
    expect(await attaching).toBe(true);
    await settle();
    expect(context.session.resumeState()?.state.turn).toBe(true);
    running.exit(0);
    await settle();
    expect(context.session.resumeState()).toBeNull();
  });

  test("a turn replayed to its end sends nothing queued until it is live", async () => {
    const context = setup({
      queue: [
        {
          id: "q1",
          text: "next",
          images: [],
          queued_at: new Date().toISOString(),
        },
      ],
    });
    const running = fakeClaudeProcess({ respond: answerInterrupts });
    running.process.replayed = 3;
    running.push({ type: "roamgate_input", seq: 1, child: 1, kind: "user" });
    running.push(RESULT);
    running.push({ type: "roamgate_input", seq: 2, child: 1, kind: "user" });
    running.push({ type: "system", subtype: "status", status: "requesting" });
    context.spawner.running.push(running);
    await context.session.attach();
    await settle();
    // A turn runs (the last replayed write): the queue waits for it.
    expect(running.written).toEqual([]);
    expect(context.session.queueLength()).toBe(1);
    running.push(RESULT);
    await settle();
    expect(running.written).toEqual([
      expect.objectContaining({
        type: "user",
        message: { role: "user", content: "next" },
      }),
    ]);
  });

  test("leaving it detached keeps the process", async () => {
    const context = setup();
    let detached = false;
    const running = fakeClaudeProcess();
    running.process.detach = () => {
      detached = true;
      running.exit(0);
    };
    context.spawner.running.push(running);
    await context.session.attach();
    context.session.dispose({ detach: true });
    expect(detached).toBe(true);
    expect(running.ended).toBe(false);
    expect(running.killed).toBe(false);
  });

  test("attach resolves only once the lines that were in are handled", async () => {
    const context = setup({
      queue: [
        {
          id: "q1",
          text: "next",
          images: [],
          queued_at: new Date().toISOString(),
        },
      ],
    });
    const running = fakeClaudeProcess({ respond: answerInterrupts });
    running.push({ type: "roamgate_input", seq: 1, child: 1, kind: "user" });
    running.push(stream({ type: "message_start", message: { id: "m1" } }));
    running.push(
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    );
    for (let index = 0; index < 300; index += 1)
      running.push(
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "." },
        }),
      );
    running.push({
      type: "system",
      subtype: "task_started",
      task_id: "t1",
    });
    running.process.replayed = 304;
    running.process.catchUp = 304;
    context.spawner.running.push(running);
    expect(await context.session.attach()).toBe(true);
    // No settling: what a hand-back reads right after the attach is the
    // rebuilt state, and nothing queued went into the running turn.
    expect(context.session.busy()).toBe(true);
    expect(context.session.backgroundTasks()).toBe(1);
    expect(running.written).toEqual([]);
    expect(context.session.queueLength()).toBe(1);
  });

  test("prompts answered in the lines read on are not asked again", async () => {
    const context = setup();
    const running = fakeClaudeProcess({ respond: answerInterrupts });
    running.push({ type: "roamgate_input", seq: 1, child: 1, kind: "user" });
    // Past what the runtime before saved as read, but in when taken.
    running.push(permission("answered"));
    running.push({
      type: "roamgate_input",
      seq: 2,
      child: 1,
      kind: "control_response",
      request_id: "answered",
    });
    running.process.replayed = 1;
    running.process.catchUp = 3;
    context.spawner.running.push(running);
    expect(await context.session.attach()).toBe(true);
    await settle();
    expect(context.prompts).toEqual([]);
    running.push(permission("live"));
    await settle();
    expect(context.prompts.map((prompt) => prompt.input)).toEqual([
      { command: "live" },
    ]);
  });

  test("a prompt another runtime answered goes when its note comes in", async () => {
    const context = setup({
      // Nobody answers here: the card waits until it is taken away.
      answer: (prompt) =>
        new Promise((resolve) =>
          prompt.signal.addEventListener("abort", () => resolve(null)),
        ),
    });
    const running = fakeClaudeProcess({ respond: answerInterrupts });
    running.push({ type: "roamgate_input", seq: 1, child: 1, kind: "user" });
    running.push(permission("late"));
    running.process.replayed = 2;
    running.process.catchUp = 2;
    context.spawner.running.push(running);
    await context.session.attach();
    await settle();
    expect(context.prompts).toHaveLength(1);
    expect(context.session.state().status).toBe("blocked");
    // The answer the runtime before sent reaches claude now.
    running.push({
      type: "roamgate_input",
      seq: 2,
      child: 1,
      kind: "control_response",
      request_id: "late",
    });
    await settle();
    expect(context.prompts[0]!.signal.aborted).toBe(true);
    expect(running.written).toEqual([]);
    expect(context.session.state().status).toBe("working");
  });

  test("a message another runtime sent starts a turn here", async () => {
    const context = setup();
    const running = fakeClaudeProcess({ respond: answerInterrupts });
    context.spawner.running.push(running);
    await context.session.attach();
    expect(context.session.busy()).toBe(false);
    running.push({ type: "roamgate_input", seq: 4, child: 1, kind: "user" });
    await settle();
    expect(context.session.busy()).toBe(true);
    expect((await context.session.send({ text: "later" })).status).toBe(
      "queued",
    );
    expect(running.written).toEqual([]);
  });

  test("nothing running: no process is started by an attach", async () => {
    const context = setup();
    expect(await context.session.attach()).toBe(false);
    expect(context.spawner.spawned).toHaveLength(0);
    expect(context.session.state().status).toBe("stopped");
  });
});

describe("what Herdr hears after a restart", () => {
  // The turns a runtime before this one saw, as the holder's log has them.
  function finishedTurns(count: number) {
    const running = fakeClaudeProcess({ respond: answerInterrupts });
    for (let seq = 1; seq <= count; seq += 1) {
      running.push({ type: "roamgate_input", seq, child: 1, kind: "user" });
      running.push(RESULT);
    }
    running.process.replayed = count * 2;
    running.process.catchUp = count * 2;
    return running;
  }

  test("a turn that finished before the restart is not reported again", async () => {
    const reported: string[] = [];
    const context = setup({ onStatus: (status) => reported.push(status) });
    context.spawner.running.push(finishedTurns(2));
    expect(await context.session.attach()).toBe(true);
    await settle();
    // Idle, once: no working -> idle that Herdr would tell the user about.
    expect(reported).toEqual(["idle"]);
  });

  test("a turn that finishes after the restart is reported once", async () => {
    const reported: string[] = [];
    const context = setup({ onStatus: (status) => reported.push(status) });
    const running = finishedTurns(1);
    context.spawner.running.push(running);
    await context.session.attach();
    await settle();
    running.push({ type: "roamgate_input", seq: 2, child: 1, kind: "user" });
    await settle();
    running.push(RESULT);
    await settle();
    expect(reported).toEqual(["idle", "working", "idle"]);
  });

  test("reading it again (a reconnect) does not report that turn again", async () => {
    const first: string[] = [];
    const before = setup({ onStatus: (status) => first.push(status) });
    const running = finishedTurns(1);
    before.spawner.running.push(running);
    await before.session.attach();
    await settle();
    running.push({ type: "roamgate_input", seq: 2, child: 1, kind: "user" });
    running.push(RESULT);
    await settle();
    before.session.dispose({ detach: true });
    expect(first).toEqual(["idle", "working", "idle"]);
    // The next reader replays both turns, the live one included.
    const again: string[] = [];
    const after = setup({ onStatus: (status) => again.push(status) });
    after.spawner.running.push(finishedTurns(2));
    await after.session.attach();
    await settle();
    expect(again).toEqual(["idle"]);
  });

  test("a process with nothing to replay is reported idle", async () => {
    const reported: string[] = [];
    const context = setup({ onStatus: (status) => reported.push(status) });
    context.spawner.running.push(finishedTurns(0));
    expect(await context.session.attach()).toBe(true);
    await settle();
    expect(reported).toEqual(["idle"]);
  });

  test("a turn the replay ends in is reported as working", async () => {
    const reported: string[] = [];
    const context = setup({ onStatus: (status) => reported.push(status) });
    const running = finishedTurns(1);
    running.push({ type: "roamgate_input", seq: 2, child: 1, kind: "user" });
    running.process.replayed = 3;
    running.process.catchUp = 3;
    context.spawner.running.push(running);
    await context.session.attach();
    await settle();
    expect(reported).toEqual(["working"]);
    running.push(RESULT);
    await settle();
    expect(reported).toEqual(["working", "idle"]);
  });
});

describe("next prompt", () => {
  const SUGGESTION = {
    type: "prompt_suggestion",
    suggestion: "run the tests",
    uuid: "g-1",
    session_id: "s1",
  };
  const nextPrompts = (events: AgentChatEvent[]) =>
    events.flatMap((event) =>
      event.type === "next_prompt" ? [event.next_prompt] : [],
    );

  test("offered after a turn, and gone when the next one starts", async () => {
    const context = setup();
    await startTurn(context);
    context.proc().push(RESULT);
    context.proc().push(SUGGESTION);
    await settle();
    expect(context.session.state().next_prompt).toEqual({
      uuid: "g-1",
      text: "run the tests",
    });
    await startTurn(context, "something else");
    expect(context.session.state().next_prompt).toBeNull();
    expect(nextPrompts(context.events)).toEqual([
      { uuid: "g-1", text: "run the tests" },
      null,
    ]);
  });

  test("dropped when it comes while a turn runs", async () => {
    const context = setup();
    await startTurn(context);
    context.proc().push(SUGGESTION);
    await settle();
    expect(context.session.state().next_prompt).toBeNull();
    expect(nextPrompts(context.events)).toEqual([]);
  });

  test("gone when the turn starts from elsewhere (a replayed message)", async () => {
    const context = setup();
    await startTurn(context);
    context.proc().push(RESULT);
    context.proc().push(SUGGESTION);
    context.proc().push({
      type: "user",
      message: { role: "user", content: "from the phone" },
      uuid: "u-9",
      isReplay: true,
    });
    await settle();
    expect(context.session.state().next_prompt).toBeNull();
  });
});

describe("switching the model (/model)", () => {
  const withModels = (options?: Parameters<typeof answerModels>[0]) => () =>
    fakeClaudeProcess({ exitOnEnd: true, respond: answerModels(options) });
  const requests = (fake: FakeClaude) =>
    fake.written.flatMap((message) =>
      message.type === "control_request" ? [message.request] : [],
    );

  test("a switch starts the process when none runs and asks it", async () => {
    const context = setup({ make: withModels() });
    expect(context.session.model()).toBeNull();
    expect(await context.session.setModel("sonnet")).toEqual({
      ok: true,
      model: "claude-sonnet-5-5",
      nextTurn: false,
    });
    expect(context.spawner.spawned).toHaveLength(1);
    expect(requests(context.proc())).toEqual([
      { subtype: "set_model", model: "sonnet" },
    ]);
    expect(context.session.model()).toBe("claude-sonnet-5-5");
    expect(context.session.chosenModel()).toBe("sonnet");
    // Nothing was sent as a message.
    expect(context.users()).toEqual([]);
  });

  test("the agent's refusal is said, and nothing changes", async () => {
    const context = setup({
      make: withModels({
        resolve: (name) => {
          throw new Error(`Model '${name}' not found`);
        },
      }),
    });
    expect(await context.session.setModel("sonet")).toEqual({
      ok: false,
      reason: "Model 'sonet' not found",
    });
    expect(context.session.chosenModel()).toBeNull();
  });

  test("while a turn runs, it is for the next turn, and the turn goes on", async () => {
    const context = setup({ make: withModels() });
    await startTurn(context);
    expect(await context.session.setModel("haiku")).toMatchObject({
      ok: true,
      nextTurn: true,
    });
    expect(context.session.state().status).toBe("working");
    expect(context.spawner.spawned).toHaveLength(1);
  });

  test("the model a turn starts on is known from its init", async () => {
    const context = setup({ make: withModels() });
    await startTurn(context);
    context.proc().push({
      type: "system",
      subtype: "init",
      session_id: "s1",
      model: "claude-opus-5-5",
    });
    await settle();
    expect(context.session.model()).toBe("claude-opus-5-5");
    // An answer from another model (a fallback): that one runs now.
    context.proc().push({
      type: "assistant",
      message: {
        id: "msg_fb",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text: "On Sonnet" }],
      },
      parent_tool_use_id: null,
    });
    await settle();
    expect(context.session.model()).toBe("claude-sonnet-5-5");
  });

  test("no switch while a rewind runs, nor while handing back", async () => {
    // It answers the switch, never the rewind's step: the rewind waits.
    const context = setup({ make: withModels(), rewindWaitMs: 50 });
    await context.session.warm();
    const rewinding = context.session.rewind({
      uuid: "u2",
      mode: "conversation",
    });
    await settle();
    expect(await context.session.setModel("haiku")).toEqual({
      ok: false,
      reason: "A rewind is running; switch once it is done",
    });
    expect((await rewinding).ok).toBe(false);
    const stopping = context.session.stop();
    expect(await context.session.setModel("haiku")).toEqual({
      ok: false,
      reason: "The session is being handed back",
    });
    await stopping;
    expect(requests(context.proc())).toEqual([
      { subtype: "rewind_conversation", target_message_uuid: "u2" },
    ]);
  });

  test("the list comes from the running process only, its rows as it says", async () => {
    const context = setup({ make: withModels() });
    expect(await context.session.listModels()).toBeNull();
    expect(context.spawner.spawned).toHaveLength(0);
    await context.session.warm();
    expect(await context.session.listModels()).toEqual([
      {
        value: "default",
        label: "Default (recommended)",
        description: "Use the default model (currently Opus 5.5)",
        resolved: "claude-opus-5-5",
      },
      {
        value: "sonnet",
        label: "Sonnet",
        description: "Sonnet 5.5",
        resolved: "claude-sonnet-5-5",
      },
      {
        value: "haiku",
        label: "Haiku",
        description: "Haiku 5.5",
        resolved: "claude-haiku-5-5",
      },
    ]);
  });

  test("a process that does not answer the list gives none, in a short while", async () => {
    jest.useFakeTimers();
    try {
      const context = setup({
        make: () => fakeClaudeProcess({ exitOnEnd: true }),
        rewindWaitMs: 30_000,
      });
      await context.session.warm();
      const listed = context.session.listModels();
      await settle();
      jest.advanceTimersByTime(5000);
      expect(await listed).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
