import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixupTargets, type MrReviewsPush } from "../../../shared/mrReviews";
import { WORKSPACE_TREE_VERSION } from "../../../shared/workspaceTree";
import { updateGuiSettings } from "../config/gui-settings";
import { createGitFixture, FORGE_HOST, type GitFixture } from "./git.fixture";
import {
  parsePartStops,
  parsePick,
  partStopsScript,
  pickedOnBranch,
  pickScript,
  readableError,
} from "./effort-service";
import { createMrReviews } from "./module";
import { openMrStore } from "./store";

const dir = mkdtempSync(join(realpathSync("/tmp"), "mr-efforts-"));
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

test("an effort declared by a tool: its card, ledger tools, the push with Undo, refusals", async () => {
  const g = createGitFixture();
  fixtures.push(g);
  g.project("media/engine");
  const clone = g.clone("media/engine", "engine");
  g.git(clone, "checkout", "-q", "-b", "big");
  g.commit(clone, "pool/a.c", "a\n", "pool: add a");
  g.commit(clone, "pool/b.c", "b\n", "pool: add b");
  g.git(clone, "branch", "-q", "other-big");
  g.git(clone, "update-ref", "refs/remotes/origin/big", "HEAD");
  const connection = g.connection([
    { workspace_id: "w1", label: "big", cwd: clone },
  ]);
  await updateGuiSettings((current) => ({
    ...current,
    mr_reviews: {
      hosts: [{ host: FORGE_HOST, provider: "gitlab" }],
      upstream_groups: ["g1"],
    },
  }));
  const pushes: MrReviewsPush[] = [];
  const reviews = createMrReviews({
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    store: openMrStore(join(dir, `state-${Math.random()}.json`)),
    discoverHosts: () => [],
    connections: () => [connection],
    tree: {
      read: async () => ({
        version: WORKSPACE_TREE_VERSION,
        nodes: [
          { id: "g1", kind: "group", parent: null, label: "Big upstreaming" },
          {
            id: "n1",
            kind: "workspace",
            parent: "g1",
            ref: { connection_id: "local", label: "big" },
          },
        ],
      }),
      apply: async () => {},
    },
    publish: (push) => pushes.push(push),
    effortsDir: join(dir, `efforts-${Math.random()}`),
  });
  await reviews.upstream.refresh(true);
  // "big" is a local branch and a remote one: the local one, as git reads it.
  expect(
    JSON.parse(
      await reviews.boardTool(
        "effort_set",
        { group: "Big upstreaming", source: "big", preview: true },
        "Claude",
      ),
    ).effort,
  ).toMatchObject({ source: "refs/heads/big" });
  // Only remote branches, of two remotes: ambiguous, refused.
  g.git(clone, "update-ref", "refs/remotes/origin/far", "HEAD");
  g.git(clone, "update-ref", "refs/remotes/mac/far", "HEAD");
  await expect(
    reviews.boardTool(
      "effort_set",
      { group: "Big upstreaming", source: "far" },
      "Claude",
    ),
  ).rejects.toThrow(
    /ambiguous.*refs\/remotes\/mac\/far.*refs\/remotes\/origin\/far/,
  );
  expect(
    JSON.parse(
      await reviews.boardTool(
        "effort_set",
        { group: "Big upstreaming", source: "mac/far", preview: true },
        "Claude",
      ),
    ).effort,
  ).toMatchObject({ source: "refs/remotes/mac/far" });
  const preview = JSON.parse(
    await reviews.boardTool(
      "effort_set",
      { group: "Big upstreaming", source: "refs/heads/big", preview: true },
      "Claude",
    ),
  );
  expect(preview.preview).toMatchObject({ total: 2, counts: { unsorted: 2 } });
  expect((await reviews.settings()).efforts).toEqual([]);
  const declared = JSON.parse(
    await reviews.boardTool(
      "effort_set",
      { group: "Big upstreaming", source: "refs/heads/big" },
      "Claude in lead",
    ),
  );
  expect(declared.effort).toMatchObject({
    name: "Big upstreaming",
    source: "refs/heads/big",
    target: { remote: "origin", branch: "main" },
    clone: { connectionId: "local", path: clone },
  });
  expect(pushes.at(-1)).toMatchObject({
    changed: ["efforts"],
    summary: "Claude in lead declared the effort refs/heads/big",
  });
  await reviews.efforts.refresh(true);
  const card = (await reviews.inbox.get({ viewer: false })).efforts![0]!;
  expect(card).toMatchObject({
    name: "Big upstreaming",
    source: "big",
    target: "origin/main",
    total: 2,
    counts: { unsorted: 2 },
  });
  const list = JSON.parse(
    (
      await reviews.boardTool(
        "ledger_list",
        { effort: "big upstreaming", cluster: true },
        "Claude",
      )
    ).replace(/^[^\n]*\n/, ""),
  );
  expect(list.commits.map((c: any) => c.subject)).toEqual([
    "pool: add a",
    "pool: add b",
  ]);
  expect(list.clusters).toEqual([
    {
      label: "pool pool:",
      size: 2,
      files: 2,
      commits: list.commits.map((c: any) => c.sha),
    },
  ]);
  const set = JSON.parse(
    await reviews.boardTool(
      "ledger_set",
      {
        effort: "Big upstreaming",
        commits: [list.commits[1].sha],
        disposition: "not_for_upstream",
        reason: "debug only",
      },
      "Claude in lead",
    ),
  );
  expect(set).toMatchObject({ changed: 1, journal: 1 });
  expect(pushes.at(-1)).toMatchObject({
    changed: ["effort"],
    summary: "Claude in lead marked 1 commit not for upstream",
    effort: { id: declared.effort.id, journal: 1 },
  });
  expect(
    (await reviews.inbox.get({ viewer: false })).efforts![0]!.counts,
  ).toEqual({ unsorted: 1, not_for_upstream: 1 });
  await reviews.handle("bridge.mr_reviews.ledger.undo", {
    id: declared.effort.id,
    journal: 1,
  });
  expect(
    (await reviews.inbox.get({ viewer: false })).efforts![0]!.counts,
  ).toEqual({ unsorted: 2 });
  await expect(
    reviews.boardTool(
      "ledger_set",
      {
        effort: "Big upstreaming",
        commits: ["0000000"],
        disposition: "planned",
      },
      "Claude",
    ),
  ).rejects.toThrow(/nothing changed/);
  // An effort on a group not headed upstream is refused.
  await expect(
    reviews.handle("bridge.mr_reviews.effort.set", {
      group: "nope",
      source: "refs/heads/big",
    }),
  ).rejects.toThrow(/headed upstream/);
  expect(
    JSON.parse(
      await reviews.boardTool(
        "effort_overlaps",
        { effort: "Big upstreaming" },
        "Claude",
      ),
    ),
  ).toEqual({ overlaps: [] });
});

test("planned requests by tool, a part made with its commits picked, a conflict reported, a commit opened", async () => {
  const g = createGitFixture();
  fixtures.push(g);
  g.project("media/engine");
  const clone = g.clone("media/engine", "engine");
  g.git(clone, "checkout", "-q", "-b", "big");
  g.commit(clone, "pool/a.c", "a\n", "pool: add a");
  g.commit(clone, "pool/b.c", "b\n", "pool: add b");
  g.commit(clone, "pool/a.c", "a2\n", "pool: change a");
  const workspaces = [{ workspace_id: "w1", label: "big", cwd: clone }];
  const connection = g.connection(workspaces);
  await updateGuiSettings((current) => ({
    ...current,
    mr_reviews: {
      hosts: [{ host: FORGE_HOST, provider: "gitlab" }],
      upstream_groups: ["g1"],
    },
  }));
  const nodes: any[] = [
    { id: "g1", kind: "group", parent: null, label: "Big" },
    {
      id: "n1",
      kind: "workspace",
      parent: "g1",
      ref: { connection_id: "local", label: "big" },
    },
  ];
  const made: string[] = [];
  const placed: unknown[] = [];
  const opened: unknown[] = [];
  const threads: unknown[] = [];
  const reviews = createMrReviews({
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    store: openMrStore(join(dir, `state-${Math.random()}.json`)),
    discoverHosts: () => [],
    connections: () => [connection],
    tree: {
      read: async () => ({ version: WORKSPACE_TREE_VERSION, nodes }),
      apply: async (ops) => {
        placed.push(...ops);
        // The part now shows in the group, as the tree would place it.
        for (const op of ops as any[])
          if (op.op === "move")
            nodes.push({
              id: `n${nodes.length}`,
              kind: "workspace",
              parent: op.parent.node,
              ref: {
                connection_id: "local",
                label: op.subject.workspace.path.split("/").pop(),
              },
            });
      },
    },
    createWorktree: async ({ workspaceId, branch }) => {
      expect(workspaceId).toBe("w1");
      // As the worktree path would: from origin's default branch.
      const path = join(g.root, `part-${branch.replace(/\//g, "-")}`);
      g.git(clone, "worktree", "add", "-q", "-b", branch, path, "origin/main");
      made.push(path);
      workspaces.push({
        workspace_id: `w${workspaces.length + 1}`,
        label: path.split("/").pop()!,
        cwd: path,
      });
      return { path, workspaceId: `w${workspaces.length}` };
    },
    openRange: (input) => {
      opened.push(input);
      return { sessionId: "s1" };
    },
    effortReview: (input) => {
      threads.push(input);
      return input.open
        ? ({ session: { id: "rs-effort" }, threads: [] } as any)
        : null;
    },
    effortsDir: join(dir, `efforts-${Math.random()}`),
  });
  await reviews.upstream.refresh(true);
  await reviews.boardTool(
    "effort_set",
    { group: "Big", source: "refs/heads/big" },
    "Claude",
  );
  await reviews.efforts.refresh(true);
  const list = JSON.parse(
    (
      await reviews.boardTool("ledger_list", { effort: "Big" }, "Claude")
    ).replace(/^[^\n]*\n/, ""),
  );
  const [a, b, a2] = list.commits.map((c: any) => c.sha);
  const proposed = JSON.parse(
    await reviews.boardTool(
      "ledger_plans",
      { effort: "Big", action: "propose", plan: "Pool b", commits: [b] },
      "Claude in lead",
    ),
  );
  expect(proposed.plan).toMatchObject({ name: "Pool b", state: "proposed" });
  // A part only once accepted.
  await expect(
    reviews.boardTool(
      "part_create",
      { effort: "Big", plan: "Pool b" },
      "Claude",
    ),
  ).rejects.toThrow(/accept Pool b first/);
  await reviews.handle("bridge.mr_reviews.ledger.plans", {
    id: "Big",
    action: "accept",
    plan: "Pool b",
  });
  const part = JSON.parse(
    await reviews.boardTool(
      "part_create",
      { effort: "Big", plan: "Pool b", branch: "pool-b" },
      "Claude in lead",
    ),
  );
  expect(part).toMatchObject({ ok: true, branch: "pool-b", picked: 1, of: 1 });
  expect(
    g.git(made[0]!, "log", "--format=%s", "origin/main..HEAD").trim(),
  ).toBe("pool: add b");
  expect(placed).toContainEqual(
    expect.objectContaining({ op: "move", parent: { node: "g1" } }),
  );
  // Its branch is a request not proposed yet, titled after the plan.
  expect((await reviews.settings()).unsent).toEqual([
    expect.objectContaining({ title: "Pool b" }),
  ]);
  // Its commit counts in a part now.
  await reviews.efforts.refresh(true);
  const counts = (await reviews.inbox.get({ viewer: false })).efforts![0]!;
  expect(counts.counts).toMatchObject({ in_part: 1, unsorted: 2 });
  expect(counts.plans).toEqual({ proposed: 0, accepted: 1 });
  // The change of a, without a: a conflict, reported, left as it is.
  await reviews.handle("bridge.mr_reviews.ledger.plans", {
    id: "Big",
    action: "propose",
    name: "Change a",
    commits: [a2],
    accepted: true,
  });
  const conflict = await reviews.handle("bridge.mr_reviews.effort.part", {
    id: "Big",
    plan: "Change a",
  });
  expect(conflict).toMatchObject({
    ok: false,
    picked: 0,
    conflict: {
      sha: expect.stringMatching(/^[0-9a-f]{40}$/),
      files: ["pool/a.c"],
    },
  });
  expect(
    g.git(made[1]!, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD").trim(),
  ).toMatch(/^[0-9a-f]{40}$/);
  const planOf = async (name: string) =>
    (
      (await reviews.handle("bridge.mr_reviews.effort.get", {
        id: "Big",
      })) as { plans: any[] }
    ).plans.find((plan) => plan.name === name);
  expect((await planOf("Change a")).part.conflict).toMatchObject({
    files: ["pool/a.c"],
  });
  // Resolved and committed there: the view reads the part as it is now.
  g.git(made[1]!, "checkout", "--theirs", "pool/a.c");
  g.git(made[1]!, "add", "pool/a.c");
  g.git(made[1]!, "-c", "core.editor=true", "cherry-pick", "--continue");
  expect((await planOf("Change a")).part).not.toHaveProperty("conflict");
  // `d`: the commit's diff as a review in the head workspace.
  await reviews.handle("bridge.mr_reviews.effort.open_commit", {
    id: "Big",
    sha: a,
  });
  expect(opened).toEqual([
    expect.objectContaining({
      workspaceId: "w1",
      root: clone,
      base: `${a}^`,
      head: a,
      title: "pool: add a",
    }),
  ]);
  // Two versions (D32): compared tree to tree in the same Changes.
  await reviews.handle("bridge.mr_reviews.effort.open_commit", {
    id: "Big",
    sha: a2,
    from: a,
  });
  expect(opened[1]).toEqual(
    expect.objectContaining({
      workspaceId: "w1",
      base: a,
      head: a2,
      compare: true,
    }),
  );
  const diff = (await reviews.handle("bridge.mr_reviews.effort.diff", {
    id: "Big",
    from: a,
    to: a2,
  })) as { text: string };
  expect(diff.text).toContain("pool");
  // The threads on its view: read, then opened in the head's checkout by
  // the first comment, for its leader.
  expect(
    await reviews.handle("bridge.mr_reviews.effort.threads", { id: "Big" }),
  ).toEqual({ snapshot: null });
  const effortId = (await reviews.settings()).efforts[0]!.id;
  expect(threads[0]).toEqual({
    effort: effortId,
    connectionId: "local",
    root: clone,
    title: "Effort Big",
    open: false,
  });
  await reviews.handle("bridge.mr_reviews.effort.threads", {
    id: "Big",
    open: true,
  });
  expect(threads[1]).toEqual({
    effort: effortId,
    connectionId: "local",
    workspaceId: "w1",
    root: clone,
    title: "Effort Big",
    open: true,
  });
}, 30_000);

test("a part of an effort headed in a linked worktree starts from the repository's parent workspace, else its main checkout's path", async () => {
  const g = createGitFixture();
  fixtures.push(g);
  g.project("media/engine");
  const clone = g.clone("media/engine", "engine");
  g.git(clone, "checkout", "-q", "-b", "big");
  g.commit(clone, "pool/a.c", "a\n", "pool: add a");
  g.commit(clone, "pool/b.c", "b\n", "pool: add b");
  g.git(clone, "checkout", "-q", "main");
  // The effort's head: a linked worktree of the clone, alone in its group.
  const head = join(g.root, "head");
  g.git(clone, "worktree", "add", "-q", head, "big");
  const repo_key = join(clone, ".git");
  const workspaces: {
    workspace_id: string;
    label: string;
    cwd: string;
    worktree?: Record<string, unknown>;
  }[] = [
    {
      workspace_id: "w1",
      label: "engine",
      cwd: clone,
      worktree: { is_linked_worktree: false, repo_key },
    },
    {
      workspace_id: "w2",
      label: "head",
      cwd: head,
      worktree: { is_linked_worktree: true, repo_key },
    },
  ];
  const connection = g.connection(workspaces);
  await updateGuiSettings((current) => ({
    ...current,
    mr_reviews: {
      hosts: [{ host: FORGE_HOST, provider: "gitlab" }],
      upstream_groups: ["g1"],
    },
  }));
  const calls: Record<string, unknown>[] = [];
  const reviews = createMrReviews({
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    store: openMrStore(join(dir, `state-${Math.random()}.json`)),
    discoverHosts: () => [],
    connections: () => [connection],
    tree: {
      read: async () => ({
        version: WORKSPACE_TREE_VERSION,
        nodes: [
          { id: "g1", kind: "group", parent: null, label: "Big" },
          {
            id: "n1",
            kind: "workspace",
            parent: "g1",
            ref: { connection_id: "local", label: "head" },
          },
        ],
      }),
      apply: async () => {},
    },
    // As Herdr does: no new worktree from a linked one, by id or by path.
    createWorktree: async (input) => {
      calls.push(input);
      const source = workspaces.find(
        (each) => each.workspace_id === input.workspaceId,
      );
      if (
        source?.worktree?.is_linked_worktree === true ||
        (input.cwd !== undefined && input.cwd !== clone)
      )
        throw new Error(
          "linked_worktree_source: New and open worktree actions start from the repo parent workspace.",
        );
      const path = join(g.root, `part-${input.branch}`);
      g.git(
        clone,
        "worktree",
        "add",
        "-q",
        "-b",
        input.branch,
        path,
        "origin/main",
      );
      return { path };
    },
    effortsDir: join(dir, `efforts-${Math.random()}`),
  });
  await reviews.upstream.refresh(true);
  await reviews.boardTool(
    "effort_set",
    { group: "Big", source: "refs/heads/big", head: "head" },
    "Claude",
  );
  await reviews.efforts.refresh(true);
  const [a, b] = JSON.parse(
    (
      await reviews.boardTool("ledger_list", { effort: "Big" }, "Claude")
    ).replace(/^[^\n]*\n/, ""),
  ).commits.map((c: any) => c.sha);
  for (const [name, sha] of [
    ["Pool a", a],
    ["Pool b", b],
  ])
    await reviews.handle("bridge.mr_reviews.ledger.plans", {
      id: "Big",
      action: "propose",
      name,
      commits: [sha],
      accepted: true,
    });
  // The main checkout's workspace is open: the part starts there.
  expect(
    await reviews.handle("bridge.mr_reviews.effort.part", {
      id: "Big",
      plan: "Pool a",
      branch: "pool-a",
    }),
  ).toMatchObject({ ok: true, picked: 1 });
  expect(calls[0]).toEqual({
    connectionId: "local",
    workspaceId: "w1",
    branch: "pool-a",
  });
  // None open there: the main checkout's path.
  workspaces.splice(0, 1);
  expect(
    await reviews.handle("bridge.mr_reviews.effort.part", {
      id: "Big",
      plan: "Pool b",
      branch: "pool-b",
    }),
  ).toMatchObject({ ok: true, picked: 1 });
  expect(calls[1]).toEqual({
    connectionId: "local",
    cwd: clone,
    branch: "pool-b",
  });
}, 30_000);

test("Herdr's errors read without their code or a closing period", () => {
  expect(
    readableError(
      new Error(
        "linked_worktree_source: New and open worktree actions start from the repo parent workspace.",
      ),
    ),
  ).toBe("New and open worktree actions start from the repo parent workspace");
  expect(readableError("Worktree command failed (exit 1): no")).toBe(
    "Worktree command failed (exit 1): no",
  );
});

test("export and import through the panel: a preview first, applied with a push", async () => {
  await updateGuiSettings((current) => ({
    ...current,
    mr_reviews: {
      hosts: [{ host: FORGE_HOST, provider: "gitlab" }],
      views: [{ name: "media", query: "project:media/*" }],
    },
  }));
  const pushes: MrReviewsPush[] = [];
  const reviews = createMrReviews({
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    store: openMrStore(join(dir, `state-${Math.random()}.json`)),
    discoverHosts: () => [],
    connections: () => [],
    publish: (push) => pushes.push(push),
    effortsDir: join(dir, `efforts-${Math.random()}`),
  });
  const { text } = (await reviews.handle("bridge.mr_reviews.export", {})) as {
    text: string;
  };
  // The hosts list, followed projects and hints too (D30).
  expect(JSON.parse(text).mr_reviews).toEqual({
    followed: [],
    hints: "",
    hosts: [{ host: FORGE_HOST, provider: "gitlab" }],
    views: [{ name: "media", query: "project:media/*" }],
  });
  const changed = text.replace("project:media/*", "project:media/gst");
  const preview = (await reviews.handle("bridge.mr_reviews.import", {
    text: changed,
  })) as { applied: boolean; changes: unknown[] };
  expect(preview).toEqual({
    applied: false,
    changes: [{ path: "mr_reviews.views[media]", kind: "changed" }],
  });
  expect((await reviews.settings()).views[0]!.query).toBe("project:media/*");
  await reviews.handle("bridge.mr_reviews.import", {
    text: changed,
    apply: true,
  });
  expect((await reviews.settings()).views[0]!.query).toBe("project:media/gst");
  expect(pushes.at(-1)?.changed).toContain("views");
  await expect(
    reviews.handle("bridge.mr_reviews.import", { text: "{}" }),
  ).rejects.toThrow(/not a Reviews export/);
});

test("a pick already in the target is skipped and said; a real conflict stops", async () => {
  const g = createGitFixture();
  fixtures.push(g);
  g.project("media/engine");
  const clone = g.clone("media/engine", "engine");
  g.git(clone, "checkout", "-q", "-b", "big");
  const same = g.commit(clone, "pool/b.c", "b\n", "pool: add b");
  const next = g.commit(clone, "pool/c.c", "c\n", "pool: add c");
  // The target holds b already, within a larger change.
  g.git(clone, "checkout", "-q", "-b", "target", "origin/main");
  g.commit(clone, "pool/b.c", "b\n", "pool: b and more");
  g.git(
    clone,
    "worktree",
    "add",
    "-q",
    "-b",
    "part",
    `${g.root}/part`,
    "target",
  );
  const connection = g.connection([]);
  const run = async (shas: string[]) =>
    parsePick(
      (
        await connection.run(
          pickScript(`${g.root}/part`, ["refs/heads/target"], shas, "part"),
          60_000,
        )
      ).stdout,
    );
  expect(await run([same.trim(), next.trim()])).toEqual({
    picked: 1,
    files: [],
    skipped: [same.trim()],
    onBranch: { count: 1, ids: [expect.stringMatching(/^[0-9a-f]{40}$/)] },
  });
  expect(g.git(`${g.root}/part`, "log", "--format=%s", "-2").trim()).toBe(
    "pool: add c\npool: b and more",
  );
});

/** A clone with a part worktree on origin/main, and a pick runner there. */
function partFixture() {
  const g = createGitFixture();
  fixtures.push(g);
  g.project("media/engine");
  const clone = g.clone("media/engine", "engine");
  g.git(clone, "checkout", "-q", "-b", "big");
  const part = `${g.root}/part`;
  const connection = g.connection([]);
  const run = async (shas: string[]) =>
    parsePick(
      (
        await connection.run(
          pickScript(part, ["refs/remotes/origin/main"], shas, "part"),
          60_000,
        )
      ).stdout,
    );
  const worktree = () =>
    g.git(clone, "worktree", "add", "-q", "-b", "part", part, "origin/main");
  return { g, clone, part, connection, run, worktree };
}

test("fixups fold into their targets in the part: the same tree, a squash! adds its body, a fixup without its target stays and is said", async () => {
  const { g, clone, part, run, worktree } = partFixture();
  g.commit(clone, "pool/x.c", "x\n", "pool: add x");
  const a = g.commit(clone, "pool/a.c", "a\n", "pool: add a");
  const b = g.commit(clone, "pool/b.c", "b\n", "pool: add b");
  const fa = g.commit(clone, "pool/a.c", "a fixed\n", "fixup! pool: add a");
  const sb = g.commit(
    clone,
    "pool/b.c",
    "b better\n",
    "squash! pool: add b\n\nAlso why b is better.",
  );
  const fx = g.commit(clone, "pool/y.c", "y\n", "fixup! pool: add x");
  const shas = [a, b, fa, sb, fx];
  // The tree the picks make without folding, in a scratch worktree.
  g.git(
    clone,
    "worktree",
    "add",
    "-q",
    "--detach",
    `${g.root}/plain`,
    "origin/main",
  );
  for (const sha of shas) g.git(`${g.root}/plain`, "cherry-pick", sha);
  const plain = g.git(`${g.root}/plain`, "rev-parse", "HEAD^{tree}").trim();
  worktree();
  expect(await run(shas)).toEqual({
    picked: 5,
    files: [],
    skipped: [],
    onBranch: { count: 5, ids: expect.any(Array) },
    fold: { count: 3, sameTree: true, unfolded: ["fixup! pool: add x"] },
  });
  expect(g.git(part, "rev-parse", "HEAD^{tree}").trim()).toBe(plain);
  expect(
    g.git(part, "log", "--reverse", "--format=%s", "origin/main..HEAD").trim(),
  ).toBe("pool: add a\npool: add b\nfixup! pool: add x");
  expect(g.git(part, "log", "-1", "--format=%B", "HEAD~2").trim()).toBe(
    "pool: add a",
  );
  expect(g.git(part, "log", "-1", "--format=%B", "HEAD~1").trim()).toBe(
    "pool: add b\n\nAlso why b is better.",
  );
  // The Plans tab says the same before the part is made.
  expect(
    fixupTargets(
      [
        "pool: add a",
        "pool: add b",
        "fixup! pool: add a",
        "squash! pool: add b",
        "fixup! pool: add x",
      ].map((subject, index) => ({ sha: shas[index]!, subject })),
    ),
  ).toEqual([undefined, undefined, 0, 1, -1]);
});

test("folding a fixup that conflicts stops there and is reported, nothing aborted", async () => {
  const { g, clone, part, connection, run, worktree } = partFixture();
  const a = g.commit(clone, "pool/a.c", "1\n", "pool: add a");
  const b = g.commit(clone, "pool/a.c", "2\n", "pool: change a");
  const fa = g.commit(clone, "pool/a.c", "3\n", "fixup! pool: add a");
  worktree();
  const result = await run([a, b, fa]);
  const stopped = g
    .git(part, "rev-parse", "-q", "--verify", "REBASE_HEAD")
    .trim();
  expect(result).toMatchObject({
    picked: 3,
    files: ["pool/a.c"],
    folding: { sha: stopped, subject: "fixup! pool: add a" },
  });
  expect(result.fold).toBeUndefined();
  expect(g.git(part, "log", "-1", "--format=%s", stopped).trim()).toBe(
    "fixup! pool: add a",
  );
  // The view reads it as that part's stop.
  const stops = parsePartStops(
    (await connection.run(partStopsScript([part]), 30_000)).stdout,
  );
  expect(stops.get(part)).toEqual({
    sha: stopped,
    files: ["pool/a.c"],
    subject: "fixup! pool: add a",
    folding: true,
  });
});

test("a part folds its plan's fixups, says the ones it cannot, and starts from an upstream branch holding the plan", async () => {
  const g = createGitFixture();
  fixtures.push(g);
  g.project("media/engine");
  const clone = g.clone("media/engine", "engine");
  g.git(clone, "checkout", "-q", "-b", "big");
  g.commit(clone, "pool/x.c", "x\n", "pool: add x");
  g.commit(clone, "pool/a.c", "a\n", "pool: add a");
  g.commit(clone, "pool/b.c", "b\n", "pool: add b");
  g.commit(clone, "pool/a.c", "a fixed\n", "fixup! pool: add a");
  g.commit(clone, "pool/y.c", "y\n", "fixup! pool: add x");
  g.commit(clone, "pool/b.c", "b better\n", "fixup! pool: add b");
  // b and its fixup, already one commit on a local upstream branch.
  g.git(clone, "branch", "-q", "upstream/pool-b", "origin/main");
  g.git(clone, "checkout", "-q", "upstream/pool-b");
  const squashed = g.commit(clone, "pool/b.c", "b better\n", "pool: add b");
  g.git(clone, "checkout", "-q", "big");
  const workspaces = [{ workspace_id: "w1", label: "big", cwd: clone }];
  const connection = g.connection(workspaces);
  await updateGuiSettings((current) => ({
    ...current,
    mr_reviews: {
      hosts: [{ host: FORGE_HOST, provider: "gitlab" }],
      upstream_groups: ["g1"],
    },
  }));
  const nodes: any[] = [
    { id: "g1", kind: "group", parent: null, label: "Big" },
    {
      id: "n1",
      kind: "workspace",
      parent: "g1",
      ref: { connection_id: "local", label: "big" },
    },
  ];
  const made: string[] = [];
  const reviews = createMrReviews({
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    store: openMrStore(join(dir, `state-${Math.random()}.json`)),
    discoverHosts: () => [],
    connections: () => [connection],
    tree: {
      read: async () => ({ version: WORKSPACE_TREE_VERSION, nodes }),
      apply: async (ops) => {
        for (const op of ops as any[])
          if (op.op === "move")
            nodes.push({
              id: `n${nodes.length}`,
              kind: "workspace",
              parent: op.parent.node,
              ref: {
                connection_id: "local",
                label: op.subject.workspace.path.split("/").pop(),
              },
            });
      },
    },
    createWorktree: async ({ branch }) => {
      const path = join(g.root, `part-${branch.replace(/\//g, "-")}`);
      g.git(clone, "worktree", "add", "-q", "-b", branch, path, "origin/main");
      made.push(path);
      workspaces.push({
        workspace_id: `w${workspaces.length + 1}`,
        label: path.split("/").pop()!,
        cwd: path,
      });
      return { path, workspaceId: `w${workspaces.length}` };
    },
    effortsDir: join(dir, `efforts-${Math.random()}`),
  });
  await reviews.upstream.refresh(true);
  await reviews.boardTool(
    "effort_set",
    { group: "Big", source: "refs/heads/big" },
    "Claude",
  );
  await reviews.efforts.refresh(true);
  const [, a, b, fa, fx, fb] = JSON.parse(
    (
      await reviews.boardTool("ledger_list", { effort: "Big" }, "Claude")
    ).replace(/^[^\n]*\n/, ""),
  ).commits.map((c: any) => c.sha);
  const plan = (name: string, commits: string[]) =>
    reviews.handle("bridge.mr_reviews.ledger.plans", {
      id: "Big",
      action: "propose",
      name,
      commits,
      accepted: true,
    });
  await plan("Pool a", [a, fa, fx]);
  await plan("Pool b", [b, fb]);
  // a and its fixup: one commit; x's fixup, its target not in the plan,
  // left as a commit and said.
  expect(
    JSON.parse(
      await reviews.boardTool(
        "part_create",
        { effort: "Big", plan: "Pool a" },
        "Claude",
      ),
    ),
  ).toMatchObject({
    ok: true,
    branch: "pool-a",
    picked: 3,
    of: 3,
    folded: 1,
    unfolded: [
      {
        sha: expect.stringMatching(new RegExp(`^${fx}`)),
        subject: "fixup! pool: add x",
      },
    ],
  });
  expect(
    g
      .git(made[0]!, "log", "--reverse", "--format=%s", "origin/main..HEAD")
      .trim(),
  ).toBe("pool: add a\nfixup! pool: add x");
  // A branch named by from that lacks the plan's changes: refused, nothing made.
  await expect(
    reviews.handle("bridge.mr_reviews.effort.part", {
      id: "Big",
      plan: "Pool b",
      from: "pool-a",
    }),
  ).rejects.toThrow(/pool-a does not hold the plan's changes/);
  expect(made).toHaveLength(1);
  // upstream/pool-b holds b and its fixup: the part starts there.
  expect(
    await reviews.handle("bridge.mr_reviews.effort.part", {
      id: "Big",
      plan: "Pool b",
    }),
  ).toMatchObject({
    ok: true,
    branch: "pool-b",
    picked: 2,
    of: 2,
    from: "upstream/pool-b",
  });
  expect(g.git(made[1]!, "rev-parse", "HEAD").trim()).toBe(squashed);
  expect(g.git(clone, "rev-parse", "upstream/pool-b").trim()).toBe(squashed);
  const planned = (
    (await reviews.handle("bridge.mr_reviews.effort.get", {
      id: "Big",
    })) as { plans: any[] }
  ).plans;
  expect(planned.find((each) => each.name === "Pool b").part).toMatchObject({
    branch: "pool-b",
    from: "upstream/pool-b",
  });
  // Their commits count in a part though their patch ids changed.
  await reviews.efforts.refresh(true);
  expect(
    (await reviews.inbox.get({ viewer: false })).efforts![0]!.counts,
  ).toMatchObject({ in_part: 5, unsorted: 1 });
}, 30_000);

test("a duplicate effort deleted by a tool: by id only, the other's ledger kept, Undo restores it, no branch touched", async () => {
  const g = createGitFixture();
  fixtures.push(g);
  g.project("media/engine");
  const clone = g.clone("media/engine", "engine");
  g.git(clone, "checkout", "-q", "-b", "big");
  g.commit(clone, "pool/a.c", "a\n", "pool: add a");
  g.commit(clone, "pool/b.c", "b\n", "pool: add b");
  const connection = g.connection([
    { workspace_id: "w1", label: "big", cwd: clone },
  ]);
  await updateGuiSettings((current) => ({
    ...current,
    mr_reviews: {
      hosts: [{ host: FORGE_HOST, provider: "gitlab" }],
      upstream_groups: ["g1"],
    },
  }));
  const pushes: MrReviewsPush[] = [];
  const reviews = createMrReviews({
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    store: openMrStore(join(dir, `state-${Math.random()}.json`)),
    discoverHosts: () => [],
    connections: () => [connection],
    tree: {
      read: async () => ({
        version: WORKSPACE_TREE_VERSION,
        nodes: [
          { id: "g1", kind: "group", parent: null, label: "Big" },
          {
            id: "n1",
            kind: "workspace",
            parent: "g1",
            ref: { connection_id: "local", label: "big" },
          },
        ],
      }),
      apply: async () => {},
    },
    publish: (push) => pushes.push(push),
    effortsDir: join(dir, `efforts-${Math.random()}`),
  });
  await reviews.upstream.refresh(true);
  // The same branch declared twice: two efforts named Big, the same commits.
  const declare = async () =>
    JSON.parse(
      await reviews.boardTool(
        "effort_set",
        { group: "Big", source: "refs/heads/big" },
        "Claude",
      ),
    ).effort.id as string;
  const kept = await declare();
  const duplicate = await declare();
  expect(kept).not.toBe(duplicate);
  await reviews.efforts.refresh(true);
  const list = JSON.parse(
    (
      await reviews.boardTool("ledger_list", { effort: kept }, "Claude")
    ).replace(/^[^\n]*\n/, ""),
  );
  const [a, b] = list.commits.map((c: any) => c.sha);
  // Each marks a different commit (same patch ids in both).
  await reviews.handle("bridge.mr_reviews.ledger.set", {
    id: kept,
    commits: [b],
    disposition: "not_for_upstream",
    reason: "debug only",
  });
  await reviews.handle("bridge.mr_reviews.ledger.set", {
    id: duplicate,
    commits: [a],
    disposition: "superseded",
    pointer: "elsewhere",
  });
  await reviews.handle("bridge.mr_reviews.ledger.plans", {
    id: kept,
    action: "propose",
    name: "Pool a",
    commits: [a],
  });
  const branches = g.git(clone, "branch", "--list").trim();
  // A name both have deletes neither.
  await expect(
    reviews.boardTool("effort_delete", { effort: "big" }, "Claude"),
  ).rejects.toThrow(/several efforts are named Big: give its id/);
  expect((await reviews.settings()).efforts).toHaveLength(2);
  const done = await reviews.boardTool(
    "effort_delete",
    { effort: duplicate },
    "Claude in lead",
  );
  expect(done).toContain(`Deleted the effort Big (${duplicate})`);
  expect((await reviews.settings()).efforts.map((each) => each.id)).toEqual([
    kept,
  ]);
  const push = pushes.at(-1)!;
  expect(push).toMatchObject({
    changed: ["efforts"],
    by: "agent",
    summary: "Claude in lead deleted the effort Big",
  });
  expect(push.undo).toBeNumber();
  // The other effort's ledger and plans, untouched; no branch moved.
  await reviews.efforts.refresh(true);
  const cards = () => reviews.inbox.get({ viewer: false });
  expect((await cards()).efforts!.map((each) => each.id)).toEqual([kept]);
  expect((await cards()).efforts![0]!.counts).toEqual({
    planned: 1,
    not_for_upstream: 1,
  });
  expect((await cards()).efforts![0]!.plans).toEqual({
    proposed: 1,
    accepted: 0,
  });
  expect(g.git(clone, "branch", "--list").trim()).toBe(branches);
  // Undo brings it back with its own marks.
  await reviews.handle("bridge.mr_reviews.order", {
    op: "undo",
    version: push.undo,
  });
  await reviews.efforts.refresh(true);
  const back = (await cards()).efforts!.find((each) => each.id === duplicate);
  expect(back?.counts).toEqual({ unsorted: 1, superseded: 1 });
  expect(
    (await cards()).efforts!.find((each) => each.id === kept)?.counts,
  ).toEqual({ planned: 1, not_for_upstream: 1 });
  await expect(
    reviews.boardTool("effort_delete", { effort: "nope" }, "Claude"),
  ).rejects.toThrow(/no such effort/);
});

test("what a part holds is read back from its branch, never taken from the pick", () => {
  // One commit with a diff and one empty: only what the branch holds.
  const commits = [{ patchId: "p1" }, { patchId: "sha:e1" }];
  expect(pickedOnBranch(commits, { count: 2, ids: ["p1"] })).toBe(2);
  expect(pickedOnBranch(commits, { count: 1, ids: ["p1"] })).toBe(1);
  expect(pickedOnBranch(commits, { count: 1, ids: ["other"] })).toBe(0);
  expect(pickedOnBranch(commits, { count: 0, ids: [] })).toBe(0);
});

test("a part never goes into an existing worktree or onto an existing branch", async () => {
  const g = createGitFixture();
  fixtures.push(g);
  g.project("media/engine");
  const clone = g.clone("media/engine", "engine");
  g.git(clone, "checkout", "-q", "-b", "big");
  g.commit(clone, "pool/a.c", "a\n", "pool: add a");
  g.commit(clone, "pool/b.c", "b\n", "pool: add b");
  // A layer of the stack already has b, in its own worktree at the path
  // the part's branch would get.
  const layer = join(g.root, "pool-b");
  g.git(clone, "worktree", "add", "-q", "-b", "layer", layer, "big");
  const layerHead = g.git(layer, "rev-parse", "HEAD").trim();
  const workspaces = [{ workspace_id: "w1", label: "big", cwd: clone }];
  const connection = g.connection(workspaces);
  await updateGuiSettings((current) => ({
    ...current,
    mr_reviews: {
      hosts: [{ host: FORGE_HOST, provider: "gitlab" }],
      upstream_groups: ["g1"],
    },
  }));
  const placed: unknown[] = [];
  const reviews = createMrReviews({
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    store: openMrStore(join(dir, `state-${Math.random()}.json`)),
    discoverHosts: () => [],
    connections: () => [connection],
    tree: {
      read: async () => ({
        version: WORKSPACE_TREE_VERSION,
        nodes: [
          { id: "g1", kind: "group", parent: null, label: "Big" },
          {
            id: "n1",
            kind: "workspace",
            parent: "g1",
            ref: { connection_id: "local", label: "big" },
          },
        ],
      }),
      apply: async (ops) => {
        placed.push(...ops);
      },
    },
    // As git recworktree does: the branch made, an existing checkout at
    // the path taken as done, and that path given back.
    createWorktree: async ({ branch }) => {
      const path = join(g.root, branch);
      g.git(clone, "branch", branch, "origin/main");
      const listed = g.git(clone, "worktree", "list", "--porcelain");
      if (!listed.includes(`worktree ${path}\n`))
        g.git(clone, "worktree", "add", "-q", path, branch);
      return { path };
    },
    effortsDir: join(dir, `efforts-${Math.random()}`),
  });
  await reviews.upstream.refresh(true);
  await reviews.boardTool(
    "effort_set",
    { group: "Big", source: "refs/heads/big" },
    "Claude",
  );
  await reviews.efforts.refresh(true);
  const list = JSON.parse(
    (
      await reviews.boardTool("ledger_list", { effort: "Big" }, "Claude")
    ).replace(/^[^\n]*\n/, ""),
  );
  const b = list.commits[1].sha;
  await reviews.handle("bridge.mr_reviews.ledger.plans", {
    id: "Big",
    action: "propose",
    name: "Pool b",
    commits: [b],
    accepted: true,
  });
  // An existing branch is refused before anything is made.
  await expect(
    reviews.boardTool(
      "part_create",
      { effort: "Big", plan: "Pool b", branch: "layer" },
      "Claude",
    ),
  ).rejects.toThrow(/branch layer exists already/);
  // The path held the layer's worktree: refused, nothing picked or moved.
  await expect(
    reviews.boardTool(
      "part_create",
      { effort: "Big", plan: "Pool b" },
      "Claude",
    ),
  ).rejects.toThrow(/not a new worktree on pool-b \(it is on layer\)/);
  expect(g.git(layer, "rev-parse", "HEAD").trim()).toBe(layerHead);
  expect(g.git(layer, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/layer");
  expect(placed).toEqual([]);
  const plan = (
    (await reviews.handle("bridge.mr_reviews.effort.get", {
      id: "Big",
    })) as { plans: any[] }
  ).plans.find((each) => each.name === "Pool b");
  expect(plan).not.toHaveProperty("part");
}, 30_000);

test("an effort's leader is its head workspace's conversation session, even stopped", async () => {
  const g = createGitFixture();
  fixtures.push(g);
  g.project("media/engine");
  const clone = g.clone("media/engine", "engine");
  g.git(clone, "checkout", "-q", "-b", "big");
  g.commit(clone, "pool/a.c", "a\n", "pool: add a");
  const base = g.connection([{ workspace_id: "w1", label: "big", cwd: clone }]);
  // Conversation mode holds w1:p1, its process stopped: Herdr sees only
  // the holder there (agent.get: not found).
  let held: string | null = "held-session";
  const connection = {
    ...base,
    herdr: async (method: string, params?: Record<string, unknown>) => {
      if (method === "agent.get")
        throw new Error(`agent_not_found: ${String(params?.target)}`);
      return base.herdr(method, params);
    },
    conversation: {
      owned: (paneId: string) => (paneId === "w1:p1" ? held : null),
      switch: async () => ({ ok: true as const }),
    },
  };
  await updateGuiSettings((current) => ({
    ...current,
    mr_reviews: {
      hosts: [{ host: FORGE_HOST, provider: "gitlab" }],
      upstream_groups: ["g1"],
    },
  }));
  const reviews = createMrReviews({
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    store: openMrStore(join(dir, `state-${Math.random()}.json`)),
    discoverHosts: () => [],
    connections: () => [connection],
    tree: {
      read: async () => ({
        version: WORKSPACE_TREE_VERSION,
        nodes: [
          { id: "g1", kind: "group", parent: null, label: "Big" },
          {
            id: "n1",
            kind: "workspace",
            parent: "g1",
            ref: { connection_id: "local", label: "big" },
          },
        ],
      }),
      apply: async () => {},
    },
    publish: () => {},
    effortsDir: join(dir, `efforts-${Math.random()}`),
  });
  await reviews.upstream.refresh(true);
  const id = JSON.parse(
    await reviews.boardTool(
      "effort_set",
      { group: "Big", source: "refs/heads/big" },
      "Claude",
    ),
  ).effort.id as string;
  expect(
    await reviews.handle("bridge.mr_reviews.effort.leader", { id }),
  ).toEqual({
    state: "ready",
    connectionId: "local",
    workspaceId: "w1",
    paneId: "w1:p1",
  });
  // Given back to the terminal and no agent there: a pane to start one in.
  held = null;
  expect(
    await reviews.handle("bridge.mr_reviews.effort.leader", { id }),
  ).toEqual({ state: "none", connectionId: "local", workspaceId: "w1" });
});
