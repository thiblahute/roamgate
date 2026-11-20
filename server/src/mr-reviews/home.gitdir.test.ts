import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MR_REVIEWS_SETTINGS,
  type MrItem,
} from "../../../shared/mrReviews";
import { createCloneFinder, type MrConnection, shQuote } from "./clones";
import { createGitFixture, FORGE_HOST, type GitFixture } from "./git.fixture";
import {
  createMrHomes,
  homeSourceScript,
  homeWorktreeError,
  homeWorktreePath,
  homeWorktreeScript,
  parseHomeSource,
} from "./home";
import { createMrOpener } from "./open";
import { openMrStore } from "./store";

/**
 * A clone kept in a repository directory, as gstreamer.git is: the
 * checkout's `.git` is a file naming the repository, which names the
 * checkout back in its `gitdir` file, and `git worktree list` names the
 * repository directory first, with no work tree of its own. Herdr's worktree
 * actions and Roamgate's worktree path run work-tree commands where a
 * worktree starts from: never there.
 */

let fx: GitFixture;
const dirs: string[] = [];
beforeAll(() => {
  fx = createGitFixture();
  fx.project("gstreamer/gstreamer");
});
afterAll(() => {
  fx.cleanup();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** `<name>.git` beside its checkout, with the project's review worktree. */
function repositoryDirectory(name: string) {
  const clones = join(fx.root, "clones");
  mkdirSync(clones, { recursive: true });
  const gitDir = join(clones, `${name}.git`);
  const checkout = join(clones, name);
  fx.git(
    clones,
    "clone",
    "-q",
    "--separate-git-dir",
    gitDir,
    `https://${FORGE_HOST}/gstreamer/gstreamer.git`,
    checkout,
  );
  // The repository names its checkout, as gstreamer.git does.
  writeFileSync(join(gitDir, "gitdir"), `${checkout}/.git\n`);
  const review = join(clones, `${name}.worktrees`, "review");
  fx.git(checkout, "worktree", "add", "-q", "--detach", review, "HEAD");
  return {
    gitDir,
    checkout,
    review,
    head: fx.git(checkout, "rev-parse", "HEAD").trim(),
  };
}

const request = (head: string): MrItem => ({
  provider: "gitlab",
  host: FORGE_HOST,
  project: "gstreamer/gstreamer",
  number: 3326,
  key: `gitlab:${FORGE_HOST}/gstreamer/gstreamer#3326`,
  url: `https://${FORGE_HOST}/gstreamer/gstreamer/-/merge_requests/3326`,
  title: "rtpgccbwe: Fix the estimate",
  author: "alice",
  draft: false,
  state: "open",
  updatedAt: new Date().toISOString(),
  headSha: head,
  sourceBranch: "gcc-fix",
  targetBranch: "main",
  pipeline: null,
  notes: 0,
  reasons: ["review_requested"],
});

/**
 * Homes on the repository: scripts run here; Herdr is a fake keeping
 * workspaces; the worktree path does what Roamgate's and Herdr's do first
 * (the source's top level, never a linked worktree), then `git worktree add`.
 */
function harness(
  repo: ReturnType<typeof repositoryDirectory>,
  options: { failWorktree?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "mr-home-gitdir-"));
  dirs.push(dir);
  const store = openMrStore(join(dir, "state.json"));
  const base = fx.connection([]);
  const workspaces: Record<string, any>[] = [
    {
      workspace_id: "w-review",
      label: "Reviews · gstreamer",
      cwd: repo.review,
    },
  ];
  const folders = new Map<string, string>([["w-review", repo.review]]);
  const herdrCalls: [string, Record<string, unknown>][] = [];
  const conn: MrConnection = {
    id: base.id,
    label: base.label,
    run: base.run,
    dirs: base.dirs,
    herdr: async (method, params = {}) => {
      herdrCalls.push([method, params]);
      if (method === "workspace.list") return { workspaces };
      if (method === "pane.list") return { panes: [] };
      if (method === "workspace.create") {
        const cwd = String(params.cwd);
        const id = cwd === repo.checkout ? "w-clone" : "w-home";
        workspaces.push({ workspace_id: id, label: params.label, cwd });
        folders.set(id, cwd);
        return { workspace: { workspace_id: id } };
      }
      if (method === "agent.get") return { agent: null };
      return {};
    },
  };
  const item = request(repo.head);
  const made: { connectionId: string; workspaceId: string; branch: string }[] =
    [];
  const reviews: Record<string, unknown>[] = [];
  const homes = createMrHomes({
    item: () => item,
    store,
    connections: () => [conn],
    settings: async () => ({ homePrompt: "" }),
    project: async () => ({
      conn,
      record: {
        connectionId: "local",
        clone: repo.gitDir,
        worktree: repo.review,
        workspaceId: "w-review",
        remote: "origin",
      },
    }),
    createWorktree: async (input) => {
      made.push(input);
      if (options.failWorktree)
        throw new Error("fatal: this operation must be run in a work tree");
      const from = folders.get(input.workspaceId) ?? "";
      // Roamgate's worktree path reads the source's top level first...
      const top = await conn.run(
        `git -C ${shQuote(from)} rev-parse --show-toplevel`,
      );
      if (top.code !== 0) throw new Error(top.stderr.trim());
      // ...and Herdr starts no worktree from a linked one.
      const [gitDir, common] = (
        await conn.run(
          `git -C ${shQuote(from)} rev-parse --path-format=absolute --git-dir --git-common-dir`,
        )
      ).stdout
        .trim()
        .split("\n");
      if (gitDir !== common)
        throw new Error(
          "New and open worktree actions start from the repo parent workspace.",
        );
      const path = join(fx.root, "worktrees", input.branch);
      fx.git(
        top.stdout.trim(),
        "worktree",
        "add",
        "-q",
        "-b",
        input.branch,
        path,
      );
      workspaces.push({
        workspace_id: "w-home",
        label: input.branch,
        worktree: { checkout_path: path },
      });
      folders.set("w-home", path);
      return { path, workspaceId: "w-home" };
    },
    openReview: (params) => {
      reviews.push(params);
      return { session: { id: `rs-${reviews.length}` } } as any;
    },
    markSeen: () => {},
    sleep: () => Promise.resolve(),
    pollMs: 1,
    deliverMs: 1,
  });
  return {
    homes,
    conn,
    item,
    made,
    reviews,
    herdrCalls,
    scripts: base.scripts,
  };
}

test("a repository directory: what git lists first, with no work tree; its checkout found, and only its own", async () => {
  const repo = repositoryDirectory("shape");
  const { run } = fx.connection([]);
  const source = async (dir: string) =>
    parseHomeSource((await run(homeSourceScript(dir))).stdout);
  expect(
    fx.git(repo.review, "worktree", "list", "--porcelain").split("\n")[0],
  ).toBe(`worktree ${repo.gitDir}`);
  expect(() => fx.git(repo.gitDir, "rev-parse", "--show-toplevel")).toThrow(
    "must be run in a work tree",
  );
  // Through its gitdir file; a checkout is its own.
  expect(await source(repo.gitDir)).toBe(repo.checkout);
  expect(await source(repo.checkout)).toBe(repo.checkout);
  // Without the file: the directory beside it, when it is this repository's.
  rmSync(join(repo.gitDir, "gitdir"));
  expect(await source(repo.gitDir)).toBe(repo.checkout);
  // The checkout elsewhere: unknown, unless core.worktree says.
  const moved = join(fx.root, "clones", "shape-main");
  renameSync(repo.checkout, moved);
  expect(await source(repo.gitDir)).toBe("");
  fx.git(repo.gitDir, "config", "core.worktree", moved);
  expect(await source(repo.gitDir)).toBe(moved);
  fx.git(repo.gitDir, "config", "--unset", "core.worktree");
  // Another repository's checkout beside it is not this one's.
  fx.git(
    join(fx.root, "clones"),
    "clone",
    "-q",
    `https://${FORGE_HOST}/gstreamer/gstreamer.git`,
    repo.checkout,
  );
  expect(await source(repo.gitDir)).toBe("");
  expect(parseHomeSource("TOP\t\n")).toBe("");
  expect(parseHomeSource("TOP\t/a/b\n")).toBe("/a/b");
});

test("Start a review with a home in a repository directory: the worktree starts from its checkout, never from the git dir", async () => {
  const repo = repositoryDirectory("gstreamer");
  const t = harness(repo);
  const started = await t.homes.start(t.item.key);
  // Herdr opened the checkout, not the repository directory, and the
  // worktree started from that workspace through the worktree path.
  expect(
    t.herdrCalls
      .filter(([method]) => method === "workspace.create")
      .map(([, params]) => params.cwd),
  ).toEqual([repo.checkout]);
  expect(t.made).toEqual([
    { connectionId: "local", workspaceId: "w-clone", branch: "gcc-fix" },
  ]);
  expect(started).toMatchObject({
    created: true,
    branch: "gcc-fix",
    workspaceId: "w-home",
    agent: { state: "none" },
  });
  // The home: a worktree of the repository, on the request's branch at its head.
  expect(
    fx
      .git(
        started.root,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      )
      .trim(),
  ).toBe(repo.gitDir);
  expect(fx.git(started.root, "symbolic-ref", "HEAD").trim()).toBe(
    "refs/heads/gcc-fix",
  );
  expect(fx.git(started.root, "rev-parse", "HEAD").trim()).toBe(repo.head);
  expect(t.reviews[0]).toMatchObject({
    workspaceId: "w-home",
    root: started.root,
  });
  // Only fetches towards the forge.
  expect(t.scripts.some((script) => /git (push|commit)/.test(script))).toBe(
    false,
  );
  // A worktree path that fails says where it started from.
  const failing = harness(repositoryDirectory("failing"), {
    failWorktree: true,
  });
  await expect(failing.homes.start(failing.item.key)).rejects.toThrow(
    `cannot make the home's worktree from ${join(fx.root, "clones", "failing")} on Desktop: fatal: this operation must be run in a work tree`,
  );
});

test("a repository directory whose checkout is gone: git makes the home from the review worktree, and says what failed", async () => {
  const repo = repositoryDirectory("gone");
  rmSync(repo.checkout, { recursive: true });
  const t = harness(repo);
  const started = await t.homes.start(t.item.key);
  // Not through the worktree path: beside the review worktree, opened as a workspace.
  expect(t.made).toEqual([]);
  const path = join(fx.root, "clones", "gone.worktrees", "gcc-fix");
  expect(started.root).toBe(path);
  expect(fx.git(path, "symbolic-ref", "HEAD").trim()).toBe(
    "refs/heads/gcc-fix",
  );
  expect(fx.git(path, "rev-parse", "HEAD").trim()).toBe(repo.head);
  expect(
    t.herdrCalls.find(([method]) => method === "workspace.create")?.[1],
  ).toEqual({ cwd: path, label: "gcc-fix", focus: false });
  // Made again where it is: the command, its directory and git's words.
  const again = await t.conn.run(
    homeWorktreeScript(repo.review, path, "gcc-fix", repo.head),
  );
  expect(again.code).toBe(4);
  const why = homeWorktreeError(again, repo.review, path, "gcc-fix", repo.head);
  expect(
    why.startsWith(
      `git -C ${repo.review} worktree add -b gcc-fix ${path} ${repo.head.slice(0, 12)} failed: fatal: `,
    ),
  ).toBe(true);
  expect(
    homeWorktreeError(
      { code: 2, stdout: "", stderr: "" },
      "/gone/review",
      path,
      "b",
      repo.head,
    ),
  ).toBe("cannot enter /gone/review");
  expect(homeWorktreePath("/src/gstreamer.worktrees/review", "me/fix it")).toBe(
    "/src/gstreamer.worktrees/me-fix-it",
  );
});

test("picking a clone kept in a repository directory", async () => {
  const repo = repositoryDirectory("picked");
  const dir = mkdtempSync(join(tmpdir(), "mr-pick-"));
  dirs.push(dir);
  const saved: unknown[] = [];
  const conn = fx.connection([]);
  const opener = createMrOpener({
    inbox: {} as any,
    store: openMrStore(join(dir, "state.json")),
    settings: async () => DEFAULT_MR_REVIEWS_SETTINGS,
    saveClone: async (key, clone) => {
      saved.push([key, clone]);
    },
    connections: () => [conn],
    clones: createCloneFinder(),
    openReview: () => {
      throw new Error("not opened here");
    },
  });
  const pick = (path: string) =>
    opener.setClone({
      host: FORGE_HOST,
      project: "gstreamer/gstreamer",
      provider: "gitlab",
      connectionId: "local",
      path,
    });
  expect(await pick(repo.gitDir)).toEqual({ ok: true, remote: "origin" });
  expect(saved).toEqual([
    [
      `${FORGE_HOST}/gstreamer/gstreamer`,
      { connectionId: "local", path: repo.gitDir },
    ],
  ]);
  await expect(pick(join(fx.root, "nowhere"))).rejects.toThrow(
    "is not a Git checkout there",
  );
});
