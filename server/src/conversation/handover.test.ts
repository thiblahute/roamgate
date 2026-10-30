import { afterEach, describe, expect, test } from "bun:test";
import { createHandover, type HeadlessSide } from "./handover";
import type { ConversationHerdr } from "./herdr";
import { createHolderRegistry, type HolderReply } from "./holder";
import { createLeaseStore } from "./lease";
import { fakeHerdr, virtualClock } from "./testing";

const PANE = "w1:p1";
const aborts: AbortController[] = [];
afterEach(() => {
  for (const controller of aborts.splice(0)) controller.abort();
});

function setup(
  options: Parameters<typeof fakeHerdr>[0] & {
    holderStarts?: boolean;
    herdr?: Partial<ConversationHerdr>;
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
