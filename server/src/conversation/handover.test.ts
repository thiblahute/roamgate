import { afterEach, describe, expect, test } from "bun:test";
import {
  createHandover,
  exitSentAsMessage,
  type HandoverDeps,
  type HeadlessSide,
} from "./handover";
import type { ConversationHerdr, WriterElsewhere } from "./herdr";
import { createHolderRegistry, type HolderReply } from "./holder";
import { createLeaseStore } from "./lease";
import {
  BACKGROUND_SCREEN,
  EXIT_DIALOG_SCREEN,
  fakeHerdr,
  IDLE_SCREEN,
  NARROW_IDLE_SCREEN,
  NARROW_SCREEN,
  NARROWEST_SCREEN,
  virtualClock,
} from "./testing";

const PANE = "w1:p1";
const aborts: AbortController[] = [];
afterEach(() => {
  for (const controller of aborts.splice(0)) controller.abort();
});

function setup(
  options: Parameters<typeof fakeHerdr>[0] & {
    holderStarts?: boolean;
    herdr?: Partial<ConversationHerdr>;
    deps?: Partial<HandoverDeps>;
  } = {},
) {
  const clock = virtualClock();
  const holders = createHolderRegistry({ now: clock.now });
  const replies: HolderReply[] = [];
  const holder = () => {
    const controller = new AbortController();
    aborts.push(controller);
    void holders
      .wait(PANE, { action: "hold", session_id: "" }, 1e9, controller.signal)
      .then((reply) => {
        if (!controller.signal.aborted) replies.push(reply);
      });
  };
  const fake = fakeHerdr({
    ...options,
    onHolder: options.holderStarts === false ? undefined : holder,
  });
  const herdr = { ...fake.herdr, ...options.herdr };
  const leases = createLeaseStore({ connectionId: "local", file: null });
  const phases: string[] = [];
  const handover = createHandover({
    herdr,
    leases,
    holders,
    holderCommand: (id) => `hold ${id}\r`,
    onLease: (paneId) => phases.push(leases.get(paneId)?.phase ?? "terminal"),
    sleep: clock.sleep,
    now: clock.now,
    ...options.deps,
  });
  return { fake, leases, holders, handover, replies, holder, phases, clock };
}

function headless(overrides: Partial<HeadlessSide> = {}) {
  const events: string[] = [];
  const side: HeadlessSide = {
    busy: () => false,
    backgroundTasks: () => 0,
    queueLength: () => 0,
    interrupt: async () => true,
    waitForResult: async () => true,
    stop: async () => {
      events.push("stopped");
      return true;
    },
    pid: () => null,
    ...overrides,
  };
  return { side, events };
}

describe("terminal to conversation", () => {
  test("stops the idle TUI, then holds the pane", async () => {
    const { fake, leases, handover } = setup();
    const result = await handover.toConversation(PANE);
    expect(result).toMatchObject({
      ok: true,
      owner: "conversation",
      session_id: fake.sessionId,
    });
    expect(leases.get(PANE)).toMatchObject({
      phase: "conversation",
      owner: "conversation",
      session_id: fake.sessionId,
      cwd: fake.cwd,
    });
    const actions = fake.calls
      .filter(([name]) => name === "prompt" || name === "sendText")
      .map((call) => call.slice(2));
    expect(actions).toEqual([["/exit"], [`hold ${fake.sessionId}\r`]]);
    // The holder starts only once the TUI's pid is gone.
    expect(fake.live.has(fake.claudePid)).toBe(false);
  });

  test("an owned session is already handed over", async () => {
    const { handover } = setup();
    await handover.toConversation(PANE);
    expect(await handover.toConversation(PANE)).toMatchObject({ ok: true });
  });

  const refusals: [
    string,
    (context: ReturnType<typeof setup>) => void,
    RegExp,
  ][] = [
    ["no agent", ({ fake }) => (fake.pane.agent = null), /not running/],
    [
      "another agent",
      ({ fake }) => (fake.pane.agent = { ...fake.pane.agent, agent: "codex" }),
      /not running/,
    ],
    [
      "a running turn",
      ({ fake }) =>
        (fake.pane.agent = { ...fake.pane.agent, agent_status: "working" }),
      /working/,
    ],
    [
      "a question in the terminal",
      ({ fake }) =>
        (fake.pane.agent = { ...fake.pane.agent, agent_status: "blocked" }),
      /waiting for an answer/,
    ],
    [
      "an unknown state",
      ({ fake }) =>
        (fake.pane.agent = { ...fake.pane.agent, agent_status: "unknown" }),
      /cannot tell/,
    ],
    [
      "no session id",
      ({ fake }) =>
        (fake.pane.agent = { ...fake.pane.agent, agent_session: null }),
      /no session id/,
    ],
    [
      "a draft in the prompt box",
      ({ fake }) =>
        (fake.pane.screen = fake.pane.screen.replace(
          "\u276f ",
          "\u276f half typed",
        )),
      /typed in Claude's prompt box/,
    ],
    [
      "a multi-line draft",
      ({ fake }) =>
        (fake.pane.screen = fake.pane.screen.replace(
          "\u276f ",
          "\u276f \n  second line",
        )),
      /typed in Claude's prompt box/,
    ],
    [
      "no prompt box",
      ({ fake }) => (fake.pane.screen = "Do you want to proceed?\n 1. Yes"),
      /prompt box is not on screen/,
    ],
    [
      "vim normal mode",
      ({ fake }) =>
        (fake.pane.screen = fake.pane.screen.replace(
          "-- INSERT --",
          "-- NORMAL --",
        )),
      /vim normal mode/,
    ],
    [
      "no claude process",
      ({ fake }) => (fake.pane.process.foreground_processes = []),
      /which process is Claude/,
    ],
    [
      "two claude processes",
      ({ fake }) =>
        fake.pane.process.foreground_processes.push({
          pid: 950,
          argv: ["claude"],
        }),
      /which process is Claude/,
    ],
    [
      "no working directory",
      ({ fake }) => {
        delete fake.pane.process.foreground_processes[0]!.cwd;
        fake.pane.agent = { ...fake.pane.agent, foreground_cwd: "" };
      },
      /working directory/,
    ],
  ];
  test("takes over with Claude's dim suggestion in the prompt box", async () => {
    const context = setup();
    context.fake.pane.screen = context.fake.pane.screen.replace(
      "\u276f ",
      "\u276f \x1b[0m\x1b[2mgo ahead with all three\x1b[0m",
    );
    const result = await context.handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toBe("");
  });

  for (const [name, arrange, reason] of refusals)
    test(`refuses on ${name}, touching nothing`, async () => {
      const context = setup();
      arrange(context);
      const result = await context.handover.toConversation(PANE);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.reason).toMatch(reason);
      expect(context.leases.get(PANE)).toBeNull();
      expect(
        context.fake.calls.some(
          ([call]) => call === "prompt" || call === "sendText",
        ),
      ).toBe(false);
    });

  test("refuses another session than the one expected", async () => {
    const { handover } = setup();
    const result = await handover.toConversation(PANE, "other-session");
    expect(result).toEqual({
      ok: false,
      reason: "The pane now runs another session",
    });
  });

  test("refuses a session conversation mode owns in another pane", async () => {
    const { handover, leases, fake } = setup();
    leases.set({
      pane_id: "w2:p9",
      session_id: fake.sessionId,
      cwd: fake.cwd,
      phase: "conversation",
    });
    const result = await handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(/another pane/);
  });

  test("refuses while a handover of the pane runs", async () => {
    const { handover, leases, fake } = setup();
    leases.set({
      pane_id: PANE,
      session_id: fake.sessionId,
      cwd: fake.cwd,
      phase: "to_terminal",
    });
    const result = await handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(/being handed over/);
  });

  test("refuses a second handover started meanwhile", async () => {
    const { handover } = setup();
    const [first, second] = await Promise.all([
      handover.toConversation(PANE),
      handover.toConversation(PANE),
    ]);
    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: false,
      reason: "A handover of this pane is already running",
    });
  });

  test("refuses when Herdr cannot be asked", async () => {
    const { handover, leases } = setup({
      herdr: {
        agentGet: async () => {
          throw new Error("socket closed");
        },
      },
    });
    const result = await handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(/socket closed/);
    expect(leases.get(PANE)).toBeNull();
  });

  test("a refused /exit leaves the terminal the owner", async () => {
    const { handover, leases } = setup({
      herdr: {
        prompt: async () => {
          throw new Error("agent_blocked");
        },
      },
    });
    const result = await handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(/did not take \/exit/);
    expect(leases.get(PANE)).toBeNull();
  });

  test("never holds the pane while the TUI may still run", async () => {
    const { handover, leases, fake } = setup({ exitIgnored: true });
    const result = await handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(/did not exit in time/);
    expect(leases.get(PANE)).toBeNull();
    expect(fake.calls.some(([call]) => call === "sendText")).toBe(false);
  });

  test("a pid gone while another claude is in the foreground is not enough", async () => {
    const context = setup({
      herdr: {
        prompt: async () => {
          // The pid ends but the shell is not back in the foreground.
          context.fake.live.delete(context.fake.claudePid);
        },
      },
    });
    const result = await context.handover.toConversation(PANE);
    expect(result.ok).toBe(false);
    expect(context.leases.get(PANE)).toBeNull();
  });

  test("a holder that cannot be typed gives the session back", async () => {
    const { handover, leases } = setup({
      herdr: {
        sendText: async () => {
          throw new Error("pane closed");
        },
      },
    });
    const result = await handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(/holder did not start/);
    expect(leases.get(PANE)).toBeNull();
  });

  test("a holder that never shows up gives the session back", async () => {
    const { handover, leases, fake } = setup({ holderStarts: false });
    const result = await handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(
      /Claude was resumed in the terminal/,
    );
    expect(leases.get(PANE)).toBeNull();
    // The shell it left gets claude back, with the session.
    expect(fake.calls.filter((call) => call[0] === "sendText").at(-1)).toEqual([
      "sendText",
      PANE,
      ` claude --resume ${fake.sessionId}\r`,
    ]);
  });

  test("a holder still starting is not typed over", async () => {
    const { handover, fake } = setup({
      holderStarts: false,
      herdr: {
        sendText: async (paneId, text) => {
          fake.calls.push(["sendText", paneId, text]);
          // python is in the foreground, slow to start.
          fake.pane.process = {
            shell_pid: 800,
            foreground_process_group_id: 950,
            foreground_processes: [{ pid: 950, argv: ["python3", "hold"] }],
          };
        },
      },
    });
    const result = await handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(/run claude --resume/);
    expect(fake.calls.filter((call) => call[0] === "sendText")).toHaveLength(1);
  });

  test("only a holder that polls after the command counts", async () => {
    const context = setup({ holderStarts: false });
    // The holder an earlier hand-back told to resume polled moments ago.
    context.holder();
    context.holders.send(PANE, { action: "hold", session_id: "" });
    await context.clock.sleep(1000);
    const result = await context.handover.toConversation(PANE);
    expect(result.ok).toBe(false);
    expect(context.leases.get(PANE)).toBeNull();
  });

  test("a TUI that exits after the deadline gets claude back in its shell", async () => {
    const { handover, fake, leases } = setup({
      exitIgnored: true,
      herdr: {},
    });
    fake.pane.process.foreground_processes[0]!.argv = [
      "claude",
      "--model",
      "haiku",
      "--resume",
      fake.sessionId,
    ];
    const result = await handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(/did not exit in time/);
    expect(leases.get(PANE)).toBeNull();
    // It exits a little later.
    fake.live.delete(fake.claudePid);
    fake.pane.process = {
      shell_pid: 800,
      foreground_process_group_id: 800,
      foreground_processes: [],
    };
    for (let index = 0; index < 50; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 0; index < 50; index += 1) await Promise.resolve();
    expect(fake.calls.filter((call) => call[0] === "sendText").at(-1)).toEqual([
      "sendText",
      PANE,
      ` claude --resume ${fake.sessionId}\r`,
    ]);
  });

  test("refuses while claude runs the session elsewhere", async () => {
    const { handover, fake, leases } = setup();
    fake.probe.elsewhere = "Claude runs this session in pane w2:p1";
    const result = await handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(/pane w2:p1; close it/);
    expect(leases.get(PANE)).toBeNull();
    expect(fake.calls.some((call) => call[0] === "prompt")).toBe(false);
  });

  test("a lease whose pane was closed does not block the session", async () => {
    const { fake, leases } = setup();
    let gone = "";
    leases.set({
      pane_id: "w9:p9",
      session_id: fake.sessionId,
      cwd: "/work/repo",
      phase: "conversation",
    });
    const closedHandover = createHandover({
      herdr: {
        ...fake.herdr,
        paneExists: async (paneId) => paneId !== "w9:p9",
      },
      leases,
      holders: createHolderRegistry(),
      holderCommand: (id) => `hold ${id}\r`,
      onPaneGone: (paneId) => {
        gone = paneId;
        leases.delete(paneId);
      },
      holderTimeoutMs: 0,
    });
    const result = await closedHandover.toConversation(PANE);
    expect(gone).toBe("w9:p9");
    // It went on (the holder never showed up here).
    expect(result.ok ? "" : result.reason).toMatch(/holder did not start/);
    // With the pane still there, it refuses.
    const other = setup();
    other.leases.set({
      pane_id: "w9:p9",
      session_id: other.fake.sessionId,
      cwd: "/work/repo",
      phase: "conversation",
    });
    const refused = await other.handover.toConversation(PANE);
    expect(refused.ok ? "" : refused.reason).toMatch(/another pane/);
  });

  test("handing back a pane where claude already runs only drops the lease", async () => {
    const { handover, fake, leases, replies } = setup();
    leases.set({
      pane_id: PANE,
      session_id: fake.sessionId,
      cwd: fake.cwd,
      phase: "conversation",
    });
    // Claude was resumed by the holder while Roamgate was away.
    const result = await handover.toTerminal(PANE, null);
    expect(result).toEqual({
      ok: true,
      owner: "terminal",
      session_id: fake.sessionId,
    });
    expect(leases.get(PANE)).toBeNull();
    expect(replies).toEqual([]);
  });

  test("never hands back next to claude running the session elsewhere", async () => {
    const { handover, fake, leases } = setup();
    leases.set({
      pane_id: PANE,
      session_id: fake.sessionId,
      cwd: fake.cwd,
      phase: "conversation",
    });
    fake.pane.process = {
      shell_pid: 800,
      foreground_process_group_id: 950,
      foreground_processes: [{ pid: 950, argv: ["python3", "roamgate-hold"] }],
    };
    fake.probe.elsewhere = "Claude runs this session in pane w2:p1";
    const result = await handover.toTerminal(PANE, null);
    expect(result.ok ? "" : result.reason).toMatch(/pane w2:p1; close it/);
    expect(leases.get(PANE)?.phase).toBe("conversation");
  });

  test("a closed connection stops a takeover where it is", async () => {
    let closed = false;
    const clock = virtualClock();
    const fake = fakeHerdr({ exitIgnored: true });
    const leases = createLeaseStore({ connectionId: "local", file: null });
    const handover = createHandover({
      herdr: fake.herdr,
      leases,
      holders: createHolderRegistry({ now: clock.now }),
      holderCommand: (id) => `hold ${id}\r`,
      sleep: async (ms) => {
        closed = true;
        await clock.sleep(ms);
      },
      now: clock.now,
      closed: () => closed,
      // The first sleep is the exit's wait, not the settle before it.
      settleMs: 0,
    });
    const result = await handover.toConversation(PANE);
    expect(result).toEqual({ ok: false, reason: "The connection is closing" });
    // Left for the runtime after this one (its start fixes it up).
    expect(leases.get(PANE)?.phase).toBe("to_conversation");
  });

  test("conversation mode owns nothing until the holder has the pane", async () => {
    // While the holder starts, no headless process may start: one that did
    // would outlive a holder that never shows up, and that holder, late,
    // resumes the TUI next to it.
    const seen: (string | undefined)[] = [];
    const context = setup({
      holderStarts: false,
      herdr: {
        sendText: async () => {
          seen.push(context.leases.get(PANE)?.phase);
        },
      },
    });
    const result = await context.handover.toConversation(PANE);
    expect(result.ok).toBe(false);
    expect(seen).toEqual(["to_conversation"]);
    // Each phase reached the browsers as it happened.
    expect(context.phases).toEqual(["to_conversation", "terminal"]);
  });

  test("each phase of a takeover is announced", async () => {
    const { handover, phases } = setup();
    await handover.toConversation(PANE);
    expect(phases).toEqual(["to_conversation", "conversation"]);
  });
});

describe("terminal to conversation, background work", () => {
  const exits = (fake: ReturnType<typeof fakeHerdr>) =>
    fake.calls.filter(([name, , text]) => name === "prompt" && text === "/exit")
      .length;

  test("background work on screen keeps the switch waiting, with no /exit", async () => {
    const { fake, handover, leases } = setup();
    fake.pane.screen = BACKGROUND_SCREEN;
    const result = await handover.toConversation(PANE);
    expect(result).toMatchObject({ ok: false, waiting: "background_tasks" });
    expect(result.ok ? "" : result.reason).toContain("1 shell");
    expect(exits(fake)).toBe(0);
    expect(leases.get(PANE)).toBeNull();
    expect(fake.live.has(fake.claudePid)).toBe(true);
  });

  test("a narrow pane's cut footer count keeps the switch waiting", async () => {
    const { fake, handover } = setup();
    fake.pane.screen = NARROW_SCREEN;
    const result = await handover.toConversation(PANE);
    expect(result).toMatchObject({ ok: false, waiting: "background_tasks" });
    expect(exits(fake)).toBe(0);
  });

  test("too narrow for the footer: the transcript's running commands keep it waiting", async () => {
    const asked: string[] = [];
    const { fake, handover } = setup({
      deps: {
        terminalTasks: async (paneId) => {
          asked.push(paneId);
          return 1;
        },
      },
    });
    fake.pane.screen = NARROWEST_SCREEN;
    const result = await handover.toConversation(PANE);
    expect(result).toMatchObject({ ok: false, waiting: "background_tasks" });
    expect(result.ok ? "" : result.reason).toContain("1 background command");
    expect(asked).toEqual([PANE]);
    expect(exits(fake)).toBe(0);
  });

  test("too narrow, and nothing running in the transcript: it switches", async () => {
    const { fake, handover } = setup({
      deps: { terminalTasks: async () => 0 },
    });
    fake.pane.screen = NARROW_IDLE_SCREEN;
    const result = await handover.toConversation(PANE);
    expect(result).toMatchObject({ ok: true, owner: "conversation" });
    expect(exits(fake)).toBe(1);
  });

  test("a wide footer that shows no work wins over the transcript", async () => {
    // A task the transcript never saw end (its Claude restarted) does not
    // hold the switch while the footer, which Claude keeps live, says none.
    let asked = 0;
    const { fake, handover } = setup({
      deps: {
        terminalTasks: async () => {
          asked += 1;
          return 2;
        },
      },
    });
    fake.pane.screen = IDLE_SCREEN.replace(/─{24}/g, "─".repeat(80));
    const result = await handover.toConversation(PANE);
    expect(result).toMatchObject({ ok: true });
    expect(asked).toBe(0);
  });

  test("an exit question is answered Stay, once, and the switch waits", async () => {
    const stays: string[] = [];
    const { fake, handover, leases } = setup({
      exitAsks: true,
      deps: { onExitDialog: (paneId) => stays.push(paneId) },
    });
    const result = await handover.toConversation(PANE);
    expect(result).toMatchObject({ ok: false, waiting: "background_tasks" });
    const keys = fake.calls.filter(([name]) => name === "sendKeys");
    // Stay, never "Exit and stop tasks" nor "Move to background".
    expect(keys).toEqual([["sendKeys", PANE, "3"]]);
    expect(fake.pane.screen).toBe(BACKGROUND_SCREEN);
    expect(fake.live.has(fake.claudePid)).toBe(true);
    expect(leases.get(PANE)).toBeNull();
    expect(stays).toEqual([PANE]);
    // Asked again while the work runs: still no second /exit.
    const again = await handover.toConversation(PANE);
    expect(again).toMatchObject({ ok: false, waiting: "background_tasks" });
    expect(exits(fake)).toBe(1);
  });

  test("an exit question without numbers is answered with Escape", async () => {
    const dialog = EXIT_DIALOG_SCREEN.replace(/\d\. /g, "");
    const context = setup({
      herdr: {
        prompt: async (paneId, text) => {
          context.fake.calls.push(["prompt", paneId, text]);
          context.fake.pane.screen = dialog;
        },
        sendKeys: async (paneId, keys) => {
          context.fake.calls.push(["sendKeys", paneId, keys]);
          if (keys === "\x1b") context.fake.pane.screen = BACKGROUND_SCREEN;
        },
      },
    });
    const result = await context.handover.toConversation(PANE);
    expect(result).toMatchObject({ ok: false, waiting: "background_tasks" });
    expect(context.fake.calls.filter(([name]) => name === "sendKeys")).toEqual([
      ["sendKeys", PANE, "\x1b"],
    ]);
  });

  test("an exit question already on screen is not answered for the user", async () => {
    const { fake, handover } = setup();
    fake.pane.screen = EXIT_DIALOG_SCREEN;
    const result = await handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(/asking whether to exit/);
    expect(exits(fake)).toBe(0);
    expect(fake.calls.some(([name]) => name === "sendKeys")).toBe(false);
  });

  test("/exit goes once: no second one while the first may still land", async () => {
    // The late exit watch waits on a sleep that never ends here.
    const clock = virtualClock();
    const { fake, handover } = setup({
      exitIgnored: true,
      deps: {
        latePollMs: 7777,
        sleep: (ms) =>
          ms === 7777 ? new Promise<void>(() => {}) : clock.sleep(ms),
        now: clock.now,
      },
    });
    const first = await handover.toConversation(PANE);
    expect(first.ok ? "" : first.reason).toMatch(/did not exit in time/);
    const second = await handover.toConversation(PANE);
    expect(second.ok ? "" : second.reason).toMatch(/already asked to exit/);
    expect(exits(fake)).toBe(1);
  });

  test("a late exit question is answered Stay, and claude is not resumed", async () => {
    const { fake, handover } = setup({ exitIgnored: true });
    const result = await handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(/did not exit in time/);
    // The /exit lands later, and Claude asks.
    fake.pane.screen = EXIT_DIALOG_SCREEN;
    for (let round = 0; round < 20; round += 1) {
      for (let index = 0; index < 50; index += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(fake.calls.filter(([name]) => name === "sendKeys")).toEqual([
      ["sendKeys", PANE, "3"],
    ]);
    expect(fake.live.has(fake.claudePid)).toBe(true);
    expect(fake.calls.some(([name]) => name === "sendText")).toBe(false);
  });

  test("waiting for the exit checks less and less often", async () => {
    const clock = virtualClock();
    const waits: number[] = [];
    let alive = 0;
    const context = setup({
      exitIgnored: true,
      herdr: {
        pidAlive: async () => {
          alive += 1;
          return true;
        },
      },
      deps: {
        sleep: (ms) => {
          waits.push(ms);
          return clock.sleep(ms);
        },
        now: clock.now,
        settleMs: 0,
      },
    });
    await context.handover.toConversation(PANE);
    const during = waits.length;
    for (let round = 0; round < 40; round += 1) {
      for (let index = 0; index < 50; index += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // The exit deadline: 200 ms first, then longer, never past 2 s.
    expect(waits[0]).toBe(200);
    expect(waits[1]).toBe(300);
    expect(Math.max(...waits.slice(0, during))).toBeLessThanOrEqual(2000);
    // The late watch starts at 2 s and stays under 15 s.
    expect(waits[during]).toBe(2000);
    expect(Math.max(...waits)).toBeLessThanOrEqual(15_000);
    expect(clock.now()).toBeGreaterThanOrEqual(15_000 + 120_000);
    // 15 s then two minutes of a TUI that never exits: a few dozen checks,
    // not one every 200 ms (some 675).
    expect(alive).toBeLessThan(40);
  });
});

describe("terminal to conversation, an exit typed at the wrong moment", () => {
  const exits = (fake: ReturnType<typeof fakeHerdr>) =>
    fake.calls.filter(([name, , text]) => name === "prompt" && text === "/exit")
      .length;
  /** The prompt box with an image pasted into it, not sent. */
  const PASTED_SCREEN = IDLE_SCREEN.replace("\u276f ", "\u276f [Image #168]");

  test("a paste reaching the prompt box before /exit stops it", async () => {
    const clock = virtualClock();
    const context = setup({
      deps: {
        settleMs: 333,
        sleep: async (ms) => {
          // The image lands while the switch looks again.
          if (ms === 333) context.fake.pane.screen = PASTED_SCREEN;
          await clock.sleep(ms);
        },
        now: clock.now,
      },
    });
    const result = await context.handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(/Something is typed/);
    expect(exits(context.fake)).toBe(0);
    expect(context.leases.get(PANE)).toBeNull();
  });

  test("a turn starting before /exit stops it", async () => {
    const clock = virtualClock();
    let status = "idle";
    const context = setup({
      deps: {
        exactStatus: () => status,
        sleep: async (ms) => {
          status = "working";
          await clock.sleep(ms);
        },
        now: clock.now,
      },
    });
    const result = await context.handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(/is working/);
    expect(exits(context.fake)).toBe(0);
  });

  test("the Claude mod's exact status wins over Herdr's", async () => {
    const { fake, handover } = setup({
      deps: { exactStatus: () => "working" },
    });
    // Herdr's screen detection says idle.
    expect(fake.pane.agent?.agent_status).toBe("idle");
    const result = await handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(/is working/);
    expect(exits(fake)).toBe(0);
  });

  test("no mod status: Herdr's is used", async () => {
    const { handover } = setup({ deps: { exactStatus: () => null } });
    expect(await handover.toConversation(PANE)).toMatchObject({ ok: true });
  });

  test("an exit taken as a message is said so, and the switch may be asked again", async () => {
    const asked: [string, number][] = [];
    const { fake, handover, leases } = setup({
      exitIgnored: true,
      deps: {
        exitSwallowed: async (_paneId, command, sinceMs) => {
          asked.push([command, sinceMs]);
          return true;
        },
      },
    });
    const first = await handover.toConversation(PANE);
    expect(first.ok ? "" : first.reason).toMatch(
      /took \/exit as a message instead of exiting/,
    );
    expect(asked[0]?.[0]).toBe("/exit");
    expect(leases.get(PANE)).toBeNull();
    // Not "already asked to exit": nothing is exiting.
    const second = await handover.toConversation(PANE);
    expect(second.ok ? "" : second.reason).not.toMatch(/already asked/);
    expect(exits(fake)).toBe(2);
  });

  test("a turn the exit starts is taken as swallowed", async () => {
    let status = "idle";
    const context = setup({
      exitIgnored: true,
      deps: { exactStatus: () => status },
      herdr: {
        prompt: async (paneId, text) => {
          context.fake.calls.push(["prompt", paneId, text]);
          // Sent as a message: Claude starts a turn on it.
          if (text === "/exit") status = "working";
        },
      },
    });
    const result = await context.handover.toConversation(PANE);
    expect(result.ok ? "" : result.reason).toMatch(/as a message/);
    // It may be asked again once the turn ends.
    status = "idle";
    const again = await context.handover.toConversation(PANE);
    expect(again.ok ? "" : again.reason).not.toMatch(/already asked/);
  });

  /** The late exit watch waits on a sleep that never ends. */
  function stuckWatch(deps: Partial<HandoverDeps> = {}) {
    const clock = virtualClock();
    return setup({
      exitIgnored: true,
      deps: {
        latePollMs: 7777,
        sleep: (ms) =>
          ms === 7777 ? new Promise<void>(() => {}) : clock.sleep(ms),
        now: clock.now,
        ...deps,
      },
    });
  }

  test("an exit found swallowed later frees the pane for a new switch", async () => {
    let swallowed = false;
    const { fake, handover } = stuckWatch({
      exitSwallowed: async () => swallowed,
    });
    const first = await handover.toConversation(PANE);
    expect(first.ok ? "" : first.reason).toMatch(/did not exit in time/);
    expect((await handover.toConversation(PANE)).ok ? "" : "refused").toBe(
      "refused",
    );
    expect(exits(fake)).toBe(1);
    // The transcript now shows the /exit as a message.
    swallowed = true;
    const again = await handover.toConversation(PANE);
    expect(again.ok ? "" : again.reason).not.toMatch(/already asked/);
    expect(exits(fake)).toBe(2);
  });

  test("cancelling the switch ends the wait for an exit", async () => {
    const { fake, handover } = stuckWatch();
    const first = await handover.toConversation(PANE);
    expect(first.ok ? "" : first.reason).toMatch(/did not exit in time/);
    const blocked = await handover.toConversation(PANE);
    expect(blocked.ok ? "" : blocked.reason).toMatch(/already asked to exit/);
    expect(handover.cancelExit(PANE)).toBe(true);
    expect(handover.cancelExit(PANE)).toBe(false);
    const again = await handover.toConversation(PANE);
    expect(again.ok ? "" : again.reason).not.toMatch(/already asked/);
    expect(exits(fake)).toBe(2);
  });

  test("a cancelled watch resumes nothing when claude exits late", async () => {
    const { fake, handover } = setup({ exitIgnored: true });
    const first = await handover.toConversation(PANE);
    expect(first.ok ? "" : first.reason).toMatch(/did not exit in time/);
    handover.cancelExit(PANE);
    // The /exit lands after all.
    fake.live.delete(fake.claudePid);
    fake.pane.agent = null;
    fake.pane.process = {
      shell_pid: 800,
      foreground_process_group_id: 800,
      foreground_processes: [],
    };
    for (let round = 0; round < 20; round += 1) {
      for (let index = 0; index < 50; index += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(fake.calls.some(([name]) => name === "sendText")).toBe(false);
  });
});

describe("exitSentAsMessage", () => {
  const record = (text: unknown, at: string, extra = {}) =>
    JSON.stringify({
      type: "user",
      timestamp: at,
      message: { role: "user", content: text },
      ...extra,
    });
  const since = Date.parse("2026-11-10T15:46:19.600Z");

  test("finds the exit sent after a pasted image", () => {
    const tail = [
      record("earlier", "2026-11-10T15:00:00.000Z"),
      record(
        [
          { type: "text", text: "[Image #168]/exit" },
          { type: "image", source: {} },
        ],
        "2026-11-10T15:46:20.000Z",
      ),
      record("[Image: source: /tmp/x.png]", "2026-11-10T15:46:20.050Z", {
        isMeta: true,
      }),
    ].join("\n");
    expect(exitSentAsMessage(tail, "/exit", since)).toBe(true);
  });

  test("an exit Claude ran as its command is not one", () => {
    const tail = record(
      "<command-name>/exit</command-name>\n<command-message>exit</command-message>",
      "2026-11-10T15:46:20.000Z",
    );
    expect(exitSentAsMessage(tail, "/exit", since)).toBe(false);
  });

  test("an older /exit message is not this exit", () => {
    const tail = record("/exit", "2026-11-10T15:40:00.000Z");
    expect(exitSentAsMessage(tail, "/exit", since)).toBe(false);
  });

  test("a partial first line and other text are skipped", () => {
    const tail = `ial":"line"}\n${record("talk about /exit please", "2026-11-10T15:46:21.000Z")}`;
    expect(exitSentAsMessage(tail, "/exit", since)).toBe(false);
  });
});

describe("conversation to terminal", () => {
  async function owned(options: Parameters<typeof setup>[0] = {}) {
    const context = setup(options);
    const result = await context.handover.toConversation(PANE);
    expect(result.ok).toBe(true);
    return context;
  }

  test("stops the headless process, then the holder resumes claude", async () => {
    const context = await owned();
    const { side, events } = headless();
    const replies = context.replies;
    const original = side.stop;
    side.stop = async () => {
      // The holder hears nothing before the process is gone.
      expect(replies).toEqual([]);
      return original();
    };
    const resumed = context.handover.toTerminal(PANE, side);
    await Promise.resolve();
    context.fake.resumed();
    const result = await resumed;
    expect(result).toMatchObject({
      ok: true,
      owner: "terminal",
      session_id: context.fake.sessionId,
      confirmed: true,
    });
    expect(events).toEqual(["stopped"]);
    expect(replies).toEqual([
      {
        action: "resume",
        session_id: context.fake.sessionId,
        cwd: context.fake.cwd,
        argv: ["claude", "--resume", context.fake.sessionId],
        args: ["--resume", context.fake.sessionId],
      },
    ]);
    expect(context.leases.get(PANE)).toBeNull();
    expect(context.fake.calls.some(([call]) => call === "releaseAgent")).toBe(
      true,
    );
  });

  test("an unowned session is the terminal's already", async () => {
    const { handover } = setup();
    expect(await handover.toTerminal(PANE, null)).toMatchObject({
      ok: true,
      owner: "terminal",
    });
  });

  test("refuses during a turn", async () => {
    const context = await owned();
    const { side, events } = headless({ busy: () => true });
    const result = await context.handover.toTerminal(PANE, side);
    expect(result.ok ? "" : result.reason).toMatch(/middle of a turn/);
    expect(events).toEqual([]);
    expect(context.leases.get(PANE)?.phase).toBe("conversation");
    expect(context.replies).toEqual([]);
  });

  test("interrupts the turn when asked, and refuses when it will not stop", async () => {
    const context = await owned();
    let interrupted = 0;
    const { side } = headless({
      busy: () => true,
      interrupt: async () => {
        interrupted += 1;
        return true;
      },
    });
    const result = await context.handover.toTerminal(PANE, side, {
      interrupt: true,
    });
    expect(interrupted).toBe(1);
    expect(result.ok ? "" : result.reason).toMatch(/did not stop its turn/);
    expect(context.leases.get(PANE)?.phase).toBe("conversation");
  });

  test("interrupts the turn when asked, then hands back", async () => {
    const context = await owned();
    let busy = true;
    const { side } = headless({
      busy: () => busy,
      interrupt: async () => {
        busy = false;
        return true;
      },
    });
    const result = await context.handover.toTerminal(PANE, side, {
      interrupt: true,
      confirm: false,
    });
    expect(result.ok).toBe(true);
  });

  test("refuses with messages in the queue", async () => {
    const context = await owned();
    const { side } = headless({ queueLength: () => 2 });
    const result = await context.handover.toTerminal(PANE, side);
    expect(result.ok ? "" : result.reason).toMatch(/2 messages wait/);
  });

  test("keeps conversation mode when the process does not stop", async () => {
    const context = await owned();
    const { side } = headless({
      stop: async () => {
        context.fake.probe.running.add(context.fake.sessionId);
        return false;
      },
    });
    const result = await context.handover.toTerminal(PANE, side);
    expect(result.ok ? "" : result.reason).toMatch(/did not stop/);
    expect(context.leases.get(PANE)?.phase).toBe("conversation");
    expect(context.replies).toEqual([]);
  });

  test("an SSH client killed is not enough: the host says the claude is gone", async () => {
    const context = await owned();
    // stop() cannot tell over SSH (false), the host's ps can.
    const { side } = headless({ stop: async () => false });
    const result = await context.handover.toTerminal(PANE, side, {
      confirm: false,
    });
    expect(result.ok).toBe(true);
    expect(
      context.fake.calls.some(([call]) => call === "headlessRunning"),
    ).toBe(true);
  });

  test("keeps conversation mode while a headless claude from before runs", async () => {
    // Roamgate died mid-turn (or an SSH client went away): no handle here,
    // and after /clear the process still names the old session.
    const context = await owned();
    const lease = context.leases.get(PANE)!;
    context.leases.set({
      ...lease,
      session_id: "22222222-0000-0000-0000-000000000000",
      headless_session_ids: [context.fake.sessionId],
    });
    context.fake.probe.running.add(context.fake.sessionId);
    const result = await context.handover.toTerminal(PANE, null);
    expect(result.ok ? "" : result.reason).toMatch(/did not stop/);
    expect(context.leases.get(PANE)?.phase).toBe("conversation");
    expect(context.replies).toEqual([]);
  });

  test("refuses when the host cannot say whether one runs", async () => {
    const context = await owned();
    context.fake.probe.fails = true;
    const result = await context.handover.toTerminal(PANE, headless().side);
    expect(result.ok).toBe(false);
    expect(context.leases.get(PANE)?.phase).toBe("conversation");
  });

  test("a stale headless pid taken by another process does not block", async () => {
    const context = await owned();
    context.leases.set({ ...context.leases.get(PANE)!, headless_pid: 812 });
    // After a reboot, 812 is some daemon: alive, but not a headless claude.
    context.fake.live.add(812);
    const result = await context.handover.toTerminal(PANE, null, {
      confirm: false,
    });
    expect(result.ok).toBe(true);
  });

  test("refuses while a background task runs", async () => {
    const context = await owned();
    const { side, events } = headless({ backgroundTasks: () => 1 });
    const result = await context.handover.toTerminal(PANE, side);
    expect(result.ok ? "" : result.reason).toMatch(/background task/);
    expect(events).toEqual([]);
    expect(context.leases.get(PANE)?.phase).toBe("conversation");
  });

  test("without a holder, says how to resume", async () => {
    const context = await owned();
    for (const controller of aborts.splice(0)) controller.abort();
    context.holders.forget(PANE);
    const { side } = headless();
    const result = await context.handover.toTerminal(PANE, side);
    expect(result).toMatchObject({ ok: true, confirmed: false });
    expect(result.ok && result.detail).toMatch(/claude --resume/);
  });

  test("reports when Herdr does not map the pane again", async () => {
    const context = await owned();
    const { side } = headless();
    const result = await context.handover.toTerminal(PANE, side);
    expect(result).toMatchObject({ ok: true, confirmed: false });
  });
});

describe("another claude on the session in another pane", () => {
  const OTHER = "w2:p12";

  /**
   * PANE's switch finds a second claude of the same session in OTHER, as
   * when a stale one was left open there. Each pane is its own fake.
   */
  function withOther(
    otherOptions: Parameters<typeof fakeHerdr>[0] = {},
    options: Parameters<typeof setup>[0] = {},
  ) {
    const other = fakeHerdr({
      claudePid: 700,
      shellPid: 600,
      ...otherOptions,
    });
    const order: string[] = [];
    // Each function reads `context` once the handover runs, after setup.
    const pick = (paneId: string) =>
      paneId === OTHER ? other.herdr : context.fake.herdr;
    const writerIn = (paneId: string): WriterElsewhere | null => {
      const agent =
        paneId === OTHER ? other.pane.agent : context.fake.pane.agent;
      if (!agent) return null;
      const status = agent.agent_status;
      return {
        text: `Claude runs this session in pane ${paneId}`,
        pane: {
          pane_id: paneId,
          workspace_id: "w2",
          tab_id: "w2:t1",
          workspace_label: "roamgate",
          tab_label: "Tab 1",
          agent_name: "Claude",
          status:
            status === "idle" || status === "working" || status === "blocked"
              ? status
              : "unknown",
        },
      };
    };
    const herdr: Partial<ConversationHerdr> = {
      agentGet: (paneId) => pick(paneId).agentGet(paneId),
      readDetection: (paneId) => pick(paneId).readDetection(paneId),
      processInfo: (paneId) => pick(paneId).processInfo(paneId),
      prompt: (paneId, text) => {
        order.push(`${paneId} ${text}`);
        return pick(paneId).prompt(paneId, text);
      },
      sendKeys: (paneId, keys) => pick(paneId).sendKeys(paneId, keys),
      sendText: (paneId, text) => {
        order.push(`${paneId} typed`);
        return pick(paneId).sendText(paneId, text);
      },
      pidAlive: async (pid) =>
        (await other.herdr.pidAlive(pid)) ||
        (await context.fake.herdr.pidAlive(pid)),
      // Each pane sees the other: a quit must never ask about it.
      writerElsewhere: async (paneId) =>
        writerIn(paneId === OTHER ? PANE : OTHER),
    };
    const context = setup({
      ...options,
      herdr: { ...herdr, ...options.herdr },
    });
    return { ...context, other, order };
  }

  test("refuses, saying where the other one is and that it is idle", async () => {
    const { handover, leases, order } = withOther();
    const result = await handover.toConversation(PANE);
    expect(result).toMatchObject({
      ok: false,
      writer: {
        pane_id: OTHER,
        workspace_label: "roamgate",
        tab_label: "Tab 1",
        status: "idle",
      },
    });
    expect(result.ok ? "" : result.reason).toBe(
      "This session is also open in roamgate / Tab 1 (pane w2:p12), where Claude is idle. Only one Claude can write a session at a time, so this waits until that one is closed",
    );
    expect(leases.get(PANE)).toBeNull();
    expect(order).toEqual([]);
  });

  test("quits the idle one there, leaving its shell, then switches", async () => {
    const { handover, leases, other, order, fake } = withOther();
    const result = await handover.toConversation(PANE, undefined, {
      quitWriter: OTHER,
    });
    expect(result).toMatchObject({ ok: true, owner: "conversation" });
    expect(leases.get(PANE)?.phase).toBe("conversation");
    // The other one quit first, then this pane's: nothing typed there.
    expect(order).toEqual([`${OTHER} /exit`, `${PANE} /exit`, `${PANE} typed`]);
    expect(other.live.has(other.claudePid)).toBe(false);
    expect(other.pane.process.foreground_process_group_id).toBe(600);
    expect(other.calls.some(([name]) => name === "sendText")).toBe(false);
    expect(leases.get(OTHER)).toBeNull();
    expect(fake.live.has(fake.claudePid)).toBe(false);
  });

  for (const status of ["working", "blocked"] as const)
    test(`never quits it while it is ${status}`, async () => {
      const { handover, other, order } = withOther();
      other.pane.agent!.agent_status = status;
      const result = await handover.toConversation(PANE, undefined, {
        quitWriter: OTHER,
      });
      expect(result).toMatchObject({ ok: false, writer: { status } });
      expect(result.ok ? "" : result.reason).toContain(
        status === "working"
          ? "where Claude is working"
          : "where Claude waits for an answer",
      );
      expect(order).toEqual([]);
      expect(other.live.has(other.claudePid)).toBe(true);
    });

  test("quits only the pane the user chose", async () => {
    const { handover, order } = withOther();
    const result = await handover.toConversation(PANE, undefined, {
      quitWriter: "w9:p9",
    });
    expect(result).toMatchObject({ ok: false, writer: { pane_id: OTHER } });
    expect(order).toEqual([]);
  });

  test("says why the other one did not quit, and this pane keeps its claude", async () => {
    const { handover, other, order, fake } = withOther();
    other.pane.screen = IDLE_SCREEN.replace("\u276f", "\u276f half a thought");
    const result = await handover.toConversation(PANE, undefined, {
      quitWriter: OTHER,
    });
    expect(result).toMatchObject({
      ok: false,
      writer: { pane_id: OTHER, status: "idle" },
    });
    expect(result.ok ? undefined : result.writer?.quit_refusal).toMatch(
      /typed in Claude's prompt box/,
    );
    expect(result.ok ? "" : result.reason).toMatch(/It did not quit: /);
    expect(order).toEqual([]);
    expect(fake.live.has(fake.claudePid)).toBe(true);
  });

  test("one quit late is not resumed there", async () => {
    const { handover, other, order } = withOther({ exitIgnored: true });
    const result = await handover.toConversation(PANE, undefined, {
      quitWriter: OTHER,
    });
    expect(result.ok ? undefined : result.writer?.quit_refusal).toMatch(
      /did not exit in time/,
    );
    expect(order).toEqual([`${OTHER} /exit`]);
    // It exits a little later: its shell stays bare.
    other.live.delete(other.claudePid);
    other.pane.agent = null;
    other.pane.process = {
      shell_pid: 600,
      foreground_process_group_id: 600,
      foreground_processes: [],
    };
    for (let round = 0; round < 20; round += 1) {
      for (let index = 0; index < 50; index += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(other.calls.some(([name]) => name === "sendText")).toBe(false);
    // The switch goes now.
    const again = await handover.toConversation(PANE);
    expect(again).toMatchObject({ ok: true, owner: "conversation" });
  });
});
