import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import { selectDiffBase } from "../workspace/diff-base";
import { readDefaultBase } from "../workspace/review-patch";
import { createReviewAgentServer } from "./agent-server";
import { handleReviewRpc } from "./rpc";
import { createReviewService } from "./service";
import { openReviewStorage } from "./storage";

/**
 * Which review the branch's three ways in land on (plan: review into the
 * inspector, D12): the agent's `open` with no target, Option+R (the
 * browser's `review.open` without a target) and a comment written in
 * Changes' Branch scope (`review.open` with the checkout's path, as
 * workspaceFeedback's route sends it). Against a real repository, with the
 * real default base lookup and the real Branch scope base selection.
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
  return root;
}

/** The Branch scope's base, as Changes resolves it (git-diff.ts). */
function branchScopeBase(root: string, requested?: string) {
  const refs = git(
    root,
    "for-each-ref",
    "--format=%(refname)%09%(symref)",
    "refs/heads/",
    "refs/remotes/",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", symbolic] = line.split("\t");
      return { name, symbolic: symbolic || undefined };
    });
  return selectDiffBase(refs, "", requested).base;
}

function setup(root: string) {
  const dir = temp("rg-rb-");
  const home = temp("rg-rbh-");
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
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
  const branchComment = async (text: string) => {
    const opened = (await handleReviewRpc(service, connection, "review.open", {
      workspace_id: "w1",
      path: root,
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
  const root = repository();
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
  // Today Changes' Branch scope draws the diff against the local branch
  // its remote HEAD names, not the remote ref the review compares with
  // (D12: two base resolutions).
  expect(branchScopeBase(root)).toBe("refs/heads/main");
});

test("a comment under a picked Compare against base lands in the default base's review, not that base's (today)", async () => {
  const root = repository();
  const { service, agentOpen, branchComment } = setup(root);
  // The Branch scope compares against the branch picked.
  expect(branchScopeBase(root, "other")).toBe("refs/heads/other");
  // That base's review exists (the agent opened it).
  const picked = await agentOpen("--range", "other..HEAD");
  expect(picked.session.target).toBe("other..HEAD");
  expect(service.get({ sessionId: picked.session.id }).session.target).toEqual({
    kind: "range",
    base: "other",
    head: "HEAD",
  });
  // The comment carries no base: it goes to the default base's review.
  const byComment = await branchComment("On the picked base");
  expect(byComment.session.id).not.toBe(picked.session.id);
  expect(byComment.session.target).toEqual({
    kind: "range",
    base: "origin/main",
    head: "HEAD",
  });
  expect(service.get({ sessionId: picked.session.id }).threads).toEqual([]);
});
