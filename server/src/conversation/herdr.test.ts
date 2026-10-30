import { describe, expect, test } from "bun:test";
import {
  claudeBackgroundWork,
  claudeFooter,
  claudeExitDialog,
  claudePromptState,
  conversationCloseEvent,
  createConversationHerdr,
  psHasHeadless,
  psInteractiveClaude,
  terminalClaudeArgs,
} from "./herdr";
import {
  BACKGROUND_SCREEN,
  EXIT_DIALOG_SCREEN,
  IDLE_SCREEN,
  NARROW_IDLE_SCREEN,
  NARROW_SCREEN,
  NARROWEST_SCREEN,
} from "./testing";

const A = "29616207-48e6-4ee2-b068-8fb98875a053";
const B = "3892d0a6-1111-2222-3333-444444444444";

describe("headless process probe", () => {
  test("finds a headless claude by the session its argv resumes", () => {
    const ps = [
      "  812 /usr/sbin/some-daemon --resume " + A,
      ` 4242 claude -p --resume ${A} --input-format stream-json --output-format stream-json`,
      ` 4300 claude --resume ${B}`,
    ].join("\n");
    expect(psHasHeadless(ps, [A])).toBeTrue();
    // The TUI on B is not a headless process.
    expect(psHasHeadless(ps, [B])).toBeFalse();
    // After /clear the process still names the old id.
    expect(psHasHeadless(ps, [B, A])).toBeTrue();
    expect(psHasHeadless(ps, [])).toBeFalse();
  });

  test("sees one through the shell that starts it on a host", () => {
    const ps = ` 77 bash -lc cd '/w' && exec env -u X claude -p --resume '${A}' --input-format stream-json`;
    expect(psHasHeadless(ps, [A])).toBeTrue();
    // A longer id that only starts with it is another session.
    expect(psHasHeadless(ps, [A.slice(0, 20)])).toBeFalse();
  });
});

describe("other writers", () => {
  test("an interactive claude resuming the session, outside the given pids", () => {
    const ps = [
      ` 4242 claude -p --resume ${A} --input-format stream-json --output-format stream-json`,
      ` 4300 claude --resume ${A}`,
      ` 4400 node /opt/claude-code/cli.js --model haiku -r ${A}`,
      ` 4500 vim notes-${A}.md`,
    ].join("\n");
    expect(psInteractiveClaude(ps, [A])).toBe(4300);
    expect(psInteractiveClaude(ps, [A], [4300])).toBe(4400);
    expect(psInteractiveClaude(ps, [A], [4300, 4400])).toBeNull();
    expect(psInteractiveClaude(ps, [B])).toBeNull();
  });

  test("a pane Herdr maps to the session, or a process on the host", async () => {
    let ps = "";
    const herdr = createConversationHerdr({
      call: async (method) =>
        method === "agent.list"
          ? {
              agents: [
                { pane_id: "w1:p1", agent_session: { value: A } },
                { pane_id: "w2:p1", agent_session: { value: B } },
              ],
            }
          : null,
      pidAlive: async () => false,
      listProcesses: async () => ps,
    });
    expect(await herdr.writerElsewhere("w1:p1", [A])).toBeNull();
    expect(await herdr.writerElsewhere("w1:p1", [A, B])).toEqual({
      text: "Claude runs this session in pane w2:p1",
      pane: { pane_id: "w2:p1", agent_name: "Claude", status: "unknown" },
    });
    ps = ` 77 claude --resume ${A}`;
    expect(await herdr.writerElsewhere("w1:p1", [A])).toEqual({
      text: "Claude runs this session in another terminal (pid 77)",
    });
    expect(await herdr.writerElsewhere("w1:p1", [A], [77])).toBeNull();
  });

  test("names another pane's writer as the sidebar does, and says whether it is idle", async () => {
    const agent = {
      pane_id: "w2:p12",
      workspace_id: "w2",
      tab_id: "w2:t3",
      agent: "claude",
      agent_status: "done",
      agent_session: { value: A },
    };
    let tab: Record<string, unknown> = { label: "3", number: 3 };
    const herdr = createConversationHerdr({
      call: async (method, params) => {
        if (method === "agent.list") return { agents: [agent] };
        if (method === "workspace.get") {
          expect(params).toEqual({ workspace_id: "w2" });
          return { workspace: { label: "roamgate", number: 1 } };
        }
        if (method === "tab.get") {
          expect(params).toEqual({ tab_id: "w2:t3" });
          return { tab };
        }
        return null;
      },
      pidAlive: async () => false,
      listProcesses: async () => "",
    });
    expect((await herdr.writerElsewhere("w1:p1", [A]))?.pane).toEqual({
      pane_id: "w2:p12",
      workspace_id: "w2",
      tab_id: "w2:t3",
      workspace_label: "roamgate",
      // A tab named by its number is "Tab 3", as in the tab bar.
      tab_label: "Tab 3",
      agent_name: "Claude",
      status: "idle",
    });
    tab = { label: "review", number: 3 };
    agent.agent_status = "working";
    expect((await herdr.writerElsewhere("w1:p1", [A]))?.pane).toMatchObject({
      tab_label: "review",
      status: "working",
    });
    agent.agent_status = "blocked";
    expect((await herdr.writerElsewhere("w1:p1", [A]))?.pane?.status).toBe(
      "blocked",
    );
  });

  test("a pane Herdr still maps to the session once its agent has gone writes nothing", async () => {
    let foreground: { pid: number; argv: string[] }[] = [];
    const herdr = createConversationHerdr({
      call: async (method) => {
        if (method === "agent.list")
          return {
            agents: [
              {
                pane_id: "w2:p12",
                agent_status: "unknown",
                agent_session: { value: A },
              },
            ],
          };
        if (method === "pane.process_info")
          return {
            process_info: {
              shell_pid: 800,
              foreground_process_group_id: foreground[0]?.pid ?? 800,
              foreground_processes: foreground,
            },
          };
        throw new Error("not found");
      },
      pidAlive: async () => false,
      listProcesses: async () => "",
    });
    // The shell is back at its prompt.
    expect(await herdr.writerElsewhere("w1:p1", [A])).toBeNull();
    // Something still runs in front of it (a holder): it counts.
    foreground = [{ pid: 950, argv: ["python3", "roamgate-hold", A] }];
    expect(await herdr.writerElsewhere("w1:p1", [A])).toMatchObject({
      pane: { pane_id: "w2:p12", status: "unknown" },
    });
  });

  test("a pane Herdr no longer knows is gone", async () => {
    const herdr = createConversationHerdr({
      call: async (_method, params) => {
        if (params.pane_id === "w9:p9")
          throw new Error("pane_not_found: w9:p9");
        if (params.pane_id === "w8:p8") throw new Error("timed out");
        return { pane: {} };
      },
      pidAlive: async () => false,
      listProcesses: async () => "",
    });
    expect(await herdr.paneExists("w1:p1")).toBe(true);
    expect(await herdr.paneExists("w9:p9")).toBe(false);
    await expect(herdr.paneExists("w8:p8")).rejects.toThrow(/timed out/);
  });
});

describe("the flags a resumed TUI keeps", () => {
  test("model, permission mode and directories; not the session or a prompt", () => {
    expect(
      terminalClaudeArgs({
        pid: 1,
        argv: [
          "/usr/local/bin/claude",
          "--model",
          "haiku",
          "--resume",
          A,
          "--permission-mode=plan",
          "--add-dir",
          "/a",
          "/b",
          "--dangerously-skip-permissions",
          "--continue",
          "--print",
          "a prompt",
        ],
      }),
    ).toEqual([
      "--model",
      "haiku",
      "--permission-mode=plan",
      "--add-dir",
      "/a",
      "/b",
      "--dangerously-skip-permissions",
    ]);
    expect(terminalClaudeArgs({ pid: 1, argv: ["claude"] })).toEqual([]);
    expect(terminalClaudeArgs({ pid: 1 })).toEqual([]);
  });
});

describe("conversation close events", () => {
  test("accepts Herdr's wire spelling and the dotted one", () => {
    // Herdr 0.9 sends pane_closed on the socket.
    expect(
      conversationCloseEvent({
        event: "pane_closed",
        data: { type: "pane_closed", pane_id: "w6:p1" },
      }),
    ).toEqual({ paneId: "w6:p1" });
    expect(
      conversationCloseEvent({
        event: "pane.closed",
        data: { pane_id: "w1:p2" },
      }),
    ).toEqual({ paneId: "w1:p2" });
    for (const event of [
      "tab_closed",
      "tab.closed",
      "workspace_closed",
      "workspace.closed",
    ])
      expect(conversationCloseEvent({ event, data: {} })).toBe("sweep");
  });

  test("a pane close without a pane id still sweeps; other events do nothing", () => {
    expect(conversationCloseEvent({ event: "pane_closed", data: {} })).toBe(
      "sweep",
    );
    expect(
      conversationCloseEvent({
        event: "pane_focused",
        data: { pane_id: "w1:p1" },
      }),
    ).toBeNull();
    expect(conversationCloseEvent(null)).toBeNull();
  });
});

describe("Claude's prompt box", () => {
  const rule = "\u2500".repeat(24);
  const box = (prompt: string, after: string[] = []) =>
    [
      "  some answer",
      rule,
      `\u276f\u00a0${prompt}`,
      ...after,
      rule,
      "  -- INSERT -- \u23f5\u23f5 auto mode on",
    ].join("\n");

  test("Claude's dim suggestion of a next prompt is not a draft", () => {
    // As Herdr reads it with its styles (`format: "ansi"`).
    const suggested = box("\x1b[0m\x1b[2mgo ahead with all three\x1b[0m\r");
    expect(claudePromptState(suggested)).toEqual({
      box: "empty",
      vim: "insert",
    });
    // The cursor on its first letter, in inverse video.
    expect(
      claudePromptState(box("\x1b[7mg\x1b[0m\x1b[2mo ahead\x1b[0m")).box,
    ).toBe("empty");
    expect(claudePromptState(box("\x1b[2;38;5;246mTry it\x1b[22m")).box).toBe(
      "empty",
    );
  });

  test("typed text is a draft, styled or not, on any line of the box", () => {
    expect(claudePromptState(box("half typed\x1b[7m \x1b[27m")).box).toBe(
      "draft",
    );
    expect(claudePromptState(box("\x1b[1mbold\x1b[0m")).box).toBe("draft");
    expect(claudePromptState(box("\x1b[2mdim\x1b[22m and typed")).box).toBe(
      "draft",
    );
    expect(claudePromptState(box("", ["  \x1b[0msecond line"])).box).toBe(
      "draft",
    );
    // Without styles (an older Herdr), any text is a draft.
    expect(claudePromptState(box("go ahead with all three")).box).toBe("draft");
    expect(claudePromptState(box("")).box).toBe("empty");
  });

  test("the prompt mark and vim mode are read through the styles", () => {
    expect(
      claudePromptState(
        box("").replace("-- INSERT --", "\x1b[1m-- NORMAL --\x1b[0m"),
      ).vim,
    ).toBe("normal");
    expect(claudePromptState("\x1b[1mDo you want to proceed?\x1b[0m").box).toBe(
      "missing",
    );
  });

  test("is read with its styles, or as plain text from a Herdr without them", async () => {
    const reads: Record<string, unknown>[] = [];
    let styled = true;
    const herdr = createConversationHerdr({
      call: async (method, params) => {
        if (method !== "agent.read") return null;
        reads.push(params as Record<string, unknown>);
        if ((params as { format?: string }).format === "ansi" && !styled)
          throw new Error("invalid request: unknown field `format`");
        return { read: { text: styled ? "styled" : "plain" } };
      },
      pidAlive: async () => false,
      listProcesses: async () => "",
    });
    expect(await herdr.readDetection("w1:p1")).toBe("styled");
    expect(reads[0]).toMatchObject({
      target: "w1:p1",
      format: "ansi",
      strip_ansi: false,
    });
    styled = false;
    expect(await herdr.readDetection("w1:p1")).toBe("plain");
    expect(reads.at(-1)).toMatchObject({ source: "detection" });
  });
});

describe("Claude's background work and exit question", () => {
  const rule = "─".repeat(40);
  test("the footer's running shells and tasks count, its agents do not", () => {
    expect(claudeBackgroundWork(BACKGROUND_SCREEN)).toBe("1 shell");
    expect(
      claudeBackgroundWork(
        [
          "❯ ",
          rule,
          "  \x1b[2m-- INSERT --\x1b[0m ⏵⏵ auto mode on · 2 shells · 1 monitor",
        ].join("\n"),
      ),
    ).toBe("2 shells, 1 monitor");
    expect(claudeBackgroundWork(IDLE_SCREEN)).toBeNull();
    expect(
      claudeBackgroundWork(
        ["❯ ", rule, "  auto mode on · ← 18 agents"].join("\n"),
      ),
    ).toBeNull();
  });

  test("a narrow pane's footer: a cut count is work, its silence says nothing", () => {
    // "· 1" with its word cut at 38 columns.
    expect(claudeFooter(NARROW_SCREEN)).toEqual({
      work: "1 background task",
      readable: true,
    });
    expect(
      claudeFooter("❯ \n" + "─".repeat(40) + "\n  auto mode on · 2 sh…"),
    ).toEqual({
      work: "2 background tasks",
      readable: true,
    });
    // At 18 columns nothing is left: not readable, whatever runs.
    expect(claudeFooter(NARROWEST_SCREEN)).toEqual({
      work: null,
      readable: false,
    });
    expect(claudeFooter(NARROW_IDLE_SCREEN)).toEqual({
      work: null,
      readable: false,
    });
    // A wide one says so when nothing runs.
    expect(claudeFooter(IDLE_SCREEN.replace(/─{24}/g, "─".repeat(80)))).toEqual(
      {
        work: null,
        readable: true,
      },
    );
    expect(claudeFooter(BACKGROUND_SCREEN)).toEqual({
      work: "1 shell",
      readable: true,
    });
  });

  test("the conversation above the prompt is not the footer", () => {
    expect(
      claudeBackgroundWork(
        ["● I started 2 shells", "❯ ", rule, "  auto mode on"].join("\n"),
      ),
    ).toBeNull();
  });

  test("the exit question and the key that answers Stay", () => {
    expect(claudeExitDialog(EXIT_DIALOG_SCREEN)).toEqual({ stayKey: "3" });
    expect(claudeExitDialog(BACKGROUND_SCREEN)).toBeNull();
    expect(claudeExitDialog(IDLE_SCREEN)).toBeNull();
    // No numbers: Escape cancels, as Stay does.
    expect(claudeExitDialog(EXIT_DIALOG_SCREEN.replace(/\d\. /g, ""))).toEqual({
      stayKey: "\x1b",
    });
  });
});
