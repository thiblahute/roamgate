import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewThread } from "../../../shared/review";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import {
  readReviewCommitPatch,
  readReviewCommits,
  readReviewHeads,
  readReviewPatch,
  readReviewPatchIds,
} from "../workspace/review-patch";
import { reviewServiceForTest } from "./testkit";

/**
 * Threads written on one commit of a branch that is then amended and
 * replayed, against a real repository and the real review loaders: each
 * follows its change onto what its commit became, else onto its line in
 * the whole change, and is outdated only when nothing matches.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

const PLAY = [
  "#include <gst-c.h>",
  "",
  "static void",
  "die (const char *what, GstError *err)",
  "{",
  '  fprintf (stderr, "%s\\n", what);',
  "}",
  "",
  "int",
  "main (void)",
  "{",
  "  return 0;",
  "}",
];

const SUBJECT = "gst-c: Add futures, elements written in C, and the pipeline";

/** main, then topic: a first commit, the one commented on, a last one. */
function repository() {
  const root = realpathSync(mkdtempSync("/tmp/rg-rw-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README"), "readme\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "first");
  git(root, "checkout", "-q", "-b", "topic");
  writeFileSync(join(root, "caps.c"), "caps\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "gst-c: a C API for caps");
  writeFileSync(join(root, "play.c"), `${PLAY.join("\n")}\n`);
  writeFileSync(
    join(root, "element.rs"),
    "pub struct GstPad {\n    _private: [u8; 0],\n}\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", SUBJECT);
  writeFileSync(join(root, "docs.md"), "docs\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "docs");
  return root;
}

function setup(root: string) {
  const on = { shQuote, runProcessWithCodeTimeout };
  const { service, pushes } = reviewServiceForTest({
    loadCommits: async (session) =>
      session.target.kind === "range"
        ? readReviewCommits({
            root: session.root,
            base: session.target.base,
            head: session.target.head,
            ...on,
          })
        : [],
    loadPatchIds: (session, shas) =>
      readReviewPatchIds({ root: session.root, shas, ...on }),
    loadHeads: (_connection, entries) => readReviewHeads({ entries, ...on }),
    loadDiff: (session, commit, options) =>
      commit
        ? readReviewCommitPatch({ root: session.root, commit, ...on })
        : readReviewPatch({
            root: session.root,
            target: session.target,
            paths: options?.paths,
            ...on,
          }),
  });
  const open = (target: Record<string, unknown>) =>
    service.open({ connectionId: "local", root, target, raise: false }).session;
  return { service, pushes, open };
}

/** A comment written in a commit's view in Changes, as the browser sends it. */
async function onCommit(
  service: ReturnType<typeof setup>["service"],
  sessionId: string,
  root: string,
  path: string,
  text: string,
  body: string,
) {
  const sha = git(root, "rev-parse", "topic~1");
  const parent = git(root, "rev-parse", "topic~2");
  const line =
    Number(
      git(root, "grep", "-n", "-F", text, "topic~1", "--", path).split(":")[2],
    ) || 0;
  const commit = { sha, subject: SUBJECT, parent };
  return service.addThread({
    sessionId,
    anchor: {
      path,
      commit: sha,
      commitSubject: SUBJECT,
      commitParent: parent,
      line,
      side: "new",
      text,
      feedback: JSON.stringify({
        source: "diff",
        path,
        kind: "branch",
        side: "new",
        line,
        quote: text,
        hunk: "@@",
        commit,
        id: `note-${body}`,
        createdAt: 1,
      }),
    },
    text: body,
  });
}

/** Amends the commented commit and replays the branch, as an agent does. */
function amendAndReplay(root: string, edit: () => void) {
  git(root, "checkout", "-q", "topic~1");
  edit();
  git(root, "add", "-A");
  git(root, "commit", "-q", "--amend", "--no-edit");
  const amended = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "topic");
  git(root, "rebase", "-q", "--onto", amended, "topic~1");
  return amended;
}

const threadOf = (
  service: ReturnType<typeof setup>["service"],
  sessionId: string,
  id: string,
): ReviewThread =>
  service.get({ sessionId }).threads.find((thread) => thread.id === id)!;

test("threads on an amended commit follow it onto the new commit and their line there", async () => {
  const root = repository();
  const { service, pushes, open } = setup(root);
  const branch = open({ kind: "range", base: "main", head: "HEAD" });
  // A review the same branch was commented in under another base.
  const before = open({ kind: "range", base: "main", head: "topic" });
  const die = await onCommit(
    service,
    before.id,
    root,
    "play.c",
    "die (const char *what, GstError *err)",
    "Logging?",
  );
  const pad = await onCommit(
    service,
    branch.id,
    root,
    "element.rs",
    "    _private: [u8; 0],",
    "What does [u8; 0] mean?!",
  );
  const exit = await onCommit(
    service,
    branch.id,
    root,
    "play.c",
    "  return 0;",
    "Exit code?",
  );
  const wasCommit = threadOf(service, branch.id, pad.id).anchor.commit;
  const amended = amendAndReplay(root, () => {
    // Lines added above the comment, and the line of one comment gone.
    writeFileSync(
      join(root, "play.c"),
      `/* Plays a URI. */\n\n${PLAY.join("\n").replace("  return 0;", "  return run ();")}\n`,
    );
  });
  expect(amended).not.toBe(wasCommit);
  pushes.length = 0;
  // Changes reads the branch's commits: the threads move in the background.
  await service.commits({ sessionId: branch.id });
  await service.reanchorRewritten({ sessionId: branch.id });
  const moved = threadOf(service, before.id, die.id).anchor;
  expect(moved.commit).toBe(amended);
  expect(moved.commitParent).toBe(git(root, "rev-parse", "topic~2"));
  expect(moved.line).toBe(6);
  expect(moved.outdated).toBeUndefined();
  const note = JSON.parse(moved.feedback!);
  expect(note.commit.sha).toBe(amended);
  expect(note.line).toBe(6);
  const padMoved = threadOf(service, branch.id, pad.id).anchor;
  expect(padMoved.commit).toBe(amended);
  expect(padMoved.line).toBe(2);
  // Its line rewritten: on what the commit became, outdated, where it was.
  const gone = threadOf(service, branch.id, exit.id).anchor;
  expect(gone.commit).toBe(amended);
  expect(gone.outdated).toBe(true);
  expect(gone.line).toBe(12);
  // Both reviews holding moved threads were told.
  const told = new Set(
    pushes.flatMap((push) =>
      push.type === "session" ? [push.snapshot.session.id] : [],
    ),
  );
  expect(told.has(branch.id)).toBe(true);
  expect(told.has(before.id)).toBe(true);
  // Nothing more to do: a second read changes nothing.
  pushes.length = 0;
  await service.reanchorRewritten({ sessionId: branch.id });
  expect(pushes.length).toBe(0);
});

test("a commit squashed away: its thread goes to its line in the whole change", async () => {
  const root = repository();
  const { service, open } = setup(root);
  const branch = open({ kind: "range", base: "main", head: "HEAD" });
  const die = await onCommit(
    service,
    branch.id,
    root,
    "play.c",
    "die (const char *what, GstError *err)",
    "Logging?",
  );
  // The three commits made one, under another subject.
  git(root, "reset", "-q", "--soft", "main");
  git(root, "commit", "-q", "-m", "gst-c: everything at once");
  await service.reanchorRewritten({ sessionId: branch.id });
  const anchor = threadOf(service, branch.id, die.id).anchor;
  expect(anchor.commit).toBeUndefined();
  expect(anchor.line).toBe(4);
  expect(anchor.outdated).toBeUndefined();
  expect(JSON.parse(anchor.feedback!).commit).toBeUndefined();
});

test("another branch's thread is not moved onto this one by its subject", async () => {
  const root = repository();
  const { service, open } = setup(root);
  // A review of another branch of the checkout, then that branch rewritten
  // under the same subject on topic only.
  git(root, "branch", "other", "topic");
  const other = open({ kind: "range", base: "main", head: "other" });
  const thread = await onCommit(
    service,
    other.id,
    root,
    "play.c",
    "die (const char *what, GstError *err)",
    "On other",
  );
  amendAndReplay(root, () => {
    writeFileSync(join(root, "play.c"), `/* changed */\n${PLAY.join("\n")}\n`);
  });
  const branch = open({ kind: "range", base: "main", head: "HEAD" });
  await service.reanchorRewritten({ sessionId: branch.id });
  const anchor = threadOf(service, other.id, thread.id).anchor;
  expect(anchor.commit).toBe(git(root, "rev-parse", "other~1"));
  expect(anchor.outdated).toBeUndefined();
});
