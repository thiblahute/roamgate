import { describe, expect, test } from "bun:test";
import type { AgentChatHandoverResult } from "../../../shared/agentChat";
import { autoStartRetry, createAutoStarter } from "./auto-start";
import { virtualClock } from "./testing";

function starter(
  answers: AgentChatHandoverResult[],
  options: { owned?: () => boolean } = {},
) {
  const clock = virtualClock();
  const tries: [string, string, number][] = [];
  const auto = createAutoStarter({
    toConversation: async (paneId, sessionId) => {
      tries.push([paneId, sessionId, clock.now()]);
      return answers.shift() ?? { ok: false, reason: "no more answers" };
    },
    owned: options.owned ?? (() => false),
    closed: () => false,
    sleep: clock.sleep,
    now: clock.now,
  });
  return { auto, tries, clock };
}

const no = (reason: string): AgentChatHandoverResult => ({ ok: false, reason });
const yes: AgentChatHandoverResult = {
  ok: true,
  owner: "conversation",
  session_id: "s",
};

describe("taking a claude that just started", () => {
  test("refusals while it starts are tried again; the user's own work ends it", () => {
    expect(autoStartRetry("Herdr has no session id for this pane")).toBe(
      "starting",
    );
    expect(autoStartRetry("Claude's prompt box is not on screen")).toBe(
      "starting",
    );
    expect(autoStartRetry("Claude is not running in this pane")).toBe(
      "starting",
    );
    expect(
      autoStartRetry("Claude is waiting for an answer in the terminal"),
    ).toBe("starting");
    expect(
      autoStartRetry(
        "Claude is working (a turn or a background task); it can switch once it is idle",
      ),
    ).toBe("busy");
    expect(
      autoStartRetry(
        "Something is typed in Claude's prompt box; send or clear it first",
      ),
    ).toBe("stop");
    expect(autoStartRetry("The pane now runs another session")).toBe("stop");
    expect(
      autoStartRetry(
        "Conversation mode already owns this session in another pane",
      ),
    ).toBe("stop");
    expect(
      autoStartRetry(
        "The pane holder did not start; Claude was resumed in the terminal",
      ),
    ).toBe("stop");
  });

  test("waits for Claude to draw its prompt, then takes it", async () => {
    const { auto, tries } = starter([
      no("Herdr has no session id for this pane"),
      no("Claude's prompt box is not on screen"),
      yes,
    ]);
    const result = await auto.start("w1:p1", "s-1");
    expect(result.ok).toBe(true);
    expect(tries.map(([pane, session, at]) => [pane, session, at])).toEqual([
      ["w1:p1", "s-1", 1000],
      ["w1:p1", "s-1", 2000],
      ["w1:p1", "s-1", 3000],
    ]);
    expect(auto.pending("w1:p1")).toBe(false);
  });

  test("a prompt it was started with runs to its end first", async () => {
    const { auto, tries } = starter([
      no("Claude is working (a turn or a background task)"),
      no("Claude is working (a turn or a background task)"),
      yes,
    ]);
    expect((await auto.start("w1:p1", "s-1")).ok).toBe(true);
    expect(tries.map(([, , at]) => at)).toEqual([1000, 4000, 7000]);
  });

  test("something typed in the terminal: it stays there", async () => {
    const { auto, tries } = starter([
      no("Something is typed in Claude's prompt box; send or clear it first"),
      yes,
    ]);
    const result = await auto.start("w1:p1", "s-1");
    expect(result.ok).toBe(false);
    expect(tries).toHaveLength(1);
  });

  test("gives up on a claude that never comes up", async () => {
    const answers = Array.from({ length: 1000 }, () =>
      no("Herdr has no session id for this pane"),
    );
    const { auto, tries, clock } = starter(answers);
    const result = await auto.start("w1:p1", "s-1");
    expect(result.ok).toBe(false);
    expect(clock.now()).toBeGreaterThanOrEqual(120_000);
    expect(clock.now()).toBeLessThan(125_000);
    expect(tries.length).toBeLessThan(130);
  });

  test("a newer start replaces the one waiting; a pane taken meanwhile ends it", async () => {
    let owned = false;
    const { auto, tries } = starter(
      [no("Herdr has no session id for this pane"), yes],
      { owned: () => owned },
    );
    const first = auto.start("w1:p1", "s-1");
    const second = auto.start("w1:p1", "s-2");
    expect((await second).ok).toBe(true);
    expect((await first).ok).toBe(false);
    // Only the newer one tried, with its own session.
    expect(tries.map(([, session]) => session)).toEqual(["s-2", "s-2"]);
    owned = true;
    const third = await auto.start("w1:p1", "s-3");
    expect(third.ok).toBe(false);
    expect(tries).toHaveLength(2);
  });
});
