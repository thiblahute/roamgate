import { expect, test } from "bun:test";
import type { ReviewPush, ReviewThread } from "../../../shared/review";
import { reviewServiceForTest } from "./testkit";

/*
 * A rendered file's review follows the file: when the file changes, each
 * thread is placed again where its lines are now, written back and
 * published; one whose lines are gone is taken off them.
 */

const before = [
  "# TODO",
  "",
  "- [ ] Firefox: old Roamgate notifications pile up since first use. What is",
  "      wanted: clear them when they no longer apply? (asked",
  "      2026-11-20 00:xx, no answer yet)",
  "- [ ] Headset (boom mic) muting after each turn: fixed twice on",
  "      2026-11-19, needs one real headset call to confirm.",
  "- [ ] Call 1 on 2026-11-19 stopped listening at 23:31 after another voice.",
  "",
  "## Done",
  "",
  "- [x] Something older.",
  "",
].join("\n");
const after = [
  "# TODO",
  "",
  "- [ ] Call 1 on 2026-11-19 stopped listening at 23:31 after another voice.",
  "",
  "## Done",
  "",
  "- [x] Something older.",
  "- [x] Headset (boom mic) muting after each turn: fixed twice on",
  "      2026-11-19, needs one real headset call to confirm.",
  "- [x] Firefox: old Roamgate notifications piling up (the user says it is fixed, 2026-11-20).",
  "",
].join("\n");
const gone = ["# TODO", "", "- [x] Something older.", ""].join("\n");

function setup(dir?: string) {
  const file = { text: before, reads: 0 };
  const kit = reviewServiceForTest({
    ...(dir ? { dir } : {}),
    loadDiff: async () => {
      throw new Error("a rendered review has no diff");
    },
    loadFile: async (_session, rev, path) => {
      file.reads += 1;
      if (rev || path !== "todo.md") throw new Error(`no ${rev}:${path}`);
      return file.text;
    },
  });
  const session = kit.service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "rendered", path: "todo.md" },
    raise: false,
  }).session;
  return { ...kit, file, sessionId: session.id };
}

/** A thread as the Files preview writes it on an item's lines. */
async function written(
  service: ReturnType<typeof setup>["service"],
  sessionId: string,
  line: number,
  endLine: number | undefined,
  quote: string,
  comment: string,
): Promise<ReviewThread> {
  const lines = before.split("\n");
  return service.addThread({
    sessionId,
    anchor: {
      path: "todo.md",
      line,
      ...(endLine !== undefined ? { endLine } : {}),
      side: "new",
      text: lines[(endLine ?? line) - 1],
      render: { quote },
      feedback: JSON.stringify({
        source: "file",
        anchor: "quote",
        path: "/repo/todo.md",
        quote,
        line,
        ...(endLine !== undefined ? { endLine } : {}),
      }),
    },
    text: comment,
  });
}

const FIREFOX =
  "Firefox: old Roamgate notifications pile up since first use. What is\nwanted: clear them when they no longer apply? (asked\n2026-11-20 00:xx, no answer yet)";
const HEADSET =
  "Headset (boom mic) muting after each turn: fixed twice on\n2026-11-19, needs one real headset call to confirm.";
const CALL =
  "Call 1 on 2026-11-19 stopped listening at 23:31 after another voice.";

function anchorsOf(
  service: ReturnType<typeof setup>["service"],
  sessionId: string,
) {
  return new Map(
    service
      .get({ sessionId })
      .threads.map((thread) => [thread.comments[0]!.body, thread]),
  );
}

async function until(check: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!check() && Date.now() - start < ms)
    await new Promise((resolve) => setTimeout(resolve, 5));
  return check();
}

test("the threads of a rendered file follow its lines once the file changes, and keep that", async () => {
  const { service, file, sessionId, dir, pushes } = setup();
  await written(service, sessionId, 3, 5, FIREFOX, "firefox");
  const headset = await written(service, sessionId, 6, 7, HEADSET, "headset");
  await written(service, sessionId, 8, undefined, CALL, "call");
  await service.resolve({
    sessionId,
    commentId: headset.id,
    resolved: true,
  });
  // Written as the file reads: nothing moves.
  await service.reanchorFile({ sessionId });
  let threads = anchorsOf(service, sessionId);
  expect(threads.get("firefox")!.anchor).toMatchObject({ line: 3, endLine: 5 });
  expect(threads.get("headset")!.anchor).toMatchObject({ line: 6, endLine: 7 });
  expect(threads.get("call")!.anchor).toMatchObject({ line: 8 });

  file.text = after;
  pushes.length = 0;
  const snapshot = await service.reanchorFile({ sessionId });
  threads = anchorsOf(service, sessionId);
  // Moved as it was: found by its last line's text, resolved still.
  const moved = threads.get("headset")!;
  expect(moved.id).toBe(headset.id);
  expect(moved.resolved).toBe(true);
  expect(moved.updatedAt).toBe(headset.updatedAt);
  expect(moved.anchor).toMatchObject({
    line: 8,
    endLine: 9,
    text: "      2026-11-19, needs one real headset call to confirm.",
    render: { quote: HEADSET },
  });
  expect(JSON.parse(moved.anchor.feedback!)).toMatchObject({
    line: 8,
    endLine: 9,
  });
  // Reworded and moved: found by its first words, quoted as it reads now.
  const reworded = threads.get("firefox")!;
  expect(reworded.anchor).toMatchObject({
    line: 10,
    text: "- [x] Firefox: old Roamgate notifications piling up (the user says it is fixed, 2026-11-20).",
    render: {
      quote:
        "Firefox: old Roamgate notifications piling up (the user says it is fixed, 2026-11-20).",
    },
  });
  expect(reworded.anchor.endLine).toBeUndefined();
  expect(JSON.parse(reworded.anchor.feedback!)).toMatchObject({
    line: 10,
    quote: reworded.anchor.render!.quote,
  });
  // Shifted up: on its line.
  expect(threads.get("call")!.anchor).toMatchObject({ line: 3 });
  expect(snapshot.threads.map((thread) => thread.anchor.line).sort()).toEqual([
    10, 3, 8,
  ]);
  // Published once, moved.
  const published = pushes.filter(
    (push): push is Extract<ReviewPush, { type: "session" }> =>
      push.type === "session" && push.snapshot.session.id === sessionId,
  );
  expect(published.length).toBe(1);
  expect(
    published[0]!.snapshot.threads.find((thread) => thread.id === headset.id)
      ?.anchor.line,
  ).toBe(8);

  // Kept: another service on the same store reads the moved anchors.
  const again = reviewServiceForTest({
    dir,
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  const stored = anchorsOf(again.service, sessionId);
  expect(stored.get("headset")!.anchor).toMatchObject({ line: 8, endLine: 9 });
  expect(stored.get("firefox")!.anchor).toMatchObject({ line: 10 });
  expect(stored.get("headset")!.resolved).toBe(true);

  // Gone from the file: off its lines, its words and text kept to find
  // it again, never on what its lines hold now.
  file.text = gone;
  await service.reanchorFile({ sessionId });
  threads = anchorsOf(service, sessionId);
  for (const name of ["firefox", "headset", "call"]) {
    const thread = threads.get(name)!;
    expect(thread.anchor.line).toBeUndefined();
    expect(thread.anchor.endLine).toBeUndefined();
    expect(thread.anchor.render?.quote).toBeTruthy();
    expect(JSON.parse(thread.anchor.feedback!)).not.toHaveProperty("line");
  }
  expect(threads.get("firefox")!.anchor.render!.quote).toBe(
    "Firefox: old Roamgate notifications piling up (the user says it is fixed, 2026-11-20).",
  );
  expect(threads.get("headset")!.resolved).toBe(true);
  // Back: placed again.
  file.text = after;
  await service.reanchorFile({ sessionId });
  threads = anchorsOf(service, sessionId);
  expect(threads.get("headset")!.anchor).toMatchObject({ line: 8, endLine: 9 });
  expect(threads.get("call")!.anchor).toMatchObject({ line: 3 });
});

test("the agent's update, a thread written and an open look at the file; reads only now and then", async () => {
  const { service, file, sessionId, pushes } = setup();
  await written(service, sessionId, 6, 7, HEADSET, "headset");
  await until(() => file.reads >= 1);
  const reads = file.reads;
  file.text = after;
  // A read of the review: not again within the half minute.
  service.get({ sessionId });
  service.list({ connectionId: "local" });
  expect(file.reads).toBe(reads);
  // The agent says it changed something: looked at now.
  pushes.length = 0;
  service.agentStatus({ sessionId, state: "update", message: "Moved it" });
  expect(
    await until(() =>
      pushes.some(
        (push) =>
          push.type === "session" &&
          push.snapshot.threads.some((thread) => thread.anchor.line === 8),
      ),
    ),
  ).toBe(true);
  expect(anchorsOf(service, sessionId).get("headset")!.anchor).toMatchObject({
    line: 8,
    endLine: 9,
  });
  // A thread written on the file as it was read before the change: placed
  // where its words are now.
  const stale = await service.addThread({
    sessionId,
    anchor: {
      path: "todo.md",
      line: 8,
      side: "new",
      text: "- [ ] Call 1 on 2026-11-19 stopped listening at 23:31 after another voice.",
      render: { quote: CALL },
    },
    text: "call",
  });
  expect(
    await until(
      () => anchorsOf(service, sessionId).get("call")!.anchor.line === 3,
    ),
  ).toBe(true);
  expect(anchorsOf(service, sessionId).get("call")!.id).toBe(stale.id);
  // Opened again by the agent (review_open file=): looked at now.
  file.text = gone;
  service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "rendered", path: "todo.md" },
    raise: false,
  });
  expect(
    await until(
      () =>
        anchorsOf(service, sessionId).get("call")!.anchor.line === undefined,
    ),
  ).toBe(true);
});

test("the checkout's review moves its Files preview threads with their files, its diff's own untouched", async () => {
  const { service, file, sessionId, pushes } = setup();
  const checkout = service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "worktree" },
    raise: false,
  }).session;
  expect(checkout.id).not.toBe(sessionId);
  // Written in the Files preview (its note says source "file"), as the
  // review in Changes keeps it.
  const inFiles = await service.addThread({
    sessionId: checkout.id,
    anchor: {
      path: "todo.md",
      line: 6,
      endLine: 7,
      side: "new",
      text: "      2026-11-19, needs one real headset call to confirm.",
      render: { quote: HEADSET },
      feedback: JSON.stringify({
        source: "file",
        anchor: "quote",
        path: "/repo/todo.md",
        quote: HEADSET,
        line: 6,
        endLine: 7,
      }),
    },
    text: "headset in files",
  });
  // Written on the diff in Changes: Changes' own placing, not the file's.
  const onDiff = await service.addThread({
    sessionId: checkout.id,
    anchor: {
      path: "todo.md",
      line: 6,
      side: "new",
      text: "- [ ] Headset (boom mic) muting after each turn: fixed twice on",
      feedback: JSON.stringify({
        source: "diff",
        kind: "combined",
        path: "todo.md",
        side: "new",
        line: 6,
      }),
    },
    text: "on the diff",
  });
  await service.reanchorFile({ sessionId: checkout.id });
  file.text = after;
  pushes.length = 0;
  // The Files preview read the file again: that path alone.
  const snapshot = await service.reanchorFile({
    sessionId: checkout.id,
    path: "todo.md",
  });
  const threads = new Map(
    snapshot.threads.map((thread) => [thread.id, thread]),
  );
  expect(threads.get(inFiles.id)!.anchor).toMatchObject({
    line: 8,
    endLine: 9,
  });
  expect(threads.get(onDiff.id)!.anchor).toMatchObject({ line: 6 });
  expect(
    pushes.filter(
      (push) =>
        push.type === "session" && push.snapshot.session.id === checkout.id,
    ).length,
  ).toBe(1);
  // Another path asked: nothing read for this one.
  const reads = file.reads;
  await service.reanchorFile({ sessionId: checkout.id, path: "other.md" });
  expect(file.reads).toBe(reads);
});

test("a thread an agent wrote with no line text is given its line's, and follows it", async () => {
  const { service, file, sessionId } = setup();
  const thread = await service.addThread({
    sessionId,
    author: "Claude",
    anchor: { path: "todo.md", line: 6, endLine: 7, side: "new" },
    text: "On the headset item",
  });
  expect(
    await until(
      () =>
        service.get({ sessionId }).threads.find((each) => each.id === thread.id)
          ?.anchor.text !== undefined,
    ),
  ).toBe(true);
  file.text = after;
  await service.reanchorFile({ sessionId });
  expect(
    service.get({ sessionId }).threads.find((each) => each.id === thread.id)
      ?.anchor,
  ).toMatchObject({ line: 8, endLine: 9 });
});
