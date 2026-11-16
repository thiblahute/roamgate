import type { On } from "claude-code";
import { expect, type MockClock, mock, test } from "claude-code/testing";

/**
 * The mod against the engine's own test kit (`claude plugin test`): the
 * hooks here stand for the engine and for Roamgate's socket.
 */

type Sent = { command: string; body: Record<string, unknown> };

/**
 * A Roamgate that holds `inbox` and records every request. Given the
 * clock, it holds a poll with nothing for its `wait_ms`, as Roamgate does.
 */
function roamgate(
  on: On,
  inbox: { id: number; text: string }[],
  clock?: MockClock,
) {
  const sent: Sent[] = [];
  on("fs.exists", () => ({ value: true }));
  on("http.fetch", async (_, e) => {
    const command = e.url.replace(/^.*\/v1\//, "");
    const body = JSON.parse(e.init?.body ?? "{}") as Record<string, unknown>;
    sent.push({ command, body });
    let answer: unknown = {};
    if (command === "mod_poll" && clock && inbox.length === 0)
      await clock.sleep(Number(body.wait_ms));
    if (command === "mod_poll")
      answer = {
        protocol: 1,
        epoch: "e1",
        messages: inbox.filter((each) => each.id > Number(body.after)),
      };
    if (command === "mod_ack" && body.outcome === "submitted") {
      const at = inbox.findIndex((each) => each.id === Number(body.id));
      if (at >= 0) inbox.splice(at, 1);
    }
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify(answer),
      },
    };
  });
  return sent;
}

/** A Claude session in a Herdr pane, in the terminal. */
function session(on: On, surfaces: ("terminal" | "desktop")[] = ["terminal"]) {
  mock.env(on, {
    HERDR_PANE_ID: "w1-2",
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    HOME: "/home/user",
  });
  on("session.surfaces", () => ({ value: surfaces }));
  on("session.id", () => ({ value: "session-1" }));
  on("session.cwd", () => ({ value: "/work" }));
  on("session.model", () => ({ value: "claude-haiku-5-5" }));
  on("session.version", () => ({ value: { version: "2.1.319" } }));
  on("session.usage", () => ({
    value: {
      startedAt: 0,
      context: { tokens: 1000, window: 200000, percent: 1 },
      rateLimits: [
        {
          kind: "five_hour",
          percentUsed: 12,
          resetsAt: "2026-11-09T10:00:00Z",
        },
      ],
    },
  }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
}

const START = {
  cwd: "/work",
  surface: "terminal",
  isInteractive: true,
} as const;

test("a waiting message is submitted as the user's, then acknowledged", async ($, on) => {
  const clock = mock.clock(on);
  session(on);
  const sent = roamgate(on, [{ id: 1, text: "A comment from me" }]);
  const submitted: { text: string; asUser?: boolean }[] = [];
  on("prompt.submit", (_, e) => {
    submitted.push({
      text: e.text,
      asUser: e.origin.kind === "plugin" ? e.origin.asUser : undefined,
    });
    return { text: e.text };
  });

  await $.session.start(START);
  await clock.settle();

  expect(submitted).toEqual([{ text: "A comment from me", asUser: true }]);
  const poll = sent.find((each) => each.command === "mod_poll");
  expect(poll?.body.pane).toBe("w1-2");
  expect(poll?.body.session).toBe("session-1");
  expect(poll?.body.herdr_socket).toBe("/tmp/herdr.sock");
  const ack = sent.find((each) => each.command === "mod_ack");
  expect(ack?.body).toMatchObject({ id: 1, outcome: "submitted" });
});

test("a prompt dropped by a stop waits for the next turn's end", async ($, on) => {
  const clock = mock.clock(on);
  session(on);
  const sent = roamgate(on, [{ id: 7, text: "From another session" }]);
  let drops = 1;
  const submitted: string[] = [];
  on("prompt.submit", (_, e) => {
    if (drops > 0) {
      drops -= 1;
      return { drop: "the prompt was removed from the queue before it ran" };
    }
    submitted.push(e.text);
    return { text: e.text };
  });
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.session.start(START);
  await clock.settle();
  expect(submitted).toEqual([]);
  expect(
    sent.some(
      (each) => each.command === "mod_ack" && each.body.outcome === "held",
    ),
  ).toBe(true);

  // A subagent's turn is not the session's: still held.
  await $.turn.complete({
    answer: "",
    durationMs: 1,
    isAborted: false,
    turnId: "t0",
    agentId: "a1",
    reason: "answer",
  });
  await clock.settle();
  expect(submitted).toEqual([]);

  await $.turn.complete({
    answer: "ok",
    durationMs: 1,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  await clock.settle();
  expect(submitted).toEqual(["From another session"]);
  expect(
    sent.filter(
      (each) => each.command === "mod_ack" && each.body.outcome === "submitted",
    ).length,
  ).toBe(1);
});

test("turns and usage reach Roamgate", async ($, on) => {
  const clock = mock.clock(on);
  session(on);
  const sent = roamgate(on, []);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.session.start(START);
  await $.turn.start({ text: "hi", turnId: "t1" });
  await $.turn.complete({
    answer: "hello",
    durationMs: 5,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  await clock.settle();

  const events = sent
    .filter((each) => each.command === "mod_event")
    .map((each) => JSON.parse(String(each.body.event)) as { type: string });
  expect(events.map((each) => each.type)).toEqual([
    "usage",
    "turn_start",
    "turn_complete",
  ]);
  expect(events[2]).toMatchObject({
    reason: "answer",
    aborted: false,
    model: "claude-haiku-5-5",
    context: { percent: 1 },
    rate_limits: [{ kind: "five_hour", percent_used: 12 }],
  });
});

test("a claude -p run in the pane stays out of it", async ($, on) => {
  const clock = mock.clock(on);
  session(on, []);
  const sent = roamgate(on, [{ id: 1, text: "not for a script" }]);
  on("prompt.submit", (_, e) => ({ text: e.text }));

  await $.session.start({ cwd: "/work", surface: null, isInteractive: false });
  await clock.advance(60_000);

  expect(sent).toEqual([]);
});

/** The engine's side of registering tools and commands. */
function registry(on: On) {
  const tools: { name: string; isDeferred?: boolean }[] = [];
  const commands: string[] = [];
  on("tool.register", (_, e) => {
    tools.push({ name: e.name, isDeferred: e.isDeferred });
    return { value: { tool: `mcp__roamgate__${e.name}` } };
  });
  on("command.register", (_, e) => {
    commands.push(e.name);
    return { value: { command: e.name } };
  });
  return { tools, commands };
}

/** A command the user typed at the terminal's prompt. */
const TYPED = {
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 80 },
} as const;

const MARKDOWN = "Fixed in `abc`: \"q\", 'q', $HOME and $(true) stay.";

test("the tools are there in a claude -p run too, and answer over the socket", async ($, on) => {
  const clock = mock.clock(on);
  session(on, []);
  const { tools, commands } = registry(on);
  const sent = roamgate(on, []);

  await $.session.start({ cwd: "/work", surface: null, isInteractive: false });
  await clock.settle();
  expect(tools.find((each) => each.name === "review_reply")).toEqual({
    name: "review_reply",
    isDeferred: false,
  });
  expect(tools.find((each) => each.name === "review_open")?.isDeferred).toBe(
    true,
  );
  expect(commands).toEqual(["rg-review", "threads"]);

  const result = await $.tool.call({
    tool: "mcp__roamgate__review_reply",
    comment_id: "1a2b3c4d",
    text: MARKDOWN,
  });
  expect(result.deny).toBeUndefined();
  const reply = sent.find((each) => each.command === "reply");
  expect(reply?.body).toMatchObject({
    comment: "1a2b3c4d",
    text: MARKDOWN,
    pane: "w1-2",
    herdr_socket: "/tmp/herdr.sock",
    cwd: "/work",
    claude_session: "session-1",
    via: "claude-mod",
  });
  // Neither the inbox nor the tools' hello: a script's run is not the pane's.
  expect(
    sent.some(
      (each) => each.command === "mod_poll" || each.command === "mod_tools",
    ),
  ).toBe(false);
});

test("Roamgate's own headless session says it has the tools, under its pane", async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, {
    ROAMGATE_HEADLESS: "1",
    ROAMGATE_PANE_ID: "w4-1",
    ROAMGATE_HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    HOME: "/home/user",
  });
  on("session.surfaces", () => ({ value: [] }));
  on("session.id", () => ({ value: "session-2" }));
  on("session.cwd", () => ({ value: "/work" }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  registry(on);
  const sent = roamgate(on, [{ id: 1, text: "not for the mod" }]);

  await $.session.start({ cwd: "/work", surface: null, isInteractive: false });
  await clock.settle();
  const hello = sent.find((each) => each.command === "mod_tools");
  expect(hello?.body).toMatchObject({
    pane: "w4-1",
    herdr_socket: "/tmp/herdr.sock",
    session: "session-2",
    headless: "1",
  });
  // Its inbox stays conversation mode's.
  expect(sent.some((each) => each.command === "mod_poll")).toBe(false);
  // Again every few minutes.
  await clock.advance(4 * 60_000);
  expect(sent.filter((each) => each.command === "mod_tools")).toHaveLength(2);
});

test("a tool says so when Roamgate is not running", async ($, on) => {
  const clock = mock.clock(on);
  session(on);
  registry(on);
  on("fs.exists", () => ({ value: false }));
  on("http.fetch", () => {
    throw new Error("no request expected");
  });

  await $.session.start(START);
  await clock.settle();
  const result = await $.tool.call({
    tool: "mcp__roamgate__review_get",
  });
  expect(String(result.deny ?? result.text)).toContain(
    "Roamgate is not running here",
  );
  const bad = await $.tool.call({
    tool: "mcp__roamgate__review_reply",
    comment_id: "1a2b",
  });
  expect(String(bad.deny ?? bad.text)).toContain("text is required");
});

test("/threads and /rg-review answer with a line of text", async ($, on) => {
  const clock = mock.clock(on);
  session(on);
  registry(on);
  const sent: { command: string; body: Record<string, unknown> }[] = [];
  on("fs.exists", () => ({ value: true }));
  on("http.fetch", (_, e) => {
    const command = e.url.replace(/^.*\/v1\//, "");
    const body = JSON.parse(e.init?.body ?? "{}") as Record<string, unknown>;
    sent.push({ command, body });
    const answer =
      command === "waiting"
        ? {
            reviews: [
              {
                session: { id: "abcdef1234", title: "Topic" },
                threads: [
                  {
                    id: "1a2b3c4d5e",
                    location: "a.c:3",
                    comments: [{ author: "You", text: "Why?" }],
                  },
                ],
              },
            ],
          }
        : command === "open"
          ? { session: { id: "abcdef1234", title: "Topic" }, threads: [] }
          : {};
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify(answer),
      },
    };
  });

  await $.session.start(START);
  await clock.settle();
  const threads = await $.command.run({ ...TYPED, command: "threads" });
  expect(threads.text).toContain("[1a2b3c4d] a.c:3: You: Why?");
  const opened = await $.command.run({
    ...TYPED,
    command: "rg-review",
    args: "main..topic",
  });
  expect(opened.text).toBe('Opened "Topic" (abcdef12) in Roamgate.');
  expect(sent.find((each) => each.command === "open")?.body).toMatchObject({
    range: "main..topic",
    pane: "w1-2",
    via: "claude-mod",
  });
});

/** The blocked and unblocked the mod reported, in order. */
function blockedEvents(sent: Sent[]): string[] {
  return sent
    .filter((each) => each.command === "mod_event")
    .map(
      (each) => (JSON.parse(String(each.body.event)) as { type: string }).type,
    )
    .filter((type) => type === "blocked" || type === "unblocked");
}

/** Permission asks for Bash, answered `after` ms later, if ever. */
function bashAsks(
  on: On,
  clock: MockClock,
  answer: "allow" | "deny" | "never",
  after = 0,
) {
  on("tool.check", { tool: "Bash" }, () => ({ decision: "ask" }));
  on("classic.PermissionRequest", async () => {
    if (answer === "never") return new Promise<never>(() => {});
    await clock.sleep(after);
    return {
      decision:
        answer === "allow"
          ? { behavior: "allow" as const }
          : { behavior: "deny" as const, message: "not now" },
    };
  });
}

/** A Bash call that runs for `ms` once allowed. */
function longBash(on: On, clock: MockClock, ms: number) {
  const ran: string[] = [];
  on("tool.call", { tool: "Bash" }, async (_, e) => {
    ran.push(e.tool_use_id ?? "");
    await clock.sleep(ms);
    return { result: "built" };
  });
  return ran;
}

test("an ask settled without a person never reads blocked while its tool runs", async ($, on) => {
  const clock = mock.clock(on);
  session(on);
  const sent = roamgate(on, [], clock);
  // Auto mode's classifier, or a hook, allows it at once.
  bashAsks(on, clock, "allow");
  longBash(on, clock, 30_000);

  await $.session.start(START);
  await clock.settle();
  const call = $.tool.call({ tool: "Bash", command: "make" });
  await clock.advance(20_000);
  expect(blockedEvents(sent)).toEqual([]);
  await clock.advance(20_000);
  expect(await call).toMatchObject({ result: "built" });
  expect(blockedEvents(sent)).toEqual([]);
});

test("a person's ask reads blocked until answered, not while the tool then runs", async ($, on) => {
  const clock = mock.clock(on);
  session(on);
  const sent = roamgate(on, [], clock);
  bashAsks(on, clock, "allow", 6_000);
  const ran = longBash(on, clock, 30_000);

  await $.session.start(START);
  await clock.settle();
  const call = $.tool.call({ tool: "Bash", command: "make" });
  await clock.advance(1_000);
  expect(blockedEvents(sent)).toEqual([]);
  await clock.advance(4_000);
  expect(blockedEvents(sent)).toEqual(["blocked"]);
  expect(ran).toEqual([]);

  await clock.advance(2_000);
  expect(ran.length).toBe(1);
  expect(blockedEvents(sent)).toEqual(["blocked", "unblocked"]);
  await clock.advance(40_000);
  expect(await call).toMatchObject({ result: "built" });
  expect(blockedEvents(sent)).toEqual(["blocked", "unblocked"]);
});

test("a denied ask is over at once", async ($, on) => {
  const clock = mock.clock(on);
  session(on);
  const sent = roamgate(on, [], clock);
  bashAsks(on, clock, "deny", 5_000);
  const ran = longBash(on, clock, 30_000);

  await $.session.start(START);
  await clock.settle();
  const call = $.tool.call({ tool: "Bash", command: "rm -rf build" });
  await clock.advance(4_000);
  expect(blockedEvents(sent)).toEqual(["blocked"]);
  await clock.advance(2_000);
  await call.catch(() => undefined);
  expect(ran).toEqual([]);
  expect(blockedEvents(sent)).toEqual(["blocked", "unblocked"]);
});

test("the main turn's end clears its asks, not a background subagent's", async ($, on) => {
  const clock = mock.clock(on);
  session(on);
  const sent = roamgate(on, [], clock);
  on("turn.complete", (_, e) => ({ text: e.answer }));
  // The person answers neither: the dialogs stay up.
  bashAsks(on, clock, "never");
  longBash(on, clock, 0);
  const end = {
    answer: "",
    durationMs: 1,
    isAborted: true,
    turnId: "t1",
    reason: "aborted",
  } as const;

  await $.session.start(START);
  await clock.settle();
  void $.tool.call({ tool: "Bash", command: "make" }).catch(() => undefined);
  await clock.advance(3_000);
  expect(blockedEvents(sent)).toEqual(["blocked"]);
  await $.turn.complete(end);
  await clock.settle();
  expect(blockedEvents(sent)).toEqual(["blocked", "unblocked"]);

  void $.tool
    .call({ tool: "Bash", command: "make", agentId: "a1" })
    .catch(() => undefined);
  await clock.advance(3_000);
  expect(blockedEvents(sent)).toEqual(["blocked", "unblocked", "blocked"]);
  await $.turn.complete({ ...end, turnId: "t2" });
  await clock.advance(3_000);
  expect(blockedEvents(sent)).toEqual(["blocked", "unblocked", "blocked"]);
});

test("AskUserQuestion reads blocked at once, until answered", async ($, on) => {
  const clock = mock.clock(on);
  session(on);
  const sent = roamgate(on, [], clock);
  on("tool.call", { tool: "AskUserQuestion" }, async () => {
    await clock.sleep(120_000);
    return { result: "Yes" };
  });

  await $.session.start(START);
  await clock.settle();
  const call = $.tool.call({
    tool: "AskUserQuestion",
    questions: [
      {
        question: "Ship it?",
        header: "Ship",
        multiSelect: false,
        options: [
          { label: "Yes", description: "Ship now" },
          { label: "No", description: "Wait" },
        ],
      },
    ],
  });
  await clock.settle();
  expect(blockedEvents(sent)).toEqual(["blocked"]);
  await clock.advance(100_000);
  expect(blockedEvents(sent)).toEqual(["blocked"]);
  await clock.advance(30_000);
  await call;
  expect(blockedEvents(sent)).toEqual(["blocked", "unblocked"]);
});
