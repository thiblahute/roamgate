import { afterEach, describe, expect, test } from "bun:test";
import {
  companionCallState,
  logCompanion,
  __resetCompanionCallForTests,
} from "./companionCall";
import {
  __resetCompanionEpochForTests,
  noteCompanionEpoch,
} from "./companionMemory";
import { noteAgentAnswer, recentAnswers } from "./voiceCompanion";
import { __resetAnswersForTests } from "./voiceCompanion";

function filled() {
  logCompanion({ kind: "heard", text: "lance les tests" });
  noteAgentAnswer({ agent: "roamgate", text: "ok", ids: [] });
}

afterEach(() => {
  __resetCompanionCallForTests();
  __resetAnswersForTests();
  __resetCompanionEpochForTests();
});

describe("noteCompanionEpoch", () => {
  test("the first epoch keeps the page's conversation", () => {
    filled();
    noteCompanionEpoch(3);
    expect(companionCallState().log).toHaveLength(1);
    expect(recentAnswers()).toHaveLength(1);
  });

  test("an epoch that moves means a reset elsewhere: forgotten here too", () => {
    noteCompanionEpoch(3);
    filled();
    noteCompanionEpoch(4);
    expect(companionCallState().log).toHaveLength(0);
    expect(recentAnswers()).toHaveLength(0);
  });

  test("the same epoch, or none, changes nothing", () => {
    noteCompanionEpoch(3);
    filled();
    noteCompanionEpoch(3);
    noteCompanionEpoch(undefined);
    expect(companionCallState().log).toHaveLength(1);
  });
});
