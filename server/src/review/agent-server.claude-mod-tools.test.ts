import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  identityBody,
  ROAMGATE_TOOLS,
  roamgateTool,
  type ToolIdentity,
  ToolInputError,
  toolRequest,
  waitingText,
} from "../../claude-mod/hooks/tools";
import type { AgentSessionInfo } from "../agent/agent-messenger";
import { createClaudeModHub } from "../agent/claude-mod";
import { createReviewAgentServer } from "./agent-server";
import { createReviewService } from "./service";
import { openReviewStorage } from "./storage";

/**
 * The Claude mod's tools (server/claude-mod/hooks/tools.ts) as the mod
 * sends them, against the real review socket: each runs the command the
 * review client runs, with the same effect.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function temp(prefix: string) {
  const path = mkdtempSync(join(realpathSync("/tmp"), prefix));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

const IDENTITY: ToolIdentity = {
  pane: "w1-2",
  workspace: "w1",
  herdr_socket: "/herdr.sock",
  cwd: "/work",
  claude_session: "aaaaaaaa-0000-4000-8000-000000000001",
};

const OTHER: AgentSessionInfo = {
  address: "local/w3-1",
  name: "Other",
  title: null,
  workspace: "w3",
  workspace_id: "w3",
  connection: "local",
  agent: "claude",
  mode: "terminal",
  state: "idle",
  cwd: null,
};

function setup() {
  const dir = temp("rg-mt-");
  const home = temp("rg-mth-");
  const hub = createClaudeModHub({ file: null, sweepMs: 3_600_000 });
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  const notified: Record<string, unknown>[] = [];
  const sent: Record<string, unknown>[] = [];
  const agent = createReviewAgentServer({
    service,
    directory: dir,
    home,
    claudeMod: hub,
    connections: () => [
      {
        id: "local",
        herdrSocketPath: "/herdr.sock",
        readRoot: async () => "/repo",
        readDefaultBase: async () => "origin/main",
      },
    ],
    notify: async (input) => {
      notified.push(input);
    },
    messages: {
      list: async () => [OTHER],
      send: async (input) => {
        sent.push(input);
        return {
          sent: true,
          to: OTHER,
          delivery: "terminal" as const,
          note: "",
        };
      },
    },
  });
  cleanups.push(() => {
    hub.dispose();
    agent.stop();
    service.close();
  });
  agent.installLocal();
  const socket = join(home, ".cache/roamgate/review.sock");

  /** One request to the socket: its JSON answer, or its error. */
  async function raw(
    command: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`http://roamgate/v1/${command}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      unix: socket,
    } as RequestInit);
    const parsed = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(parsed.error));
    return parsed;
  }

  /** A tool call as the mod makes it: its JSON answer, or its error. */
  async function call(
    name: string,
    input: Record<string, unknown> = {},
    identity: ToolIdentity = IDENTITY,
  ): Promise<Record<string, unknown>> {
    const tool = roamgateTool(name);
    if (!tool) throw new Error(`no tool ${name}`);
    const { command, body } = toolRequest(tool, input, identity);
    return raw(command, body);
  }
  return { hub, service, call, raw, notified, sent };
}

/** Markdown a shell would have mangled. */
const MARKDOWN = [
  "Fixed in `abc123`: \"double\", 'single', $HOME and $(touch /tmp/x) stay.",
  "",
  "```sh",
  'echo "$PATH" `date` \\',
  "```",
].join("\n");

test("every tool runs the client's command on the review socket", async () => {
  const { service, call } = setup();
  const opened = (await call("review_open", { title: "Topic" })) as {
    session: { id: string; agent: { name: string; paneId: string } };
  };
  // Named Claude, bound to the asking pane.
  expect(opened.session.agent).toMatchObject({
    name: "Claude",
    paneId: "w1-2",
  });
  const review = opened.session.id;
  const asked = await service.addThread({
    sessionId: review,
    anchor: { path: "a.c", line: 3, side: "new" },
    text: "Why?",
  });

  const replied = (await call("review_reply", {
    comment_id: asked.id.slice(0, 8),
    text: MARKDOWN,
  })) as { comments: { id: string; author: string; text: string }[] };
  const answer = replied.comments.at(-1)!;
  expect(answer).toMatchObject({ author: "Claude", text: MARKDOWN });

  await call("review_working", {
    comment_id: asked.id,
    message: "Freeing the buffer",
  });
  expect(
    service.get({ sessionId: review }).session.agent.working,
  ).toMatchObject({ message: "Freeing the buffer" });
  await call("review_working", { review, done: true, message: "Done" });

  const draft = (await call("review_add", {
    kind: "draft",
    file: "a.c",
    line: 4,
    end_line: 6,
    side: "old",
    text: "Nit: `x`",
  })) as Record<string, unknown>;
  expect(draft).toMatchObject({
    kind: "draft",
    path: "a.c",
    line: 4,
    end_line: 6,
    side: "old",
  });
  expect(
    ((await call("review_add", { text: "A note" })) as { kind: string }).kind,
  ).toBe("discussion");

  await call("review_edit", { comment_id: answer.id, text: "Edited $HOME" });
  expect(
    service
      .get({ sessionId: review })
      .threads.find((thread) => thread.id === asked.id)
      ?.comments.at(-1)?.body,
  ).toBe("Edited $HOME");

  expect(
    (await call("review_resolve", { comment_id: asked.id })).resolved,
  ).toBe(true);
  expect((await call("review_reopen", { comment_id: asked.id })).resolved).toBe(
    false,
  );
  await call("review_update", { message: "Pushed the fixes" });
  expect(await call("review_summary", { review, text: "Fine" })).toEqual({
    kept: true,
  });
  const got = (await call("review_get", { review })) as {
    threads: unknown[];
  };
  expect(got.threads).toHaveLength(3);
});

test("threads waiting for the session's answer, across its reviews", async () => {
  const { service, call } = setup();
  const opened = (await call("review_open", {})) as {
    session: { id: string };
  };
  const review = opened.session.id;
  const asked = await service.addThread({ sessionId: review, text: "Why?" });
  const other = await service.addThread({
    sessionId: review,
    text: "And this?",
  });
  await call("review_reply", { comment_id: other.id, text: "Because" });

  const waiting = (await call("review_threads")) as {
    reviews: { threads: { id: string }[] }[];
  };
  expect(waiting.reviews).toHaveLength(1);
  expect(waiting.reviews[0]!.threads.map((thread) => thread.id)).toEqual([
    asked.id,
  ]);
  expect(waitingText(waiting)).toContain(`[${asked.id.slice(0, 8)}]`);
  // Another pane's session has none.
  const elsewhere = await call(
    "review_threads",
    {},
    { ...IDENTITY, pane: "w9-9", claude_session: "b" },
  );
  expect(waitingText(elsewhere)).toBe(
    "No thread waits for an answer from this session.",
  );
});

test("a review's own agent writes when it runs in the asking pane", async () => {
  const { service, call } = setup();
  const review = service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "worktree" },
    agent: "Opus",
    paneId: "w1-2",
  }).session.id;
  const asked = await service.addThread({ sessionId: review, text: "Hi" });
  const mine = (await call("review_reply", {
    comment_id: asked.id,
    text: "Hello",
  })) as { comments: { author: string }[] };
  expect(mine.comments.at(-1)!.author).toBe("Opus");
  // From another pane: Claude; ROAMGATE_REVIEW_AGENT wins over both.
  const theirs = (await call(
    "review_reply",
    { comment_id: asked.id, text: "Me too" },
    { ...IDENTITY, pane: "w1-3" },
  )) as { comments: { author: string }[] };
  expect(theirs.comments.at(-1)!.author).toBe("Claude");
  const named = (await call(
    "review_reply",
    { comment_id: asked.id, text: "And me" },
    { ...IDENTITY, agent: "Reviewer" },
  )) as { comments: { author: string }[] };
  expect(named.comments.at(-1)!.author).toBe("Reviewer");
});

test("notify, sessions and messages go where the client's do", async () => {
  const { call, notified, sent } = setup();
  expect(
    await call("review_notify", { title: "Merge", text: "Decide `x`" }),
  ).toEqual({ notified: true });
  expect(notified[0]).toMatchObject({
    paneId: "w1-2",
    agent: "Claude",
    title: "Merge",
    text: "Decide `x`",
  });
  const listed = (await call("agent_sessions")) as {
    sessions: { address: string }[];
  };
  expect(listed.sessions[0]!.address).toBe("local/w3-1");
  expect(
    await call("agent_message", { to: "local/w3-1", text: MARKDOWN }),
  ).toMatchObject({ sent: true });
  expect(sent[0]).toMatchObject({
    from: { connectionId: "local", paneId: "w1-2" },
    to: "local/w3-1",
    text: MARKDOWN,
  });
});

test("a session says it has the tools over the socket, and when it leaves", async () => {
  const { hub, raw } = setup();
  const hello = {
    ...identityBody(IDENTITY),
    session: IDENTITY.claude_session,
    client: "t1",
    tools: ROAMGATE_TOOLS.length,
  };
  expect(hub.hasTools("local", "w1-2")).toBe(false);
  expect(await raw("mod_tools", hello)).toEqual({ ok: true });
  expect(hub.hasTools("local", "w1-2")).toBe(true);
  await raw("mod_tools", { ...hello, gone: "1" });
  expect(hub.hasTools("local", "w1-2")).toBe(false);
});

test("what the model gets wrong is said back before any request", () => {
  const reply = roamgateTool("review_reply")!;
  expect(() => toolRequest(reply, { comment_id: "a" }, IDENTITY)).toThrow(
    ToolInputError,
  );
  expect(() =>
    toolRequest(
      roamgateTool("review_add")!,
      { text: "x", kind: "comment" },
      IDENTITY,
    ),
  ).toThrow('kind is "discussion" or "draft"');
  expect(() =>
    toolRequest(roamgateTool("review_add")!, { text: "x", line: 0 }, IDENTITY),
  ).toThrow("line number");
  expect(() =>
    toolRequest(
      roamgateTool("review_open")!,
      { range: "a..b", worktree: true },
      IDENTITY,
    ),
  ).toThrow("one of");
  expect(() =>
    toolRequest(roamgateTool("review_open")!, { path: "rel" }, IDENTITY),
  ).toThrow("absolute");
  // review_open runs from the path it is given.
  expect(
    toolRequest(
      roamgateTool("review_open")!,
      { path: "/other", compare_old: "t-old", compare_new: "t" },
      IDENTITY,
    ).body,
  ).toMatchObject({ cwd: "/other", compare: "t-old..t" });
  // Every tool has a schema the model reads, and a command.
  for (const tool of ROAMGATE_TOOLS) {
    expect(tool.description.length).toBeGreaterThan(20);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.command).toMatch(/^[a-z_]+$/);
  }
});
