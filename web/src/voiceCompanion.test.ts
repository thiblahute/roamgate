import { afterEach, describe, expect, test } from "bun:test";
import type { AgentPermissionPrompt } from "../../shared/review";
import {
  __resetCompanionCallForTests,
  COMPANION_VOICE_KEY,
  companionCallState,
  companionName,
  DEFAULT_COMPANION_NAME,
  endCompanionCall,
  isCompanionVoice,
  setCompanionName,
  setCompanionTarget,
  startCompanionCall,
  subscribeCompanionCall,
} from "./companionCall";
import { createVoiceActions } from "./voiceActions";
import {
  __resetAnswersForTests,
  answerDelivery,
  answerPromptByVoice,
  answersContext,
  answerText,
  companionRouteAction,
  findAnswer,
  isReadWholeRequest,
  isDismissRequest,
  matchAnswer,
  modeRequest,
  noteAgentAnswer,
  questionFromPermission,
  questionFromPrompt,
  relayText,
  sessionLabel,
} from "./voiceCompanion";
import { BLOCKED_NOTICE } from "./components/voiceStream";

afterEach(() => __resetAnswersForTests());

describe("answers on a call", () => {
  test("a companion tells them; relay, or no front, reads them as before", () => {
    expect(answerDelivery("companion")).toBe("tell");
    expect(answerDelivery("relay")).toBe("read");
    expect(answerDelivery(null)).toBe("read");
  });

  test("are kept, found by who wrote them, and given shortened", () => {
    noteAgentAnswer({
      agent: "Roamgate",
      text: "Deployed.",
      ids: ["a"],
      at: 0,
    });
    noteAgentAnswer({
      agent: "IGA-184 video",
      text: "y".repeat(2000),
      ids: ["b"],
      at: 0,
    });
    expect(findAnswer()?.agent).toBe("IGA-184 video");
    expect(findAnswer("roamgate")?.text).toBe("Deployed.");
    expect(findAnswer("iga 184")?.ids).toEqual(["b"]);
    expect(findAnswer("ranger")).toBeNull();
    const context = answersContext(60_000);
    expect(context).toContain("- Roamgate, 1 min ago: Deployed.");
    expect(context).toContain("(2000 characters, cut)");
    expect(context).not.toContain("y".repeat(1300));
  });

  test("the notice that a question waits is not part of an answer", () => {
    expect(answerText(`Done.\n\n${BLOCKED_NOTICE}\n\n`)).toBe("Done.");
  });
});

describe("what the user says to the companion", () => {
  test("asking to hear an answer whole", () => {
    for (const said of [
      "Read me the whole answer.",
      "Can you read the full reply?",
      "read me the answer word for word",
      "Lis-moi toute la réponse.",
      "Relis-moi la réponse en entier",
    ])
      expect(isReadWholeRequest(said)).toBe(true);
    for (const said of [
      "Read the README and fix the typo.",
      "Is the answer ready?",
      "Lis le fichier de config.",
    ])
      expect(isReadWholeRequest(said)).toBe(false);
  });

  test("switching to every answer read, and back", () => {
    expect(modeRequest("Read everything from now on.")).toBe("relay");
    expect(modeRequest("Lis tout.")).toBe("relay");
    expect(modeRequest("Lis-moi toutes les réponses")).toBe("relay");
    expect(modeRequest("Stop reading everything, just summarize.")).toBe(
      "companion",
    );
    expect(modeRequest("Arrête de tout lire.")).toBe("companion");
    expect(modeRequest("OK, lis-moi tout à partir de maintenant")).toBe(
      "relay",
    );
    // Work for the agent, not a switch.
    expect(modeRequest("Read everything in the logs folder")).toBeNull();
    expect(modeRequest("Lis tout le fichier")).toBeNull();
    expect(modeRequest("Fix the tests.")).toBeNull();
  });
});

const permission: AgentPermissionPrompt = {
  id: "p1",
  connectionId: "local",
  paneId: "w2:p2",
  agent: "claude",
  tool: "Bash",
  summary: "git push --force-with-lease",
  canAlways: true,
  createdAt: "",
  expiresAt: "",
};

describe("an agent's question", () => {
  test("is relayed with its words and every choice, as written", () => {
    const question = questionFromPermission(permission, "Roamgate");
    expect(relayText(question)).toBe(
      "Roamgate wants to use Bash: git push --force-with-lease. Options: 1: Allow. 2: Allow, and don't ask again. 3: Deny.",
    );
    const asked = questionFromPermission(
      {
        ...permission,
        id: "p2",
        questions: [
          {
            question: "Which branch should I rebase onto?",
            options: [{ label: "main" }, { label: "release/1.2" }],
            multiSelect: false,
          },
        ],
      },
      "Roamgate",
    );
    expect(relayText(asked)).toBe(
      "Roamgate asks: Which branch should I rebase onto? Options: 1: main. 2: release/1.2.",
    );
    const menu = questionFromPrompt(
      {
        lines: ["Do you want to make this edit to voice.ts?"],
        options: [
          { key: "1", label: "Yes", input: "1" },
          { key: "2", label: "Yes, allow all edits this session", input: "2" },
          {
            key: "3",
            label: "No, and tell Claude what to do differently",
            input: "3",
          },
        ],
      },
      "Roamgate",
    )!;
    expect(relayText(menu)).toBe(
      "Roamgate asks: Do you want to make this edit to voice.ts? Options: 1: Yes. 2: Yes, allow all edits this session. 3: No, and tell Claude what to do differently.",
    );
  });

  test("is answered with the choice said, or the words as said", () => {
    const question = questionFromPermission(permission, "Roamgate");
    expect(matchAnswer("Two.", question)).toEqual({ option: 1 });
    expect(matchAnswer("option 3", question)).toEqual({ option: 2 });
    expect(matchAnswer("le premier", question)).toEqual({ option: 0 });
    expect(matchAnswer("Allow, and don't ask again", question)).toEqual({
      option: 1,
    });
    expect(matchAnswer("Oui.", question)).toEqual({ option: 0 });
    expect(matchAnswer("No", question)).toEqual({ option: 2 });
    // Not an answer: it goes on as anything said.
    expect(matchAnswer("What does it push?", question)).toBeNull();
    const asked = questionFromPermission(
      {
        ...permission,
        questions: [
          {
            question: "Which branch?",
            options: [{ label: "main" }, { label: "release/1.2" }],
            multiSelect: false,
          },
        ],
      },
      "Roamgate",
    );
    expect(matchAnswer("main", asked)).toEqual({ option: 0 });
    expect(matchAnswer("The one from yesterday, next", asked)).toEqual({
      words: "The one from yesterday, next",
    });
  });

  test("is dismissed, unanswered, when told to drop it (in English or French)", () => {
    const question = questionFromPermission(permission, "Roamgate");
    const asked = questionFromPermission(
      {
        ...permission,
        questions: [
          {
            question: "What should I delete?",
            options: [{ label: "Worktree" }, { label: "Images" }],
            multiSelect: false,
          },
        ],
      },
      "Roamgate",
    );
    for (const said of [
      "Dismiss it.",
      "dismiss the question",
      "Skip it, please",
      "Never mind",
      "Forget it",
      "Laisse tomber la question.",
      "laisse tomber",
      "Ignore la question",
      "Oublie ça",
    ]) {
      expect(isDismissRequest(said)).toBe(true);
      expect(matchAnswer(said, question)).toEqual({ dismiss: true });
      // Not taken as the user's own words for a question that takes them.
      expect(matchAnswer(said, asked)).toEqual({ dismiss: true });
    }
    for (const said of ["Dismiss the build and rerun", "skip CI on main"])
      expect(isDismissRequest(said)).toBe(false);
  });

  test("a dismissal said on the call reaches the prompt as dismiss; answers as before", async () => {
    const sent: unknown[][] = [];
    const send = async (...args: unknown[]) => {
      sent.push(args);
      return true;
    };
    const question = {
      ...permission,
      id: "q1",
      questions: [
        {
          question: "What should I delete?",
          options: [{ label: "Worktree" }, { label: "Images" }],
          multiSelect: false,
        },
      ],
    };
    const asked = questionFromPermission(question, "Roamgate");
    const said = matchAnswer("laisse tomber la question", asked)!;
    expect(await answerPromptByVoice(question, asked, said, send)).toBe(true);
    expect(sent[sent.length - 1]).toEqual([
      permission.connectionId,
      "q1",
      "dismiss",
    ]);
    const allow = questionFromPermission(permission, "Roamgate");
    expect(
      await answerPromptByVoice(
        permission,
        allow,
        matchAnswer("dismiss it", allow)!,
        send,
      ),
    ).toBe(true);
    expect(sent[sent.length - 1]).toEqual([
      permission.connectionId,
      permission.id,
      "dismiss",
    ]);
    await answerPromptByVoice(question, asked, { option: 1 }, send);
    expect(sent[sent.length - 1]).toEqual([
      permission.connectionId,
      "q1",
      { answers: { "What should I delete?": "Images" } },
    ]);
    await answerPromptByVoice(permission, allow, { option: 0 }, send);
    expect(sent[sent.length - 1]).toEqual([
      permission.connectionId,
      permission.id,
      "allow",
    ]);
  });

  test("of several at once is relayed, and answered on screen", () => {
    const asked = questionFromPermission(
      {
        ...permission,
        questions: [
          {
            question: "Color?",
            options: [{ label: "Red" }],
            multiSelect: false,
          },
          {
            question: "Fruit?",
            options: [{ label: "Fig" }],
            multiSelect: true,
          },
        ],
      },
      "Roamgate",
    );
    expect(relayText(asked)).toBe(
      "Roamgate asks: Color? Fruit? Answer it on the screen.",
    );
    expect(matchAnswer("Red", asked)).toBeNull();
  });
});

describe("the companion's actions", () => {
  test("list sessions, read the last answer, forward, answer", async () => {
    const sent: string[] = [];
    const moved: string[] = [];
    const answered: unknown[] = [];
    const question = questionFromPermission(permission, "Roamgate");
    const actions = createVoiceActions({
      sessions: () => [
        {
          id: "local/w2:p2",
          machine: "Mac",
          workspace: "roamgate",
          title: "",
          folder: "/src",
          agent: "claude",
          status: "idle",
        },
      ],
      current: () => "local/w2:p2",
      send: async (words) => {
        sent.push(words);
      },
      moveTo: (session, words) => moved.push(`${session}: ${words}`),
      question: () => question,
      answer: async (asked, answer) => {
        answered.push([asked.key, answer]);
        return true;
      },
    });
    expect(actions.listSessions().map((session) => session.status)).toEqual([
      "idle",
    ]);
    noteAgentAnswer({ agent: "roamgate", text: "Tests pass.", ids: [] });
    expect(actions.lastAnswer()?.text).toBe("Tests pass.");
    expect(await actions.forward("push it")).toBe("sent");
    expect(await actions.forward("rebase", "desktop/w1:p1")).toBe("moved");
    expect(sent).toEqual(["push it"]);
    expect(moved).toEqual(["desktop/w1:p1: rebase"]);
    expect(actions.pendingQuestion()).toBe(question);
    expect(await actions.answerQuestion(question, { option: 2 })).toBe(true);
    expect(answered).toEqual([["permission:p1", { option: 2 }]]);
  });
});

describe("a call with the companion itself", () => {
  test("work starts on the default session or the one named; a look shows it", () => {
    expect(companionRouteAction({ to: "current" }, "local/w2:p2")).toEqual({
      kind: "forward",
      pane: "local/w2:p2",
    });
    expect(
      companionRouteAction(
        { to: "send", pane: "desktop/w1:p1" },
        "local/w2:p2",
      ),
    ).toEqual({ kind: "forward", pane: "desktop/w1:p1" });
    expect(
      companionRouteAction(
        { to: "open", pane: "desktop/w1:p1" },
        "local/w2:p2",
      ),
    ).toEqual({ kind: "show", pane: "desktop/w1:p1" });
    // No session to start it on yet: not sent anywhere.
    expect(companionRouteAction({ to: "current" }, "")).toBeNull();
    // Its own answers, Ranger and errands go as in any voice chat.
    for (const to of ["self", "ranger", "errand", "nobody", "ask", "read"])
      expect(companionRouteAction({ to }, "local/w2:p2")).toBeNull();
  });

  test("sessions are named aloud by their workspace", () => {
    const sessions = [
      { id: "local/w2:p2", workspace: "roamgate", title: "t", agent: "claude" },
      { id: "local/w3:p1", workspace: "", title: "gst2", agent: "claude" },
    ];
    expect(sessionLabel("local/w2:p2", sessions)).toBe("roamgate");
    expect(sessionLabel("local/w3:p1", sessions)).toBe("gst2");
    expect(sessionLabel("local/w9:p9", sessions)).toBe("the session");
  });

  test("starts from anywhere; a pane only sets where work goes", () => {
    __resetCompanionCallForTests();
    const seen: boolean[] = [];
    subscribeCompanionCall(() => seen.push(companionCallState().open));
    startCompanionCall();
    expect(companionCallState()).toMatchObject({ open: true, target: null });
    startCompanionCall("local/w2:p2");
    expect(companionCallState()).toMatchObject({
      open: true,
      target: "local/w2:p2",
      started: 2,
    });
    // Starting again from the menu keeps where work goes.
    startCompanionCall();
    expect(companionCallState().target).toBe("local/w2:p2");
    setCompanionTarget("desktop/w1:p1");
    expect(companionCallState().target).toBe("desktop/w1:p1");
    endCompanionCall();
    expect(companionCallState().open).toBe(false);
    expect(seen).toEqual([true, true, true, true, false]);
    expect(isCompanionVoice(COMPANION_VOICE_KEY)).toBe(true);
    expect(isCompanionVoice({ connectionId: "local", paneId: "w2:p2" })).toBe(
      false,
    );
  });

  test("is called Companion unless named", () => {
    // Outside a browser: a storage of its own.
    if (!(globalThis as { localStorage?: unknown }).localStorage) {
      const kept = new Map<string, string>();
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: (key: string) => kept.get(key) ?? null,
          setItem: (key: string, value: string) => kept.set(key, value),
          removeItem: (key: string) => kept.delete(key),
        },
      });
    }
    expect(companionName()).toBe(DEFAULT_COMPANION_NAME);
    setCompanionName("  Jarvis ");
    expect(companionName()).toBe("Jarvis");
    setCompanionName("");
    expect(companionName()).toBe("Companion");
  });
});
