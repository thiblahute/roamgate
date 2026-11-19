import { describe, expect, test } from "bun:test";
import { withTurnContext } from "../http/voice";
import { TurnCauses, turnContext } from "./turn-causes";

const clock = (start = 1_000_000) => {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe("TurnCauses", () => {
  test("the turn's cause is the last one noted before it started", () => {
    const time = clock();
    const causes = new TurnCauses(time.now);
    causes.note("local", "w1:p1", { by: "agent", name: "builder" });
    time.advance(60_000);
    causes.note("local", "w1:p1", { by: "user", via: "review" });
    time.advance(2_000);
    // The turn started with the review comment and ran 40 s.
    time.advance(40_000);
    expect(causes.turn("local", "w1:p1", 40_000).cause).toMatchObject({
      by: "user",
      via: "review",
    });
    // A turn that started before it was the agent's message.
    expect(causes.turn("local", "w1:p1", 90_000).cause).toMatchObject({
      by: "agent",
      name: "builder",
    });
    // Another session has none.
    expect(causes.turn("local", "w1:p2").cause).toBeNull();
  });

  test("an old cause did not start a new turn", () => {
    const time = clock();
    const causes = new TurnCauses(time.now);
    causes.note("local", "w1:p1", { by: "companion" });
    time.advance(2 * 60 * 60_000);
    expect(causes.turn("local", "w1:p1", 30_000).cause).toBeNull();
  });

  test("only the user's own causes and keys are their input", () => {
    const time = clock();
    const causes = new TurnCauses(time.now);
    causes.note("local", "w1:p1", { by: "companion" });
    expect(causes.turn("local", "w1:p1").userAt).toBeNull();
    causes.noteUser("local", "w1:p1");
    expect(causes.turn("local", "w1:p1").userAt).toBe(time.now());
    // Keys typed are not a turn's cause.
    expect(causes.turn("local", "w1:p1").cause).toMatchObject({
      by: "companion",
    });
    time.advance(5_000);
    causes.note("local", "w1:p1", { by: "user", via: "chat" });
    expect(causes.turn("local", "w1:p1").userAt).toBe(time.now());
  });
});

describe("turnContext", () => {
  test("says what started the turn, how long it ran, and whether the user looks", () => {
    const now = 1_000_000;
    expect(
      turnContext(
        {
          cause: { by: "user", via: "review", at: now - 40_000 },
          userAt: now - 40_000,
          turnMs: 40_000,
          looking: true,
        },
        now,
      ),
    ).toBe(
      "(started by the user's review comment; ran 40 s; the user's last input there 40 s ago; the user is looking at it)",
    );
    expect(
      turnContext(
        {
          cause: { by: "companion", at: now - 600_000 },
          userAt: null,
          turnMs: 9 * 60_000,
        },
        now,
      ),
    ).toBe(
      "(started by your own errand; ran 9 min; no input from the user there lately)",
    );
    expect(
      turnContext(
        {
          cause: { by: "agent", name: "roamgate-android", at: now },
          userAt: now - 3 * 60 * 60_000,
        },
        now,
      ),
    ).toBe(
      "(started by a message from agent session roamgate-android; the user's last input there 3 h ago)",
    );
    expect(turnContext({ cause: null, userAt: null }, now)).toBe(
      "(started by nothing Roamgate saw: cause unknown; no input from the user there lately)",
    );
  });

  test("an event about a session gets its turn's context, others stay as they are", () => {
    const time = clock();
    const causes = new TurnCauses(time.now);
    causes.note("local", "w1:p1", { by: "user", via: "review" });
    time.advance(40_000);
    expect(
      withTurnContext(
        "cps-iga185: Claude finished",
        { pane: "local/w1:p1", turn_ms: 40_000, looking: true },
        causes,
        time.now(),
      ),
    ).toBe(
      "cps-iga185: Claude finished (started by the user's review comment; ran 40 s; the user's last input there 40 s ago; the user is looking at it)",
    );
    expect(
      withTurnContext("Ranger task succeeded: backup", {}, causes, time.now()),
    ).toBe("Ranger task succeeded: backup");
    expect(withTurnContext("x", { pane: "nopane" }, causes, time.now())).toBe(
      "x",
    );
  });
});
