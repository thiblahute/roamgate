import { afterEach, describe, expect, test } from "bun:test";
import { overlaySuspendedPanes } from "../agent/agent-sessions";
import { handleAgentChatRpc } from "./rpc";
import {
  disposeServices,
  eventually,
  heldPane,
  PANE,
  setupService,
  type Ws,
} from "./service-testing";
import type { HolderShell } from "./service-holders";
import { foregroundCommand, shellName } from "./suspended";
import { settle } from "./testing";

afterEach(disposeServices);

const JOB = {
  jobControl: true,
  pid: 4321,
  job: "11111111-2222-3333-4444-555555555555",
};

/** A pane in conversation mode, its holder able to stop as a shell job. */
async function held(
  shell: HolderShell = JOB,
  extra: Parameters<typeof setupService>[1] = {},
) {
  const setup = setupService(undefined, extra, { shell });
  expect((await setup.service.handover(PANE, "conversation")).ok).toBe(true);
  await settle();
  heldPane(setup.fake);
  return setup;
}

/** The holder's job is stopped: the pane's shell is back at its prompt. */
function shellAtPrompt(fake: ReturnType<typeof setupService>["fake"]) {
  fake.pane.process = {
    shell_pid: 800,
    foreground_process_group_id: 800,
    foreground_processes: [{ pid: 800, argv0: "-bash" }],
  };
}

describe("Ctrl+Z: a conversation stopped as a shell job", () => {
  test("stops the process, releases the pane and tells the holder what to keep", async () => {
    const { service, fake, spawner, holderPolls } = await held();
    const result = await service.handover(PANE, "terminal", {
      suspend: { title: "Fix the build" },
    });
    expect(result).toEqual({
      ok: true,
      owner: "terminal",
      session_id: fake.sessionId,
      suspended: true,
    });
    // Nothing runs on the session, and no claude is started in the pane.
    expect(spawner.alive()).toEqual([]);
    expect(await holderPolls[0]).toEqual({
      action: "suspend",
      session_id: fake.sessionId,
      cwd: fake.cwd,
      title: "Fix the build",
    });
    expect(service.state(PANE)).toMatchObject({
      owner: "terminal",
      phase: "terminal",
    });
    expect(service.suspendedPanes()).toEqual([
      {
        pane_id: PANE,
        session_id: fake.sessionId,
        title: "Fix the build",
        suspended_at: expect.any(String),
        holder_pid: 4321,
        job: JOB.job,
      },
    ]);
    // Herdr's agent goes: the pane is a shell again.
    expect(fake.calls).toContainEqual(["releaseAgent", PANE]);
  });

  test("is refused by a holder that cannot stop as a job, the session kept", async () => {
    const { service, spawner } = await held({ jobControl: false });
    const result = await service.handover(PANE, "terminal", { suspend: {} });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringMatching(/cannot stop as a shell job/),
    });
    expect(service.state(PANE).owner).toBe("conversation");
    expect(spawner.alive().length).toBe(1);
    expect(service.suspendedPanes()).toEqual([]);
  });

  test("the RPC takes a one-line title, and only to the terminal", async () => {
    const { service, holderPolls } = await held();
    await handleAgentChatRpc(
      service,
      null,
      { name: "a" } as Ws,
      "agent_chat.handover",
      {
        pane_id: PANE,
        to: "terminal",
        suspend: true,
        title: "two\nlines\u0007",
      },
    );
    expect(await holderPolls[0]).toMatchObject({
      action: "suspend",
      title: "two lines",
    });
  });
});

describe("fg: the conversation back from the shell", () => {
  test("resumes the same session, in conversation mode, read through the holder's new log", async () => {
    const { service, fake, spawner } = await held();
    await service.handover(PANE, "terminal", { suspend: { title: "t" } });
    shellAtPrompt(fake);
    const reply = await service.holder.fg({
      paneId: PANE,
      spec: { session_id: fake.sessionId, cwd: fake.cwd },
      shell: JOB,
    });
    expect(reply).toEqual({ action: "hold", session_id: fake.sessionId });
    await settle();
    expect(service.state(PANE)).toMatchObject({
      owner: "conversation",
      phase: "conversation",
      session_id: fake.sessionId,
    });
    // The same session resumed, history and all (claude --resume <id>).
    const starts = spawner.spawned.map((each) => each.options.sessionId);
    expect(starts).toEqual([fake.sessionId, fake.sessionId]);
    expect(spawner.alive().length).toBe(1);
    expect(service.suspendedPanes()).toEqual([]);
    // Herdr is told the pane is Claude's again.
    expect(fake.reports.at(-1)).toEqual({
      state: "idle",
      sessionId: fake.sessionId,
    });
  });

  test("is refused while another claude writes the session, and the job stays", async () => {
    const { service, fake } = await held();
    await service.handover(PANE, "terminal", { suspend: {} });
    fake.probe.elsewhere = "claude runs the session in pane w2:p1";
    const reply = await service.holder.fg({
      paneId: PANE,
      spec: { session_id: fake.sessionId, cwd: fake.cwd },
    });
    expect(reply).toEqual({
      action: "refused",
      reason: expect.stringMatching(/w2:p1; close it there first/),
    });
    expect(service.state(PANE).owner).toBe("terminal");
    expect(service.suspendedPanes().length).toBe(1);
  });

  test("the page's fg names the stopped job, never the shell's current one", async () => {
    const { service, fake } = await held();
    await service.handover(PANE, "terminal", { suspend: {} });
    shellAtPrompt(fake);
    expect(await service.foreground(PANE)).toEqual({ ok: true });
    expect(fake.calls).toContainEqual([
      "sendText",
      PANE,
      ` fg '%?${JOB.job}'\r`,
    ]);
  });

  test("the page's fg waits for the shell's prompt, and needs a stopped conversation", async () => {
    const { service, fake } = await held();
    expect(await service.foreground(PANE)).toEqual({
      ok: false,
      reason: "No conversation is stopped in this pane",
    });
    await service.handover(PANE, "terminal", { suspend: {} });
    // Something else runs in the pane (vim, a build): fg is not typed.
    fake.pane.process = {
      shell_pid: 800,
      foreground_process_group_id: 960,
      foreground_processes: [{ pid: 960, argv: ["vim"] }],
    };
    expect(await service.foreground(PANE)).toEqual({
      ok: false,
      reason: expect.stringMatching(/Something runs in the pane's terminal/),
    });
    expect(
      fake.calls.some(
        ([call, , text]) => call === "sendText" && String(text).includes("fg"),
      ),
    ).toBe(false);
  });

  test("a stopped job whose holder is gone is forgotten", async () => {
    const changed: string[] = [];
    const { service, fake } = await held(JOB, {
      suspendedWatchMs: 5,
      onLeaseChanged: (paneId) => changed.push(paneId),
    });
    fake.live.add(4321);
    await service.handover(PANE, "terminal", { suspend: {} });
    await Bun.sleep(20);
    expect(service.suspendedPanes().length).toBe(1);
    // `kill %1`: the holder is gone, and the browsers are told.
    fake.live.delete(4321);
    changed.length = 0;
    await eventually(() => service.suspendedPanes().length === 0, 2000);
    expect(changed).toContain(PANE);
  });
});

describe("the stopped job's helpers", () => {
  test("fg names the job by its session id, or by pid in fish", () => {
    const entry = { session_id: "abcdef12-0000", holder_pid: 77 };
    expect(foregroundCommand(entry, "bash")).toBe(" fg '%?abcdef12-0000'\r");
    expect(foregroundCommand({ ...entry, job: "12345678-aaaa" }, "zsh")).toBe(
      " fg '%?12345678-aaaa'\r",
    );
    expect(foregroundCommand(entry, "fish")).toBe(" fg 77\r");
    expect(() =>
      foregroundCommand({ session_id: "x'; rm -rf /" }, "bash"),
    ).toThrow();
    expect(shellName({ pid: 1, argv0: "-zsh" })).toBe("zsh");
    expect(shellName({ pid: 1, argv: ["/usr/bin/fish"] })).toBe("fish");
  });

  test("panes show their stopped conversation, their agent left alone", () => {
    const listed = overlaySuspendedPanes(
      "pane.list",
      { panes: [{ pane_id: PANE, agent: null }, { pane_id: "w1:p2" }] },
      [
        {
          pane_id: PANE,
          session_id: "s1",
          title: "t",
          suspended_at: "2026-11-19T00:00:00.000Z",
        },
      ],
    );
    expect(listed).toEqual({
      panes: [
        {
          pane_id: PANE,
          agent: null,
          suspended_conversation: {
            session_id: "s1",
            title: "t",
            suspended_at: "2026-11-19T00:00:00.000Z",
          },
        },
        { pane_id: "w1:p2" },
      ],
    });
  });
});
