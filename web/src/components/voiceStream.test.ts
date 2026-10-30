import { describe, expect, test } from "bun:test";
import type { AgentChatEvent } from "../../../shared/agentChat";
import {
  BLOCKED_NOTICE,
  type ClaudeTurn,
  createTurnFeed,
  type TurnFeed,
  watchClaudeTurns,
} from "./voiceStream";

async function read(feed: TurnFeed): Promise<string> {
  let text = "";
  for await (const chunk of feed.text) text += chunk;
  return text;
}

const result: AgentChatEvent = {
  type: "result",
  subtype: "success",
  is_error: false,
  interrupted: false,
  text: "",
};

describe("a turn read aloud as it is written", () => {
  test("text deltas, a break per block, the end on the result", async () => {
    const feed = createTurnFeed();
    for (const event of [
      { type: "block_start", message_id: "m", index: 0, block: "text" },
      { type: "delta", message_id: "m", index: 0, text: "Hello" },
      { type: "delta", message_id: "m", index: 0, text: " there" },
      { type: "block_stop", message_id: "m", index: 0 },
      { type: "block_start", message_id: "m", index: 1, block: "thinking" },
      { type: "block_stop", message_id: "m", index: 1, text: "secret" },
      result,
    ] as AgentChatEvent[])
      feed.handle(event);
    expect(await read(feed)).toBe("Hello there\n\n\n\n");
    expect(feed.ids()).toEqual(["live:m:0"]);
  });

  test("a whole block without deltas is read too", async () => {
    const feed = createTurnFeed();
    feed.handle({ type: "block_stop", message_id: "m", index: 0, text: "Hi." });
    feed.handle(result);
    expect(await read(feed)).toContain("Hi.");
  });

  test("waits for the message's replay: what came before is another turn", async () => {
    const feed = createTurnFeed({ uuid: "u2", text: "next one" });
    feed.handle({ type: "delta", message_id: "a", index: 0, text: "Old." });
    feed.handle(result);
    feed.handle({ type: "user", uuid: "u2", text: "next one", images: 0 });
    feed.handle({ type: "delta", message_id: "b", index: 0, text: "New." });
    feed.handle(result);
    expect(await read(feed)).toBe("New.\n\n");
  });

  test("a queued message sent with others is known by its words", async () => {
    const feed = createTurnFeed({ uuid: "u3", text: "second" });
    feed.handle({
      type: "user",
      uuid: "merged",
      text: "first\n\nsecond",
      images: 0,
    });
    expect(feed.started()).toBe(true);
  });

  test("Claude asking something is said once", async () => {
    const feed = createTurnFeed();
    const blocked: AgentChatEvent = {
      type: "status",
      status: "blocked",
      tools_running: true,
      activity: "Bash",
    };
    feed.handle(blocked);
    feed.handle(blocked);
    feed.handle(result);
    const text = await read(feed);
    expect(text.split(BLOCKED_NOTICE).length).toBe(2);
  });

  test("closing ends it with what came", async () => {
    const feed = createTurnFeed();
    feed.handle({ type: "delta", message_id: "m", index: 0, text: "Part" });
    feed.close();
    expect(await read(feed)).toBe("Part");
    await feed.done;
  });
});

const REPORT = `<agent-message from="voice-overlay">
[Subagent hand-back] The report follows:
  You said: next one
</agent-message>`;
const TASK = `<task-notification>
<status>completed</status>
<summary>Agent "x" finished</summary>
</task-notification>`;
const user = (uuid: string, text: string): AgentChatEvent => ({
  type: "user",
  uuid,
  text,
  images: 0,
});
const say = (id: string, text: string): AgentChatEvent[] => [
  { type: "block_start", message_id: id, index: 0, block: "text" },
  { type: "delta", message_id: id, index: 0, text },
  { type: "block_stop", message_id: id, index: 0 },
];

/** A stream as the hook sees it: listeners, fed in order. */
function fakeStream() {
  const listeners = new Set<(event: AgentChatEvent) => void>();
  return {
    subscribe(listener: (event: AgentChatEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(...events: AgentChatEvent[]) {
      for (const event of events)
        for (const listener of [...listeners]) listener(event);
    },
  };
}

describe("however the spoken message goes, its answer is read", () => {
  test("sent: from its replay to its turn's end", async () => {
    const feed = createTurnFeed({ uuid: "u", text: "[Voice] hi" });
    for (const event of [
      user("u", "[Voice] hi"),
      ...say("m", "Hello."),
      result,
    ])
      feed.handle(event);
    expect(await read(feed)).toBe("Hello.\n\n\n\n");
  });

  test("queued: the turn running is not read, the message's own is", async () => {
    const feed = createTurnFeed({ uuid: "u", text: "[Voice] next one" });
    for (const event of [
      ...say("a", "Old."),
      result,
      user("u", "[Voice] next one"),
      ...say("b", "New."),
      result,
    ])
      feed.handle(event);
    expect(await read(feed)).toBe("New.\n\n\n\n");
  });

  test("queued and merged with others: known by its words", async () => {
    const feed = createTurnFeed({ uuid: "u", text: "[Voice] second" });
    for (const event of [
      user("merged", "typed first\n\n[Voice] second"),
      ...say("b", "Both."),
      result,
    ])
      feed.handle(event);
    expect(await read(feed)).toBe("Both.\n\n\n\n");
  });

  test("steered and folded into the running turn: read on to its end", async () => {
    const feed = createTurnFeed({ uuid: "u", text: "[Voice] also this" });
    feed.start();
    for (const event of [
      ...say("a", "Still working."),
      user("u", "[Voice] also this"),
      ...say("b", "Done, with that."),
      result,
    ])
      feed.handle(event);
    expect(await read(feed)).toBe("Still working.\n\nDone, with that.\n\n\n\n");
  });

  test("steered, then run as a turn of its own: the turn's end does not stop the reading", async () => {
    const feed = createTurnFeed({ uuid: "u", text: "[Voice] also this" });
    feed.start();
    for (const event of [
      ...say("a", "Finishing."),
      result,
      user("u", "[Voice] also this"),
      ...say("b", "Now that."),
      result,
    ])
      feed.handle(event);
    expect(await read(feed)).toBe("Finishing.\n\n\n\nNow that.\n\n\n\n");
  });

  test("a report quoting the message is not its replay", async () => {
    const feed = createTurnFeed({ uuid: "u", text: "next one" });
    feed.handle(user("r", REPORT));
    expect(feed.started()).toBe(true);
    feed.handle(result);
    // Claude's answer to the report is read, and the reading goes on to
    // the message's own turn.
    expect(feed.ended()).toBe(false);
    feed.handle(user("u", "next one"));
    feed.handle(result);
    expect(feed.ended()).toBe(true);
  });
});

describe("turns Claude starts by itself", () => {
  test("a task ending after the reading ended starts a reading of its own", async () => {
    const stream = fakeStream();
    let current: TurnFeed | null = createTurnFeed({ uuid: "u", text: "hi" });
    stream.subscribe(current.handle);
    const turns: ClaudeTurn[] = [];
    watchClaudeTurns(
      stream.subscribe,
      () => current,
      (turn) => turns.push(turn),
    );
    stream.emit(user("u", "hi"), ...say("m", "Hello."), result);
    expect(current.ended()).toBe(true);
    // The regression: a task notification came, Claude answered it, and
    // nothing was read.
    stream.emit(user("t", TASK), ...say("n", "The agent finished."));
    expect(turns).toHaveLength(1);
    current = turns[0]!.feed;
    stream.emit(user("t2", TASK), result);
    // One during the turn read is part of it.
    expect(turns).toHaveLength(1);
    expect(await read(turns[0]!.feed)).toBe("The agent finished.\n\n\n\n");
  });

  test("one during a reading is left to it, and the user's messages never start one", () => {
    const stream = fakeStream();
    const current = createTurnFeed({ uuid: "u", text: "hi" });
    stream.subscribe(current.handle);
    const turns: ClaudeTurn[] = [];
    watchClaudeTurns(
      stream.subscribe,
      () => current,
      (turn) => turns.push(turn),
    );
    stream.emit(user("u", "hi"), user("r", REPORT));
    expect(turns).toHaveLength(0);
    stream.emit(result, user("x", "typed in the box"));
    expect(turns).toHaveLength(0);
  });
});
