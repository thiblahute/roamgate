import { afterEach, expect, test } from "bun:test";
import {
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
  LOCAL_SOCKET_KEY,
  REVIEW_AGENT_MAX_BODY_BYTES,
  REVIEW_AGENT_MAX_WATCHES,
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

function setup(): Setup {
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
      },
    ],
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
  expect(listed.json[0].threads).toBe(2);
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
