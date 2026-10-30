import { describe, expect, test } from "bun:test";
import {
  answerMoveQuestion,
  askToMove,
  claimVoice,
  currentMoveQuestion,
  currentVoice,
  handVoiceTo,
  isMoveYes,
  type MoveQuestion,
  voiceFollowPane,
  voiceWorkspaceMove,
} from "./voiceFollow";
import { handOffVoice, takeVoiceHandoff } from "./voiceRoute";

const pane = (
  pane_id: string,
  extra: Partial<{
    workspace_id: string;
    tab_id: string;
    focused: boolean;
    agent: string;
  }> = {},
) => ({
  pane_id,
  workspace_id: "w2",
  tab_id: "t1",
  focused: false,
  ...extra,
});

const w2 = { workspace_id: "w2", active_tab_id: "t1" };

describe("the pane voice follows to", () => {
  test("the shown pane when it is an agent", () => {
    const panes = [
      pane("shell", { focused: false }),
      pane("claude", { focused: true, agent: "claude" }),
      pane("codex", { agent: "codex" }),
    ];
    expect(voiceFollowPane(w2, panes, { recentPaneIds: ["codex"] })).toBe(
      "claude",
    );
  });

  test("else the most recently used agent pane", () => {
    const panes = [
      pane("shell", { focused: true }),
      pane("old", { agent: "claude" }),
      pane("recent", { agent: "codex", tab_id: "t2" }),
    ];
    expect(
      voiceFollowPane(w2, panes, { recentPaneIds: ["shell", "recent", "old"] }),
    ).toBe("recent");
  });

  test("never one recently used: the shown tab's first", () => {
    const panes = [
      pane("other-tab", { agent: "claude", tab_id: "t2" }),
      pane("shown-tab", { agent: "claude" }),
    ];
    expect(voiceFollowPane(w2, panes)).toBe("shown-tab");
  });

  test("the pane picked by hand when it is an agent", () => {
    const panes = [
      pane("a", { focused: true, agent: "claude" }),
      pane("b", { agent: "claude", tab_id: "t2" }),
    ];
    expect(voiceFollowPane(w2, panes, { chosenPaneId: "b" })).toBe("b");
    // A shell picked by hand: its workspace's agent instead.
    expect(
      voiceFollowPane(w2, [...panes, pane("sh")], { chosenPaneId: "sh" }),
    ).toBe("a");
  });

  test("none in a workspace without agents, whatever the others have", () => {
    const panes = [
      pane("shell", { focused: true }),
      pane("elsewhere", { agent: "claude", workspace_id: "w1" }),
      pane("blank", { agent: "  " }),
    ];
    expect(voiceFollowPane(w2, panes)).toBeNull();
  });
});

describe("what a focus change does to voice chat", () => {
  const panes = [
    pane("here", { workspace_id: "w1", focused: true, agent: "claude" }),
    pane("shell", { focused: true }),
    pane("agent", { agent: "claude", tab_id: "t2" }),
  ];

  test("nothing with voice off or the same workspace", () => {
    expect(
      voiceWorkspaceMove({ voiceOn: false, from: "w1", workspace: w2, panes }),
    ).toEqual({ to: "free" });
    expect(
      voiceWorkspaceMove({ voiceOn: true, from: "w2", workspace: w2, panes }),
    ).toEqual({ to: "free" });
  });

  test("goes on with the agent, focusing it when not shown", () => {
    expect(
      voiceWorkspaceMove({ voiceOn: true, from: "w1", workspace: w2, panes }),
    ).toEqual({ to: "pane", paneId: "agent", shown: false });
    expect(
      voiceWorkspaceMove({
        voiceOn: true,
        from: "w2",
        workspace: { workspace_id: "w1", active_tab_id: "t1" },
        panes,
      }),
    ).toEqual({ to: "pane", paneId: "here", shown: true });
  });

  test("asks before a workspace with no agent", () => {
    expect(
      voiceWorkspaceMove({
        voiceOn: true,
        from: "w1",
        workspace: w2,
        panes: panes.filter((each) => each.pane_id !== "agent"),
      }),
    ).toEqual({ to: "ask" });
  });
});

describe("the answer to moving anyway", () => {
  test("yes", () => {
    for (const said of [
      "Yes",
      "yeah, just move",
      "Just move.",
      "okay move",
      "Oui",
      "ouais vas-y",
      "Yes please",
    ])
      expect(isMoveYes(said)).toBe(true);
  });

  test("no, or anything else", () => {
    for (const said of [
      "No",
      "no, stay",
      "Non",
      "yes no wait",
      "don't move",
      "what's the status of the build?",
      "",
    ])
      expect(isMoveYes(said)).toBe(false);
  });
});

describe("one voice chat at a time", () => {
  const owner = (name: string, log: string[], asked: MoveQuestion[] = []) => ({
    connectionId: "c",
    paneId: name,
    handAway: () => log.push(`${name} handed away`),
    ask: (question: MoveQuestion) => asked.push(question),
  });

  test("a new one ends the one running", () => {
    const log: string[] = [];
    const releaseA = claimVoice(owner("a", log));
    const releaseB = claimVoice(owner("b", log));
    expect(log).toEqual(["a handed away"]);
    // The first, ending late, does not let the second go.
    releaseA();
    expect(currentVoice()?.paneId).toBe("b");
    releaseB();
    expect(currentVoice()).toBeNull();
  });

  test("the question goes to the voice chat; a newer one replaces it", async () => {
    const log: string[] = [];
    const asked: MoveQuestion[] = [];
    const release = claimVoice(owner("a", log, asked));
    const first = askToMove("notes", () => {});
    expect(first.text).toBe(
      "There is no agent in notes, so voice can't go there. Do you still want to move?",
    );
    const second = askToMove("scratch", () => {});
    expect(await first.answered).toBeNull();
    expect(asked).toEqual([first, second]);
    expect(currentMoveQuestion()).toBe(second);
    answerMoveQuestion(second, true);
    expect(await second.answered).toBe(true);
    expect(currentMoveQuestion()).toBeNull();
    // Voice chat ending drops a question left open.
    const third = askToMove("logs", () => {});
    release();
    expect(await third.answered).toBeNull();
  });
});

describe("handing voice to the next workspace's agent", () => {
  test("the running one ends before the next one is handed it", () => {
    const log: string[] = [];
    let running = true;
    const release = claimVoice({
      connectionId: "c",
      paneId: "old",
      handAway: () => {
        log.push("old ends");
        running = false;
      },
      ask: () => {},
    });
    handVoiceTo({ connectionId: "c", paneId: "new" });
    expect(log).toEqual(["old ends"]);
    // The old chat, unmounting after, leaves no handoff of its own: it is
    // no longer running, so the new pane's stands.
    if (running)
      handOffVoice({ connectionId: "c", paneId: "old", message: null });
    expect(takeVoiceHandoff("c", "old")).toBeNull();
    expect(takeVoiceHandoff("c", "new")).toEqual({ message: null });
    // Taken once.
    expect(takeVoiceHandoff("c", "new")).toBeNull();
    release();
  });

  test("keeps the router's handoff and its words", () => {
    const log: string[] = [];
    const release = claimVoice({
      connectionId: "c",
      paneId: "old",
      handAway: () => log.push("old ends"),
      ask: () => {},
    });
    handOffVoice({
      connectionId: "c",
      paneId: "new",
      message: "run the tests",
    });
    handVoiceTo({ connectionId: "c", paneId: "new" });
    expect(log).toEqual([]);
    expect(takeVoiceHandoff("c", "new")).toEqual({ message: "run the tests" });
    release();
  });

  test("nothing when it is already there", () => {
    const log: string[] = [];
    const release = claimVoice({
      connectionId: "c",
      paneId: "here",
      handAway: () => log.push("ended"),
      ask: () => {},
    });
    handVoiceTo({ connectionId: "c", paneId: "here" });
    expect(log).toEqual([]);
    expect(takeVoiceHandoff("c", "here")).toBeNull();
    release();
  });
});
