import { describe, expect, test } from "bun:test";
import type { HistoryEntry } from "./agentHistory";
import {
  newOutboxMessage,
  nextOutboxDeadline,
  type OutboxMessage,
  outboxNotShown,
  releaseHeldOutbox,
  settleOutbox,
} from "./chatOutbox";

function user(id: string, text: string, extra: Partial<HistoryEntry> = {}) {
  return {
    id,
    kind: "message",
    role: "user",
    text,
    sent_at: "2026-10-28T12:00:00.000Z",
    ...extra,
  } as HistoryEntry;
}

function sent(message: OutboxMessage): OutboxMessage {
  return { ...message, state: "sent" };
}

describe("settleOutbox", () => {
  test("keeps a message until the transcript shows it", () => {
    const history = [user("a", "Look at the readme")];
    const message = sent(newOutboxMessage("p1", "Run the tests", history, 0));
    const outbox = [message];
    expect(settleOutbox(outbox, history, 1000)).toBe(outbox);
    expect(
      settleOutbox(outbox, [...history, user("b", "Run the tests")], 2000),
    ).toEqual([]);
  });

  test("never takes a message the history had before it was sent", () => {
    const history = [user("a", "Again")];
    const outbox = [sent(newOutboxMessage("p1", "Again", history, 0))];
    expect(settleOutbox(outbox, history, 1000)).toHaveLength(1);
    expect(
      settleOutbox(outbox, [...history, user("b", "Again")], 1000),
    ).toEqual([]);
  });

  test("takes the message as queued too", () => {
    const outbox = [sent(newOutboxMessage("p1", "And then?", [], 0))];
    expect(
      settleOutbox(outbox, [user("q", "And then?", { queued: true })], 10),
    ).toEqual([]);
  });

  test("tolerates the transcript rewriting whitespace", () => {
    const outbox = [
      sent(newOutboxMessage("p1", "  two\n\nlines \t here ", [], 0)),
    ];
    expect(settleOutbox(outbox, [user("b", "two lines here")], 10)).toEqual([]);
  });

  test("matches a message the agent added to", () => {
    const outbox = [sent(newOutboxMessage("p1", "What is in it?", [], 0))];
    expect(
      settleOutbox(outbox, [user("b", "[Image #1] What is in it?")], 10),
    ).toEqual([]);
  });

  test("ignores the agent's own and other words", () => {
    const outbox = [sent(newOutboxMessage("p1", "ok", [], 0))];
    const history = [
      user("b", "ok", { role: "assistant" }),
      user("c", "ok then, go on"),
      user("d", "ok", { compact_summary: true }),
    ];
    expect(settleOutbox(outbox, history, 10)).toHaveLength(1);
  });

  test("pairs messages with the same words in order", () => {
    const first = sent(newOutboxMessage("p1", "Next", [], 0));
    const second = sent(newOutboxMessage("p1", "Next", [], 5));
    const third = sent(newOutboxMessage("p1", "Done", [], 9));
    const left = settleOutbox([first, second, third], [user("b", "Next")], 20);
    expect(left.map((message) => message.id)).toEqual([second.id, third.id]);
  });

  test("fails a sent message the transcript never shows", () => {
    const outbox = [sent(newOutboxMessage("p1", "Hello", [], 0))];
    const [late] = settleOutbox(outbox, [], 1000, 1000);
    expect(late?.state).toBe("failed");
    expect(late?.reason).toBeTruthy();
    // Still taken if it shows up after all.
    expect(settleOutbox([late!], [user("b", "Hello")], 5000, 1000)).toEqual([]);
  });

  test("does not time out a message still being sent", () => {
    const outbox = [newOutboxMessage("p1", "Hello", [], 0)];
    expect(settleOutbox(outbox, [], 10_000, 1000)).toBe(outbox);
  });
});

test("nextOutboxDeadline is the earliest sent message's", () => {
  const sending = newOutboxMessage("p1", "a", [], 0);
  expect(nextOutboxDeadline([sending], 100)).toBeNull();
  expect(
    nextOutboxDeadline(
      [sent({ ...sending, sentAtMs: 50 }), sent({ ...sending, sentAtMs: 20 })],
      100,
    ),
  ).toBe(120);
});

describe("conversation mode's other bubbles", () => {
  const sent = (text: string, uuid?: string): OutboxMessage => ({
    ...newOutboxMessage("p1", text, [], 1000),
    state: "sent",
    ...(uuid ? { uuid } : {}),
  });

  test("hides a message its queued, live or transcript bubble shows", () => {
    const a = sent("same words here", "u1");
    const b = sent("same words here", "u2");
    expect(outboxNotShown([a, b], new Set(["u2"]))).toEqual([a]);
  });

  test("keeps a message without a uuid: the transcript settles it", () => {
    const list = [sent("hello there friend")];
    expect(outboxNotShown(list, new Set(["u1"]))).toBe(list);
  });

  test("the same list when nothing is shown elsewhere", () => {
    const list = [sent("hello there friend", "u1")];
    expect(outboxNotShown(list, new Set(["u9"]))).toBe(list);
  });
});

describe("held messages", () => {
  const held = (paneId: string, text: string): OutboxMessage => ({
    ...newOutboxMessage(paneId, text, [], 0),
    uuid: `uuid-${text}`,
    held: true,
  });

  test("a message held through the handover waits without timing out", () => {
    const message = held("p1", "Sent during the takeover");
    expect(settleOutbox([message], [], 10 * 60_000)).toEqual([message]);
    expect(nextOutboxDeadline([message])).toBeNull();
  });

  test("fails a pane's held messages when the handover did not happen", () => {
    const mine = held("p1", "first");
    const other = held("p2", "elsewhere");
    const plain = newOutboxMessage("p1", "not held", [], 0);
    const released = releaseHeldOutbox([mine, other, plain], "p1", "why");
    expect(released[0]).toMatchObject({
      state: "failed",
      reason: "why",
      held: undefined,
      text: "first",
    });
    expect(released[1]).toBe(other);
    expect(released[2]).toBe(plain);
  });

  test("leaves the outbox untouched when nothing is held", () => {
    const outbox = [newOutboxMessage("p1", "a", [], 0)];
    expect(releaseHeldOutbox(outbox, "p1", "why")).toBe(outbox);
  });
});
