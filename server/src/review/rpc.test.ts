import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleReviewRpc } from "./rpc";
import { createReviewService, type ReviewService } from "./service";
import { openReviewStorage } from "./storage";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(): ReviewService {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-rpc-"));
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  cleanups.push(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return service;
}

const local = { id: "local", resolveRoot: async () => "/repo" };
const remote = { id: "remote", resolveRoot: async () => "/srv/repo" };

test("the browser opens by workspace and always writes as the user", async () => {
  const service = setup();
  const opened = (await handleReviewRpc(service, local, "review.open", {
    workspace_id: "w1",
    target: { kind: "worktree" },
  })) as { session: { id: string; root: string } };
  expect(opened.session.root).toBe("/repo");
  const thread = (await handleReviewRpc(service, local, "review.thread.add", {
    session_id: opened.session.id,
    author: "Claude",
    text: "Spoofed?",
  })) as { comments: { author: string }[] };
  expect(thread.comments[0]!.author).toBe("you");
});

test("a review is invisible from another connection", async () => {
  const service = setup();
  const opened = (await handleReviewRpc(service, local, "review.open", {
    workspace_id: "w1",
    target: { kind: "worktree" },
  })) as { session: { id: string } };
  await expect(
    handleReviewRpc(service, remote, "review.get", {
      session_id: opened.session.id,
    }),
  ).rejects.toThrow("no such review");
  expect(
    (
      (await handleReviewRpc(service, remote, "review.list", {})) as {
        sessions: unknown[];
      }
    ).sessions,
  ).toHaveLength(0);
});

test("the browser finds a review's merge request on its own connection only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-rpc-"));
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
    gitlab: {
      context: () => {
        throw new Error("glab must not run");
      },
      checkout: async () => ({
        branch: "four",
        head: "a1",
        defaultBranch: "main",
        remoteHeads: {},
        upstream: null,
        pushRemote: null,
        remotes: {},
        gitlabHost: "gitlab.example",
        gitlabLogins: [],
      }),
      find: async () => ({
        url: "https://gitlab.example/g/p/-/merge_requests/4",
        title: "Four",
        number: 4,
        state: "opened",
        branch: "four",
      }),
    },
  });
  cleanups.push(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const opened = (await handleReviewRpc(service, local, "review.open", {
    workspace_id: "w1",
    target: { kind: "worktree" },
  })) as { session: { id: string } };
  expect(
    await handleReviewRpc(service, local, "review.gitlab.find", {
      session_id: opened.session.id,
    }),
  ).toEqual({
    mergeRequest: {
      url: "https://gitlab.example/g/p/-/merge_requests/4",
      title: "Four",
      number: 4,
    },
  });
  await expect(
    handleReviewRpc(service, remote, "review.gitlab.find", {
      session_id: opened.session.id,
    }),
  ).rejects.toThrow("no such review");
  // GitLab: the merge request's own review, in the same workspace.
  const gitlab = (await handleReviewRpc(service, local, "review.gitlab.open", {
    session_id: opened.session.id,
  })) as { snapshot: { session: Record<string, unknown> } };
  expect(gitlab.snapshot.session).toMatchObject({
    target: {
      kind: "mr",
      url: "https://gitlab.example/g/p/-/merge_requests/4",
    },
    workspaceId: "w1",
    gitlab: true,
  });
  await expect(
    handleReviewRpc(service, remote, "review.gitlab.open", {
      session_id: opened.session.id,
    }),
  ).rejects.toThrow("no such review");
});
