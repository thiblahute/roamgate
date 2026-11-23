import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MrEffort } from "../../../shared/mrReviews";
import {
  changePlans,
  changesOf,
  clusterLedger,
  createLedgerStore,
  decideMatches,
  deriveEffort,
  overlapOf,
  setDispositions,
  snapshotOf,
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

test("fuzzy proposals from upstream, confirmed and rejected; planned requests; what changed", async () => {
  const g = createGitFixture();
  fixtures.push(g);
  const bare = g.project("media/engine");
  const clone = g.clone("media/engine", "engine");
  g.git(clone, "checkout", "-q", "-b", "big");
  const big = "pool: allocate buffers lazily\n".repeat(1);
  g.commit(clone, "gst/pool/pool.c", "a\nb\nc\n", big.trim());
  g.commit(clone, "gst/pool/pool.h", "h\n", "pool: export the allocator");
  g.commit(clone, "tests/t.c", "t\n", "tests: cover the pool");
  g.commit(clone, "docs/d.md", "d\n", "docs: describe the pool");
  // Upstream took the first one reworded and changed (another patch id).
  const up = g.clone("media/engine", "up");
  g.commit(
    up,
    "gst/pool/pool.c",
    "a\nb\nc changed\n",
    "bufferpool: allocate buffers lazily",
  );
  g.commit(up, "other/x.c", "x\n", "other: unrelated work");
  g.git(up, "push", "-q", bare, "main");
  const connection = g.connection([]);
  const store = createLedgerStore(join(g.root, "efforts"));
  const effort = effortOf(clone);
  const derive = async () =>
    (
      await deriveEffort({
        effort,
        connection,
        store,
        checkTarget: true,
        requests: async () => [],
        force: true,
      })
    ).derived;
  let derived = await derive();
  const first = derived.commits[0]!;
  expect(first.disposition).toBe("unsorted");
  expect(first.sizes).toEqual([3]);
  const upstreamSha = g.git(up, "rev-parse", "HEAD~1").trim();
  expect(derived.proposals?.[first.key]?.[0]).toMatchObject({
    sha: upstreamSha,
    subject: "bufferpool: allocate buffers lazily",
  });
  expect(derived.proposals?.[derived.commits[2]!.key]).toBeUndefined();
  // What changed starts from the first reading.
  expect(
    changesOf(derived, store.ledger("e1"), store.seen("e1")),
  ).toMatchObject({ unsorted: [], landed: [], proposals: [first.key] });

  // Rejected: never proposed again.
  const rejected = await decideMatches(store, effort, {
    decisions: [
      {
        commit: first.sha.slice(0, 8),
        match: upstreamSha.slice(0, 9),
        accept: false,
      },
    ],
    by: "agent",
    summary: "no",
  });
  expect(rejected).toMatchObject({ accepted: 0, rejected: 1 });
  derived = await derive();
  expect(derived.proposals?.[first.key]).toBeUndefined();
  await undoLedger(store, "e1", rejected.journal);
  derived = await derive();
  expect(derived.proposals?.[first.key]?.[0]?.sha).toBe(upstreamSha);
  // Confirmed: upstream by hand, pointing at it, in its history.
  await decideMatches(store, effort, {
    decisions: [{ commit: first.sha, match: upstreamSha, accept: true }],
    by: "user",
    summary: "yes",
  });
  derived = await derive();
  expect(derived.commits[0]).toMatchObject({
    disposition: "upstream",
    note: upstreamSha,
  });
  expect(
    store.history("e1", first.key).map((each) => [each.where, each.sha]),
  ).toEqual([
    ["source", first.sha],
    ["upstream", upstreamSha],
  ]);
  // An unknown match is refused, nothing changed.
  await expect(
    decideMatches(store, effort, {
      decisions: [{ commit: first.sha, match: "deadbeef00", accept: true }],
      by: "user",
      summary: "x",
    }),
  ).rejects.toThrow(/nothing changed/);

  // Planned requests: proposed, a commit in one only, split, accepted.
  const [, header, tests, docs] = derived.commits.map((each) => each.sha);
  const proposed = await changePlans(
    store,
    effort,
    { action: "propose", name: "Pool API", commits: [docs!, header!, tests!] },
    { by: "agent", summary: "p" },
  );
  expect(proposed.plan).toMatchObject({ state: "proposed", name: "Pool API" });
  // In source order whatever the order given.
  expect(proposed.plan!.commits).toEqual(
    derived.commits.slice(1).map((each) => each.key),
  );
  await expect(
    changePlans(
      store,
      effort,
      { action: "propose", name: "Other", commits: [tests!] },
      { by: "agent", summary: "p" },
    ),
  ).rejects.toThrow(/one planned request only.*Pool API/);
  // Another effort's plan holds it: refused too (D4).
  await expect(
    changePlans(
      store,
      effort,
      { action: "edit", plan: "Pool API", add: [tests!] },
      {
        by: "agent",
        summary: "p",
        taken: new Map([[derived.commits[2]!.patchId, "Elsewhere"]]),
      },
    ),
  ).rejects.toThrow(/in a part of Elsewhere/);
  await changePlans(
    store,
    effort,
    { action: "split", plan: "Pool API", commits: [docs!], name: "Pool docs" },
    { by: "user", summary: "s" },
  );
  await changePlans(
    store,
    effort,
    { action: "accept", plan: "pool api" },
    { by: "user", summary: "a" },
  );
  derived = await derive();
  expect(derived.commits.map((each) => [each.disposition, each.note])).toEqual([
    ["upstream", upstreamSha],
    ["planned", "Pool API"],
    ["planned", "Pool API"],
    ["planned", "Pool docs"],
  ]);
  expect(store.ledger("e1").plans.map((p) => [p.name, p.state])).toEqual([
    ["Pool API", "accepted"],
    ["Pool docs", "proposed"],
  ]);
  // Undo of a plan change puts every plan back.
  const dropped = await changePlans(
    store,
    effort,
    { action: "drop", plan: "Pool docs" },
    { by: "user", summary: "d" },
  );
  expect(store.ledger("e1").plans).toHaveLength(1);
  await undoLedger(store, "e1", dropped.journal);
  expect(store.ledger("e1").plans).toHaveLength(2);

  // What changed: the confirmed commit landed since the first look.
  const changes = changesOf(derived, store.ledger("e1"), store.seen("e1"));
  expect(changes.landed).toEqual([first.key]);
  expect(changes.proposals).toEqual([]);
  store.writeSeen("e1", snapshotOf(derived, store.ledger("e1")));
  // A new commit on the source shows as new unsorted.
  g.commit(clone, "new.c", "n\n", "A new thing");
  derived = await derive();
  const after = changesOf(derived, store.ledger("e1"), store.seen("e1"));
  expect(after.landed).toEqual([]);
  expect(after.unsorted).toEqual([derived.commits.at(-1)!.key]);
});

test("an effort's files are written behind, never synced on the event loop, and read meanwhile", async () => {
  const root = mkdtempSync(join(tmpdir(), "roamgate-efforts-"));
  const syncs = spyOn(fs, "fsyncSync");
  const appends = spyOn(fs, "appendFileSync");
  try {
    const store = createLedgerStore(join(root, "efforts"));
    const ledger = { ...store.ledger("e1"), aliases: { p2: "p1" } };
    store.writeLedger("e1", ledger);
    store.appendHistory("e1", [{ key: "k", sha: "a" }]);
    // The caller goes on at once (5 s on a busy disk, 2026-11-23): what it
    // wrote is read back before it is in the file.
    expect(existsSync(join(root, "efforts", "e1", "ledger.json"))).toBe(false);
    expect(store.ledger("e1").aliases).toEqual({ p2: "p1" });
    expect(store.history("e1", "k")).toEqual([{ key: "k", sha: "a" }]);
    await store.flush();
    store.appendHistory("e1", [{ key: "k", sha: "b" }]);
    await store.flush();
    expect(
      JSON.parse(
        readFileSync(join(root, "efforts", "e1", "ledger.json"), "utf8"),
      ).aliases,
    ).toEqual({ p2: "p1" });
    expect(store.history("e1", "k").map((line) => line.sha)).toEqual([
      "a",
      "b",
    ]);
    expect(createLedgerStore(join(root, "efforts")).ledger("e1")).toEqual(
      store.ledger("e1"),
    );
    expect(syncs).not.toHaveBeenCalled();
    expect(appends).not.toHaveBeenCalled();
  } finally {
    syncs.mockRestore();
    appends.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
