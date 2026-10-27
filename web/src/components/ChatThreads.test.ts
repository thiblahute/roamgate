import { expect, test } from "bun:test";
import type { ReviewSnapshot, ReviewThread } from "../../../shared/review";
import type { HistoryEntry } from "./agentHistory";
import {
  chatPartEntry,
  placeChatThreads,
  samePlaces,
  writeThenReadBack,
} from "./ChatThreads";

test("a write saved is saved even when reading it back fails", async () => {
  const calls: string[] = [];
  const remembered: ReviewSnapshot[] = [];
  await writeThenReadBack(
    async (method) => {
      calls.push(method);
      if (method === "review.get") throw new Error("timeout: review.get");
      return {};
    },
    "s1",
    "review.reply",
    { comment_id: "t1", text: "but i like my overlay!" },
    (snapshot) => remembered.push(snapshot),
  );
  expect(calls).toEqual(["review.reply", "review.get"]);
  expect(remembered).toEqual([]);
});

test("a write that fails says so, and reads nothing back", async () => {
  const calls: string[] = [];
  await expect(
    writeThenReadBack(
      async (method) => {
        calls.push(method);
        throw new Error("not connected to bridge");
      },
      "s1",
      "review.reply",
      { comment_id: "t1", text: "x" },
      () => {},
    ),
  ).rejects.toThrow("not connected to bridge");
  expect(calls).toEqual(["review.reply"]);
});

test("what is read back is remembered", async () => {
  const snapshot = {
    session: { id: "s1" },
    threads: [],
  } as unknown as ReviewSnapshot;
  const remembered: ReviewSnapshot[] = [];
  await writeThenReadBack(
    async (method) => (method === "review.get" ? snapshot : {}),
    "s1",
    "review.reply",
    {},
    (value) => remembered.push(value),
  );
  await Promise.resolve();
  expect(remembered).toEqual([snapshot]);
});

/** An agent's message as the history gives it. */
function said(id: string, text: string, sent_at: string) {
  return {
    id,
    kind: "message",
    role: "assistant",
    text,
    sent_at,
  } as HistoryEntry;
}

function chatThread(id: string, anchor: ReviewThread["anchor"]): ReviewThread {
  return {
    id,
    sessionId: "s1",
    kind: "discussion",
    anchor,
    comments: [
      {
        id: `${id}-c`,
        author: "you",
        body: "We should fix that",
        createdAt: "2026-11-05T13:45:41Z",
        updatedAt: "2026-11-05T13:45:41Z",
      },
    ],
    resolved: false,
    createdAt: "2026-11-05T13:45:41Z",
    updatedAt: "2026-11-05T13:45:41Z",
  } as ReviewThread;
}

// The transcript went past the size read by its end: the same message,
// read by its record, has another id than when it was commented on.
const fixed = said(
  "1a9478df77f7ec28f3f658da:0",
  [
    "IGA-186 is fixed and committed on this branch. I used Brian's proposed change, confirmed with a local reproduction. Nothing is pushed.",
    "",
    "| Commit | What |",
    "| --- | --- |",
    "| `6c34c00b8` | uridecodepool: forward **user seeks** to nested timeline sources |",
    "",
    "- **Double seek**: when a cut-crossing seek activates a nested source, the inner composition may now be positioned twice. The result is correct, but it could cost some skimming speed.",
  ].join("\n"),
  "2026-11-05T13:43:28.354Z",
);
const skipped = said(
  "985c71717ffaa79a450e1a67:0",
  "All 8 skipped tests are the `validate.nle.*` scenarios, and one is `uridecodepoolsrc_new_stack_no_seek`, which matters here. Why are they skipped?",
  "2026-11-04T12:27:27.882Z",
);

test("a comment finds its message again when its id changed", () => {
  const entries = [skipped, fixed];
  // Its time and words.
  expect(
    chatPartEntry(
      {
        entry: "3b559b567aad313200110017:0",
        quote:
          "Double seek: when a cut-crossing seek activates a nested source, the inner composition may now be positioned twice.",
        at: "2026-11-05T13:43:28.354Z",
        excerpt: "IGA 186 is fixed and committed on this branch.",
      },
      entries,
    ),
  ).toBe(fixed.id);
  // Words as drawn: code and bold without their marks.
  expect(
    chatPartEntry(
      {
        entry: "bf6d64342e352355298c5139:0",
        quote:
          "All 8 skipped tests are the validate.nle.* scenarios, and one is uridecodepoolsrc_new_stack_no_seek, which matters here.",
      },
      entries,
    ),
  ).toBe(skipped.id);
  // A table's cells, read without the bars between them.
  expect(
    chatPartEntry(
      {
        entry: "gone:0",
        quote: "6c34c00b8uridecodepool: forward user seeks to nested",
      },
      entries,
    ),
  ).toBe(fixed.id);
  // Its own id first.
  expect(
    chatPartEntry({ entry: skipped.id, quote: "Double seek" }, entries),
  ).toBe(skipped.id);
  // Neither its time nor its words: not shown.
  expect(
    chatPartEntry({ entry: "gone:0", quote: "Something else said" }, entries),
  ).toBeNull();
});

test("words said twice go to the message nearest the comment's time", () => {
  const early = said("a:0", "Tests pass.", "2026-11-05T10:00:00Z");
  const late = said("b:0", "Tests pass.", "2026-11-05T13:00:00Z");
  expect(
    chatPartEntry(
      { entry: "x:0", quote: "Tests pass.", at: "2026-11-05T12:59:00Z" },
      [early, late],
    ),
  ).toBe("b:0");
  expect(
    chatPartEntry(
      { entry: "x:0", quote: "Tests pass.", at: "2026-11-05T10:01:00Z" },
      [early, late],
    ),
  ).toBe("a:0");
});

test("every thread is drawn on its message or listed as away", () => {
  const threads = [
    chatThread("t1", {
      chat: {
        entry: "3b559b567aad313200110017:0",
        quote: "IGA-186 is fixed and committed on this branch.",
        at: "2026-11-05T13:43:28.354Z",
      },
    }),
    chatThread("t2", {
      chat: { entry: "old:0", quote: "Whitelist fix: you were right" },
    }),
    // On a message of t2's thread, and on one of that one's.
    chatThread("t3", {
      message: { thread: "t2", comment: "t2-c", quote: "fix" },
    }),
    chatThread("t4", {
      message: { thread: "t3", comment: "t3-c", quote: "fix" },
    }),
    chatThread("t5", {
      message: { thread: "t1", comment: "t1-c", quote: "fix" },
    }),
  ];
  const placed = placeChatThreads(threads, [skipped, fixed]);
  expect([...placed.byEntry.keys()]).toEqual([fixed.id]);
  expect(placed.byEntry.get(fixed.id)?.map((t) => t.id)).toEqual(["t1"]);
  expect([...placed.away].sort()).toEqual(["t2", "t3", "t4"]);
  // Without the messages shown: by their ids, as before.
  const blind = placeChatThreads(threads, undefined);
  expect([...blind.byEntry.keys()]).toEqual([
    "3b559b567aad313200110017:0",
    "old:0",
  ]);
  expect(blind.away.size).toBe(0);
});

test("the same places are kept, so messages read draw nothing again", () => {
  const thread = chatThread("t1", {
    chat: { entry: fixed.id, quote: "IGA-186 is fixed" },
  });
  const before = placeChatThreads([thread], [fixed]);
  // An older page read: the thread stays where it was.
  expect(samePlaces(before, placeChatThreads([thread], [skipped, fixed]))).toBe(
    true,
  );
  // Its message gone from those shown: it is away.
  expect(samePlaces(before, placeChatThreads([thread], [skipped]))).toBe(false);
  // A new answer in it: drawn again.
  expect(
    samePlaces(before, placeChatThreads([{ ...thread }], [skipped, fixed])),
  ).toBe(false);
});
