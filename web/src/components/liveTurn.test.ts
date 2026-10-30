import { describe, expect, test } from "bun:test";
import type { AgentChatEvent } from "../../../shared/agentChat";
import type { HistoryEntry } from "./agentHistory";
import {
  applyLiveEvent,
  EMPTY_LIVE_TURN,
  LIVE_ITEM_GRACE_MS,
  type LiveTurn,
  liveTurnEntries,
  reconcileLiveTurn,
  withStreamedText,
} from "./liveTurn";

function play(events: AgentChatEvent[], from = EMPTY_LIVE_TURN, now = 1000) {
  return events.reduce((turn, event) => applyLiveEvent(turn, event, now), from);
}

const entry = (extra: Partial<HistoryEntry>): HistoryEntry => ({
  id: "x",
  role: "assistant",
  kind: "message",
  text: "",
  sent_at: "2026-10-29T00:00:00.000Z",
  ...extra,
});

describe("the live turn", () => {
  test("text grows token by token, keyed by message id and block index", () => {
    const turn = play([
      { type: "block_start", message_id: "m1", index: 0, block: "text" },
      { type: "delta", message_id: "m1", index: 0, text: "Hel" },
      { type: "delta", message_id: "m1", index: 0, text: "lo." },
    ]);
    expect(liveTurnEntries(turn)).toEqual([
      expect.objectContaining({
        id: "live:m1:0",
        role: "assistant",
        text: "Hello.",
        message_id: "m1",
        block_index: 0,
      }),
    ]);
  });

  test("thinking blocks are not drawn, nor their deltas", () => {
    const turn = play([
      { type: "block_start", message_id: "m1", index: 0, block: "thinking" },
      { type: "delta", message_id: "m1", index: 0, text: "hmm" },
      { type: "block_stop", message_id: "m1", index: 0, text: "hmm" },
    ]);
    expect(liveTurnEntries(turn)).toEqual([]);
  });

  test("a block's stop gives its whole text", () => {
    const turn = play([
      { type: "block_start", message_id: "m1", index: 1, block: "text" },
      { type: "delta", message_id: "m1", index: 1, text: "Partial" },
      { type: "block_stop", message_id: "m1", index: 1, text: "Partial text." },
    ]);
    expect(liveTurnEntries(turn)[0]?.text).toBe("Partial text.");
  });

  test("an abandoned block (a retry, an interrupt) is dropped", () => {
    const turn = play([
      { type: "block_start", message_id: "m1", index: 0, block: "text" },
      { type: "delta", message_id: "m1", index: 0, text: "Kept." },
      { type: "block_start", message_id: "m1", index: 1, block: "text" },
      { type: "delta", message_id: "m1", index: 1, text: "Dropped" },
      { type: "abandoned", message_id: "m1", from_index: 1 },
    ]);
    expect(liveTurnEntries(turn).map((each) => each.text)).toEqual(["Kept."]);
  });

  test("tools show as a call and a result, paired by tool_use id", () => {
    const turn = play([
      {
        type: "tool_use",
        tool_use_id: "tu1",
        name: "Read",
        input: { file_path: "/a" },
        message_id: "m1",
        index: 0,
      },
      { type: "tool_result", tool_use_id: "tu1", is_error: false, text: "ok" },
    ]);
    expect(liveTurnEntries(turn)).toEqual([
      expect.objectContaining({
        kind: "tool_call",
        tool_name: "Read",
        source_call_id: "tu1",
        text: '{"file_path":"/a"}',
      }),
      expect.objectContaining({
        kind: "tool_result",
        source_call_id: "tu1",
        text: "ok",
      }),
    ]);
  });

  test("the replayed user message shows, once", () => {
    const user: AgentChatEvent = {
      type: "user",
      uuid: "u1",
      text: "Hi",
      images: 0,
    };
    const turn = play([user, user]);
    expect(liveTurnEntries(turn)).toEqual([
      expect.objectContaining({ role: "user", text: "Hi", uuid: "u1" }),
    ]);
  });

  test("unchanged by an event it does not draw", () => {
    const turn = play([
      { type: "block_start", message_id: "m1", index: 0, block: "text" },
    ]);
    expect(
      applyLiveEvent(
        turn,
        {
          type: "status",
          status: "working",
          tools_running: false,
          activity: null,
        },
        2000,
      ),
    ).toBe(turn);
  });

  test("/clear starts over", () => {
    const turn = play([
      { type: "delta", message_id: "m1", index: 0, text: "Old." },
      { type: "session", session_id: "s2", previous: "s1" },
    ]);
    expect(turn.items).toEqual([]);
  });
});

describe("reconciling with the transcript", () => {
  const streamed = (): LiveTurn =>
    play([
      { type: "user", uuid: "u1", text: "Do it", images: 0 },
      { type: "delta", message_id: "m1", index: 0, text: "On it." },
      {
        type: "tool_use",
        tool_use_id: "tu1",
        name: "Bash",
        input: {},
        message_id: "m1",
        index: 1,
      },
      { type: "tool_result", tool_use_id: "tu1", is_error: false, text: "" },
      { type: "delta", message_id: "m2", index: 0, text: "Done." },
    ]);

  test("an item leaves once its transcript entry is there", () => {
    const history = [
      entry({ id: "a", role: "user", text: "Do it", uuid: "u1" }),
      entry({ id: "b", text: "On it.", message_id: "m1", block_index: 0 }),
      entry({
        id: "c",
        role: "tool",
        kind: "tool_call",
        source_call_id: "tu1",
      }),
    ];
    const left = reconcileLiveTurn(streamed(), history, 1000);
    expect(liveTurnEntries(left).map((each) => each.id)).toEqual([
      "live:result:tu1",
      "live:m2:0",
    ]);
  });

  test("another block of the same message is not taken for it", () => {
    const history = [
      entry({ id: "b", text: "Done.", message_id: "m2", block_index: 1 }),
    ];
    const left = reconcileLiveTurn(streamed(), history, 1000);
    expect(left.items.some((item) => item.key === "m2:0")).toBe(true);
  });

  test("a user message is matched by its words when uuids differ", () => {
    const history = [entry({ id: "a", role: "user", text: "Do  it" })];
    const left = reconcileLiveTurn(streamed(), history, 1000);
    expect(left.items.some((item) => item.kind === "user")).toBe(false);
  });

  test("a message said again waits for its own entry, not the earlier one", () => {
    // "Do it" was said before (its own uuid); this one's is not in yet.
    const history = [
      entry({ id: "a", role: "user", text: "Do it", uuid: "u0" }),
    ];
    const left = reconcileLiveTurn(streamed(), history, 1000);
    expect(left.items.some((item) => item.kind === "user")).toBe(true);
    const settled = reconcileLiveTurn(
      left,
      [...history, entry({ id: "b", role: "user", text: "Do it", uuid: "u1" })],
      1000,
    );
    expect(settled.items.some((item) => item.kind === "user")).toBe(false);
  });

  test("the same object when nothing is settled", () => {
    const turn = streamed();
    expect(reconcileLiveTurn(turn, [], 1000)).toBe(turn);
  });

  test("a finished turn's items go after a grace period anyway", () => {
    const turn = applyLiveEvent(
      streamed(),
      {
        type: "result",
        subtype: "success",
        is_error: false,
        interrupted: false,
        text: "",
      },
      2000,
    );
    expect(reconcileLiveTurn(turn, [], 2000 + 1000).items.length).toBe(5);
    expect(
      reconcileLiveTurn(turn, [], 2000 + LIVE_ITEM_GRACE_MS + 1).items,
    ).toEqual([]);
  });

  test("a running turn's items wait, however long", () => {
    const turn = streamed();
    expect(reconcileLiveTurn(turn, [], 10 * LIVE_ITEM_GRACE_MS)).toBe(turn);
  });
});

describe("coming in the middle of a turn (a reload)", () => {
  const rain = "Rain falls steadily. Umbrellas tilted against the wind.";

  test("a block drawn from the later deltas only gets all of its text", () => {
    // The page came back while the answer streamed: the deltas since then.
    const tail = play([
      { type: "delta", message_id: "m1", index: 1, text: "ilted against" },
    ]);
    const turn = withStreamedText(
      tail,
      [
        {
          message_id: "m1",
          index: 1,
          text: "Rain falls steadily. Umbrellas tilted against",
          done: false,
        },
      ],
      1000,
    );
    expect(liveTurnEntries(turn).map((each) => each.text)).toEqual([
      "Rain falls steadily. Umbrellas tilted against",
    ]);
    const more = play(
      [{ type: "delta", message_id: "m1", index: 1, text: " the wind." }],
      turn,
    );
    expect(liveTurnEntries(more)[0]?.text).toBe(rain);
  });

  test("a block not drawn yet comes in, one already ahead stays", () => {
    const ahead = play([
      { type: "delta", message_id: "m1", index: 1, text: "Rain falls" },
    ]);
    expect(
      withStreamedText(
        ahead,
        [{ message_id: "m1", index: 1, text: "Rain", done: false }],
        1000,
      ),
    ).toBe(ahead);
    const empty = withStreamedText(
      EMPTY_LIVE_TURN,
      [{ message_id: "m1", index: 1, text: "Rain", done: false }],
      1000,
    );
    expect(empty.endedAt).toBeNull();
    expect(liveTurnEntries(empty).map((each) => each.text)).toEqual(["Rain"]);
    expect(withStreamedText(ahead, [], 1000)).toBe(ahead);
  });

  test("its block leaves once the transcript has it: no second copy", () => {
    const turn = play(
      [
        { type: "delta", message_id: "m1", index: 1, text: " the wind." },
        { type: "block_stop", message_id: "m1", index: 1, text: rain },
      ],
      withStreamedText(
        EMPTY_LIVE_TURN,
        [
          {
            message_id: "m1",
            index: 1,
            text: "Rain falls steadily. Umbrellas tilted against",
            done: false,
          },
        ],
        1000,
      ),
    );
    const history = [
      entry({ id: "t", text: rain, message_id: "m1", block_index: 1 }),
    ];
    expect(reconcileLiveTurn(turn, history, 1000).items).toEqual([]);
  });

  test("a finished block whose index went astray is matched by its words", () => {
    // A complete block given another index than its stream's (a thinking
    // block before it): the browser had no block type to tell.
    const turn = play([
      { type: "block_stop", message_id: "m1", index: 0, text: rain },
    ]);
    expect(liveTurnEntries(turn)).toHaveLength(1);
    const history = [
      entry({ id: "t", text: rain, message_id: "m1", block_index: 1 }),
    ];
    expect(reconcileLiveTurn(turn, history, 1000).items).toEqual([]);
    // Another message with the same words is not it.
    const other = [
      entry({ id: "t", text: rain, message_id: "m0", block_index: 0 }),
    ];
    expect(reconcileLiveTurn(turn, other, 1000)).toBe(turn);
  });
});

describe("what Claude Code puts in the user's turn", () => {
  const report = `<agent-message from="voice-overlay">
[Subagent hand-back] The report follows:
  Committed.
</agent-message>`;
  const task = `<task-notification>
<status>completed</status>
<summary>Agent "Float it" finished</summary>
</task-notification>`;

  test("shows as notices, not as the user's message", () => {
    const turn = play([
      { type: "user", uuid: "a", text: report, images: 0 },
      { type: "user", uuid: "b", text: task, images: 0 },
      {
        type: "user",
        uuid: "c",
        text: "<system-reminder>\nquiet\n</system-reminder>",
        images: 0,
      },
    ]);
    expect(
      liveTurnEntries(turn).map((each) => [
        each.role,
        each.injected?.label,
        each.text,
        each.uuid,
      ]),
    ).toEqual([
      ["user", "Report from voice-overlay", "Committed.", "a"],
      [
        "user",
        'Task finished: Agent "Float it" finished',
        'Agent "Float it" finished',
        "b",
      ],
    ]);
  });

  test("settles into its transcript entry instead of floating at the end", () => {
    const turn = play([
      { type: "user", uuid: "u1", text: "[Voice] Float it", images: 0 },
      { type: "block_start", message_id: "m1", index: 0, block: "text" },
      { type: "block_stop", message_id: "m1", index: 0, text: "On it." },
      { type: "user", uuid: "a", text: report, images: 0 },
      { type: "block_start", message_id: "m2", index: 0, block: "text" },
      { type: "block_stop", message_id: "m2", index: 0, text: "Thanks." },
    ]);
    // The transcript now has all of it, the report by its replay's uuid.
    const history = [
      entry({ id: "1", role: "user", text: "[Voice] Float it", uuid: "u1" }),
      entry({ id: "2", text: "On it.", message_id: "m1", block_index: 0 }),
      entry({
        id: "3",
        role: "user",
        text: "Committed.",
        uuid: "a",
        injected: { kind: "report", label: "Report from voice-overlay" },
      }),
      entry({ id: "4", text: "Thanks.", message_id: "m2", block_index: 0 }),
    ];
    expect(reconcileLiveTurn(turn, history, 2000).items).toEqual([]);
    // Not there yet: it waits, and is not taken for a user message.
    const waiting = reconcileLiveTurn(turn, history.slice(0, 2), 2000);
    expect(waiting.items.map((item) => item.key)).toEqual(["user:a", "m2:0"]);
  });
});
