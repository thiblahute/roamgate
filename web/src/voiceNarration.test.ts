import { describe, expect, jest, test } from "bun:test";
import type { AgentChatEvent } from "../../shared/agentChat";
import { ACK_CUT_MS } from "./voiceAck";
import {
  LONG_COMMAND_MS,
  NARRATION_BREATH_MS,
  NARRATION_GAP_MS,
  NARRATION_QUIET_MS,
  narrationDue,
  narrationLine,
  pickTool,
  QUICK_FRESH_MS,
  spokenDescription,
  spokenFileName,
  startTurnNarration,
} from "./voiceNarration";

describe("narrationLine", () => {
  test("says what Ranger does with its tools", () => {
    expect(narrationLine("workspace_status", {})).toBe(
      "Looking at the workspaces.",
    );
    expect(narrationLine("workspace_tree_get", {})).toBe(
      "Looking at the workspaces.",
    );
    expect(narrationLine("workspace_tree_move", {})).toBe(
      "Arranging the workspaces.",
    );
    expect(narrationLine("propose_tab_create", {})).toBe(
      "Preparing an action.",
    );
    expect(narrationLine("chat_thread_reply", {}, "fr")).toBe(
      "Je réponds à ton commentaire.",
    );
    expect(narrationLine("show_in_roamgate", {})).toBeNull();
  });

  test("says the description of commands, agents, workflows, monitors", () => {
    expect(
      narrationLine("Bash", {
        command: "gh stack",
        description: "Restack the voice layers",
      }),
    ).toBe("Running a command: restack the voice layers.");
    expect(narrationLine("Agent", { description: "Upstream rebase." })).toBe(
      "I started an agent: upstream rebase.",
    );
    expect(narrationLine("Workflow", { description: "Review the stack" })).toBe(
      "I started a workflow: review the stack.",
    );
    expect(narrationLine("Monitor", { description: "CI pipeline" })).toBe(
      "Watching: CI pipeline.",
    );
    expect(narrationLine("Bash", { command: "ls" })).toBe("Running a command.");
    expect(narrationLine("Monitor", {})).toBeNull();
  });

  test("names the file read or edited, as it is said", () => {
    expect(
      narrationLine("Read", { file_path: "/repo/web/src/voiceAck.ts" }),
    ).toBe("Reading voice ack.");
    expect(
      narrationLine("Edit", {
        file_path: "web/src/components/useVoiceChat.ts",
      }),
    ).toBe("Editing use voice chat.");
    expect(narrationLine("Write", { file_path: "FEATURES.md" })).toBe(
      "Writing features.",
    );
    expect(narrationLine("Grep", { pattern: "a.*b" })).toBe(
      "Searching the code.",
    );
    expect(narrationLine("Read", {})).toBeNull();
  });

  test("translates the prefix, keeps the description", () => {
    expect(narrationLine("Bash", { description: "Run the tests" }, "fr")).toBe(
      "Je lance une commande : run the tests.",
    );
    expect(narrationLine("Read", { file_path: "a/voiceAck.ts" }, "es")).toBe(
      "Leo voice ack.",
    );
  });

  test("unknown tools say nothing", () => {
    expect(narrationLine("TodoWrite", { todos: [] })).toBeNull();
    expect(narrationLine("mcp__x__y", { description: "x" })).toBeNull();
  });
});

describe("spoken words", () => {
  test("descriptions keep names and acronyms, and stay short", () => {
    expect(spokenDescription("GStreamer build")).toBe("GStreamer build");
    expect(spokenDescription("CI status")).toBe("CI status");
    expect(spokenDescription("Run `bun test` now.")).toBe("run bun test now");
    expect(
      spokenDescription(
        "one two three four five six seven eight nine ten eleven twelve thirteen",
      ),
    ).toBe("one two three four five six seven eight nine ten eleven twelve");
  });

  test("file names lose folders and extensions, words apart", () => {
    expect(spokenFileName("web/src/voiceAck.test.ts")).toBe("voice ack test");
    expect(spokenFileName("README.md")).toBe("readme");
    expect(spokenFileName("styles/app-shell.css")).toBe("app shell");
    expect(spokenFileName("AgentHistoryCard.tsx")).toBe("agent history card");
    expect(spokenFileName("parseHTMLText.ts")).toBe("parse HTML text");
    expect(spokenFileName(".gitignore")).toBe("gitignore");
  });
});

describe("narrationDue", () => {
  const base = {
    busy: false,
    sinceSaid: 60_000,
    sinceNarrated: Number.POSITIVE_INFINITY,
    long: true,
  };
  test("long tools after a breath, quick ones after a long silence", () => {
    expect(narrationDue(base)).toBe(true);
    expect(narrationDue({ ...base, sinceSaid: NARRATION_BREATH_MS - 1 })).toBe(
      false,
    );
    expect(
      narrationDue({ ...base, long: false, sinceSaid: NARRATION_QUIET_MS - 1 }),
    ).toBe(false);
    expect(
      narrationDue({ ...base, long: false, sinceSaid: NARRATION_QUIET_MS }),
    ).toBe(true);
  });
  test("never while busy, nor soon after another update", () => {
    expect(narrationDue({ ...base, busy: true })).toBe(false);
    expect(narrationDue({ ...base, sinceNarrated: NARRATION_GAP_MS - 1 })).toBe(
      false,
    );
  });
});

describe("pickTool", () => {
  const tool = (name: string, startedAt: number, running = true) => ({
    name,
    input: {},
    startedAt,
    running,
    told: false,
  });
  test("an agent before the quick tools after it", () => {
    const tools = [tool("Agent", 0, false), tool("Read", 1000, false)];
    expect(pickTool(tools, 2000)?.tool.name).toBe("Agent");
    expect(pickTool(tools, 2000)?.long).toBe(true);
  });
  test("a command is long once it ran a while", () => {
    expect(pickTool([tool("Bash", 0)], LONG_COMMAND_MS - 1)?.long).toBe(false);
    expect(pickTool([tool("Bash", 0)], LONG_COMMAND_MS)?.long).toBe(true);
    expect(pickTool([tool("Bash", 0, false)], LONG_COMMAND_MS)?.long).toBe(
      false,
    );
  });
  test("old quick tools are no news", () => {
    expect(pickTool([tool("Read", 0, false)], 20_000)).toBeNull();
  });
});

/** A turn's updates with fake time, recording what is fetched and played. */
function turn(said: string) {
  let clock = 0;
  let busy = false;
  let spoken = 0;
  const fetched: string[] = [];
  const played: string[] = [];
  let ending: (() => void) | null = null;
  let release: (() => void) | null = null;
  let hold = false;
  const controller = new AbortController();
  const narration = startTurnNarration({
    said,
    signal: controller.signal,
    busy: () => busy,
    now: () => clock,
    onSpoken: () => {
      spoken += 1;
    },
    speech: {
      fetchAudio: async (text, language) => {
        fetched.push(`${language}:${text}`);
        if (hold)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return new Blob([text]);
      },
      playAudio: async (audio, signal) => {
        played.push(await audio.text());
        await new Promise<void>((resolve) => {
          ending = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        ending = null;
      },
    },
  });
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    for (let step = 0; step < ms; step += 250) {
      clock += 250;
      jest.advanceTimersByTime(250);
      await flush();
    }
  };
  let ids = 0;
  const use = (name: string, input: unknown) => {
    const id = `t${(ids += 1)}`;
    narration.handle({
      type: "tool_use",
      tool_use_id: id,
      name,
      input,
      message_id: "m",
      index: ids,
    } as AgentChatEvent);
    return id;
  };
  const result = (id: string) =>
    narration.handle({
      type: "tool_result",
      tool_use_id: id,
      is_error: false,
      text: "",
    });
  return {
    narration,
    controller,
    fetched,
    played,
    advance,
    flush,
    use,
    result,
    setBusy: (value: boolean) => {
      busy = value;
    },
    holdFetch: () => {
      hold = true;
    },
    releaseFetch: async () => {
      hold = false;
      release?.();
      await flush();
    },
    finishPlaying: async () => {
      ending?.();
      await flush();
    },
    spoken: () => spoken,
    /** Ends the turn, an update playing heard to its end. */
    close: async () => {
      const done = narration.end();
      ending?.();
      await flush();
      await done;
    },
  };
}

describe("startTurnNarration", () => {
  test("says an agent after a breath, then nothing more for a while", async () => {
    jest.useFakeTimers();
    try {
      const t = turn("Can you rebase the stack");
      t.use("Agent", { description: "Upstream rebase" });
      await t.advance(NARRATION_BREATH_MS - 500);
      expect(t.played).toEqual([]);
      await t.advance(1000);
      expect(t.played).toEqual(["I started an agent: upstream rebase."]);
      expect(t.spoken()).toBe(1);
      await t.finishPlaying();
      // Another long command soon after: held back by the gap.
      t.use("Bash", { description: "Build everything" });
      await t.advance(NARRATION_GAP_MS - 3000);
      expect(t.played.length).toBe(1);
      await t.advance(3500);
      expect(t.played).toEqual([
        "I started an agent: upstream rebase.",
        "Running a command: build everything.",
      ]);
      await t.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test("quick reads only after a long silence, in the turn's language", async () => {
    jest.useFakeTimers();
    try {
      const t = turn("Est-ce que tu peux regarder le code");
      await t.advance(NARRATION_QUIET_MS - 2000);
      t.use("Read", { file_path: "web/src/voiceAck.ts" });
      await t.advance(1000);
      expect(t.played).toEqual([]);
      t.use("Read", { file_path: "web/src/voiceNarration.ts" });
      await t.advance(1500);
      expect(t.played).toEqual(["Je lis voice narration."]);
      expect(t.fetched).toEqual(["fr:Je lis voice narration."]);
      await t.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test("waits while something plays or the user talks", async () => {
    jest.useFakeTimers();
    try {
      const t = turn("Run the tests");
      t.use("Agent", { description: "Run the tests" });
      t.setBusy(true);
      await t.advance(10_000);
      expect(t.fetched).toEqual([]);
      t.setBusy(false);
      await t.advance(NARRATION_BREATH_MS - 500);
      expect(t.fetched).toEqual([]);
      await t.advance(1000);
      expect(t.played).toEqual(["I started an agent: run the tests."]);
      await t.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test("drops an update whose audio comes after the reply started", async () => {
    jest.useFakeTimers();
    try {
      const t = turn("Fix the build");
      t.holdFetch();
      t.use("Agent", { description: "Fix the build" });
      await t.advance(NARRATION_BREATH_MS + 500);
      expect(t.fetched.length).toBe(1);
      t.narration.activity();
      await t.releaseFetch();
      await t.advance(500);
      expect(t.played).toEqual([]);
      await t.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test("drops a quick update when a newer tool started meanwhile", async () => {
    jest.useFakeTimers();
    try {
      const t = turn("Look at it");
      await t.advance(NARRATION_QUIET_MS);
      t.holdFetch();
      t.use("Read", { file_path: "a.ts" });
      await t.advance(300);
      expect(t.fetched).toEqual(["en:Reading a."]);
      t.use("Read", { file_path: "b.ts" });
      await t.releaseFetch();
      await t.advance(300);
      // The newer one is the news now.
      expect(t.played).toEqual(["Reading b."]);
      await t.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test("quiet() cuts an update that runs long", async () => {
    jest.useFakeTimers();
    try {
      const t = turn("Deploy it");
      t.use("Workflow", { description: "Deploy" });
      await t.advance(NARRATION_BREATH_MS + 500);
      expect(t.narration.playing()).toBe(true);
      let quiet = false;
      void t.narration.quiet().then(() => {
        quiet = true;
      });
      await t.advance(ACK_CUT_MS - 500);
      expect(quiet).toBe(false);
      await t.advance(750);
      expect(quiet).toBe(true);
      expect(t.narration.playing()).toBe(false);
      await t.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a finished quick command is told once, then no news; nothing after end", async () => {
    jest.useFakeTimers();
    try {
      const t = turn("Check the status");
      const id = t.use("Bash", { description: "Show git status" });
      t.result(id);
      // Just finished, it is still the latest thing done.
      await t.advance(NARRATION_QUIET_MS + 1000);
      expect(t.fetched).toHaveLength(1);
      t.fetched.length = 0;
      await t.advance(QUICK_FRESH_MS + NARRATION_GAP_MS);
      expect(t.fetched).toEqual([]);
      await t.close();
      t.use("Agent", { description: "Too late" });
      await t.advance(NARRATION_GAP_MS);
      expect(t.fetched).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});
