import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import { resolveDefaultBase } from "../workspace/diff-base";
import { readDefaultBase, readReviewHeads } from "../workspace/review-patch";
import { createReviewAgentServer } from "./agent-server";
import { handleReviewRpc } from "./rpc";
import { reviewServiceForTest } from "./testkit";

/**
 * Which review the branch's three ways in land on: the agent's `open`
 * with no target, Option+R (the
 * browser's `review.open` without a target) and a comment written in
 * Changes' Branch scope (`review.open` with the checkout's path, as
 * workspaceFeedback's route sends it). Against a real repository, with the
 * real default base lookup and the real Branch scope base selection: one
 * resolution, the newer of the local default branch and its remote.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function temp(prefix: string) {
  // Short paths: unix sockets are limited to about 100 bytes.
  const path = realpathSync(mkdtempSync(join(realpathSync("/tmp"), prefix)));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

/**
 * A clone of a repository whose default branch is main (origin/HEAD set),
 * a local main, a branch `other` to compare against, and `topic` checked
 * out with a commit of its own.
 */
function repository() {
  const upstream = temp("rg-up-");
  git(upstream, "init", "-q", "-b", "main");
  git(upstream, "commit", "-q", "--allow-empty", "-m", "first");
  git(upstream, "branch", "other");
  const root = join(temp("rg-clone-"), "repo");
  git("/tmp", "clone", "-q", upstream, root);
  git(root, "branch", "other", "origin/other");
  git(root, "checkout", "-q", "-b", "topic");
  git(root, "commit", "-q", "--allow-empty", "-m", "topic work");
  return { root, upstream };
}

/** The Branch scope's base under Automatic, as Changes resolves it. */
async function branchScopeBase(root: string) {
  return (
    await resolveDefaultBase({ root, shQuote, runProcessWithCodeTimeout })
  ).base;
}

function setup(root: string) {
  const dir = temp("rg-rb-");
  const home = temp("rg-rbh-");
  const { service } = reviewServiceForTest({
    dir,
    loadHeads: (_connection, entries) =>
      readReviewHeads({ entries, shQuote, runProcessWithCodeTimeout }),
  });
  const defaultBase = (path: string) =>
    readDefaultBase({ root: path, shQuote, runProcessWithCodeTimeout });
  const agent = createReviewAgentServer({
    service,
    directory: dir,
    home,
    connections: () => [
      {
        id: "local",
        herdrSocketPath: "/herdr.sock",
        readRoot: async () => root,
        readDefaultBase: defaultBase,
      },
    ],
  });
  cleanups.push(() => {
    agent.stop();
    service.close();
  });
  agent.installLocal();
  const connection = {
    id: "local",
    resolveRoot: async () => root,
    readRoot: async () => root,
    readDefaultBase: defaultBase,
  };
  const client = join(home, ".cache/roamgate/bin/roamgate-review");
  /** The agent's review client, run in the checkout. */
  const agentOpen = async (...args: string[]) => {
    const proc = Bun.spawn(["python3", client, "open", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        HERDR_PANE_ID: "w1:p2",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_SOCKET_PATH: "/herdr.sock",
        ROAMGATE_REVIEW_AGENT: "Claude",
      },
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (code !== 0) throw new Error(stderr);
    return JSON.parse(stdout) as {
      session: { id: string; target: unknown };
    };
  };
  /** Option+R: the browser opens the workspace's review, no target. */
  const optionR = async () =>
    (await handleReviewRpc(service, connection, "review.open", {
      workspace_id: "w1",
      agent_pane: "w1:p2",
      agent: "Claude",
    })) as { session: { id: string; target: unknown } };
  /**
   * A comment in Changes' Branch scope: workspaceFeedback's route opens
   * the checkout's path with no target, then adds the thread there.
   */
  const branchComment = async (text: string, picked?: string) => {
    const opened = (await handleReviewRpc(service, connection, "review.open", {
      workspace_id: "w1",
      path: root,
      ...(picked
        ? { target: { kind: "range", base: picked, head: "HEAD" } }
        : {}),
    })) as { session: { id: string; target: unknown } };
    await handleReviewRpc(service, connection, "review.thread.add", {
      session_id: opened.session.id,
      anchor: { path: "a.ts", line: 1, side: "new", feedback: "diff" },
      text,
    });
    return opened;
  };
  return { service, agentOpen, optionR, branchComment };
}

test("review_open with no target, Option+R and a Branch-scope comment land on the same review", async () => {
  const { root } = repository();
  const { service, agentOpen, optionR, branchComment } = setup(root);
  const byAgent = await agentOpen();
  const byKey = await optionR();
  const byComment = await branchComment("Why?");
  // One review of the branch against the remote's default branch.
  const targetOf = (id: string) =>
    service.get({ sessionId: id }).session.target;
  // The agent is told the range it opened, as text.
  expect(byAgent.session.target).toBe("origin/main..HEAD");
  expect(targetOf(byAgent.session.id)).toEqual({
    kind: "range",
    base: "origin/main",
    head: "HEAD",
  });
  expect(byKey.session.id).toBe(byAgent.session.id);
  expect(byComment.session.id).toBe(byAgent.session.id);
  expect(
    service
      .get({ sessionId: byAgent.session.id })
      .threads.map((thread) => thread.comments[0]?.body),
  ).toEqual(["Why?"]);
  // Changes' Branch scope draws against the same base: local main
  // and origin/main are the same commit, so the remote one.
  expect(await branchScopeBase(root)).toBe("refs/remotes/origin/main");
});

test("a comment under a picked Compare against base lands in that base's review", async () => {
  const { root } = repository();
  const { service, agentOpen, optionR, branchComment } = setup(root);
  // That base's review exists (the agent opened it).
  const picked = await agentOpen("--range", "other..HEAD");
  expect(picked.session.target).toBe("other..HEAD");
  // The comment carries the picked base (workspaceFeedback's route).
  const byComment = await branchComment("On the picked base", "other");
  expect(byComment.session.id).toBe(picked.session.id);
  expect(
    service
      .get({ sessionId: picked.session.id })
      .threads.map((thread) => thread.comments[0]?.body),
  ).toEqual(["On the picked base"]);
  // The default base's review is another, and Automatic never moves the
  // picked one.
  const byKey = await optionR();
  expect(byKey.session.id).not.toBe(picked.session.id);
  expect(byKey.session.target).toEqual({
    kind: "range",
    base: "origin/main",
    head: "HEAD",
  });
  expect(service.get({ sessionId: byKey.session.id }).threads).toEqual([]);
});

test("a stale local main: Changes and the review both compare with origin/main", async () => {
  const { root, upstream } = repository();
  git(upstream, "commit", "-q", "--allow-empty", "-m", "upstream moves on");
  git(root, "fetch", "-q");
  // The branch is rebased on origin/main; local main stays behind.
  git(root, "rebase", "-q", "origin/main");
  expect(git(root, "rev-list", "--count", "main..origin/main").trim()).toBe(
    "1",
  );
  const { optionR } = setup(root);
  expect(await branchScopeBase(root)).toBe("refs/remotes/origin/main");
  expect((await optionR()).session.target).toEqual({
    kind: "range",
    base: "origin/main",
    head: "HEAD",
  });
});

test("a local main ahead of origin/main: Changes and the review both compare with main", async () => {
  const { root } = repository();
  git(root, "checkout", "-q", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "not pushed yet");
  git(root, "checkout", "-q", "topic");
  git(root, "rebase", "-q", "main");
  const { optionR } = setup(root);
  expect(await branchScopeBase(root)).toBe("refs/heads/main");
  expect((await optionR()).session.target).toEqual({
    kind: "range",
    base: "main",
    head: "HEAD",
  });
  // On main itself, main..HEAD would be empty: its unpushed work is
  // compared with origin/main.
  git(root, "checkout", "-q", "main");
  expect(await branchScopeBase(root)).toBe("refs/remotes/origin/main");
});

test("local main and origin/main diverged: the one whose merge-base with HEAD is newest", async () => {
  const { root, upstream } = repository();
  git(upstream, "commit", "-q", "--allow-empty", "-m", "upstream moves on");
  git(root, "fetch", "-q");
  git(root, "checkout", "-q", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "local only");
  // Branched from origin/main: origin/main.
  git(root, "checkout", "-q", "-b", "from-remote", "origin/main");
  git(root, "commit", "-q", "--allow-empty", "-m", "work");
  expect(await branchScopeBase(root)).toBe("refs/remotes/origin/main");
  // Branched from the local main: main.
  git(root, "checkout", "-q", "-b", "from-local", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "work");
  expect(await branchScopeBase(root)).toBe("refs/heads/main");
});

test("when Automatic's base moves, the branch's review follows it with its comments", async () => {
  const { root } = repository();
  const { service, optionR, branchComment } = setup(root);
  const before = await branchComment("Kept?");
  expect(before.session.target).toEqual({
    kind: "range",
    base: "origin/main",
    head: "HEAD",
  });
  // The local main gets ahead and the branch moves onto it.
  git(root, "checkout", "-q", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "not pushed yet");
  git(root, "checkout", "-q", "topic");
  git(root, "rebase", "-q", "main");
  const after = await optionR();
  // The same review, now against main, its comment still there.
  expect(after.session.id).toBe(before.session.id);
  const now = service.get({ sessionId: after.session.id });
  expect(now.session.target).toEqual({
    kind: "range",
    base: "main",
    head: "HEAD",
  });
  expect(now.session.title).toBe("main..HEAD");
  expect(now.threads.map((thread) => thread.comments[0]?.body)).toEqual([
    "Kept?",
  ]);
  expect(service.list({ root }).length).toBe(1);
});

/**
 * A remote whose HEAD names Entire's metadata branch (an orphan
 * "Initialize metadata branch"), as `git remote set-head` can leave it.
 */
function entireRepository() {
  const { root, upstream } = repository();
  git(upstream, "checkout", "-q", "--orphan", "entire/checkpoints/v1");
  git(
    upstream,
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "Initialize metadata branch",
  );
  git(upstream, "checkout", "-q", "main");
  git(root, "fetch", "-q");
  git(root, "remote", "set-head", "origin", "entire/checkpoints/v1");
  return { root, upstream };
}

test("a remote HEAD naming Entire's checkpoints is no base: the default branch is", async () => {
  const { root } = entireRepository();
  expect(git(root, "symbolic-ref", "refs/remotes/origin/HEAD").trim()).toBe(
    "refs/remotes/origin/entire/checkpoints/v1",
  );
  const { agentOpen, optionR } = setup(root);
  expect(await branchScopeBase(root)).toBe("refs/remotes/origin/main");
  expect((await optionR()).session.target).toEqual({
    kind: "range",
    base: "origin/main",
    head: "HEAD",
  });
  expect((await agentOpen()).session.target).toBe("origin/main..HEAD");
});

test("a branch's review once based on a metadata ref follows Automatic to the default branch", async () => {
  const { root } = entireRepository();
  const { service, branchComment } = setup(root);
  // Opened before: Automatic took the remote HEAD's metadata branch.
  const before = service.open({
    connectionId: "local",
    workspaceId: "w1",
    root,
    target: {
      kind: "range",
      base: "origin/entire/checkpoints/v1",
      head: "HEAD",
    },
    automatic: true,
  });
  service.addThread({
    sessionId: before.session.id,
    anchor: { path: "a.ts", line: 1, side: "new" },
    text: "Written then",
  });
  const after = await branchComment("Written now");
  expect(after.session.id).toBe(before.session.id);
  const now = service.get({ sessionId: before.session.id });
  expect(now.session.target).toEqual({
    kind: "range",
    base: "origin/main",
    head: "HEAD",
  });
  expect(now.threads.map((thread) => thread.comments[0]?.body)).toEqual([
    "Written then",
    "Written now",
  ]);
  expect(service.list({ root }).length).toBe(1);
});

test("an agent's range of the checked-out branch joins the Branch scope's review", async () => {
  const { root } = repository();
  const { service, agentOpen, branchComment } = setup(root);
  const branch = await branchComment("On the branch");
  // The agent names the branch and its base itself.
  const byAgent = await agentOpen("--range", "main..topic");
  expect(byAgent.session.id).toBe(branch.session.id);
  expect(service.list({ root }).length).toBe(1);
  // Another range is another review, and one kept is kept.
  git(root, "branch", "older", "HEAD~1");
  const other = await agentOpen("--range", "main..older");
  expect(other.session.id).not.toBe(branch.session.id);
  expect((await agentOpen("--range", "main..older")).session.id).toBe(
    other.session.id,
  );
});
