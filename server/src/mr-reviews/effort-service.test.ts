import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MrReviewsPush } from "../../../shared/mrReviews";
import { WORKSPACE_TREE_VERSION } from "../../../shared/workspaceTree";
import { updateGuiSettings } from "../config/gui-settings";
import { createGitFixture, FORGE_HOST, type GitFixture } from "./git.fixture";
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
  // "big" is a local branch and a remote one: ambiguous, refused.
  await expect(
    reviews.boardTool(
      "effort_set",
      { group: "Big upstreaming", source: "big" },
      "Claude",
    ),
  ).rejects.toThrow(/ambiguous.*refs\/heads\/big.*refs\/remotes\/origin\/big/);
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
