import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { MrEffort } from "../../../shared/mrReviews";
import {
  clusterLedger,
  createLedgerStore,
  deriveEffort,
  overlapOf,
  setDispositions,
  undoLedger,
} from "./efforts";
import { createGitFixture, type GitFixture } from "./git.fixture";

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const each of fixtures.splice(0)) each.cleanup();
});

const effortOf = (clone: string, extra: Partial<MrEffort> = {}): MrEffort => ({
  id: "e1",
  group: "g1",
  name: "Big",
  clone: { connectionId: "local", path: clone },
  source: "refs/heads/big",
  target: { remote: "origin", branch: "main" },
  feeders: [],
  ...extra,
});

test("a ledger: upstream by patch id, authored dispositions kept across a reword and a rebase, history, undo", async () => {
  const g = createGitFixture();
  fixtures.push(g);
  const bare = g.project("media/engine");
  const clone = g.clone("media/engine", "engine");
  g.git(clone, "checkout", "-q", "-b", "big");
  g.commit(clone, "pool/a.c", "a\n", "pool: add a");
  g.commit(clone, "pool/b.c", "b\n", "pool: add b");
  g.commit(clone, "docs/x.md", "x\n", "fixup! pool: add a");
  g.commit(clone, "tests/t.c", "t\n", "Add a test");
  // Upstream took "pool: add b" under another sha.
  const up = g.clone("media/engine", "up");
  g.commit(up, "pool/b.c", "b\n", "pool: add b (upstream)");
  g.git(up, "push", "-q", bare, "main");
  g.git(clone, "checkout", "-q", "-b", "feed");
  g.commit(clone, "feed.c", "f\n", "Not on big yet");
  g.git(clone, "checkout", "-q", "big");
  const connection = g.connection([]);
  const store = createLedgerStore(join(g.root, "efforts"));
  const effort = effortOf(clone, { feeders: ["refs/heads/feed"] });
  const derive = async (force = false) =>
    (
      await deriveEffort({
        effort,
        connection,
        store,
        checkTarget: true,
        requests: async () => [],
        force,
      })
    ).derived;
  let derived = await derive();
  expect(derived.commits.map((c) => [c.subject, c.disposition, c.dir])).toEqual(
    [
      ["pool: add a", "unsorted", "pool"],
      ["pool: add b", "upstream", "pool"],
      ["fixup! pool: add a", "unsorted", "docs"],
      ["Add a test", "unsorted", "tests"],
    ],
  );
  // The target was fetched into Roamgate's own ref, not origin/main.
  expect(
    g.git(clone, "rev-parse", "refs/roamgate/upstream/origin/main").trim(),
  ).toBe(g.git(up, "rev-parse", "HEAD").trim());
  expect(g.git(clone, "rev-parse", "origin/main").trim()).not.toBe(
    g.git(up, "rev-parse", "HEAD").trim(),
  );
  expect(derived.feeders).toMatchObject([
    { ref: "refs/heads/feed", notReady: 1, drift: 0 },
  ]);
  // Unchanged heads: no commit read again.
  const before = connection.scripts.length;
  await derive();
  expect(connection.scripts.length).toBe(before + 1);

  const test = derived.commits[3]!;
  const done = await setDispositions(store, effort, {
    commits: [test.sha.slice(0, 10)],
    disposition: "not_for_upstream",
    reason: "local only",
    by: "agent",
    summary: "test kept here",
  });
  expect(done).toMatchObject({ changed: 1, unknown: [] });
  derived = await derive();
  expect(derived.commits[3]).toMatchObject({
    disposition: "not_for_upstream",
    note: "local only",
  });
  // Reworded: a new sha, the same patch id, the same key.
  g.git(clone, "commit", "-q", "--amend", "-m", "Add a test", "--allow-empty");
  // Changed content, same subject and author date: the secondary key.
  Bun.write(join(clone, "tests/t.c"), "t2\n");
  g.git(clone, "add", "tests/t.c");
  g.git(clone, "commit", "-q", "--amend", "--no-edit");
  derived = await derive();
  expect(derived.commits[3]).toMatchObject({
    key: test.key,
    disposition: "not_for_upstream",
  });
  expect(derived.commits[3]!.patchId).not.toBe(test.patchId);
  expect(store.history("e1", test.key).length).toBe(2);
  expect(store.ledger("e1").aliases[derived.commits[3]!.patchId]).toBe(
    test.key,
  );
  // A bulk change all or nothing; Undo takes the last one back.
  await expect(
    setDispositions(store, effort, {
      commits: [derived.commits[0]!.sha, "deadbeef00"],
      disposition: "planned",
      by: "user",
      summary: "x",
    }),
  ).resolves.toMatchObject({ changed: 0, unknown: ["deadbeef00"] });
  expect((await undoLedger(store, "e1")).undone).toBe("test kept here");
  derived = await derive();
  expect(derived.commits[3]!.disposition).toBe("unsorted");
  // The leader's first grouping: fixups with their commit, by directory.
  expect(
    clusterLedger(
      derived.commits.filter((c) => c.disposition === "unsorted"),
    ).map((c) => c.label),
  ).toEqual(["tests", "pool pool:"]);
});

test("overlaps: same, contains, partial", () => {
  const a = new Set(["1", "2", "3"]);
  expect(
    overlapOf(a, new Set(["1", "2", "3"]), { with: "B", kind: "effort" })
      ?.relation,
  ).toBe("same");
  expect(
    overlapOf(a, new Set(["1"]), { with: "B", kind: "effort" })?.relation,
  ).toBe("contains");
  expect(
    overlapOf(a, new Set(["1", "2", "3", "4"]), { with: "B", kind: "effort" })
      ?.relation,
  ).toBe("contained");
  expect(
    overlapOf(a, new Set(["3", "9"]), { with: "B", kind: "branch" }),
  ).toMatchObject({
    relation: "partial",
    shared: 1,
  });
  expect(overlapOf(a, new Set(["9"]), { with: "B", kind: "effort" })).toBe(
    null,
  );
});

test("880 commits: derived within the bound, then nothing run while the heads hold", async () => {
  const g = createGitFixture();
  fixtures.push(g);
  g.project("media/engine");
  const clone = g.clone("media/engine", "engine");
  const base = g.git(clone, "rev-parse", "HEAD").trim();
  // fast-import: big with 880 commits, main with every third one's patch.
  const lines: string[] = [];
  const add = (branch: string, from: string, mark: number, i: number) => {
    const data = `line ${i}\n`;
    lines.push(
      `commit refs/heads/${branch}`,
      `mark :${mark}`,
      `author Test <test@example.org> ${1_760_000_000 + i} +0000`,
      `committer Test <test@example.org> ${1_760_000_000 + i} +0000`,
      `data ${`${branch} change ${i}`.length}`,
      `${branch} change ${i}`,
      `from ${from}`,
      `M 100644 inline dir${i % 12}/file${i}.c`,
      `data ${data.length}`,
      data,
    );
  };
  let from = base;
  for (let i = 0; i < 880; i++) {
    add("big", from, i + 1, i);
    from = `:${i + 1}`;
  }
  from = base;
  for (let i = 0; i < 880; i += 3) {
    add("newmain", from, 10_000 + i, i);
    from = `:${10_000 + i}`;
  }
  const result = Bun.spawnSync(["git", "-C", clone, "fast-import", "--quiet"], {
    stdin: new Blob([`${lines.join("\n")}\n`]),
    env: { ...process.env, HOME: join(g.root, "home") },
  });
  expect(result.exitCode).toBe(0);
  g.git(clone, "update-ref", "refs/remotes/origin/main", "refs/heads/newmain");
  const connection = g.connection([]);
  const store = createLedgerStore(join(g.root, "efforts"));
  const effort = effortOf(clone);
  const started = performance.now();
  const { derived } = await deriveEffort({
    effort,
    connection,
    store,
    // No remote copy to fetch: the clone's own origin/main is the target.
    checkTarget: false,
    requests: async () => [],
  });
  const took = performance.now() - started;
  expect(derived.commits.length).toBe(880);
  expect(
    derived.commits.filter((c) => c.disposition === "upstream").length,
  ).toBe(294);
  expect(took).toBeLessThan(30_000);
  const scripts = connection.scripts.length;
  const again = await deriveEffort({
    effort,
    connection,
    store,
    checkTarget: false,
    requests: async () => [],
  });
  expect(again.ran).toBe(false);
  expect(connection.scripts.length).toBe(scripts + 1);
}, 60_000);
