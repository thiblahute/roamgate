import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunProcessWithCodeTimeout } from "./file-types";
import {
  createLastStepBaselineStore,
  keepLastSteps,
  LAST_STEPS_KEPT,
  lastStepRefPrefix,
  readDiffSummary,
} from "./git-diff";
import {
  readReviewPatch,
  readReviewState,
  ReviewGoneError,
} from "./review-patch";

/*
 * The Last step as a review target: each step's snapshot trees
 * kept under refs while its review has threads and for the last steps,
 * read back after a restart, untracked files over 50 MB left out and named.
 */

setDefaultTimeout(30_000);

const runProcessWithCodeTimeout: RunProcessWithCodeTimeout = async (argv) => {
  const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

function shQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const context = { shQuote, runProcessWithCodeTimeout };

async function git(root: string, ...args: string[]) {
  const result = await runProcessWithCodeTimeout(
    ["git", "-C", root, ...args],
    5000,
  );
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

const roots: string[] = [];
afterEach(async () => {
  keepLastSteps(null);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "roamgate-step-target-"));
  roots.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "a.txt"), "one\n");
  await git(root, "add", "a.txt");
  await git(root, "commit", "-qm", "one");
  return root;
}

/** A step: the baseline taken, the files written, the step completed. */
async function step(
  store: ReturnType<typeof createLastStepBaselineStore>,
  root: string,
  write: () => Promise<void>,
  workspace = "w1",
) {
  await store.captureWorkspace(workspace, async () => root);
  await write();
  expect(await store.completeWorkspace(workspace)).toBe(true);
  const done = await store.completedStep?.(workspace, root);
  if (!done?.step) throw new Error("no step");
  return done;
}

async function stepRefs(root: string, workspace = "w1") {
  const out = await git(
    root,
    "for-each-ref",
    "--format=%(refname)",
    `${lastStepRefPrefix(workspace)}/`,
  );
  return [
    ...new Set(
      out
        .split("\n")
        .filter(Boolean)
        .map((ref) => ref.split("/")[4]!),
    ),
  ].sort();
}

test("a completed step's trees are kept under refs, its summary names it as a target", async () => {
  const root = await repository();
  const store = createLastStepBaselineStore(context, { refs: true });
  const done = await step(store, root, () =>
    writeFile(join(root, "a.txt"), "two\n"),
  );
  expect(done.step).toMatch(/^\d{13}-[0-9a-f]{8}$/);
  expect(await stepRefs(root)).toEqual([done.step!]);
  expect(
    (
      await git(
        root,
        "rev-parse",
        `${lastStepRefPrefix("w1")}/${done.step}/after`,
      )
    ).trim(),
  ).toBe(done.current);
  const summary = await readDiffSummary({
    workspaceId: "w1",
    workspace: {},
    root,
    params: { mode: "last-step" },
    ...context,
    lastStepBaselines: store,
  });
  expect(summary.entries.map((entry) => entry.path)).toEqual(["a.txt"]);
  expect(summary.step).toEqual({
    step: done.step!,
    before: done.baseline,
    after: done.current,
    at: done.at!,
  });
  // The review of the step reads tree against tree.
  const target = {
    kind: "step" as const,
    step: done.step!,
    before: done.baseline,
    after: done.current,
  };
  const diff = await readReviewPatch({ root, target, ...context });
  expect(diff.files.map((file) => file.path)).toEqual(["a.txt"]);
  expect(diff.files[0]!.hunks[0]!.lines.map((line) => line.kind)).toEqual([
    "-",
    "+",
  ]);
  expect(diff.baseSha).toBe(done.baseline);
  expect(diff.headSha).toBe(done.current);
  expect(await readReviewState({ root, target, ...context })).toBe(
    `${done.baseline} ${done.current}`,
  );
  await store.dispose();
});

test("only the last steps keep their refs, and a step whose review has threads", async () => {
  const root = await repository();
  const store = createLastStepBaselineStore(context, { refs: true });
  const steps: string[] = [];
  let kept = "";
  keepLastSteps((at) => (at === root && kept ? [kept] : []));
  for (let index = 0; index < LAST_STEPS_KEPT + 2; index++) {
    const done = await step(store, root, () =>
      writeFile(join(root, "a.txt"), `step ${index}\n`),
    );
    steps.push(done.step!);
    // The first step's review got a thread.
    if (index === 0) kept = done.step!;
    // Steps in one millisecond would not sort by time.
    await Bun.sleep(2);
  }
  expect(await stepRefs(root)).toEqual(
    [steps[0]!, ...steps.slice(-LAST_STEPS_KEPT)].sort(),
  );
  // Another workspace's steps are its own.
  await step(
    store,
    root,
    () => writeFile(join(root, "a.txt"), "other\n"),
    "w2",
  );
  expect((await stepRefs(root)).length).toBe(LAST_STEPS_KEPT + 1);
  expect((await stepRefs(root, "w2")).length).toBe(1);
  await store.dispose();
});

test("after a restart, the latest step is read back from its refs; a store without refs knows none", async () => {
  const root = await repository();
  const first = createLastStepBaselineStore(context, { refs: true });
  const done = await step(first, root, () =>
    writeFile(join(root, "a.txt"), "after\n"),
  );
  await first.dispose();
  const restarted = createLastStepBaselineStore(context, { refs: true });
  expect(await restarted.completedStep?.("w1", root)).toEqual({
    baseline: done.baseline,
    current: done.current,
    step: done.step!,
    at: done.at!,
  });
  // The scope shows it again, with the same target.
  const summary = await readDiffSummary({
    workspaceId: "w1",
    workspace: {},
    root,
    params: { mode: "last-step" },
    ...context,
    lastStepBaselines: restarted,
  });
  expect(summary.baseline_available).toBe(true);
  expect(summary.step?.step).toBe(done.step!);
  expect(await restarted.completedStep?.("other", root)).toBeUndefined();
  const memoryOnly = createLastStepBaselineStore(context);
  expect(await memoryOnly.completedStep?.("w1", root)).toBeUndefined();
  await restarted.dispose();
  await memoryOnly.dispose();
});

test("a step whose refs were dropped and trees collected expires: its review says the snapshot is gone", async () => {
  const root = await repository();
  const store = createLastStepBaselineStore(context, { refs: true });
  const done = await step(store, root, () =>
    writeFile(join(root, "new.txt"), "a new file nobody else has\n"),
  );
  await store.dispose();
  const prefix = `${lastStepRefPrefix("w1")}/${done.step}`;
  for (const end of ["before", "after"])
    await git(root, "update-ref", "-d", `${prefix}/${end}`);
  await git(root, "reflog", "expire", "--expire=now", "--all");
  await git(root, "gc", "-q", "--prune=now");
  const target = {
    kind: "step" as const,
    step: done.step!,
    before: done.baseline,
    after: done.current,
  };
  const error = await readReviewPatch({ root, target, ...context }).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ReviewGoneError);
  expect((error as ReviewGoneError).code).toBe("head-gone");
  // Restarted, no step is known any more: the scope is empty.
  const restarted = createLastStepBaselineStore(context, { refs: true });
  const summary = await readDiffSummary({
    workspaceId: "w1",
    workspace: {},
    root,
    params: { mode: "last-step" },
    ...context,
    lastStepBaselines: restarted,
  });
  expect(summary.baseline_available).toBe(false);
  expect(summary.entries).toEqual([]);
  await restarted.dispose();
});

test("an untracked file of 20 MB is in the snapshots: only those over 50 MB are left out", async () => {
  const root = await repository();
  const store = createLastStepBaselineStore(context, { refs: true });
  const done = await step(store, root, async () => {
    await writeFile(join(root, "big.bin"), "");
    await truncate(join(root, "big.bin"), 20 * 1024 * 1024);
  });
  expect(done.skipped ?? []).toEqual([]);
  const summary = await readDiffSummary({
    workspaceId: "w1",
    workspace: {},
    root,
    params: { mode: "last-step" },
    ...context,
    lastStepBaselines: store,
  });
  expect(summary.entries.map((entry) => entry.path)).toEqual(["big.bin"]);
  await store.dispose();
});

test("an untracked file over 50 MB is left out of the snapshots and named; the step goes on", async () => {
  const root = await repository();
  const store = createLastStepBaselineStore(context, { refs: true });
  const done = await step(store, root, async () => {
    await writeFile(join(root, "small.txt"), "small\n");
    await writeFile(join(root, "huge.bin"), "");
    // Sparse: its size without writing it.
    await truncate(join(root, "huge.bin"), 51 * 1024 * 1024);
  });
  expect(done.skipped).toEqual(["huge.bin"]);
  const summary = await readDiffSummary({
    workspaceId: "w1",
    workspace: {},
    root,
    params: { mode: "last-step" },
    ...context,
    lastStepBaselines: store,
  });
  expect(summary.entries.map((entry) => entry.path)).toEqual(["small.txt"]);
  expect(summary.step?.skipped).toEqual(["huge.bin"]);
  await store.dispose();
  // Read back after a restart too.
  const restarted = createLastStepBaselineStore(context, { refs: true });
  expect((await restarted.completedStep?.("w1", root))?.skipped).toEqual([
    "huge.bin",
  ]);
  await restarted.dispose();
});
