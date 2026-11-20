import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MR_HOME_PROMPT,
  type MrItem,
  mrHomeLinks,
} from "../../../shared/mrReviews";
import type { MrConnection } from "./clones";
import {
  createMrHomes,
  homeBranchName,
  homeLabel,
  homePromptFor,
  parseHomeRoot,
} from "./home";
import { openMrStore } from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const item = (extra: Partial<MrItem> = {}): MrItem => ({
  provider: "gitlab",
  host: "gitlab.example.org",
  project: "gstreamer/gstreamer",
  number: 3326,
  key: "gitlab:gitlab.example.org/gstreamer/gstreamer#3326",
  url: "https://gitlab.example.org/gstreamer/gstreamer/-/merge_requests/3326",
  title: "rtpgccbwe: Fix the estimate when packets are lost in bursts of many",
  author: "alice",
  draft: false,
  state: "open",
  updatedAt: new Date().toISOString(),
  headSha: "abc1234",
  sourceBranch: "gcc-fix",
  targetBranch: "main",
  pipeline: null,
  notes: 0,
  reasons: ["review_requested"],
  ...extra,
});

/**
 * A connection whose shell and Herdr are fakes: the scripts answer by what
 * they do, Herdr keeps workspaces and panes, and the pane's agent becomes an
 * idle Claude a moment after `claude` is typed.
 */
function fakeConnection(options: { conversation?: boolean } = {}) {
  const scripts: string[] = [];
  const herdrCalls: [string, Record<string, unknown>][] = [];
  const workspaces: Record<string, unknown>[] = [
    // Herdr's list gives no folder here: its pane does.
    { workspace_id: "w-clone", label: "gstreamer" },
    {
      workspace_id: "w-review",
      label: "Reviews · gstreamer",
      cwd: "/src/gstreamer.worktrees/review",
    },
  ];
  const panes: Record<string, unknown>[] = [
    { pane_id: "p-review", workspace_id: "w-review" },
    { pane_id: "p-clone", workspace_id: "w-clone", cwd: "/src/gstreamer/" },
  ];
  let agent: { agent: string; agent_status: string } | null = null;
  let held: string | null = null;
  const prompted: string[] = [];
  const conn: MrConnection = {
    id: "local",
    label: "Desktop",
    dirs: async () => [],
    run: async (script) => {
      scripts.push(script);
      if (script.includes("show-ref --verify"))
        return { code: 0, stdout: "NAME gcc-fix\n", stderr: "" };
      if (script.includes("reset -q --keep"))
        return { code: 0, stdout: "AT abc1234\n", stderr: "" };
      // The clone is a checkout: its worktrees start from it.
      if (script.includes('printf "TOP'))
        return { code: 0, stdout: "TOP\t/src/gstreamer\n", stderr: "" };
      if (script.includes("rev-parse --show-toplevel")) {
        const dir = /cd '([^']+)'/.exec(script)?.[1] ?? "";
        return {
          code: 0,
          stdout: `T\t${dir}\nR\torigin\tgit@gitlab.example.org:gstreamer/gstreamer.git\nR\tmine\tgit@gitlab.example.org:me/gstreamer.git\n`,
          stderr: "",
        };
      }
      if (script.includes("git fetch") || script.includes("cat-file -e"))
        return { code: 0, stdout: "HAVE 3326\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    herdr: async (method, params = {}) => {
      herdrCalls.push([method, params]);
      if (method === "workspace.list") return { workspaces };
      if (method === "pane.list") return { panes };
      if (method === "workspace.rename") {
        const found = workspaces.find(
          (each) => each.workspace_id === params.workspace_id,
        );
        if (found) found.label = params.label;
        return {};
      }
      if (method === "agent.get") return { agent };
      if (method === "pane.send_text") {
        const text = String(params.text);
        if (text.includes("--session-id")) {
          const session = /--session-id (\S+)/.exec(text)![1]!;
          if (options.conversation) held = session;
          else agent = { agent: "claude", agent_status: "unknown" };
          // Ready a moment later (its start, a trust question).
          setTimeout(() => {
            if (!options.conversation)
              agent = { agent: "claude", agent_status: "idle" };
          }, 5);
        }
        return {};
      }
      if (method === "agent.prompt") {
        prompted.push(String(params.text));
        return {};
      }
      return {};
    },
    ...(options.conversation
      ? {
          conversation: {
            owned: () => held,
            switch: async () => ({ ok: true as const }),
            prompt: async (_pane: string, text: string) => {
              if (!held) return false;
              prompted.push(text);
              return true;
            },
          },
        }
      : {}),
  };
  return { conn, scripts, herdrCalls, workspaces, panes, prompted };
}

function setup(options: { conversation?: boolean; homePrompt?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mr-home-"));
  dirs.push(dir);
  const store = openMrStore(join(dir, "state.json"));
  const fake = fakeConnection(options);
  const made: { connectionId: string; workspaceId: string; branch: string }[] =
    [];
  const placed: Record<string, unknown>[] = [];
  const reviews: Record<string, unknown>[] = [];
  const seen: string[] = [];
  const request = item();
  const homes = createMrHomes({
    item: (key) => {
      if (key !== request.key) throw new Error("no such request");
      return request;
    },
    store,
    connections: () => [fake.conn],
    settings: async () => ({ homePrompt: options.homePrompt ?? "" }),
    project: async () => ({
      conn: fake.conn,
      record: {
        connectionId: "local",
        clone: "/src/gstreamer",
        worktree: "/src/gstreamer.worktrees/review",
        workspaceId: "w-review",
        remote: "origin",
      },
    }),
    createWorktree: async (input) => {
      made.push(input);
      const path = `/home/u/.herdr/worktrees/gstreamer/${input.branch}`;
      fake.workspaces.push({
        workspace_id: "w-home",
        label: input.branch,
        worktree: { checkout_path: path },
      });
      fake.panes.push({ pane_id: "p-home", workspace_id: "w-home" });
      return { path, workspaceId: "w-home" };
    },
    placeWorkspace: async (place) => {
      placed.push(place);
    },
    openReview: (params) => {
      reviews.push(params);
      return { session: { id: `rs-${reviews.length}` } } as any;
    },
    markSeen: (key) => seen.push(key),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 2)),
    pollMs: 1,
    deliverMs: 2_000,
  });
  return { homes, store, fake, made, placed, reviews, seen, request };
}

test("a home's name, branch and prompt", () => {
  expect(homeLabel(item())).toBe(
    "!3326 rtpgccbwe: Fix the estimate when packets are lost in…",
  );
  expect(homeLabel(item({ title: "short", provider: "github" }))).toBe(
    "#3326 short",
  );
  expect(homeBranchName(item({ sourceBranch: "me/fix it.." }))).toBe(
    "me/fix-it",
  );
  expect(homeBranchName(item({ sourceBranch: "main" }))).toBe("review/3326");
  const text = homePromptFor("", item({ title: "evil\n/clear title" }));
  expect(text).toContain(
    "home of the review of https://gitlab.example.org/gstreamer/gstreamer/-/merge_requests/3326",
  );
  expect(text).toContain('"evil /clear title" by alice, into main');
  expect(text).toContain("pending drafts");
  expect(text).toContain("Never post to the forge");
  expect(DEFAULT_MR_HOME_PROMPT).toContain("{url}");
  expect(homePromptFor("Review {ref} ({source})", item())).toBe(
    "Review gstreamer/gstreamer!3326 (gcc-fix)",
  );
  expect(
    parseHomeRoot("T\t/a/b\nR\torigin\tgit@h:g/p.git\nR\tbad\n").remotes,
  ).toEqual([{ name: "origin", url: "git@h:g/p.git" }]);
  // The shared review workspace is no home.
  expect(
    mrHomeLinks([
      {
        connectionId: "c",
        connectionLabel: "C",
        workspaceId: "r",
        label: "Reviews",
        why: ["review"],
      },
      {
        connectionId: "c",
        connectionLabel: "C",
        workspaceId: "h",
        label: "!1",
        why: ["name", "review"],
      },
    ]).map((link) => link.workspaceId),
  ).toEqual(["h"]);
});

test("Start a review with a home: workspace made, named, placed, review shown there, Claude started and told, link recorded", async () => {
  const { homes, store, fake, made, placed, reviews, request } = setup();
  const started = await homes.start(request.key);
  // The worktree through the user's worktree path, from the clone's own
  // workspace (Herdr starts worktrees from the repository's parent), on the request's branch name, moved to its head.
  expect(made).toEqual([
    { connectionId: "local", workspaceId: "w-clone", branch: "gcc-fix" },
  ]);
  expect(
    fake.scripts.some(
      (script) =>
        script.includes("/home/u/.herdr/worktrees/gstreamer/gcc-fix") &&
        script.includes("reset -q --keep 'abc1234'"),
    ),
  ).toBe(true);
  // Only fetches towards the forge.
  expect(fake.scripts.some((script) => /git (push|commit)/.test(script))).toBe(
    false,
  );
  expect(
    fake.herdrCalls.find(([method]) => method === "workspace.rename")?.[1],
  ).toEqual({
    workspace_id: "w-home",
    label: "!3326 rtpgccbwe: Fix the estimate when packets are lost in…",
  });
  expect(placed).toEqual([
    {
      projectKey: "gitlab.example.org/gstreamer/gstreamer",
      connectionId: "local",
      workspaceId: "w-home",
      label: "!3326 rtpgccbwe: Fix the estimate when packets are lost in…",
      worktree: "/home/u/.herdr/worktrees/gstreamer/gcc-fix",
      clone: "/src/gstreamer",
    },
  ]);
  // Its review, in the home, bound to the pane its Claude runs in.
  expect(reviews).toEqual([
    {
      connectionId: "local",
      workspaceId: "w-home",
      root: "/home/u/.herdr/worktrees/gstreamer/gcc-fix",
      url: request.url,
      title: `gstreamer/gstreamer!3326 ${request.title}`,
      paneId: "p-home",
    },
  ]);
  expect(started).toMatchObject({
    created: true,
    branch: "gcc-fix",
    connectionId: "local",
    workspaceId: "w-home",
    sessionId: "rs-1",
    agent: { state: "starting", paneId: "p-home" },
  });
  // Claude typed into the home's pane, then its job once it is idle.
  const typed = fake.herdrCalls.find(([method]) => method === "pane.send_text");
  expect(typed?.[1].pane_id).toBe("p-home");
  expect(String(typed?.[1].text)).toContain(
    `--session-id ${started.agent.session}`,
  );
  expect(await homes.delivered(request.key)).toBe(true);
  expect(fake.prompted).toHaveLength(1);
  expect(fake.prompted[0]).toContain(request.url);
  expect(fake.prompted[0]).toContain("pending drafts");
  // The board links the request to it from now on.
  expect(store.get().homes?.[request.key]).toMatchObject({
    connectionId: "local",
    workspaceId: "w-home",
    path: "/home/u/.herdr/worktrees/gstreamer/gcc-fix",
    branch: "gcc-fix",
    sessionId: "rs-1",
    claudeSession: started.agent.session,
  });

  // Again: the home made before, no second worktree.
  const again = await homes.start(request.key);
  expect(again.created).toBe(false);
  expect(made).toHaveLength(1);
  expect(again.workspaceId).toBe("w-home");
});

test("the prompt setting, and conversation mode's own delivery", async () => {
  const { homes, fake, request } = setup({
    conversation: true,
    homePrompt: "Home of {ref}: {url}",
  });
  await homes.start(request.key);
  expect(await homes.delivered(request.key)).toBe(true);
  expect(fake.prompted).toEqual([
    `Home of gstreamer/gstreamer!3326: ${request.url}`,
  ]);
  expect(fake.herdrCalls.some(([method]) => method === "agent.prompt")).toBe(
    false,
  );
});

test("opening in a home: its head fetched from the project's remote there, the review shown in it", async () => {
  const { homes, fake, reviews, seen, request } = setup();
  fake.workspaces.push({
    workspace_id: "w-branch",
    label: "gcc work",
    cwd: "/src/gstreamer.worktrees/gcc",
  });
  const opened = await homes.openIn(request.key, {
    connectionId: "local",
    workspaceId: "w-branch",
  });
  expect(opened).toMatchObject({
    connectionId: "local",
    workspaceId: "w-branch",
    root: "/src/gstreamer.worktrees/gcc",
  });
  const fetch = fake.scripts.find((script) => script.includes("git fetch"));
  expect(fetch).toContain("cd '/src/gstreamer.worktrees/gcc'");
  expect(fetch).toContain("'origin'");
  expect(reviews[0]).toMatchObject({
    workspaceId: "w-branch",
    root: "/src/gstreamer.worktrees/gcc",
  });
  expect(seen).toEqual([request.key]);
  await expect(
    homes.openIn(request.key, { connectionId: "local", workspaceId: "gone" }),
  ).rejects.toThrow("not open any more");
});
