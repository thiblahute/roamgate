import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReviewAgentServer,
  HOLD_OUTPUT_MAX_BODY_BYTES,
  LOCAL_SOCKET_KEY,
  REVIEW_AGENT_MAX_BODY_BYTES,
  REVIEW_AGENT_MAX_WATCHES,
  type ReviewAgentConnection,
  type ReviewAgentServer,
} from "./agent-server";
import { createReviewService, type ReviewService } from "./service";
import { openReviewStorage } from "./storage";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function temp(prefix: string) {
  // Short paths: unix sockets are limited to about 100 bytes.
  const path = mkdtempSync(join(realpathSync("/tmp"), prefix));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

type Setup = {
  service: ReviewService;
  agent: ReviewAgentServer;
  home: string;
  socket: string;
  client: string;
  cwd: string;
  /** Another repository, at /other. */
  other: string;
};

const notified: Record<string, unknown>[] = [];
const placements: Record<string, unknown>[] = [];
function setup(extra: Partial<ReviewAgentConnection> = {}): Setup {
  const dir = temp("rg-rev-");
  const home = temp("rg-home-");
  const cwd = realpathSync(temp("rg-cwd-"));
  const other = realpathSync(temp("rg-other-"));
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  const agent = createReviewAgentServer({
    service,
    directory: dir,
    home,
    connections: () => [
      {
        id: "local",
        herdrSocketPath: "/herdr.sock",
        readRoot: async (path) => {
          if (path === other) return "/other";
          if (path !== cwd) throw new Error(`unexpected cwd ${path}`);
          return "/repo";
        },
        readDefaultBase: async () => "origin/main",
        ...extra,
      },
    ],
    notify: async (input) => {
      notified.push(input);
    },
    workspaces: async (input) => {
      placements.push(input);
      return { under: input.workspaceId };
    },
  });
  cleanups.push(() => {
    agent.stop();
    service.close();
  });
  agent.installLocal();
  return {
    service,
    agent,
    home,
    socket: join(home, ".cache/roamgate/review.sock"),
    client: join(home, ".cache/roamgate/bin/roamgate-review"),
    cwd,
    other,
  };
}

async function run(
  s: Setup,
  args: string[],
  stdin?: string,
  env: Record<string, string | undefined> = {
    ROAMGATE_REVIEW_AGENT: "Claude",
  },
) {
  const proc = Bun.spawn(["python3", s.client, ...args], {
    cwd: s.cwd,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH,
      HOME: s.home,
      HERDR_PANE_ID: "w1:p2",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_SOCKET_PATH: "/herdr.sock",
      ...env,
    },
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr, json: code === 0 ? JSON.parse(stdout) : null };
}

test("installs the client and links the well-known socket", async () => {
  const s = setup();
  expect(lstatSync(s.socket).isSymbolicLink()).toBe(true);
  expect(readlinkSync(s.socket)).toBe(s.agent.socketPath(LOCAL_SOCKET_KEY)!);
  expect(readFileSync(s.client, "utf8")).toStartWith("#!/usr/bin/env python3");
  expect(lstatSync(s.client).mode & 0o777).toBe(0o755);
  expect(lstatSync(s.agent.socketPath(LOCAL_SOCKET_KEY)!).mode & 0o777).toBe(
    0o600,
  );
});

test("links the skill and client where agents look, not over the user's", () => {
  const s = setup();
  const skills = join(s.home, ".claude/skills");
  const bin = join(s.home, ".local/bin");
  mkdirSync(skills, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // The user's own client stays; a link to an old install is replaced.
  writeFileSync(join(bin, "roamgate-review"), "mine");
  symlinkSync(
    "/old/.cache/roamgate/skills/roamgate-review",
    join(skills, "roamgate-review"),
  );
  s.agent.installLocal();
  expect(
    readFileSync(join(skills, "roamgate-review/SKILL.md"), "utf8"),
  ).toStartWith("---\nname: roamgate-review");
  expect(readFileSync(join(bin, "roamgate-review"), "utf8")).toBe("mine");

  rmSync(join(bin, "roamgate-review"));
  s.agent.installLocal();
  expect(readlinkSync(join(bin, "roamgate-review"))).toBe(s.client);
});

test("links the skill where Codex reads skills too, once that folder exists", () => {
  const s = setup();
  const codex = join(s.home, ".codex/skills");
  s.agent.installLocal();
  expect(existsSync(join(codex, "roamgate-review"))).toBe(false);
  mkdirSync(codex, { recursive: true });
  s.agent.installLocal();
  expect(
    readFileSync(join(codex, "roamgate-review/SKILL.md"), "utf8"),
  ).toStartWith("---\nname: roamgate-review");
});

test("open --repo takes each repository's own range", async () => {
  const s = setup();
  const opened = await run(s, [
    "open",
    "--range",
    "origin/main..topic",
    "--repo",
    `${s.other}=upstream/main..series`,
  ]);
  expect(opened.stderr).toBe("");
  const other = opened.json.repos.find(
    (repo: { root: string }) => repo.root === "/other",
  );
  expect(
    s.service.get({ sessionId: other.session }).session.target,
  ).toMatchObject({ kind: "range", base: "upstream/main", head: "series" });
});

test("in Claude Code the agent is named Claude by default", async () => {
  const s = setup();
  const opened = await run(s, ["open"], undefined, { CLAUDECODE: "1" });
  const sessionId = opened.json.session.id as string;
  expect(s.service.get({ sessionId }).session.agent.name).toBe("Claude");
});

test("a claude in conversation mode names its pane under Roamgate's names", async () => {
  const s = setup();
  // The holder's headless claude: no Herdr names (Herdr's hook would claim
  // the pane), Roamgate's instead.
  const opened = await run(s, ["open"], undefined, {
    CLAUDECODE: "1",
    HERDR_PANE_ID: undefined,
    HERDR_SOCKET_PATH: undefined,
    ROAMGATE_HEADLESS: "1",
    ROAMGATE_PANE_ID: "w1:p7",
    ROAMGATE_HERDR_SOCKET_PATH: "/herdr.sock",
  });
  expect(opened.stderr).toBe("");
  const sessionId = opened.json.session.id as string;
  expect(s.service.get({ sessionId }).session.agent).toMatchObject({
    name: "Claude",
    paneId: "w1:p7",
  });
});

test("the agent loop: open, discuss, watch, reply, resolve", async () => {
  const s = setup();
  const opened = await run(s, ["open", "--message", "Please review"]);
  expect(opened.stderr).toBe("");
  expect(opened.json.session.target).toBe("origin/main..HEAD");
  const sessionId = opened.json.session.id as string;
  const session = s.service.get({ sessionId }).session;
  expect(session.agent).toMatchObject({ name: "Claude", paneId: "w1:p2" });
  expect(session.workspaceId).toBe("w1");

  // The agent leaves a draft review comment on a line, text from stdin.
  const draft = await run(
    s,
    ["add", "--file", "src/a.c", "--line", "4", "--draft", "-"],
    "Leaks on the error path\n",
  );
  expect(draft.json).toMatchObject({
    kind: "draft",
    location: "src/a.c:4",
    comments: [{ author: "Claude", text: "Leaks on the error path\n" }],
  });
  // A thread on a part of a comment (a work item's description): the
  // comment's anchor, with it and the words quoted, its review found by it.
  const onPart = await run(s, [
    "add",
    "--on-comment",
    draft.json.comments[0].id,
    "--quote",
    "the **error** path",
    "Which",
    "one?",
  ]);
  expect(onPart.stderr).toBe("");
  const part = s.service
    .get({ sessionId })
    .threads.find((thread) => thread.id === onPart.json.id)!;
  expect(part.anchor).toMatchObject({
    path: "src/a.c",
    line: 4,
    message: {
      thread: draft.json.id,
      comment: draft.json.comments[0].id,
      quote: "the error path",
    },
  });
  const missing = await run(s, [
    "add",
    "--on-comment",
    draft.json.comments[0].id,
    "--quote",
    "not there",
    "x",
  ]);
  expect(missing.stderr).toContain("the quote is not in that comment");

  // Nothing waits on the agent yet, so watch blocks until the user asks.
  const watching = run(s, ["watch", "--timeout", "5"]);
  await Bun.sleep(200);
  const question = await s.service.addThread({
    sessionId,
    anchor: { path: "src/a.c", line: 9, side: "new" },
    text: "Why is this static?",
  });
  const woke = await watching;
  expect(woke.json.outcome).toBe("unanswered");
  expect(woke.json.threads.map((t: { id: string }) => t.id)).toEqual([
    question.id,
  ]);

  const answer = await run(s, [
    "reply",
    "--comment",
    question.id.slice(0, 5),
    "It",
    "is",
    "file-local",
  ]);
  expect(answer.json.comments.at(-1)).toMatchObject({
    author: "Claude",
    text: "It is file-local",
  });
  const resolved = await run(s, ["resolve", "--comment", question.id]);
  expect(resolved.json.resolved).toBe(true);
  const reopened = await run(s, ["reopen", "--comment", question.id]);
  expect(reopened.json.resolved).toBe(false);
  await run(s, ["resolve", "--comment", question.id]);

  const working = await run(s, ["working", "--message", "Fixing the leak"]);
  expect(working.json.agent.working.message).toBe("Fixing the leak");
  const onThread = await run(s, [
    "working",
    "--comment",
    question.id.slice(0, 5),
    "--message",
    "Making it static",
  ]);
  expect(onThread.json.agent.working).toMatchObject({
    message: "Making it static",
    threadId: question.id,
  });
  const listed = await run(s, ["list"]);
  expect(listed.json).toHaveLength(1);
  expect(listed.json[0].threads).toBe(3);
  // --all: every review of the connection, whatever the checkout.
  const all = await run(s, ["list", "--all"]);
  expect(all.json.map((each: { id: string }) => each.id)).toEqual(
    listed.json.map((each: { id: string }) => each.id),
  );
  // summary without text reads the overall comment.
  const summary = await run(s, ["summary"]);
  expect(summary.json).toEqual({ summary: "" });
});

test("an agent cannot rewrite the user's comment and gets a clear error", async () => {
  const s = setup();
  const opened = await run(s, ["open", "--worktree"]);
  const thread = await s.service.addThread({
    sessionId: opened.json.session.id,
    text: "Mine",
  });
  const edited = await run(s, ["edit", "--comment", thread.id, "Changed"]);
  expect(edited.code).toBe(1);
  expect(JSON.parse(edited.stderr).error).toContain("only edit its own");
});

test("a command before any review is opened says how to open one", async () => {
  const s = setup();
  const result = await run(s, ["get"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("roamgate-review open");
});

test(
  "a watch outlives the server's default idle timeout",
  async () => {
    const s = setup();
    await run(s, ["open", "--worktree"]);
    const started = Date.now();
    const result = await run(s, ["watch", "--timeout", "12"]);
    expect(result.code).toBe(0);
    expect(result.json.outcome).toBe("timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(11_500);
  },
  { timeout: 30_000 },
);

/** A raw request on the agent socket, as the client sends it. */
function post(s: Setup, command: string, body: string) {
  return fetch(`http://roamgate/v1/${command}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
    unix: s.agent.socketPath(LOCAL_SOCKET_KEY)!,
  } as RequestInit);
}

test("a pane of a Herdr server Roamgate is not connected to is refused", async () => {
  const s = setup();
  const opened = await run(s, ["open", "--worktree"], undefined, {
    ROAMGATE_REVIEW_AGENT: "Claude",
    HERDR_SOCKET_PATH: "/elsewhere/herdr.sock",
  });
  expect(opened.code).toBe(1);
  expect(opened.stderr).toContain("not one of Roamgate's connections");
  expect(s.service.list()).toHaveLength(0);
});

test("a pane naming its Herdr socket through a link reaches it", async () => {
  const dir = temp("rg-rev-");
  const home = temp("rg-home-");
  const herdr = join(dir, "herdr.sock");
  writeFileSync(herdr, "");
  const link = join(dir, "herdr-link.sock");
  symlinkSync(herdr, link);
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  const agent = createReviewAgentServer({
    service,
    directory: dir,
    home,
    connections: () => [
      {
        id: "local",
        herdrSocketPath: herdr,
        readRoot: async () => "/repo",
        readDefaultBase: async () => "origin/main",
      },
    ],
  });
  cleanups.push(() => {
    agent.stop();
    service.close();
  });
  const path = agent.listen(LOCAL_SOCKET_KEY);
  const list = (herdrSocket: string) =>
    fetch("http://roamgate/v1/list", {
      method: "POST",
      body: JSON.stringify({
        herdr_socket: herdrSocket,
        agent: "Claude",
        cwd: "/repo",
      }),
      unix: path,
    } as RequestInit);
  expect((await list(link)).status).toBe(200);
  expect((await list(join(dir, "other.sock"))).status).toBe(503);
});

test("a request larger than the limit is refused unread", async () => {
  const s = setup();
  const response = await post(
    s,
    "list",
    JSON.stringify({ text: "x".repeat(REVIEW_AGENT_MAX_BODY_BYTES + 1) }),
  );
  expect(response.status).toBe(413);
});

test("a conversation holder's log chunk may pass the agent limit", async () => {
  const s = setup();
  // A chunk with a line past a megabyte (a screenshot in a tool result):
  // read, not refused (no conversation mode here, so 503).
  const response = await post(
    s,
    "hold_output",
    JSON.stringify({
      pane: "w1:p1",
      holder_id: "a".repeat(32),
      offset: 0,
      end: 10,
      data: "x".repeat(REVIEW_AGENT_MAX_BODY_BYTES + 1),
    }),
  );
  expect(response.status).toBe(503);
  // Past its own limit it is refused unread too.
  const huge = await post(
    s,
    "hold_output",
    "x".repeat(HOLD_OUTPUT_MAX_BODY_BYTES + 1),
  );
  expect(huge.status).toBe(413);
});

test("watches on one review are capped", async () => {
  const s = setup();
  const opened = await run(s, ["open", "--worktree"]);
  const session = opened.json.session.id as string;
  const body = JSON.stringify({
    session,
    agent: "Claude",
    mode: "any",
    timeout: "30",
  });
  const controllers = Array.from(
    { length: REVIEW_AGENT_MAX_WATCHES },
    () => new AbortController(),
  );
  const watching = controllers.map((controller) =>
    fetch("http://roamgate/v1/watch", {
      method: "POST",
      body,
      signal: controller.signal,
      unix: s.agent.socketPath(LOCAL_SOCKET_KEY)!,
    } as RequestInit).catch(() => null),
  );
  await Bun.sleep(100);
  const refused = await post(s, "watch", body);
  expect(refused.status).toBe(429);
  for (const controller of controllers) controller.abort();
  await Promise.all(watching);
  // Ended watches free their place.
  await Bun.sleep(50);
  const again = await post(
    s,
    "watch",
    JSON.stringify({ session, agent: "Claude", timeout: "1", mode: "any" }),
  );
  expect(again.status).toBe(200);
});

test("stopping removes the well-known link only while it points here", () => {
  const s = setup();
  s.agent.stop();
  expect(() => lstatSync(s.socket)).toThrow();
  const other = setup();
  // Another bridge took the link over: stopping this one leaves it.
  rmSync(other.socket);
  symlinkSync("/somewhere/else.sock", other.socket);
  other.agent.stop();
  expect(readlinkSync(other.socket)).toBe("/somewhere/else.sock");
});

test("the well-known link is replaced in one step, no temp link left", () => {
  const s = setup();
  rmSync(s.socket);
  symlinkSync("/somewhere/old.sock", s.socket);
  s.agent.installLocal();
  expect(readlinkSync(s.socket)).toBe(s.agent.socketPath(LOCAL_SOCKET_KEY)!);
  expect(
    readdirSync(join(s.home, ".cache/roamgate")).filter((name) =>
      name.includes(".tmp"),
    ),
  ).toEqual([]);
});

test("unknown commands and bad JSON are refused", async () => {
  const s = setup();
  const response = await fetch("http://roamgate/v1/nope", {
    method: "POST",
    unix: s.agent.socketPath(LOCAL_SOCKET_KEY)!,
    body: "{",
  } as RequestInit);
  expect(response.status).toBe(400);
  expect(tmpdir()).toBeTruthy();
});

test("--compare opens a tree-to-tree review of two versions", async () => {
  const { parseTargetFlags } = await import("./agent-server");
  const noDefault = async () => "main";
  expect(
    await parseTargetFlags(
      new URLSearchParams({ compare: "topic-before..topic" }),
      noDefault,
    ),
  ).toEqual({
    kind: "range",
    base: "topic-before",
    head: "topic",
    compare: true,
  });
  expect(() =>
    parseTargetFlags(new URLSearchParams({ compare: "topic" }), noDefault),
  ).toThrow("--compare takes OLD NEW");
  // Versions are often named with dots.
  expect(
    await parseTargetFlags(
      new URLSearchParams({ compare: "v1.2..v1.3" }),
      noDefault,
    ),
  ).toEqual({ kind: "range", base: "v1.2", head: "v1.3", compare: true });
  expect(() =>
    parseTargetFlags(new URLSearchParams({ compare: "a..b..c" }), noDefault),
  ).toThrow("--compare takes OLD NEW");
});

test("an agent tells the user they need to act", async () => {
  const s = setup();
  notified.length = 0;
  const sent = await run(s, [
    "notify",
    "--title",
    "MR !12",
    "The reviewer asks for a test; I can add it, OK?",
  ]);
  expect(sent.json).toEqual({ notified: true });
  expect(notified).toEqual([
    {
      connectionId: "local",
      paneId: "w1:p2",
      agent: "Claude",
      title: "MR !12",
      text: "The reviewer asks for a test; I can add it, OK?",
    },
  ]);
  // Nothing to say, or outside a pane: refused.
  expect((await run(s, ["notify"])).code).not.toBe(0);
  expect(
    (await run(s, ["notify", "hi"], undefined, { HERDR_PANE_ID: "" })).code,
  ).not.toBe(0);
  expect(notified).toHaveLength(1);
});

test("a holder is never routed to another local connection's Herdr", async () => {
  const dir = temp("rg-rev-");
  const home = temp("rg-home-");
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  const held: string[] = [];
  const outputs: Record<string, unknown>[] = [];
  const agent = createReviewAgentServer({
    service,
    directory: dir,
    home,
    // The other local connection is reconnecting: only this one is ready.
    connections: () => [
      {
        id: "b",
        herdrSocketPath: "/b.sock",
        readRoot: async () => "/repo",
        readDefaultBase: async () => "origin/main",
      },
    ],
    holder: {
      hold: async ({ connectionId }) => {
        held.push(connectionId);
        return { action: "hold", session_id: "s" };
      },
      output: (input) => {
        outputs.push(input);
        return { offset: input.end };
      },
      handback: async ({ connectionId }) => {
        held.push(connectionId);
        return { action: "refused", reason: "no" };
      },
    },
  });
  cleanups.push(() => {
    agent.stop();
    service.close();
  });
  agent.installLocal();
  const post = (command: string, herdrSocket: string) =>
    fetch(`http://roamgate/v1/${command}`, {
      unix: join(home, ".cache/roamgate/review.sock"),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pane: "w1:p2",
        session: "s",
        herdr_socket: herdrSocket,
      }),
    } as RequestInit);
  const refused = await post("hold", "/a.sock");
  expect(refused.status).toBe(503);
  expect(await refused.json()).toEqual({
    error: "this pane's Herdr server is not one of Roamgate's connections",
  });
  expect((await post("handback", "/a.sock")).status).toBe(503);
  expect(held).toEqual([]);
  // Only its own socket reaches it, even as the only local connection.
  expect((await post("hold", "/b.sock")).status).toBe(200);
  expect((await post("hold", "/a.sock")).status).toBe(503);
  expect(held).toEqual(["b"]);
  // The holder's log goes the same way, offsets checked.
  const output = (offset: number, end: number) =>
    fetch("http://roamgate/v1/hold_output", {
      unix: join(home, ".cache/roamgate/review.sock"),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pane: "w1:p2",
        herdr_socket: "/b.sock",
        holder_id: "f".repeat(32),
        offset,
        end,
        data: '{"type":"x"}\n',
      }),
    } as RequestInit);
  const taken = await output(0, 13);
  expect(await taken.json()).toEqual({ offset: 13 });
  expect(outputs).toEqual([
    {
      connectionId: "b",
      paneId: "w1:p2",
      holderId: "f".repeat(32),
      offset: 0,
      end: 13,
      data: '{"type":"x"}\n',
    },
  ]);
  expect((await output(5, 2)).status).toBe(400);
});

test("an SSH connection named local has its own socket", async () => {
  // The desktop serving: its Herdr is the local connection "desktop", and
  // the Mac is the SSH connection that kept the id "local".
  const dir = temp("rg-rev-");
  const home = temp("rg-home-");
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  const held: string[] = [];
  const agent = createReviewAgentServer({
    service,
    directory: dir,
    home,
    connections: () => [
      {
        id: "desktop",
        herdrSocketPath: "/desktop/herdr.sock",
        readRoot: async () => "/repo",
        readDefaultBase: async () => "origin/main",
      },
      {
        id: "local",
        sshHost: "mac",
        readRoot: async () => "/repo",
        readDefaultBase: async () => "origin/main",
      },
    ],
    holder: {
      hold: async ({ connectionId }) => {
        held.push(connectionId);
        return { action: "hold", session_id: "s" };
      },
      output: (input) => ({ offset: input.end }),
      handback: async () => ({ action: "refused", reason: "no" }),
    },
  });
  cleanups.push(() => {
    agent.stop();
    service.close();
  });
  agent.installLocal();
  const remote = agent.listen("local");
  expect(remote).not.toBe(agent.socketPath(LOCAL_SOCKET_KEY));
  const hold = (unix: string, herdrSocket: string) =>
    fetch("http://roamgate/v1/hold", {
      unix,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pane: "w2:p14",
        session: "s",
        herdr_socket: herdrSocket,
      }),
    } as RequestInit);
  // A Mac pane, through the forward of the Mac's review.sock.
  expect(
    (await hold(remote, "/Users/me/.config/herdr/herdr.sock")).status,
  ).toBe(200);
  // A desktop pane, through the desktop's own link.
  const link = join(home, ".cache/roamgate/review.sock");
  expect((await hold(link, "/desktop/herdr.sock")).status).toBe(200);
  expect(held).toEqual(["local", "desktop"]);
  // Stopping the Mac's socket leaves the desktop's link in place.
  agent.stop("local");
  expect(readlinkSync(link)).toBe(agent.socketPath(LOCAL_SOCKET_KEY)!);
});

test("an agent's worktrees and workspaces go under its own workspace", async () => {
  const s = setup();
  placements.length = 0;
  const made = await run(s, [
    "worktree",
    "--branch",
    "up-ocio",
    "--repo",
    s.other,
  ]);
  expect(made.json).toEqual({ under: "w1" });
  const placed = await run(s, ["place", "--workspace-id", "w7"]);
  expect(placed.json).toEqual({ under: "w1" });
  const opened = await run(s, ["workspace", "--label", "notes"]);
  expect(opened.code).toBe(0);
  expect(placements).toEqual([
    {
      connectionId: "local",
      paneId: "w1:p2",
      workspaceId: "w1",
      command: "worktree",
      params: { branch: "up-ocio", repo: s.other, cwd: s.cwd },
    },
    {
      connectionId: "local",
      paneId: "w1:p2",
      workspaceId: "w1",
      command: "place",
      params: { workspace_id: "w7", cwd: s.cwd },
    },
    {
      connectionId: "local",
      paneId: "w1:p2",
      workspaceId: "w1",
      command: "workspace",
      params: { label: "notes", cwd: s.cwd },
    },
  ]);
  // place needs one of its targets, and all of them a pane.
  expect((await run(s, ["place"])).code).not.toBe(0);
  expect(
    (
      await run(s, ["place", "--path", s.other], undefined, {
        HERDR_PANE_ID: "",
      })
    ).code,
  ).not.toBe(0);
  expect(placements).toHaveLength(3);
});

test("an agent can name a group of the Workspaces tree, and list them", async () => {
  const s = setup();
  placements.length = 0;
  await run(s, [
    "worktree",
    "--branch",
    "pc",
    "--group",
    "gst/upstreaming",
    "--create-group",
  ]);
  await run(s, ["place", "--workspace-id", "w7", "--group", "gst > up"]);
  // groups needs no pane.
  const listed = await run(s, ["groups"], undefined, { HERDR_PANE_ID: "" });
  expect(listed.code).toBe(0);
  expect(placements).toEqual([
    {
      connectionId: "local",
      paneId: "w1:p2",
      workspaceId: "w1",
      command: "worktree",
      params: {
        branch: "pc",
        group: "gst/upstreaming",
        create_group: "1",
        cwd: s.cwd,
      },
    },
    {
      connectionId: "local",
      paneId: "w1:p2",
      workspaceId: "w1",
      command: "place",
      params: { workspace_id: "w7", group: "gst > up", cwd: s.cwd },
    },
    {
      connectionId: "local",
      paneId: "",
      workspaceId: "w1",
      command: "groups",
      params: { cwd: s.cwd },
    },
  ]);
});

test("a claude started in a pane reaches its own connection's claude start", async () => {
  const dir = temp("rg-rev-");
  const home = temp("rg-home-");
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  const started: Record<string, string>[] = [];
  const agent = createReviewAgentServer({
    service,
    directory: dir,
    home,
    connections: () => [
      {
        id: "b",
        herdrSocketPath: "/b.sock",
        readRoot: async () => "/repo",
        readDefaultBase: async () => "origin/main",
      },
    ],
    claudeStart: async (input) => {
      started.push(input);
      return { action: "conversation" };
    },
  });
  cleanups.push(() => {
    agent.stop();
    service.close();
  });
  agent.installLocal();
  const post = (body: Record<string, string>) =>
    fetch("http://roamgate/v1/claude_start", {
      unix: join(home, ".cache/roamgate/review.sock"),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    } as RequestInit);
  const session = "44444444-aaaa-bbbb-cccc-000000000000";
  const ok = await post({
    pane: "w1:p2",
    session,
    source: "startup",
    herdr_socket: "/b.sock",
  });
  expect(await ok.json()).toEqual({ action: "conversation" });
  expect(started).toEqual([
    {
      connectionId: "b",
      paneId: "w1:p2",
      sessionId: session,
      source: "startup",
    },
  ]);
  // Another Herdr's pane, a bad session id, no pane: nothing starts.
  expect(
    (await post({ pane: "w1:p2", session, herdr_socket: "/a.sock" })).status,
  ).toBe(503);
  expect(
    (await post({ pane: "w1:p2", session: "$(x)", herdr_socket: "/b.sock" }))
      .status,
  ).toBe(400);
  expect((await post({ session, herdr_socket: "/b.sock" })).status).toBe(400);
  expect(started).toHaveLength(1);
});

test("get lists the rendered file's threads in the code review, each with its own review", async () => {
  const s = setup();
  const opened = await run(s, ["open", "--worktree"]);
  const rendered = s.service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "rendered", path: "plan.md" },
    raise: false,
  }).session;
  const thread = await s.service.addThread({
    sessionId: rendered.id,
    anchor: { path: "plan.md", line: 2, side: "new" },
    text: "Decision 1: a or b?",
  });
  const got = await run(s, ["get", "--session", opened.json.session.id]);
  expect(got.code).toBe(0);
  const listed = got.json.threads.find(
    (each: { id: string }) => each.id === thread.id,
  );
  expect(listed?.session).toBe(rendered.id);
  expect(listed?.path).toBe("plan.md");
});

test("--last-step opens the review of the workspace's last step; none known says so", async () => {
  const before = "a".repeat(40);
  const after = "b".repeat(40);
  const asked: string[][] = [];
  const s = setup({
    readLastStep: async (root, workspaceId) => {
      asked.push([root, workspaceId]);
      return workspaceId === "w1"
        ? { kind: "step", step: "1763200000000-abcdef01", before, after }
        : null;
    },
  });
  const opened = await run(s, ["open", "--last-step"]);
  expect(opened.stderr).toBe("");
  expect(asked).toEqual([["/repo", "w1"]]);
  const { session } = s.service.get({ sessionId: opened.json.session.id });
  expect(session.target).toEqual({
    kind: "step",
    step: "1763200000000-abcdef01",
    before,
    after,
  });
  expect(session.automaticBase).toBeUndefined();
  // Opened again: the same review.
  const again = await run(s, ["open", "--last-step"]);
  expect(again.json.session.id).toBe(session.id);
  const none = await run(s, ["open", "--last-step"], undefined, {
    ROAMGATE_REVIEW_AGENT: "Claude",
    HERDR_WORKSPACE_ID: "w9",
  });
  expect(none.code).not.toBe(0);
  expect(none.stderr).toContain("no last step known here yet");
});

test("Changes switching scopes (reads with no review) leaves an agent's id-less get on the same review", async () => {
  const s = setup();
  const opened = await run(s, ["open"]);
  const sessionId = opened.json.session.id as string;
  const count = s.service.list().length;
  for (const target of [
    { kind: "worktree" },
    { kind: "range", base: "main", head: "HEAD" },
    {
      kind: "step",
      step: "1-a",
      before: "a".repeat(40),
      after: "b".repeat(40),
    },
  ])
    await s.service.previewDiff({
      connectionId: "local",
      root: "/repo",
      target,
    });
  expect(s.service.list().length).toBe(count);
  const got = await run(s, ["get"]);
  expect(got.stderr).toBe("");
  expect(got.json.session.id).toBe(sessionId);
});
