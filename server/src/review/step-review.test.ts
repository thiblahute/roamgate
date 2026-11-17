import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { ReviewSession } from "../../../shared/review";
import { describeTarget } from "./service";
import { reviewServiceForTest } from "./testkit";

/*
 * The Last step as a review target in the review service (plan D15), and
 * scopes read without a review (plan section 2: showing a scope never
 * creates or touches a session).
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup(dir?: string) {
  const directory =
    dir ??
    (() => {
      const path = mkdtempSync(join(tmpdir(), "roamgate-step-review-"));
      directories.push(path);
      return path;
    })();
  const loads: { target: unknown; commit?: string }[] = [];
  const { service } = reviewServiceForTest({
    dir: directory,
    loadDiff: async (session, commit) => {
      loads.push({ target: session.target, commit });
      return { files: [], truncated: false, headSha: "f".repeat(40) };
    },
    loadCommits: async (session) =>
      session.target.kind === "range"
        ? [
            {
              sha: "c".repeat(40),
              parent: null,
              author: "T",
              date: "2026-11-15",
              subject: "One",
              body: "",
            },
          ]
        : [],
    loadState: async () => "state",
  });
  return { directory, service, loads };
}

const before = "a".repeat(40);
const after = "b".repeat(40);
const stepTarget = {
  kind: "step",
  step: "1763200000000-abcdef01",
  before,
  after,
  at: "2026-11-15T10:02:00.000Z",
  skipped: ["huge.bin"],
};

test("a step's review is one per step: the same two snapshots open the same session", () => {
  const { service } = setup();
  const first = service.open({
    connectionId: "local",
    root: "/repo",
    workspaceId: "w1",
    target: stepTarget,
    raise: false,
  }).session;
  expect(first.target).toEqual(stepTarget as ReviewSession["target"]);
  expect(first.title).toMatch(/^last step \d\d:\d\d$/);
  const again = service.open({
    connectionId: "local",
    root: "/repo",
    target: { ...stepTarget, at: undefined },
    raise: false,
  }).session;
  expect(again.id).toBe(first.id);
  const next = service.open({
    connectionId: "local",
    root: "/repo",
    target: {
      ...stepTarget,
      step: "1763200000001-abcdef02",
      before: after,
      after: "c".repeat(40),
    },
    raise: false,
  }).session;
  expect(next.id).not.toBe(first.id);
  // A step without its end names its trees.
  expect(describeTarget({ kind: "step", step: "x", before, after })).toBe(
    `last step ${before.slice(0, 7)}..${after.slice(0, 7)}`,
  );
});

test("a step's target refuses what is not a tree id, an option-like step or a path outside the checkout", () => {
  const { service } = setup();
  const open = (target: unknown) =>
    service.open({ connectionId: "local", root: "/repo", target });
  expect(() => open({ ...stepTarget, before: "HEAD" })).toThrow(
    "invalid before",
  );
  expect(() => open({ ...stepTarget, after: `${after};x` })).toThrow(
    "invalid after",
  );
  expect(() => open({ ...stepTarget, step: "--x" })).toThrow("invalid step");
  const opened = open({
    ...stepTarget,
    skipped: ["../etc/passwd", "ok.bin", 3],
  });
  expect(
    opened.session.target.kind === "step" && opened.session.target.skipped,
  ).toEqual(["ok.bin"]);
});

test("a step's review has no commits; its diff is the step's; the steps with threads are kept", async () => {
  const { service, loads } = setup();
  const { session } = service.open({
    connectionId: "local",
    root: "/repo",
    target: stepTarget,
    raise: false,
  });
  expect(await service.commits({ sessionId: session.id })).toEqual({
    commits: [],
  });
  const first = await service.diff({ sessionId: session.id, first: true });
  expect(first.view).toBeNull();
  expect(loads.at(-1)).toEqual({ target: session.target, commit: undefined });
  expect(service.keptSteps("/repo")).toEqual([]);
  await service.addThread({
    sessionId: session.id,
    anchor: { path: "a.txt", line: 1, side: "new", text: "two" },
    text: "Why?",
    author: "you",
  });
  expect(service.keptSteps("/repo")).toEqual([stepTarget.step]);
  expect(service.keptSteps("/other")).toEqual([]);
});

test("reading a scope with no review (Changes showing it) creates, touches and publishes no session", async () => {
  const { service, loads } = setup();
  const range = service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "range", base: "main", head: "HEAD" },
    raise: false,
  }).session;
  const listed = service.list().map(({ session }) => session.updatedAt);
  const read = { connectionId: "local", root: "/repo" };
  expect(
    await service.previewCommits({
      ...read,
      target: { kind: "range", base: "origin/main", head: "HEAD" },
    }),
  ).toEqual({ commits: [expect.objectContaining({ subject: "One" })] });
  const diff = await service.previewDiff({
    ...read,
    target: { kind: "range", base: "origin/main", head: "HEAD" },
    commit: "c".repeat(40),
  });
  expect(diff.files).toEqual([]);
  expect(loads.at(-1)?.commit).toBe("c".repeat(40));
  await service.previewDiff({ ...read, target: { kind: "worktree" } });
  await service.previewDiff({ ...read, target: stepTarget });
  expect(await service.previewState({ ...read, target: stepTarget })).toEqual({
    state: "state",
  });
  // Only a checkout's changes: no merge request or chat this way.
  await expect(
    service.previewDiff({ ...read, target: { kind: "chat", chat: "x" } }),
  ).rejects.toThrow("only a checkout's changes");
  expect(service.list().map(({ session }) => session.id)).toEqual([range.id]);
  expect(service.list().map(({ session }) => session.updatedAt)).toEqual(
    listed,
  );
  // The review an agent's id-less call finds is still the range's.
  expect(
    service.get({ sessionId: range.id }).session.seenHeadSha,
  ).toBeUndefined();
});

test("a review of a kind from a newer build is kept and listed, never crashing a read", async () => {
  const { directory, service } = setup();
  const { session } = service.open({
    connectionId: "local",
    root: "/repo",
    target: stepTarget,
    raise: false,
  });
  service.close();
  // An older build reads what this one wrote: its own fallbacks for a kind
  // it does not know are the ones this build has for an unknown kind.
  const db = new Database(join(directory, "reviews.sqlite"));
  const row = db
    .query<{ data: string }, [string]>("SELECT data FROM sessions WHERE id = ?")
    .get(session.id);
  if (!row) throw new Error("no stored session");
  const stored = JSON.parse(row.data);
  stored.target = { kind: "from-a-newer-build", what: 1 };
  db.query("UPDATE sessions SET data = ? WHERE id = ?").run(
    JSON.stringify(stored),
    session.id,
  );
  db.close();
  const { service: reopened } = setup(directory);
  const found = reopened.list().find((each) => each.session.id === session.id);
  expect(found?.session.target.kind as string).toBe("from-a-newer-build");
  expect(describeTarget(found!.session.target)).toBe("review");
  expect(await reopened.commits({ sessionId: session.id })).toEqual({
    commits: [],
  });
  await reopened.diff({ sessionId: session.id });
  expect(reopened.get({ sessionId: session.id }).session.id).toBe(session.id);
});
