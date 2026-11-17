import { expect, test } from "bun:test";
import { handleReviewRpc } from "./rpc";
import { type ReviewService } from "./service";
import { reviewServiceForTest } from "./testkit";

function setup(): ReviewService {
  return reviewServiceForTest().service;
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

test("a relative path is refused; an empty one is the workspace's own", async () => {
  const service = setup();
  const asked: string[] = [];
  const reading = {
    ...local,
    readRoot: async (path: string) => {
      asked.push(path);
      return "/repo";
    },
  };
  await expect(
    handleReviewRpc(service, reading, "review.open", {
      workspace_id: "w1",
      path: "blog/public",
      target: { kind: "worktree" },
    }),
  ).rejects.toThrow("must be absolute");
  const opened = (await handleReviewRpc(service, reading, "review.open", {
    workspace_id: "w1",
    path: "",
    target: { kind: "worktree" },
  })) as { session: { root: string } };
  expect(opened.session.root).toBe("/repo");
  expect(asked).toEqual([]);
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

test("the page's list has the chats, so their threads survive a reload", async () => {
  const service = setup();
  await handleReviewRpc(service, local, "review.open", {
    workspace_id: "w1",
    target: { kind: "worktree" },
  });
  await handleReviewRpc(service, local, "review.open", {
    workspace_id: "w1",
    target: { kind: "chat", chat: "claude-session-1" },
  });
  const { sessions } = (await handleReviewRpc(
    service,
    local,
    "review.list",
    {},
  )) as { sessions: { session: { target: { kind: string } } }[] };
  expect(sessions.map((each) => each.session.target.kind).sort()).toEqual([
    "chat",
    "worktree",
  ]);
  // Agents listing the reviews of a checkout still do not see them.
  expect(service.list({ connectionId: "local" })).toHaveLength(1);
});

test("the browser finds a review's merge request on its own connection only", async () => {
  const { service } = reviewServiceForTest({
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

test("the merge request the user picked (Changes' card's remote) opens as is, whatever the branch's lookup finds", async () => {
  const { service } = reviewServiceForTest({
    gitlab: {
      context: () => {
        throw new Error("glab must not run");
      },
      checkout: async () => {
        throw new Error("the branch's own request is not looked up");
      },
      // The branch's lookup would find none.
      find: async () => null,
    },
  });
  const opened = (await handleReviewRpc(service, local, "review.open", {
    workspace_id: "w1",
    target: { kind: "worktree" },
  })) as { session: { id: string } };
  const fork = "https://gitlab.example/fork/p/-/merge_requests/7";
  const picked = (await handleReviewRpc(service, local, "review.gitlab.open", {
    session_id: opened.session.id,
    url: fork,
  })) as {
    mergeRequest: { url: string; number: number };
    snapshot: { session: Record<string, unknown> };
  };
  expect(picked.mergeRequest).toMatchObject({ url: fork, number: 7 });
  expect(picked.snapshot.session).toMatchObject({
    target: { kind: "mr", url: fork },
    workspaceId: "w1",
    gitlab: true,
  });
  await expect(
    handleReviewRpc(service, local, "review.gitlab.open", {
      session_id: opened.session.id,
      url: "http://gitlab.example/fork/p/-/merge_requests/7",
    }),
  ).rejects.toThrow("invalid merge request URL");
});

test("a page's storage write reaches the connection with its token, checked", async () => {
  const service = setup();
  const written: unknown[] = [];
  const withStorage = {
    ...local,
    renderedStorage: (token: string, write: unknown) => {
      written.push([token, write]);
      if ((write as { key?: string }).key === "full") {
        const error = new Error("full");
        error.name = "QuotaExceededError";
        throw error;
      }
      return true;
    },
  };
  expect(
    await handleReviewRpc(service, withStorage, "review.rendered.storage", {
      token: "t",
      write: { op: "set", key: "k", value: "v" },
    }),
  ).toEqual({ stored: true });
  expect(written).toEqual([["t", { op: "set", key: "k", value: "v" }]]);
  await expect(
    handleReviewRpc(service, withStorage, "review.rendered.storage", {
      token: "t",
      write: { op: "set", key: "", value: "v" },
    }),
  ).rejects.toThrow("invalid storage write");
  await expect(
    handleReviewRpc(service, withStorage, "review.rendered.storage", {
      token: "t",
      write: { op: "set", key: "full", value: "v" },
    }),
  ).rejects.toThrow("full");
  await expect(
    handleReviewRpc(service, local, "review.rendered.storage", {
      token: "t",
      write: { op: "clear" },
    }),
  ).rejects.toThrow("invalid storage write");
});

test("a rendered review's page comes from the connection, only for its own reviews", async () => {
  const service = setup();
  const asked: { root: string; target: unknown; page?: string }[] = [];
  const withPages = {
    ...local,
    renderedPage: async (
      session: { root: string; target: unknown },
      page?: string,
    ) => {
      asked.push({ root: session.root, target: session.target, page });
      return { src: "/rendered/x/index.html", mode: "static" as const };
    },
  };
  const worktree = (await handleReviewRpc(service, withPages, "review.open", {
    workspace_id: "w1",
    target: { kind: "worktree" },
  })) as { session: { id: string } };
  await expect(
    handleReviewRpc(service, withPages, "review.rendered.page", {
      session_id: worktree.session.id,
    }),
  ).rejects.toThrow("not a rendered review");
  const rendered = (await handleReviewRpc(service, withPages, "review.open", {
    workspace_id: "w1",
    target: { kind: "rendered", path: "docs/index.html" },
  })) as { session: { id: string } };
  expect(
    await handleReviewRpc(service, withPages, "review.rendered.page", {
      session_id: rendered.session.id,
      page: "other.html",
    }),
  ).toEqual({ src: "/rendered/x/index.html", mode: "static" });
  expect(asked).toEqual([
    {
      root: "/repo",
      target: { kind: "rendered", path: "docs/index.html" },
      page: "other.html",
    },
  ]);
  await expect(
    handleReviewRpc(
      service,
      { ...remote, renderedPage: withPages.renderedPage },
      "review.rendered.page",
      {
        session_id: rendered.session.id,
      },
    ),
  ).rejects.toThrow("no such review");
  await expect(
    handleReviewRpc(service, withPages, "review.rendered.page", {
      session_id: rendered.session.id,
      page: 5,
    }),
  ).rejects.toThrow("invalid page");
});

test("no review method submits, publishes, resolves or posts on a forge: drafts only", async () => {
  const service = setup();
  for (const method of [
    "review.gitlab.submit",
    "review.gitlab.publish",
    "review.gitlab.send",
    "review.gitlab.resolve",
    "review.gitlab.reply",
    "review.github.submit",
    "review.github.publish",
    "review.github.resolve",
    "review.forge.submit",
    "review.forge.publish",
    "review.submit",
    "review.publish",
    "review.send",
  ])
    await expect(
      handleReviewRpc(service, local, method, { session_id: "x" }),
    ).rejects.toThrow(/unknown review method/);
});
