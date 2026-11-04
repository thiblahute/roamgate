import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMrReviews } from "./module";
import { openMrStore } from "./store";

test("a closed request's review is dropped after the retention days", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-mod-"));
  try {
    const store = openMrStore(join(dir, "state.json"));
    const old = new Date(Date.now() - 4 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    store.update((state) => {
      state.reviews.a = { connectionId: "c", sessionId: "sa", closedAt: old };
      state.reviews.b = {
        connectionId: "c",
        sessionId: "sb",
        closedAt: recent,
      };
      state.reviews.c = { connectionId: "c", sessionId: "sc" };
      state.seen.a = { at: old, updatedAt: old, headSha: "x", notes: 0 };
      state.projects.p = {
        connectionId: "c",
        clone: "/x",
        worktree: "/x.worktrees/review",
      };
    });
    const removed: string[] = [];
    const reviews = createMrReviews({
      run: async () => ({ code: 1, stdout: "", stderr: "" }),
      store,
      readSettings: async () => ({ mr_reviews: { retention_days: 3 } }) as any,
      discoverHosts: () => [],
      removeReview: (id) => removed.push(id),
    });
    await reviews.lifecycle();
    expect(removed).toEqual(["sa"]);
    expect(Object.keys(store.get().reviews).sort()).toEqual(["b", "c"]);
    expect(store.get().seen.a).toBeUndefined();
    // The project's review worktree stays.
    expect(store.get().projects.p).toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forgetting a review worktree keeps the reviews and their Claude sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-mod-"));
  try {
    const store = openMrStore(join(dir, "state.json"));
    store.update((state) => {
      state.projects["h/g/p"] = {
        connectionId: "local",
        clone: "/x",
        worktree: "/x.worktrees/review",
      };
      state.reviews["gitlab:h/g/p#1"] = {
        connectionId: "local",
        sessionId: "s",
        claudeSession: "c",
      };
      state.prefetched["gitlab:h/g/p#1"] = "abc";
    });
    const reviews = createMrReviews({
      run: async () => ({ code: 1, stdout: "", stderr: "" }),
      store,
      readSettings: async () => ({}) as any,
      discoverHosts: () => [],
    });
    const result = (await reviews.handle("bridge.mr_reviews.forget_worktree", {
      project: "H/G/P",
    })) as any;
    expect(result.forgotten.worktree).toBe("/x.worktrees/review");
    expect(store.get().projects).toEqual({});
    expect(store.get().prefetched).toEqual({});
    expect(store.get().reviews["gitlab:h/g/p#1"]).toMatchObject({
      claudeSession: "c",
    });
    await expect(
      reviews.handle("bridge.mr_reviews.forget_worktree", { project: "h/g/p" }),
    ).rejects.toThrow(/no review worktree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the review pane's agent review, with no agent pane: the request's Claude starts and reviews", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-mod-"));
  try {
    const store = openMrStore(join(dir, "state.json"));
    store.update((state) => {
      state.items = [
        {
          provider: "gitlab",
          host: "h",
          project: "g/p",
          number: 1,
          key: "gitlab:h/g/p#1",
          url: "https://h/g/p/-/merge_requests/1",
          title: "t",
          author: "a",
          draft: false,
          state: "open",
          updatedAt: "2026-11-04T00:00:00Z",
          headSha: "a".repeat(40),
          sourceBranch: "x",
          targetBranch: "main",
          pipeline: null,
          notes: 0,
          reasons: ["assigned"],
        },
      ];
      state.projects["h/g/p"] = {
        connectionId: "c",
        clone: "/x",
        worktree: "/x.worktrees/review",
        workspaceId: "w1",
      };
      state.reviews["gitlab:h/g/p#1"] = {
        connectionId: "c",
        sessionId: "rev1",
        workspaceId: "w1",
      };
    });
    let paneAgent: string | null = null;
    const typed: string[] = [];
    const reviewsAsked: unknown[] = [];
    const reviews = createMrReviews({
      run: async () => ({ code: 1, stdout: "", stderr: "" }),
      store,
      readSettings: async () => ({ claude_start_mode: "conversation" }) as any,
      discoverHosts: () => [],
      requestReview: async (params) => {
        reviewsAsked.push(params);
      },
      connections: () => [
        {
          id: "c",
          label: "C",
          run: async () => ({ code: 0, stdout: "", stderr: "" }),
          dirs: async () => [],
          herdr: async (method, params: any) => {
            if (method === "pane.list")
              return { panes: [{ pane_id: "w1:p1", workspace_id: "w1" }] };
            if (method === "agent.get") {
              if (!paneAgent) throw new Error("agent_not_found");
              return {
                agent: {
                  agent: "claude",
                  agent_status: "idle",
                  agent_session: { value: paneAgent },
                },
              };
            }
            if (method === "pane.send_text") {
              typed.push(params.text);
              paneAgent =
                /--session-id ([0-9a-f-]{36})/.exec(params.text)?.[1] ?? null;
            }
            return {};
          },
        },
      ],
    });
    // The workspace's pane is a bare shell: no agent pane.
    const state = (await reviews.handle("bridge.mr_reviews.claude", {
      session_id: "rev1",
      action: "review",
    })) as any;
    expect(state.state).toBe("ready");
    // Started in the claude start setting's mode (conversation: no opt-out).
    expect(typed).toHaveLength(1);
    expect(typed[0]).not.toContain("ROAMGATE_CLAUDE_START=terminal");
    expect(reviewsAsked).toEqual([{ sessionId: "rev1", paneId: "w1:p1" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the sidebar learns each review workspace and the request it is on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-mod-"));
  try {
    const store = openMrStore(join(dir, "state.json"));
    store.update((state) => {
      state.items = [
        {
          provider: "gitlab",
          host: "h",
          project: "g/p",
          number: 12846,
          key: "k",
          url: "https://h/g/p/-/merge_requests/12846",
          title: "pitch: Predictable output",
          author: "a",
          draft: false,
          state: "open",
          updatedAt: "t",
          headSha: "a".repeat(40),
          sourceBranch: "x",
          targetBranch: "main",
          pipeline: null,
          notes: 0,
          reasons: [],
        },
      ];
      state.projects["h/g/p"] = {
        connectionId: "desktop",
        clone: "/x",
        worktree: "/x.worktrees/review",
        workspaceId: "w7",
        checkedOut: "k",
      };
    });
    const reviews = createMrReviews({
      run: async () => ({ code: 1, stdout: "", stderr: "" }),
      store,
      readSettings: async () => ({}) as any,
      discoverHosts: () => [],
    });
    expect(await reviews.handle("bridge.mr_reviews.workspaces", {})).toEqual({
      workspaces: [
        {
          connectionId: "desktop",
          workspaceId: "w7",
          project: "h/g/p",
          current: {
            key: "k",
            label: "!12846 pitch: Predictable output",
            url: "https://h/g/p/-/merge_requests/12846",
          },
        },
      ],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
