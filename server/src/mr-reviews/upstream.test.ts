import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MrItem, MrReviewsPush } from "../../../shared/mrReviews";
import {
  type WorkspaceTree,
  WORKSPACE_TREE_VERSION,
} from "../../../shared/workspaceTree";
import { updateGuiSettings } from "../config/gui-settings";
import { createGitFixture, FORGE_HOST, type GitFixture } from "./git.fixture";
import { createMrReviews } from "./module";
import { openMrStore } from "./store";
import {
  branchCommitsScript,
  headedGroups,
  parseBranchCommits,
  parseRequestPatchIds,
  parseUpstreamScan,
  requestOfBranch,
  requestPatchIdsScript,
  targetOf,
  upstreamMembers,
  upstreamScanScript,
} from "./upstream";

const dir = mkdtempSync(join(realpathSync("/tmp"), "mr-upstream-"));
const previousPath = process.env.ROAMGATE_SETTINGS_PATH;
process.env.ROAMGATE_SETTINGS_PATH = join(dir, "settings.json");
afterAll(() => {
  if (previousPath === undefined) delete process.env.ROAMGATE_SETTINGS_PATH;
  else process.env.ROAMGATE_SETTINGS_PATH = previousPath;
  rmSync(dir, { recursive: true, force: true });
});
const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const each of fixtures.splice(0)) each.cleanup();
});

const tree = (
  workspaces: { id: string; parent: string; path: string; label: string }[],
): WorkspaceTree => ({
  version: WORKSPACE_TREE_VERSION,
  nodes: [
    { id: "g1", kind: "group", parent: null, label: "Upstream" },
    { id: "g2", kind: "group", parent: "g1", label: "Media" },
    { id: "g3", kind: "group", parent: null, label: "Other" },
    ...workspaces.map((each) => ({
      id: each.id,
      kind: "workspace" as const,
      parent: each.parent,
      ref: { connection_id: "local", label: each.label },
    })),
  ],
});

test("members: under a marked group, nested groups too, minus the skipped", () => {
  const t = tree([
    { id: "a", parent: "g1", path: "/a", label: "a" },
    { id: "b", parent: "g2", path: "/b", label: "b" },
    { id: "c", parent: "g3", path: "/c", label: "c" },
    { id: "d", parent: "g2", path: "/d", label: "d" },
  ]);
  expect([...headedGroups(t, ["g1"]).entries()]).toEqual([
    ["g1", "g1"],
    ["g2", "g1"],
  ]);
  const live = new Map([
    [
      "local",
      ["a", "b", "c", "d"].map((name) => ({
        workspace_id: `w-${name}`,
        label: name,
      })),
    ],
  ]);
  const dirs = new Map(
    ["a", "b", "c", "d"].map((name) => [`local\0w-${name}`, `/${name}`]),
  );
  expect(
    upstreamMembers(
      t,
      {
        upstreamGroups: ["g1"],
        upstreamSkip: [{ connection_id: "local", label: "d" }],
      },
      live,
      dirs,
    ).map((member) => [member.workspaceId, member.group]),
  ).toEqual([
    ["w-a", "g1"],
    ["w-b", "g1"],
  ]);
  expect(
    upstreamMembers(t, { upstreamGroups: [], upstreamSkip: [] }, live),
  ).toEqual([]);
});

const own = (n: number, extra: Partial<MrItem> = {}): MrItem => ({
  provider: "gitlab",
  host: FORGE_HOST,
  project: "media/engine",
  number: n,
  key: `gitlab:${FORGE_HOST}/media/engine#${n}`,
  url: `https://${FORGE_HOST}/media/engine/-/merge_requests/${n}`,
  title: `MR ${n}`,
  author: "me",
  draft: false,
  state: "open",
  updatedAt: new Date().toISOString(),
  headSha: "",
  sourceBranch: `b${n}`,
  targetBranch: "main",
  pipeline: "success",
  notes: 0,
  reasons: ["authored"],
  ...extra,
});

test("a checkout's branch, target, commits and a request's patch ids, from real git", async () => {
  const g = createGitFixture();
  fixtures.push(g);
  const bare = g.project("media/engine");
  const clone = g.clone("media/engine", "engine");
  // A request on the forge: one commit on top of main.
  const work = g.clone("media/engine", "theirs");
  g.git(work, "checkout", "-q", "-b", "mr7");
  g.commit(work, "fix.c", "int fixed;\n", "Fix the pool");
  const head7 = g.git(work, "rev-parse", "HEAD").trim();
  g.git(work, "push", "-q", bare, "HEAD:refs/merge-requests/7/head");
  // Here: a feature branch, and the same fix under another sha.
  g.git(clone, "checkout", "-q", "-b", "feature");
  g.commit(clone, "a.c", "a\n", "Add a");
  g.commit(clone, "b.c", "b\n", "Add b");
  g.commit(clone, "dirty.c", "x\n", "Add dirty");
  Bun.write(join(clone, "dirty.c"), "changed\n");
  const scan = parseUpstreamScan(
    Bun.spawnSync(["sh", "-c", upstreamScanScript([clone, "/nowhere"])], {
      env: { ...process.env, HOME: join(g.root, "home") },
    }).stdout.toString(),
  );
  const checkout = scan.get(clone)!;
  expect(scan.has("/nowhere")).toBe(false);
  expect(checkout).toMatchObject({ branch: "feature", dirty: 1 });
  expect(checkout.targets).toEqual([
    {
      remote: "origin",
      ref: "origin/main",
      sha: g.git(clone, "rev-parse", "origin/main").trim(),
      behind: 0,
      ahead: 3,
    },
  ]);
  const target = targetOf(checkout, [
    { host: FORGE_HOST, provider: "gitlab" },
  ])!;
  expect(target).toMatchObject({
    provider: "gitlab",
    host: FORGE_HOST,
    project: "media/engine",
  });
  expect(targetOf(checkout, [{ host: "other.org", provider: "gitlab" }])).toBe(
    null,
  );

  g.git(clone, "checkout", "-q", "-f", "-b", "fix", "origin/main");
  g.commit(clone, "fix.c", "int fixed;\n", "Fix the pool (mine)");
  const commits = parseBranchCommits(
    Bun.spawnSync(
      [
        "sh",
        "-c",
        branchCommitsScript([{ dir: clone, target: "origin/main" }]),
      ],
      { env: { ...process.env, HOME: join(g.root, "home") } },
    ).stdout.toString(),
  ).get(clone)!;
  expect(commits.map((commit) => commit.subject)).toEqual([
    "Fix the pool (mine)",
  ]);
  expect(commits[0]!.patchId).toMatch(/^[0-9a-f]{40}$/);

  const run = (script: string) =>
    Bun.spawnSync(["sh", "-c", script], {
      env: { ...process.env, HOME: join(g.root, "home") },
    }).stdout.toString();
  const request = {
    key: own(7).key,
    provider: "gitlab" as const,
    number: 7,
    head: head7,
  };
  const ids = parseRequestPatchIds(
    run(requestPatchIdsScript(clone, "origin", "origin/main", [request])),
  );
  expect([...ids.get(request.key)!]).toEqual([commits[0]!.patchId!]);
  expect(g.git(clone, "rev-parse", "refs/roamgate/mr/7").trim()).toBe(head7);
  // At that head already: no fetch (the forge may be gone), same answer.
  rmSync(bare, { recursive: true, force: true });
  expect(
    parseRequestPatchIds(
      run(requestPatchIdsScript(clone, "origin", "origin/main", [request])),
    ),
  ).toEqual(ids);

  const branch = {
    provider: "gitlab" as const,
    host: FORGE_HOST,
    project: "media/engine",
    branch: "fix",
    commits,
  };
  // By patch id: the request holds every commit of the branch.
  expect(requestOfBranch(branch, [own(7)], ids)?.number).toBe(7);
  // By name first; a closed one leaves the work unproposed.
  expect(
    requestOfBranch(branch, [own(8, { sourceBranch: "fix" })])?.number,
  ).toBe(8);
  expect(
    requestOfBranch(branch, [own(8, { sourceBranch: "fix", state: "closed" })]),
  ).toBe(null);
  expect(requestOfBranch(branch, [own(7)])).toBe(null);
});

test("branch rows: lane, not proposed yet, overrides, and the request's key once it opens", async () => {
  const g = createGitFixture();
  fixtures.push(g);
  g.project("media/engine");
  const clone = g.clone("media/engine", "engine");
  g.git(clone, "checkout", "-q", "-b", "pool-rework");
  g.commit(clone, "a.c", "a\n", "Rework the buffer pool");
  g.commit(clone, "b.c", "b\n", "Use the new pool");
  const outside = g.clone("media/engine", "outside");
  g.git(outside, "checkout", "-q", "-b", "elsewhere");
  g.commit(outside, "c.c", "c\n", "Not headed upstream");
  const connection = g.connection([
    { workspace_id: "w1", label: "pool rework", cwd: clone },
    { workspace_id: "w2", label: "outside", cwd: outside },
  ]);
  const workspaceTree = tree([
    { id: "n1", parent: "g2", path: clone, label: "pool rework" },
    { id: "n2", parent: "g3", path: outside, label: "outside" },
  ]);
  await updateGuiSettings((current) => ({
    ...current,
    mr_reviews: {
      hosts: [{ host: FORGE_HOST, provider: "gitlab" }],
      upstream_groups: ["g1"],
    },
  }));
  const store = openMrStore(join(dir, `state-${Math.random()}.json`));
  const other = own(40, { sourceBranch: "other" });
  store.update((state) => {
    state.items = [other];
  });
  const pushes: MrReviewsPush[] = [];
  const reviews = createMrReviews({
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    store,
    discoverHosts: () => [],
    connections: () => [connection],
    tree: { read: async () => workspaceTree, apply: async () => {} },
    publish: (push) => pushes.push(push),
  });
  await reviews.inbox.get({ viewer: true });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const key = `branch:gitlab:${FORGE_HOST}/media/engine@pool-rework`;
  const snapshot = async () =>
    (await reviews.inbox.get({ viewer: false })).entries;
  const row = (await snapshot()).find((entry) => entry.key === key)!;
  expect(row).toMatchObject({
    title: "Rework the buffer pool",
    section: "authored",
    lane: "not_sent",
    next: { text: "Propose 2 commits upstream", from: "rule" },
    branch: {
      name: "pool-rework",
      workspaceLabel: "pool rework",
      target: "origin/main",
      ahead: 2,
      behind: 0,
      dirty: 0,
    },
  });
  expect(
    (await snapshot()).some((entry) => entry.title === "Not headed upstream"),
  ).toBe(false);
  // Its workspace is its link.
  expect(
    (
      (await reviews.handle("bridge.mr_reviews.links", { keys: [key] })) as {
        links: Record<string, unknown[]>;
      }
    ).links[key],
  ).toEqual([
    {
      connectionId: "local",
      connectionLabel: "Desktop",
      workspaceId: "w1",
      label: "pool rework",
      why: ["branch"],
    },
  ]);
  // Not proposed yet, with a title; something set by hand; a place.
  expect(
    JSON.parse(
      await reviews.boardTool(
        "upstream_unsent",
        { branch: "pool-rework", unsent: true, title: "Rework the pool" },
        "Claude in lead",
      ),
    ),
  ).toMatchObject({ changed: true, key, unsent: true });
  expect(pushes.at(-1)!.summary).toBe(
    "Claude in lead made pool-rework a request not proposed yet",
  );
  // The workspace skipped: no row; back: the row again.
  await reviews.boardTool(
    "upstream_workspace",
    { workspace: clone, headed: false },
    "Claude",
  );
  await reviews.upstream.refresh(true);
  expect((await snapshot()).some((entry) => entry.key === key)).toBe(false);
  await reviews.boardTool(
    "upstream_workspace",
    { workspace: "pool rework", headed: true },
    "Claude",
  );
  await reviews.upstream.refresh(true);
  await reviews.handle("bridge.mr_reviews.override", {
    key,
    set: { labels: ["pool"] },
  });
  await reviews.handle("bridge.mr_reviews.order", {
    op: "top",
    keys: [key],
  });
  const unsent = (await snapshot()).find((entry) => entry.key === key)!;
  expect(unsent).toMatchObject({
    unsent: true,
    title: "Rework the pool",
    next: { text: "Open the request (2 commits)" },
  });
  expect(pushes.map((push) => push.changed).flat()).toContain("unsent");
  // The request opens: it takes the branch's place and what was set.
  const request = own(41, { sourceBranch: "pool-rework" });
  store.update((state) => {
    state.items = [other, request];
  });
  await reviews.upstream.refresh(true);
  await reviews.rekeyBranches();
  const settings = await reviews.settings();
  expect(settings.unsent).toEqual([]);
  expect(settings.order.slice(0, 2)).toEqual([request.key, other.key]);
  expect(settings.overrides[request.key]?.labels).toEqual(["pool"]);
  expect(settings.overrides[key]).toBeUndefined();
  const after = await snapshot();
  expect(after.some((entry) => entry.key === key)).toBe(false);
  expect(after.find((entry) => entry.key === request.key)).toMatchObject({
    fromBranch: "pool-rework",
  });
  // The group unmarked: no branch rows.
  await expect(
    reviews.boardTool(
      "upstream_group",
      { group: "Nope", headed: false },
      "Claude",
    ),
  ).rejects.toThrow(/Upstream\/Media/);
  await reviews.boardTool(
    "upstream_group",
    { group: "Upstream", headed: false },
    "Claude",
  );
  expect(pushes.at(-1)).toMatchObject({
    changed: ["upstream"],
    summary: "Claude unmarked Upstream as headed upstream",
  });
  store.update((state) => {
    state.items = [];
  });
  expect((await snapshot()).some((entry) => entry.branch)).toBe(false);
});
