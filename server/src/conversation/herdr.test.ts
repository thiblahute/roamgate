import { describe, expect, test } from "bun:test";
import {
  conversationCloseEvent,
  createConversationHerdr,
  psHasHeadless,
  psInteractiveClaude,
  terminalClaudeArgs,
} from "./herdr";

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
    expect(await herdr.writerElsewhere("w1:p1", [A, B])).toBe(
      "Claude runs this session in pane w2:p1",
    );
    ps = ` 77 claude --resume ${A}`;
    expect(await herdr.writerElsewhere("w1:p1", [A])).toBe(
      "Claude runs this session in another terminal (pid 77)",
    );
    expect(await herdr.writerElsewhere("w1:p1", [A], [77])).toBeNull();
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
