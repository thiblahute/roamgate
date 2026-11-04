import { afterEach, describe, expect, jest, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentChatEventEnvelope } from "../../../shared/agentChat";
import { withOwnedSessions } from "../agent/agent-sessions";
import { createLeaseStore, flushLeaseFiles, forgetLeaseFiles } from "./lease";
import type { HolderStatus } from "./pane-child";
import { handleAgentChatRpc, isAgentChatMethod } from "./rpc";
import { type ConversationServiceOptions, createSlots } from "./service";
import {
  disposeLater,
  disposeServices,
  eventually,
  heldPane,
  PANE,
  setupService as setup,
  userTexts,
  type Ws,
} from "./service-testing";
import {
  answerInterrupts,
  answerRewinds,
  fakeClaudeProcess,
  fakeSpawner,
  RESULT,
  settle,
  virtualClock,
} from "./testing";

afterEach(disposeServices);

describe("conversation service", () => {
  test("refuses to send while the terminal owns the session", async () => {
    const { service } = setup();
    expect(() => service.send(PANE, { text: "hi" })).toThrow(/terminal owns/);
  });

  test("Roamgate's own prompts are messages once conversation mode holds the pane", async () => {
    const { service, spawner } = setup();
    // The terminal owns it: the caller types into the pane.
    expect(await service.prompt(PANE, "a comment")).toBe(false);
    await service.handover(PANE, "conversation");
    await settle();
    let before = 0;
    expect(await service.prompt(PANE, "a comment", () => before++)).toBe(true);
    expect(before).toBe(1);
    await settle();
    const users = spawner.spawned[0]!.fake.written.filter(
      (message) => message.type === "user",
    );
    expect(users.map((each) => each.message)).toEqual([
      { role: "user", content: "a comment" },
    ]);
  });

  test("a `!` line runs on the host and reaches Claude, in bash-mode format, with the next message only", async () => {
    const runs: {
      cwd: string;
      command: string;
      output: (o: {
        stdout: string;
        stderr: string;
        truncated: boolean;
      }) => void;
      end: (value: { code: number | null; stopped: boolean }) => void;
      stopped: boolean;
    }[] = [];
    const { service, spawner, sent, fake } = setup(undefined, {
      runShell: ({ cwd, command, onOutput }) => {
        const done = Promise.withResolvers<{
          code: number | null;
          stopped: boolean;
        }>();
        const run = {
          cwd,
          command,
          output: onOutput,
          end: done.resolve,
          stopped: false,
        };
        runs.push(run);
        return {
          done: done.promise,
          stop() {
            run.stopped = true;
            done.resolve({ code: null, stopped: true });
          },
        };
      },
    });
    const ws = { name: "browser" };
    // The terminal owns the session: nothing runs.
    expect(() => service.shell(PANE, { command: "echo hi" })).toThrow(
      /terminal owns/,
    );
    await service.handover(PANE, "conversation");
    await settle();
    service.subscribe(ws, PANE);
    const { id } = service.shell(PANE, { command: " echo hi && pwd" });
    expect(runs[0]).toMatchObject({
      cwd: fake.cwd,
      command: " echo hi && pwd",
    });
    runs[0]!.output({ stdout: "hi\n", stderr: "", truncated: false });
    await Bun.sleep(150);
    const shellEvents = () =>
      sent
        .filter(([, envelope]) => envelope.event === "agent_chat.shell")
        .map(([, envelope]) => (envelope.data as { shell: unknown }).shell);
    // Live output, then how it ended.
    expect(shellEvents().at(-1)).toMatchObject({
      id,
      status: "running",
      stdout: "hi\n",
    });
    runs[0]!.output({
      stdout: `hi\n${fake.cwd}\n`,
      stderr: "<warn>",
      truncated: false,
    });
    runs[0]!.end({ code: 0, stopped: false });
    await settle();
    expect(shellEvents().at(-1)).toMatchObject({
      id,
      status: "done",
      exit_code: 0,
    });
    expect(service.state(PANE).shells).toHaveLength(1);
    // Running it started no turn.
    expect(
      spawner.spawned[0]!.fake.written.filter((each) => each.type === "user"),
    ).toEqual([]);
    // A second one, stopped.
    const stopped = service.shell(PANE, { command: "sleep 100" });
    expect(service.stopShell(PANE, stopped.id)).toBe(true);
    await settle();
    expect(runs[1]!.stopped).toBe(true);
    expect(service.state(PANE).shells?.[1]).toMatchObject({
      status: "stopped",
      exit_code: null,
    });
    // The next message carries both, first, as Claude Code's bash mode.
    await service.send(PANE, { text: "what did my last command print?" });
    await settle();
    const users = spawner.spawned[0]!.fake.written.filter(
      (each) => each.type === "user",
    );
    expect(users).toHaveLength(1);
    expect((users[0]!.message as { content: unknown }).content).toEqual([
      { type: "text", text: "<bash-input> echo hi && pwd</bash-input>" },
      {
        type: "text",
        text: `<bash-stdout>hi\n${fake.cwd}\n</bash-stdout><bash-stderr>&lt;warn&gt;</bash-stderr>`,
      },
      { type: "text", text: "<bash-input>sleep 100</bash-input>" },
      {
        type: "text",
        text: "<bash-stdout></bash-stdout><bash-stderr></bash-stderr>",
      },
      { type: "text", text: "what did my last command print?" },
    ]);
    // Claude has them: they leave the chat's state (the transcript has them).
    expect(service.state(PANE).shells).toBeUndefined();
    expect(shellEvents().at(-1)).toMatchObject({ delivered: true });
    // The message after goes alone.
    spawner.spawned[0]!.fake.push(RESULT);
    await settle();
    await service.send(PANE, { text: "thanks" });
    await settle();
    const after = spawner.spawned[0]!.fake.written.filter(
      (each) => each.type === "user",
    );
    expect((after.at(-1)!.message as { content: unknown }).content).toBe(
      "thanks",
    );
  });

  test("a `!` line's output is cut as Claude Code cuts it", async () => {
    let output: (o: {
      stdout: string;
      stderr: string;
      truncated: boolean;
    }) => void = () => {};
    let end: (value: { code: number; stopped: boolean }) => void = () => {};
    const { service, spawner } = setup(undefined, {
      runShell: ({ onOutput }) => {
        output = onOutput;
        const done = Promise.withResolvers<{
          code: number;
          stopped: boolean;
        }>();
        end = done.resolve;
        return { done: done.promise, stop() {} };
      },
    });
    await service.handover(PANE, "conversation");
    await settle();
    service.shell(PANE, { command: "yes" });
    output({
      stdout: `${"y\n".repeat(20_000)}`,
      stderr: "",
      truncated: true,
    });
    end({ code: 0, stopped: false });
    await settle();
    const shell = service.state(PANE).shells![0]!;
    expect(shell.truncated).toBe(true);
    expect(shell.stdout.length).toBe(30_000);
    await service.send(PANE, { text: "and?" });
    await settle();
    const content = (
      spawner.spawned[0]!.fake.written.find((each) => each.type === "user")!
        .message as { content: { text: string }[] }
    ).content;
    expect(content[1]!.text).toEndWith(
      // 10,000 characters past the cap: 5,000 lines and the empty last.
      "\n\n... [5001 lines truncated] ...</bash-stdout><bash-stderr></bash-stderr>",
    );
  });

  test("without a runner, `!` lines are refused", async () => {
    const { service } = setup();
    await service.handover(PANE, "conversation");
    await settle();
    expect(() => service.shell(PANE, { command: "ls" })).toThrow(/unavailable/);
  });

  test("takes over, reports to Herdr, and warms the headless process", async () => {
    const { service, fake, spawner } = setup();
    const result = await service.handover(PANE, "conversation");
    expect(result.ok).toBe(true);
    await settle();
    expect(spawner.spawned.map((each) => each.options)).toEqual([
      {
        paneId: PANE,
        sessionId: fake.sessionId,
        cwd: fake.cwd,
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(fake.reports[0]).toEqual({
      state: "idle",
      sessionId: fake.sessionId,
    });
    expect(service.state(PANE)).toMatchObject({
      owner: "conversation",
      phase: "conversation",
      status: "idle",
      session_id: fake.sessionId,
    });
    expect(service.ownedSession(PANE)).toEqual({
      session_id: fake.sessionId,
      cwd: fake.cwd,
    });
  });

  test("never starts a headless claude while one runs in the pane", async () => {
    const { service, fake, spawner } = setup();
    await service.handover(PANE, "conversation");
    await settle();
    spawner.spawned[0]!.fake.exit(0);
    await settle();
    // Someone typed claude in the pane meanwhile.
    fake.resumed();
    await expect(service.send(PANE, { text: "hi" })).rejects.toThrow(
      /second one/,
    );
    expect(spawner.spawned).toHaveLength(1);
    // The holder resumed it (Roamgate was away): the terminal has it now.
    await settle();
    expect(service.state(PANE).phase).toBe("terminal");
  });

  test("never starts a headless claude while claude runs the session elsewhere", async () => {
    const { service, fake, spawner } = setup();
    await service.handover(PANE, "conversation");
    await settle();
    spawner.spawned[0]!.fake.exit(0);
    await settle();
    fake.probe.elsewhere = "Claude runs this session in pane w2:p1";
    await expect(service.send(PANE, { text: "hi" })).rejects.toThrow(
      /pane w2:p1; conversation mode will not start a second writer/,
    );
    expect(spawner.spawned).toHaveLength(1);
  });

  test("never starts a headless claude behind a pane with no holder", async () => {
    const first = setup();
    await first.service.handover(PANE, "conversation");
    await settle();
    first.service.dispose();
    // Roamgate restarts; the holder is gone (the pane is a bare shell).
    const second = setup(first.store, { carriedQueueDelayMs: 60_000 });
    second.fake.pane.agent = null;
    second.fake.pane.process = {
      shell_pid: 800,
      foreground_process_group_id: 800,
      foreground_processes: [],
    };
    // The message waits; the terminal has the session again.
    expect(await second.service.send(PANE, { text: "hi", uuid: "m1" })).toEqual(
      { status: "queued", id: "m1" },
    );
    expect(second.spawner.spawned).toHaveLength(0);
    expect(second.store.get(PANE)).toBeNull();
    expect(second.service.state(PANE)).toMatchObject({
      owner: "terminal",
      queue: [expect.objectContaining({ id: "m1", text: "hi" })],
    });
    // Nothing was typed into the shell.
    expect(second.fake.calls.some((call) => call[0] === "sendText")).toBe(
      false,
    );
  });

  test("never starts a headless claude for a holder of another session", async () => {
    const { service, fake, spawner, store } = setup();
    store.set({
      pane_id: PANE,
      session_id: fake.sessionId,
      cwd: fake.cwd,
      phase: "conversation",
    });
    fake.pane.agent = null;
    fake.pane.process = {
      shell_pid: 800,
      foreground_process_group_id: 800,
      foreground_processes: [],
    };
    void service.holder.hold({
      paneId: PANE,
      sessionId: "99999999-0000-0000-0000-000000000000",
      signal: new AbortController().signal,
    });
    await expect(service.send(PANE, { text: "hi" })).rejects.toThrow(
      /another session/,
    );
    expect(spawner.spawned).toHaveLength(0);
    expect(store.get(PANE)?.phase).toBe("conversation");
  });

  test("a stale lease on a pane running claude again is taken over afresh", async () => {
    const store = createLeaseStore({ connectionId: "c1", file: null });
    const { service, fake } = setup(store);
    store.set({
      pane_id: PANE,
      session_id: fake.sessionId,
      cwd: fake.cwd,
      phase: "conversation",
    });
    const result = await service.handover(PANE, "conversation");
    expect(result).toMatchObject({ ok: true, owner: "conversation" });
    // It went through /exit and the holder, not straight to "owned".
    expect(fake.calls).toContainEqual(["prompt", PANE, "/exit"]);
  });

  test("a closed pane takes its lease and its process with it", async () => {
    const { service, spawner, store } = setup();
    await service.handover(PANE, "conversation");
    await settle();
    await service.send(PANE, { text: "a long turn" });
    expect(spawner.alive()).toHaveLength(1);
    service.paneClosed(PANE);
    await settle();
    expect(store.get(PANE)).toBeNull();
    expect(spawner.alive()).toHaveLength(0);
  });

  test("a sweep drops the leases whose pane is gone", async () => {
    const { service, fake, store } = setup();
    await service.handover(PANE, "conversation");
    await settle();
    await service.sweep();
    expect(store.get(PANE)).not.toBeNull();
    fake.probe.closed = true;
    await service.sweep();
    expect(store.get(PANE)).toBeNull();
  });

  test("the queue outlives the runtime and is sent by the next one", async () => {
    const first = setup();
    await first.service.handover(PANE, "conversation");
    await settle();
    await first.service.send(PANE, { text: "first" });
    expect(
      await first.service.send(PANE, { text: "later", uuid: "q1" }),
    ).toEqual({ status: "queued", id: "q1" });
    // An SSH drop, a Herdr reconnect: the runtime is replaced.
    first.service.dispose();
    expect(first.store.get(PANE)?.queue).toEqual([
      expect.objectContaining({ id: "q1", text: "later" }),
    ]);
    // Its holder polls again, from the new runtime.
    expect(await first.holderPolls[0]).toMatchObject({ action: "hold" });
    const second = setup(first.store, { carriedQueueDelayMs: 0 });
    heldPane(second.fake);
    expect(second.service.state(PANE).queue).toEqual([
      expect.objectContaining({ id: "q1", text: "later" }),
    ]);
    second.startHolder();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await settle(100);
    const users = second.spawner.spawned[0]!.fake.written.filter(
      (message) => message.type === "user",
    );
    expect(users.map((each) => each.message)).toEqual([
      { role: "user", content: "later" },
    ]);
    expect(second.store.get(PANE)?.queue).toBeUndefined();
    second.spawner.spawned[0]!.fake.push(RESULT);
  });

  test("a takeover cut by the runtime going changes nothing more", async () => {
    const { service, fake, store } = setup();
    const result = service.handover(PANE, "conversation");
    service.dispose();
    expect(await result).toEqual({
      ok: false,
      reason: "The connection is closing",
    });
    expect(store.get(PANE)).toBeNull();
    expect(fake.calls.some((call) => call[0] === "prompt")).toBe(false);
  });

  test("never starts a second headless claude next to one from before", async () => {
    const { service, fake, spawner, store } = setup();
    await service.handover(PANE, "conversation");
    await settle();
    // The argv's session is kept, also once the process is gone.
    expect(store.get(PANE)?.headless_session_ids).toEqual([fake.sessionId]);
    spawner.spawned[0]!.fake.exit(0);
    await settle();
    expect(store.get(PANE)?.headless_session_ids).toEqual([fake.sessionId]);
    // Gone from here only: an SSH client died, or Roamgate restarted, and
    // the claude it started still works on the session.
    fake.probe.running.add(fake.sessionId);
    await expect(service.send(PANE, { text: "hi" })).rejects.toThrow(
      /earlier conversation process/,
    );
    // The host cannot say: no start either.
    fake.probe.running.clear();
    fake.probe.fails = true;
    await expect(service.send(PANE, { text: "hi" })).rejects.toThrow(
      /did not answer/,
    );
    expect(spawner.spawned).toHaveLength(1);
    fake.probe.fails = false;
    await service.send(PANE, { text: "hi" });
    expect(spawner.spawned).toHaveLength(2);
  });

  test("nothing is typed into the pane while a handover runs", async () => {
    const { service, fake } = setup();
    expect(service.inputRefusal(PANE)).toBeNull();
    expect(service.handingOver()).toBe(false);
    let during: string | null = null;
    let anyDuring = false;
    const prompt = fake.herdr.prompt;
    fake.herdr.prompt = async (paneId, text) => {
      during = service.inputRefusal(PANE);
      // What a browser's terminal keys are checked against.
      anyDuring = service.handingOver();
      await prompt(paneId, text);
    };
    await service.handover(PANE, "conversation");
    expect(during).toMatch(/being handed over/);
    expect(anyDuring).toBe(true);
    expect(service.inputRefusal(PANE)).toBeNull();
    expect(service.handingOver()).toBe(false);
  });

  test("events reach only the pane's subscribers, until they go", async () => {
    const { service, sent } = setup();
    const a = { name: "a" };
    const b = { name: "b" };
    expect(service.subscribe(a, PANE).owner).toBe("terminal");
    service.subscribe(b, "other");
    await service.handover(PANE, "conversation");
    await settle();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every(([ws]) => ws === a)).toBe(true);
    // Each phase as it happens: nobody types into a pane being taken over.
    const leases = sent
      .filter(([, envelope]) => envelope.event === "agent_chat.lease")
      .map(([, envelope]) => envelope.data);
    expect(leases[0]).toMatchObject({
      pane_id: PANE,
      owner: "terminal",
      phase: "to_conversation",
    });
    expect(leases.at(-1)).toMatchObject({
      pane_id: PANE,
      owner: "conversation",
      phase: "conversation",
    });
    sent.length = 0;
    service.cleanupWs(a);
    await service.send(PANE, { text: "hi" });
    expect(sent).toEqual([]);
  });

  test("Enter in the holder hands the session back once the process is gone", async () => {
    const { service, fake, spawner, holderPolls } = setup();
    await service.handover(PANE, "conversation");
    await settle();
    const reply = await service.holder.handback({ paneId: PANE });
    expect(reply).toEqual({
      action: "resume",
      session_id: fake.sessionId,
      cwd: fake.cwd,
      argv: ["claude", "--resume", fake.sessionId],
      args: ["--resume", fake.sessionId],
    });
    expect(spawner.alive()).toEqual([]);
    expect(await holderPolls[0]).toEqual(reply);
    expect(service.state(PANE).owner).toBe("terminal");
  });

  test("the holder is refused during a turn", async () => {
    const { service } = setup();
    await service.handover(PANE, "conversation");
    await settle();
    await service.send(PANE, { text: "work" });
    expect(await service.holder.handback({ paneId: PANE })).toEqual({
      action: "refused",
      reason: expect.stringMatching(/middle of a turn/),
    });
    expect(service.state(PANE).owner).toBe("conversation");
  });

  test("a holder this runtime never knew keeps holding (never resumes)", async () => {
    // Another Roamgate on the host's socket, with no lease for the pane:
    // telling the holder to resume would end the session's process.
    const { service } = setup(undefined, { holdPollMs: 5 });
    expect(
      await service.holder.hold({
        paneId: PANE,
        sessionId: "abc",
        signal: new AbortController().signal,
      }),
    ).toEqual({ action: "hold", session_id: "abc" });
  });

  test("a holder whose lease this runtime dropped resumes claude", async () => {
    const { service, fake, holderAborts } = setup(undefined, {
      holdPollMs: 5,
    });
    await service.handover(PANE, "conversation");
    await settle();
    expect((await service.handover(PANE, "terminal")).ok).toBe(true);
    for (const controller of holderAborts) controller.abort();
    // It missed the reply that resumed it: its next poll gets it.
    expect(
      await service.holder.hold({
        paneId: PANE,
        sessionId: fake.sessionId,
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ action: "resume", session_id: fake.sessionId });
  });

  test("/clear moves the lease, the holder and Herdr's mapping", async () => {
    const { service, fake, spawner, store, holderPolls } = setup();
    await service.handover(PANE, "conversation");
    await settle();
    await service.send(PANE, { text: "/clear" });
    spawner.spawned[0]!.fake.push({
      type: "conversation_reset",
      new_conversation_id: "22222222-0000-0000-0000-000000000000",
      session_id: fake.sessionId,
    });
    await settle();
    expect(store.get(PANE)?.session_id).toBe(
      "22222222-0000-0000-0000-000000000000",
    );
    expect(await holderPolls[0]).toEqual({
      action: "hold",
      session_id: "22222222-0000-0000-0000-000000000000",
    });
    expect(fake.reports.at(-1)?.sessionId).toBe(
      "22222222-0000-0000-0000-000000000000",
    );
  });

  test("a restart mid-handover settles the leases safely", () => {
    const store = createLeaseStore({ connectionId: "c1", file: null });
    store.set({
      pane_id: "a",
      session_id: "s-a",
      cwd: "/a",
      phase: "to_terminal",
    });
    store.set({
      pane_id: "b",
      session_id: "s-b",
      cwd: "/b",
      phase: "to_conversation",
    });
    setup(store);
    expect(store.get("a")?.phase).toBe("conversation");
    expect(store.get("b")).toBeNull();
  });
});

describe("turns cut short", () => {
  function interruptedEvents(sent: [Ws, AgentChatEventEnvelope][]) {
    return sent
      .filter(([, envelope]) => envelope.event === "agent_chat.interrupted")
      .map(([, envelope]) =>
        envelope.data.type === "interrupted" ? envelope.data.interrupted : 0,
      );
  }

  test("a running turn is marked on the lease until its result", async () => {
    const { service, spawner, store } = setup();
    await service.handover(PANE, "conversation");
    await settle();
    expect(store.get(PANE)?.turn_started_at).toBeUndefined();
    await service.send(PANE, { text: "work" });
    expect(store.get(PANE)?.turn_started_at).toEqual(expect.any(String));
    spawner.spawned[0]!.fake.push(RESULT);
    await settle();
    expect(store.get(PANE)?.turn_started_at).toBeUndefined();
    expect(service.state(PANE).interrupted).toBeNull();
  });

  test("a process exiting mid-turn leaves a notice, until the next send", async () => {
    const { service, spawner, store, sent } = setup();
    const ws = { name: "w" };
    service.subscribe(ws, PANE);
    await service.handover(PANE, "conversation");
    await settle();
    await service.send(PANE, { text: "work" });
    spawner.spawned[0]!.fake.exit(137);
    await settle();
    expect(store.get(PANE)?.turn_started_at).toBeUndefined();
    expect(service.state(PANE).interrupted).toEqual({
      at: expect.any(String),
      reason: "process_exited",
    });
    expect(interruptedEvents(sent)).toEqual([
      { at: expect.any(String), reason: "process_exited" },
    ]);
    sent.length = 0;
    await service.send(PANE, { text: "continue", uuid: "c1" });
    expect(service.state(PANE).interrupted).toBeNull();
    expect(interruptedEvents(sent)).toEqual([null]);
    expect(store.get(PANE)?.turn_started_at).toEqual(expect.any(String));
  });

  test("a process that exited, or a turn the user stopped, leaves none", async () => {
    const { service, spawner } = setup();
    await service.handover(PANE, "conversation");
    await settle();
    await service.send(PANE, { text: "work" });
    spawner.spawned[0]!.fake.push(RESULT);
    await settle();
    spawner.spawned[0]!.fake.exit(0);
    await settle();
    expect(service.state(PANE).interrupted).toBeNull();
    await service.send(PANE, { text: "more" });
    await settle();
    const second = spawner.spawned[1]!.fake;
    // Interrupted on purpose, then the process dies before its result.
    second.process.write = () => {};
    await service.interrupt(PANE);
    second.exit(1);
    await settle();
    expect(service.state(PANE).interrupted).toBeNull();
  });

  test("a restart whose process is gone says the turn was cut short, until dismissed", async () => {
    const first = setup();
    await first.service.handover(PANE, "conversation");
    await settle();
    await first.service.send(PANE, { text: "work" });
    first.service.dispose();
    expect(first.store.get(PANE)?.turn_started_at).toEqual(expect.any(String));
    expect(first.store.get(PANE)?.interrupted).toBeUndefined();
    // The holder came back, but runs nothing for the session any more.
    const second = setup(first.store, { carriedQueueDelayMs: 0 });
    heldPane(second.fake);
    second.startHolder();
    await Bun.sleep(5);
    await settle();
    const ws = { name: "w" };
    expect(second.service.subscribe(ws, PANE).interrupted).toEqual({
      at: expect.any(String),
      reason: "restart",
    });
    expect(second.store.get(PANE)?.turn_started_at).toBeUndefined();
    expect(
      await handleAgentChatRpc(
        second.service,
        null,
        ws,
        "agent_chat.interrupted.dismiss",
        { pane_id: PANE },
      ),
    ).toEqual({ ok: true });
    expect(second.service.state(PANE).interrupted).toBeNull();
    expect(interruptedEvents(second.sent)).toEqual([null]);
  });

  test("a restart reads on the turn the holder's process still runs", async () => {
    const first = setup();
    await first.service.handover(PANE, "conversation");
    await settle();
    await first.service.send(PANE, { text: "work", uuid: "u1" });
    first.service.dispose();
    // The holder's process went on: what the runtime before read is
    // replayed (two lines), then the rest comes live.
    const running = fakeClaudeProcess({ respond: answerInterrupts });
    running.process.replayed = 2;
    running.push({ type: "system", subtype: "status", status: "requesting" });
    running.push({
      type: "control_request",
      request_id: "perm-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls" },
      },
    });
    const asked: string[] = [];
    const second = setup(first.store, {
      carriedQueueDelayMs: 0,
      ask: async (_pane, prompt) => {
        asked.push(prompt.tool);
        return "allow";
      },
    });
    second.spawner.running.push(running);
    const ws = { name: "w" };
    second.service.subscribe(ws, PANE);
    heldPane(second.fake);
    second.startHolder();
    await Bun.sleep(5);
    await settle();
    expect(second.spawner.spawned).toHaveLength(0);
    expect(second.service.state(PANE)).toMatchObject({
      status: "working",
      interrupted: null,
    });
    // The prompt still open is asked again, once, and answered.
    expect(asked).toEqual(["Bash"]);
    expect(running.written).toEqual([
      expect.objectContaining({
        type: "control_response",
        response: expect.objectContaining({ request_id: "perm-1" }),
      }),
    ]);
    // Nothing replayed reached the browser: its state once it was read,
    // then the prompt asked and answered.
    expect(
      second.sent.map(([, envelope]) =>
        envelope.data.type === "status" ? envelope.data.status : envelope.event,
      ),
    ).toEqual(["idle", "working", "blocked", "working"]);
    running.push(RESULT);
    await settle();
    expect(second.store.get(PANE)?.turn_started_at).toBeUndefined();
    expect(second.service.state(PANE).status).toBe("idle");
  });

  test("a holder back late after a restart is read then, its turn not cut short", async () => {
    const first = setup();
    await first.service.handover(PANE, "conversation");
    await settle();
    await first.service.send(PANE, { text: "work", uuid: "u1" });
    first.service.dispose();
    const running = fakeClaudeProcess({ respond: answerInterrupts });
    running.process.replayed = 1;
    running.push({ type: "system", subtype: "status", status: "requesting" });
    const second = setup(first.store, { carriedQueueDelayMs: 0 });
    second.spawner.running.push(running);
    heldPane(second.fake);
    // The SSH link is slow to come back: the first attempt gives up.
    await Bun.sleep(5);
    await settle(200);
    expect(second.service.state(PANE)).toMatchObject({
      status: "stopped",
      interrupted: null,
    });
    expect(second.store.get(PANE)?.turn_started_at).toEqual(expect.any(String));
    // Its first poll reads what it runs.
    second.startHolder();
    await settle();
    expect(second.spawner.spawned).toHaveLength(0);
    expect(second.service.state(PANE)).toMatchObject({
      status: "working",
      interrupted: null,
    });
    running.push(RESULT);
    await settle();
    expect(second.store.get(PANE)?.turn_started_at).toBeUndefined();
  });

  test("speech clears the notice, a spoken stop does not", async () => {
    const first = setup();
    await first.service.handover(PANE, "conversation");
    await settle();
    await first.service.send(PANE, { text: "work" });
    first.service.dispose();
    const second = setup(first.store, { carriedQueueDelayMs: 0 });
    heldPane(second.fake);
    second.startHolder();
    await Bun.sleep(5);
    await settle();
    await second.service.voice(PANE, { text: "stop" });
    expect(second.service.state(PANE).interrupted?.reason).toBe("restart");
    await second.service.voice(PANE, { text: "go on", uuid: "v1" });
    expect(second.service.state(PANE).interrupted).toBeNull();
  });
});

describe("a holder gone with its host", () => {
  /**
   * The host rebooted: the runtime before this one owned the session, its
   * holder died, and Herdr restored the pane with an interactive claude on
   * the same session (the fake Herdr's idle claude).
   */
  async function rebooted(extra: Partial<ConversationServiceOptions<Ws>>) {
    const first = setup();
    await first.service.handover(PANE, "conversation");
    await settle();
    first.service.dispose();
    expect(first.store.get(PANE)?.phase).toBe("conversation");
    return setup(first.store, extra);
  }

  test("falls back to the terminal, and stays there until the user switches", async () => {
    const second = await rebooted({ carriedQueueDelayMs: 0 });
    const ws = { name: "w" };
    second.service.subscribe(ws, PANE);
    await eventually(() => second.store.get(PANE) === null);
    await Bun.sleep(5);
    // Nothing moves it back by itself, whatever a browser shows.
    expect(second.fake.calls.some((call) => call[0] === "prompt")).toBe(false);
    expect(second.spawner.spawned).toHaveLength(0);
    expect(second.service.state(PANE).phase).toBe("terminal");
    // The user's switch takes it over, through the usual handover: /exit
    // first, then the holder, and only then a headless claude.
    expect(await second.service.handover(PANE, "conversation")).toMatchObject({
      ok: true,
    });
    await eventually(
      () =>
        second.service.state(PANE).phase === "conversation" &&
        second.spawner.spawned.length === 1,
    );
    const prompts = second.fake.calls.filter((call) => call[0] === "prompt");
    expect(prompts).toEqual([["prompt", PANE, "/exit"]]);
    expect(second.fake.live.has(second.fake.claudePid)).toBe(false);
    const phases = second.sent
      .filter(([, envelope]) => envelope.event === "agent_chat.lease")
      .map(([, envelope]) => (envelope.data as { phase: string }).phase);
    expect(phases.slice(0, 3)).toEqual([
      "terminal",
      "to_conversation",
      "conversation",
    ]);
  });

  test("a message sent meanwhile waits for the user's switch, then goes to the new process", async () => {
    const second = await rebooted({ carriedQueueDelayMs: 60_000 });
    second.service.subscribe({ name: "w" }, PANE);
    // Sent before anything noticed the holder is gone.
    expect(
      await second.service.send(PANE, { text: "hello", uuid: "m1" }),
    ).toMatchObject({ id: "m1" });
    await eventually(() => second.store.get(PANE) === null);
    await Bun.sleep(5);
    // Kept, for conversation mode: never typed into the terminal.
    expect(second.service.state(PANE)).toMatchObject({
      owner: "terminal",
      queue: [expect.objectContaining({ id: "m1" })],
    });
    expect(second.spawner.spawned).toHaveLength(0);
    await second.service.handover(PANE, "conversation");
    await eventually(() => second.spawner.spawned.length === 1);
    await eventually(
      () => userTexts(second.spawner.spawned[0]!.fake).length === 1,
    );
    expect(userTexts(second.spawner.spawned[0]!.fake)).toEqual(["hello"]);
    expect(second.service.state(PANE)).toMatchObject({
      phase: "conversation",
      queue: [],
    });
    // Never typed into the TUI: only /exit and the holder's command.
    expect(
      second.fake.calls.filter(
        (call) => call[0] === "prompt" || call[0] === "sendText",
      ),
    ).toEqual([
      ["prompt", PANE, "/exit"],
      ["sendText", PANE, `hold ${second.fake.sessionId}\r`],
    ]);
  });

  test("a pane restored as a shell keeps the message until claude runs and the user switches", async () => {
    const second = await rebooted({ carriedQueueDelayMs: 60_000 });
    second.fake.live.delete(second.fake.claudePid);
    second.fake.pane.agent = null;
    second.fake.pane.process = {
      shell_pid: 800,
      foreground_process_group_id: 800,
      foreground_processes: [{ pid: 800, argv: ["fish"] }],
    };
    second.service.subscribe({ name: "w" }, PANE);
    expect(
      await second.service.send(PANE, { text: "later", uuid: "m2" }),
    ).toEqual({ status: "queued", id: "m2" });
    expect(second.service.state(PANE)).toMatchObject({
      owner: "terminal",
      queue: [expect.objectContaining({ id: "m2" })],
    });
    expect(second.spawner.spawned).toHaveLength(0);
    // The user starts claude in the pane: it stays in the terminal...
    second.fake.resumed(second.fake.sessionId, second.fake.claudePid);
    await Bun.sleep(20);
    expect(second.spawner.spawned).toHaveLength(0);
    // ...until the user switches it.
    await second.service.handover(PANE, "conversation");
    await eventually(() => second.spawner.spawned.length === 1);
    await eventually(
      () => userTexts(second.spawner.spawned[0]!.fake).length === 1,
    );
    expect(userTexts(second.spawner.spawned[0]!.fake)).toEqual(["later"]);
  });

  test("a holder still in the pane, or a process still on the session, keeps the lease", async () => {
    const second = await rebooted({ carriedQueueDelayMs: 60_000 });
    // A holder Herdr still shows (a slow link): it may come back.
    heldPane(second.fake);
    await second.service.sweep();
    await Bun.sleep(5);
    expect(second.store.get(PANE)?.phase).toBe("conversation");
    // claude in the pane, but a headless one still works on the session.
    second.fake.resumed();
    second.fake.probe.running.add(second.fake.sessionId);
    await second.service.sweep();
    expect(second.store.get(PANE)?.phase).toBe("conversation");
    // The host cannot say.
    second.fake.probe.running.clear();
    second.fake.probe.fails = true;
    await second.service.sweep();
    expect(second.store.get(PANE)?.phase).toBe("conversation");
    second.fake.probe.fails = false;
    await second.service.sweep();
    expect(second.store.get(PANE)).toBeNull();
  });

  test("a holder dying under a running Roamgate is noticed by the next sweep", async () => {
    const { service, fake, spawner, store, holderAborts, clock } = setup();
    service.subscribe({ name: "w" }, PANE);
    await service.handover(PANE, "conversation");
    await settle();
    spawner.spawned[0]!.fake.exit(0);
    await settle();
    // The holder dies; Herdr restores claude in the pane.
    holderAborts[0]!.abort();
    await clock.sleep(10_000);
    fake.resumed(fake.sessionId, fake.claudePid);
    await service.sweep();
    // The terminal has it, and keeps it until the user switches again.
    await eventually(() => store.get(PANE) === null);
    await settle();
    expect(spawner.spawned).toHaveLength(1);
    await service.handover(PANE, "conversation");
    await eventually(
      () =>
        spawner.spawned.length === 2 &&
        store.get(PANE)?.phase === "conversation",
    );
    expect(
      fake.calls.filter((call) => call[0] === "prompt" && call[2] === "/exit"),
    ).toHaveLength(2);
  });
});

describe("the holder's requests, the parked queue and the owned panes", () => {
  test("messages parked while the terminal has the session can be edited and taken back", async () => {
    const first = setup();
    await first.service.handover(PANE, "conversation");
    await settle();
    first.service.dispose();
    const second = setup(first.store, { carriedQueueDelayMs: 60_000 });
    second.fake.live.delete(second.fake.claudePid);
    second.fake.pane.agent = null;
    second.fake.pane.process = {
      shell_pid: 800,
      foreground_process_group_id: 800,
      foreground_processes: [{ pid: 800, argv: ["fish"] }],
    };
    const ws = { name: "w" };
    second.service.subscribe(ws, PANE);
    expect(
      await second.service.send(PANE, { text: "first", uuid: "m1" }),
    ).toEqual({ status: "queued", id: "m1" });
    expect(second.service.editQueued(PANE, "m1", " changed ")).toBe(true);
    expect(second.service.editQueued(PANE, "nope", "x")).toBe(false);
    expect(second.service.state(PANE).queue).toEqual([
      expect.objectContaining({ id: "m1", text: "changed" }),
    ]);
    expect(second.service.removeQueued(PANE, "nope")).toBeNull();
    expect(second.service.removeQueued(PANE, "m1")).toMatchObject({
      id: "m1",
      text: "changed",
    });
    expect(second.service.state(PANE).queue).toEqual([]);
    const queues = second.sent
      .filter(([, envelope]) => envelope.event === "agent_chat.queue")
      .map(([, envelope]) =>
        (envelope.data as { queue: { text: string }[] }).queue.map(
          (item) => item.text,
        ),
      );
    expect(queues.slice(-2)).toEqual([["changed"], []]);
  });

  test("a holder polling a pane whose lease says terminal is told to resume", async () => {
    const { service, store, fake } = setup();
    await service.handover(PANE, "conversation");
    await settle();
    store.set({ ...store.get(PANE)!, phase: "terminal" });
    expect(
      await service.holder.hold({
        paneId: PANE,
        sessionId: fake.sessionId,
        signal: new AbortController().signal,
      }),
    ).toEqual({ action: "resume", session_id: fake.sessionId, cwd: fake.cwd });
  });

  test("a holder this runtime never knew keeps holding until its poll is cut", async () => {
    const { service } = setup(undefined, { holdPollMs: 60_000 });
    const controller = new AbortController();
    const reply = service.holder.hold({
      paneId: "w9:p9",
      sessionId: "s9",
      signal: controller.signal,
    });
    controller.abort();
    expect(await reply).toEqual({ action: "hold", session_id: "s9" });
  });

  test("a holder's log for a pane with no channel is not taken", () => {
    const { service } = setup();
    expect(
      service.holder.output({
        paneId: PANE,
        holderId: "h1",
        offset: 0,
        end: 3,
        data: "abc",
      }),
    ).toEqual({});
  });

  test("without a spawner of its own, a start needs a holder that runs it", async () => {
    const { service, spawner } = setup(undefined, { spawn: undefined });
    await service.handover(PANE, "conversation");
    await eventually(() => service.state(PANE).lost !== undefined);
    expect(service.state(PANE).lost?.reason).toMatch(
      /pane holder is from an older Roamgate/,
    );
    expect(spawner.spawned).toHaveLength(0);
  });

  test("cancelling a switch with no exit waited for clears nothing", () => {
    const { service } = setup();
    expect(service.cancelHandover(PANE)).toEqual({ ok: true, cleared: false });
  });

  test("the panes conversation mode holds, as Herdr would show them", async () => {
    const { service, fake, spawner } = setup();
    expect(service.ownedPanes()).toEqual([]);
    await service.handover(PANE, "conversation");
    await settle();
    expect(service.ownedPanes()).toEqual([
      {
        pane_id: PANE,
        session_id: fake.sessionId,
        cwd: fake.cwd,
        phase: "conversation",
        agent: "claude",
        agent_status: "idle",
      },
    ]);
    await service.send(PANE, { text: "work" });
    await settle();
    expect(service.ownedPanes()[0]?.agent_status).toBe("working");
    spawner.spawned[0]!.fake.push(RESULT);
    await settle();
    expect(service.ownedPanes()[0]?.agent_status).toBe("idle");
    expect(service.handingOver()).toBe(false);
  });
});

describe("a conversation process that cannot be read", () => {
  const HOLDER = "d".repeat(32);
  const holderStatus = (extra: Partial<HolderStatus> = {}): HolderStatus => ({
    holderId: HOLDER,
    applied: 0,
    child: 1,
    childAlive: true,
    childPid: 77,
    logSize: 9_000_000,
    epochOffset: 0,
    ...extra,
  });

  test("shows as lost, not idle, and Recover resumes it with the queue, once", async () => {
    const first = setup();
    await first.service.handover(PANE, "conversation");
    await settle();
    first.service.dispose();
    const lease = first.store.get(PANE)!;
    first.store.set({
      ...lease,
      queue: [
        {
          id: "q1",
          text: "OK, open the PR",
          images: [],
          queued_at: new Date().toISOString(),
        },
      ],
    });
    // Its holder polls, but its log never comes through (a chunk the
    // socket refuses, say): every attach gives up.
    let readable = false;
    const spawner = fakeSpawner();
    const second = setup(first.store, {
      carriedQueueDelayMs: 0,
      holdPollMs: 20,
      spawn: async (options) => {
        if (options.attachOnly && !readable)
          throw new Error("The pane holder's log could not be read");
        return spawner.spawn(options);
      },
    });
    const ws = { name: "w" };
    second.service.subscribe(ws, PANE);
    heldPane(second.fake);
    const polls = new AbortController();
    second.holderAborts.push(polls);
    const poll = (status: HolderStatus) =>
      second.service.holder.hold({
        paneId: PANE,
        sessionId: lease.session_id,
        signal: polls.signal,
        status,
      });
    void poll(holderStatus());
    await eventually(() => !!second.service.state(PANE).lost);
    expect(second.service.state(PANE)).toMatchObject({
      phase: "conversation",
      lost: { reason: "The pane holder's log could not be read" },
      queue: [expect.objectContaining({ id: "q1" })],
    });
    expect(
      second.sent.some(
        ([, envelope]) =>
          envelope.event === "agent_chat.lost" &&
          (envelope.data as { lost: unknown }).lost !== null,
      ),
    ).toBe(true);
    expect(spawner.spawned).toHaveLength(0);
    // Recover: the holder is told to end its child...
    readable = true;
    const recovering = handleAgentChatRpc(
      second.service,
      null,
      ws,
      "agent_chat.recover",
      { pane_id: PANE },
    );
    const reply = await poll(holderStatus());
    expect(reply).toMatchObject({
      commands: [expect.objectContaining({ op: "kill", child: 1 })],
    });
    // ...it has, and the log is read on from its end.
    const seq = (reply as unknown as { commands: { seq: number }[] })
      .commands[0]!.seq;
    const after = await poll(
      holderStatus({ applied: seq, childAlive: false, logSize: 9_000_200 }),
    );
    expect(after).toMatchObject({ output_from: 9_000_200 });
    expect(await recovering).toEqual({ ok: true });
    // A new process resumes the session with the queued message, once.
    await eventually(() => spawner.spawned.length === 1);
    await eventually(() => userTexts(spawner.spawned[0]!.fake).length === 1);
    expect(userTexts(spawner.spawned[0]!.fake)).toEqual(["OK, open the PR"]);
    expect(second.service.state(PANE).lost).toBeUndefined();
    expect(
      second.sent
        .filter(([, envelope]) => envelope.event === "agent_chat.lost")
        .at(-1)?.[1].data,
    ).toMatchObject({ lost: null });
  });

  test("Recover with a holder that cannot end its child restarts Claude through the terminal, the queue sent once", async () => {
    const first = setup();
    await first.service.handover(PANE, "conversation");
    await settle();
    first.service.dispose();
    const lease = first.store.get(PANE)!;
    first.store.set({
      ...lease,
      turn_started_at: new Date().toISOString(),
      queue: [
        {
          id: "q1",
          text: "What is going on?",
          images: [],
          queued_at: new Date().toISOString(),
        },
      ],
    });
    const spawner = fakeSpawner();
    let resumed = false;
    const second = setup(first.store, {
      carriedQueueDelayMs: 0,
      holdPollMs: 20,
      recoverWaitMs: 30,
      recoverRetryMs: 5,
      spawn: async (options) => {
        // The old holder's child cannot be read (its reader stopped).
        if (options.attachOnly && !resumed)
          throw new Error("The pane holder's log could not be read");
        return spawner.spawn(options);
      },
    });
    const ws = { name: "w" };
    second.service.subscribe(ws, PANE);
    heldPane(second.fake);
    const polls = new AbortController();
    const poll = (status: HolderStatus) =>
      second.service.holder.hold({
        paneId: PANE,
        sessionId: lease.session_id,
        signal: polls.signal,
        status,
      });
    void poll(holderStatus());
    await eventually(() => !!second.service.state(PANE).lost);
    const recovering = second.service.recover(PANE);
    // It is told to end its child, but keeps saying it runs (its reader
    // died, so nothing clears it), until it is told to resume claude.
    const replies: unknown[] = [];
    void (async () => {
      while (!resumed) {
        const reply = (await poll(holderStatus())) as { action?: string };
        replies.push(reply);
        await Bun.sleep(1);
        if (reply.action === "resume") {
          resumed = true;
          polls.abort();
          second.fake.resumed(second.fake.sessionId, second.fake.claudePid);
        }
      }
    })();
    expect(await recovering).toEqual({ ok: true });
    expect(resumed).toBe(true);
    expect(replies[0]).toMatchObject({
      commands: [expect.objectContaining({ op: "kill", child: 1 })],
    });
    // Taken over again (/exit, a new holder), and a new process resumes
    // the session with the queued message, once.
    expect(second.store.get(PANE)?.phase).toBe("conversation");
    await eventually(() => spawner.spawned.length === 1);
    await eventually(() => userTexts(spawner.spawned[0]!.fake).length === 1);
    expect(userTexts(spawner.spawned[0]!.fake)).toEqual(["What is going on?"]);
    expect(second.service.state(PANE).lost).toBeUndefined();
  });

  test("Recover says why when the holder cannot end a child that still runs", async () => {
    const first = setup();
    await first.service.handover(PANE, "conversation");
    await settle();
    first.service.dispose();
    const lease = first.store.get(PANE)!;
    const second = setup(first.store, {
      carriedQueueDelayMs: 0,
      holdPollMs: 20,
      recoverWaitMs: 30,
      spawn: async () => {
        throw new Error("The pane holder's log could not be read");
      },
    });
    second.service.subscribe({ name: "w" }, PANE);
    heldPane(second.fake);
    second.fake.probe.running.add(lease.session_id);
    const polls = new AbortController();
    second.holderAborts.push(polls);
    const poll = () =>
      second.service.holder.hold({
        paneId: PANE,
        sessionId: lease.session_id,
        signal: polls.signal,
        status: holderStatus(),
      });
    void poll();
    await eventually(() => !!second.service.state(PANE).lost);
    const recovering = second.service.recover(PANE);
    let done = false;
    void recovering.finally(() => {
      done = true;
    });
    while (!done) {
      await poll();
      await Bun.sleep(1);
    }
    const result = await recovering;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(
      /still runs on the session; end it on the host/,
    );
    // The lease stays, and the chat says why.
    expect(second.store.get(PANE)?.phase).toBe("conversation");
    expect(second.service.state(PANE).lost?.reason).toMatch(
      /end it on the host/,
    );
  });

  test("a holder gone mid-question under a running Roamgate gives the terminal the session, the queue kept", async () => {
    const first = setup();
    await first.service.handover(PANE, "conversation");
    await settle();
    first.service.dispose();
    const lease = first.store.get(PANE)!;
    const spawner = fakeSpawner();
    const second = setup(first.store, {
      carriedQueueDelayMs: 0,
      holdPollMs: 20,
      holderWatchMs: 5,
      // The question waits for good: nobody answers it.
      ask: () => new Promise(() => {}),
      spawn: (options) => spawner.spawn(options),
    });
    second.service.subscribe({ name: "w" }, PANE);
    heldPane(second.fake);
    const polls = new AbortController();
    void second.service.holder.hold({
      paneId: PANE,
      sessionId: lease.session_id,
      signal: polls.signal,
      status: holderStatus(),
    });
    await settle();
    await second.service.send(PANE, { text: "clean up", uuid: "m1" });
    await eventually(() => spawner.spawned.length === 1);
    const proc = spawner.spawned[0]!.fake;
    await settle();
    proc.push({
      type: "control_request",
      request_id: "r1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Delete?",
              options: [{ label: "Yes" }],
              multiSelect: false,
            },
          ],
        },
      },
    });
    await settle();
    await second.service.send(PANE, { text: "now iga185", uuid: "m2" });
    expect(second.service.state(PANE)).toMatchObject({
      status: "blocked",
      queue: [expect.objectContaining({ id: "m2" })],
    });
    // The holder is gone (another Roamgate told it to resume): claude runs
    // in the pane, and the process it ran went with it.
    polls.abort();
    second.fake.resumed(second.fake.sessionId, second.fake.claudePid);
    await second.clock.sleep(60_000);
    await eventually(() => second.store.get(PANE) === null);
    expect(second.service.state(PANE)).toMatchObject({
      owner: "terminal",
      queue: [expect.objectContaining({ id: "m2", text: "now iga185" })],
    });
    // Nothing was typed into the pane, and nothing answered the question.
    expect(
      second.fake.calls.filter(
        (call) => call[0] === "prompt" || call[0] === "sendText",
      ),
    ).toEqual([]);
    expect(proc.written.filter((m) => m.type === "control_response")).toEqual(
      [],
    );
  });

  test("Recover is refused while the terminal owns the session, or with no holder log to give up", async () => {
    const { service } = setup();
    expect(await service.recover(PANE)).toEqual({
      ok: false,
      reason: "Conversation mode does not own this session",
    });
    await service.handover(PANE, "conversation");
    await settle();
    // The holder polls without a log (an older one): nothing to recover.
    expect(await service.recover(PANE)).toEqual({
      ok: false,
      reason: "The pane holder is not connected",
    });
  });
});

describe("leases on disk", () => {
  // A restart: what this process knew is gone, the file is read again.
  async function restart() {
    await flushLeaseFiles();
    forgetLeaseFiles();
  }

  test("survive a restart, per connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roamgate-leases-"));
    try {
      const file = join(dir, "leases.json");
      const one = createLeaseStore({ connectionId: "c1", file });
      const two = createLeaseStore({ connectionId: "c2", file });
      one.set({
        pane_id: "p",
        session_id: "s1",
        cwd: "/x",
        phase: "conversation",
      });
      two.set({
        pane_id: "p",
        session_id: "s2",
        cwd: "/y",
        phase: "conversation",
      });
      await restart();
      const again = createLeaseStore({ connectionId: "c1", file });
      expect(again.get("p")).toMatchObject({
        connection_id: "c1",
        session_id: "s1",
        owner: "conversation",
      });
      again.delete("p");
      await restart();
      expect(
        createLeaseStore({ connectionId: "c1", file }).get("p"),
      ).toBeNull();
      expect(
        createLeaseStore({ connectionId: "c2", file }).get("p")?.session_id,
      ).toBe("s2");
    } finally {
      await restart();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a burst of saves is written once, off the event loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roamgate-leases-"));
    try {
      const file = join(dir, "leases.json");
      const store = createLeaseStore({ connectionId: "c1", file });
      for (let offset = 0; offset < 50; offset++)
        store.set({
          pane_id: `p${offset % 5}`,
          session_id: `s${offset}`,
          cwd: "/x",
          phase: "conversation",
        });
      // Nothing is written in the caller's turn.
      expect(existsSync(file)).toBe(false);
      await flushLeaseFiles();
      const written = JSON.parse(readFileSync(file, "utf8")) as {
        leases: { pane_id: string; session_id: string }[];
      };
      expect(written.leases.map((lease) => lease.session_id).sort()).toEqual([
        "s45",
        "s46",
        "s47",
        "s48",
        "s49",
      ]);
      // A change while a write is under way goes in the next one.
      store.set({
        pane_id: "p0",
        session_id: "late",
        cwd: "/x",
        phase: "conversation",
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
      store.set({
        pane_id: "p1",
        session_id: "later",
        cwd: "/x",
        phase: "conversation",
      });
      await flushLeaseFiles();
      await restart();
      const again = createLeaseStore({ connectionId: "c1", file });
      expect(again.get("p0")?.session_id).toBe("late");
      expect(again.get("p1")?.session_id).toBe("later");
    } finally {
      await restart();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rewinding in conversation mode", () => {
  const withRewinds = () =>
    fakeSpawner(() =>
      fakeClaudeProcess({ exitOnEnd: true, respond: answerRewinds() }),
    );

  test("refused while the terminal owns the session: it rewinds itself", async () => {
    const { service } = setup();
    expect(
      await service.rewind(PANE, { uuid: "u1", mode: "conversation" }),
    ).toEqual({ ok: false, reason: "The terminal owns this session" });
  });

  test("the headless process rewinds; lease and holder stay, no second writer", async () => {
    const spawner = withRewinds();
    const { service, holderPolls } = setup(undefined, { spawn: spawner.spawn });
    await service.handover(PANE, "conversation");
    await settle();
    const lease = service.state(PANE);
    const result = await handleAgentChatRpc(
      service,
      null,
      { name: "w" },
      "agent_chat.rewind",
      { pane_id: PANE, uuid: "u2", last_seen: "u3", mode: "both" },
    );
    expect(result).toEqual({
      ok: true,
      prefill: "the message",
      files: ["/work/a.txt"],
      code: "restored",
    });
    expect(spawner.spawned).toHaveLength(1);
    expect(spawner.alive()).toHaveLength(1);
    const after = service.state(PANE);
    expect(after.owner).toBe("conversation");
    expect(after.session_id).toBe(lease.session_id);
    expect(holderPolls).toHaveLength(1);
    expect(
      spawner.spawned[0]!.fake.written.filter(
        (message) => message.type === "control_request",
      ).map((message) => (message.request as { subtype: string }).subtype),
    ).toEqual(["rewind_files", "rewind_conversation", "rewind_files"]);
  });

  test("refused during a turn; a hand-back is refused during a rewind", async () => {
    const spawner = withRewinds();
    const { service } = setup(undefined, { spawn: spawner.spawn });
    await service.handover(PANE, "conversation");
    await settle();
    await service.send(PANE, { text: "work" });
    expect(
      await service.rewind(PANE, { uuid: "u1", mode: "conversation" }),
    ).toEqual({ ok: false, reason: "A turn is running; stop it first" });
    spawner.spawned[0]!.fake.push(RESULT);
    await settle();
    const rewound = service.rewind(PANE, { uuid: "u1", mode: "conversation" });
    expect(await service.holder.handback({ paneId: PANE })).toMatchObject({
      action: "refused",
    });
    expect((await rewound).ok).toBe(true);
    expect(service.state(PANE).owner).toBe("conversation");
  });

  test("the check reads the pane's transcript, whoever owns it", async () => {
    const transcript = [
      { type: "user", uuid: "u1", message: { role: "user", content: "a" } },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "MultiEdit",
              input: { file_path: "/work/a.txt" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "a1",
        message: { role: "user", content: "b" },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const panes: string[] = [];
    const spawner = withRewinds();
    const { service } = setup(undefined, {
      spawn: spawner.spawn,
      readTranscript: async (paneId) => {
        panes.push(paneId);
        return transcript;
      },
    });
    const ws = { name: "w" };
    const check = (uuid: string) =>
      handleAgentChatRpc(service, null, ws, "agent_chat.rewind.check", {
        pane_id: PANE,
        uuid,
      });
    expect(await check("u1")).toEqual({
      code: "no_checkpoint",
      files: ["/work/a.txt"],
    });
    await service.handover(PANE, "conversation");
    await settle();
    const started = spawner.spawned.length;
    expect(await check("u2")).toEqual({ code: "none" });
    expect(panes).toEqual([PANE, PANE]);
    // Asking starts nothing and asks the process nothing.
    expect(spawner.spawned).toHaveLength(started);
    for (const each of spawner.spawned)
      expect(
        each.fake.written.filter(
          (message) => message.type === "control_request",
        ),
      ).toHaveLength(0);
    await expect(
      handleAgentChatRpc(service, null, ws, "agent_chat.rewind.check", {
        pane_id: PANE,
      }),
    ).rejects.toThrow(/uuid/);
  });

  test("the RPC validates its mode and message", async () => {
    const { service } = setup();
    const ws = { name: "w" };
    await expect(
      handleAgentChatRpc(service, null, ws, "agent_chat.rewind", {
        pane_id: PANE,
        uuid: "u1",
        mode: "everything",
      }),
    ).rejects.toThrow(/mode/);
    await expect(
      handleAgentChatRpc(service, null, ws, "agent_chat.rewind", {
        pane_id: PANE,
        mode: "code",
      }),
    ).rejects.toThrow(/uuid/);
  });
});

describe("agent_chat RPCs", () => {
  test("dispatch and validate", async () => {
    const { service } = setup();
    const ws = { name: "w" };
    expect(isAgentChatMethod("agent_chat.send")).toBe(true);
    expect(isAgentChatMethod("agent_history.get")).toBe(false);
    expect(
      await handleAgentChatRpc(service, null, ws, "agent_chat.state", {
        pane_id: PANE,
      }),
    ).toMatchObject({ owner: "terminal" });
    await expect(
      handleAgentChatRpc(service, null, ws, "agent_chat.handover", {
        pane_id: PANE,
        to: "nowhere",
      }),
    ).rejects.toThrow(/conversation or terminal/);
    await expect(
      handleAgentChatRpc(service, null, ws, "agent_chat.send", {}),
    ).rejects.toThrow(/pane_id/);
    expect(
      await handleAgentChatRpc(service, null, ws, "agent_chat.handover", {
        pane_id: PANE,
        to: "conversation",
      }),
    ).toMatchObject({ ok: true });
    await settle();
    expect(
      await handleAgentChatRpc(service, null, ws, "agent_chat.voice", {
        pane_id: PANE,
        text: "hello",
      }),
    ).toMatchObject({ action: "sent" });
  });
});

describe("only the user's switch moves a session", () => {
  const rpc = (
    service: ReturnType<typeof setup>["service"],
    ws: Ws,
    method: string,
    params: Record<string, unknown>,
  ) =>
    handleAgentChatRpc(service, null, ws, method, { pane_id: PANE, ...params });

  test("an automatic request from an older page is refused, the user's switch goes", async () => {
    const { service } = setup();
    const phone = { name: "phone" };
    await rpc(service, phone, "agent_chat.subscribe", {});
    expect(
      await rpc(service, phone, "agent_chat.handover", {
        to: "conversation",
        auto: true,
      }),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/Only the user's switch/),
    });
    expect(service.state(PANE).phase).toBe("terminal");
    expect(
      await rpc(service, phone, "agent_chat.handover", { to: "conversation" }),
    ).toMatchObject({ ok: true });
    await settle();
    expect(service.state(PANE).phase).toBe("conversation");
    expect(
      await rpc(service, phone, "agent_chat.handover", {
        to: "terminal",
        auto: true,
      }),
    ).toMatchObject({ ok: false });
    expect(service.state(PANE).phase).toBe("conversation");
    expect(
      await rpc(service, phone, "agent_chat.handover", { to: "terminal" }),
    ).toMatchObject({ ok: true, owner: "terminal" });
  });

  test("what a browser shows is not asked any more", async () => {
    const { service } = setup();
    await expect(
      rpc(service, { name: "w" }, "agent_chat.view", { view: "chat" }),
    ).rejects.toThrow();
  });
});

describe("the session resolver", () => {
  test("sees the session conversation mode owns", async () => {
    const owned = [{ pane_id: PANE, session_id: "s1", cwd: "/w" }];
    const call = withOwnedSessions(
      async () => ({ agent: { pane_id: PANE, agent: null } }),
      () => owned,
    );
    expect(await call("agent.get", { target: PANE })).toMatchObject({
      agent: {
        agent: "claude",
        agent_session: { kind: "id", value: "s1", source: "roamgate:headless" },
        foreground_cwd: "/w",
      },
    });
    expect(await call("agent.get", { target: "other" })).toEqual({
      agent: { pane_id: PANE, agent: null },
    });
  });

  test("the holder's own claude, as Herdr sees it, does not hide the session", async () => {
    // Herdr's fallback detection of the holder's child: claude, idle, no
    // session id.
    const child = {
      pane_id: PANE,
      agent: "claude",
      agent_status: "idle",
      agent_session: null,
    };
    // What the TUI's hooks told Herdr before it exited.
    const stale = {
      ...child,
      agent_session: { source: "herdr:claude", kind: "id", value: "s1" },
    };
    // While the pane changes hands, Herdr drops the session for a few
    // seconds: unknown, or no agent at all.
    const unknown = { ...child, agent_status: "unknown" };
    const none = { pane_id: PANE, agent: null, agent_session: null };
    // Its last word on a turn the TUI ended.
    const done = { ...stale, agent_status: "done" };
    for (const phase of ["conversation", "to_terminal", undefined])
      for (const herdr of [child, stale, unknown, none, done]) {
        const owned = [
          {
            pane_id: PANE,
            session_id: "s1",
            cwd: "/w",
            agent_status: "working",
            phase,
          },
        ];
        const call = withOwnedSessions(
          async (method) => {
            if (method === "agent.get") return { agent: herdr };
            if (method === "agent.list") return { agents: [herdr] };
            return { panes: [herdr] };
          },
          () => owned,
        );
        const held = {
          pane_id: PANE,
          agent: "claude",
          agent_status: "working",
          agent_session: {
            source: "roamgate:headless",
            kind: "id",
            value: "s1",
          },
          foreground_cwd: "/w",
        };
        expect(await call("agent.get", { target: PANE })).toMatchObject({
          agent: held,
        });
        expect(await call("agent.list", {})).toMatchObject({
          agents: [held],
        });
        expect(await call("pane.list", {})).toMatchObject({ panes: [held] });
      }
  });

  test("while a takeover starts, Herdr's word on the TUI stands", async () => {
    const tui = {
      pane_id: PANE,
      agent: "claude",
      agent_status: "working",
      agent_session: { source: "herdr:claude", kind: "id", value: "s1" },
    };
    const owned = [
      {
        pane_id: PANE,
        session_id: "s1",
        cwd: "/w",
        agent_status: "working",
        phase: "to_conversation",
      },
    ];
    const call = withOwnedSessions(
      async () => ({ agent: tui }),
      () => owned,
    );
    expect(await call("agent.get", { target: PANE })).toEqual({ agent: tui });
    // Another session there is not the one being taken over.
    const other = {
      ...tui,
      agent_session: { ...tui.agent_session, value: "s2" },
    };
    const otherCall = withOwnedSessions(
      async () => ({ agent: other }),
      () => owned,
    );
    expect(await otherCall("agent.get", { target: PANE })).toMatchObject({
      agent: { agent_session: { value: "s1", source: "roamgate:headless" } },
    });
    // Herdr dropped the session as the TUI exits: the takeover's stands.
    for (const dropped of [
      { ...tui, agent_status: "unknown", agent_session: null },
      { pane_id: PANE, agent: null, agent_session: null },
    ]) {
      const droppedCall = withOwnedSessions(
        async () => ({ agent: dropped }),
        () => owned,
      );
      expect(await droppedCall("agent.get", { target: PANE })).toMatchObject({
        agent: {
          agent: "claude",
          agent_session: { value: "s1", source: "roamgate:headless" },
        },
      });
    }
  });

  test("Herdr's agent_not_found for a held pane is not an error", async () => {
    const owned = [
      { pane_id: PANE, session_id: "s1", cwd: "/w", agent_status: "working" },
    ];
    const call = withOwnedSessions(
      async (method) => {
        if (method === "agent.get")
          throw new Error("agent_not_found: agent target w1:p1 not found");
        if (method === "agent.list")
          return { agents: [{ pane_id: "w2:p1", agent: "codex" }] };
        return {
          panes: [
            { pane_id: PANE, agent: null, agent_status: "unknown" },
            { pane_id: "w2:p1", agent: "codex", agent_status: "idle" },
          ],
        };
      },
      () => owned,
    );
    expect(await call("agent.get", { target: PANE })).toMatchObject({
      agent: { agent: "claude", agent_status: "working" },
    });
    await expect(call("agent.get", { target: "w3:p1" })).rejects.toThrow(
      /agent_not_found/,
    );
    expect(await call("agent.list", {})).toEqual({
      agents: [
        { pane_id: "w2:p1", agent: "codex" },
        expect.objectContaining({
          pane_id: PANE,
          agent: "claude",
          agent_status: "working",
        }),
      ],
    });
    expect(await call("pane.list", {})).toEqual({
      panes: [
        expect.objectContaining({
          pane_id: PANE,
          agent: "claude",
          agent_status: "working",
          foreground_cwd: "/w",
        }),
        { pane_id: "w2:p1", agent: "codex", agent_status: "idle" },
      ],
    });
  });
});

describe("reading conversations again after a restart", () => {
  test("a few at a time, in order, each slot given back once", async () => {
    const slot = createSlots(2);
    const started: number[] = [];
    const releases: (() => void)[] = [];
    for (const n of [1, 2, 3, 4])
      void slot().then((release) => {
        started.push(n);
        releases.push(release);
      });
    await settle();
    expect(started).toEqual([1, 2]);
    releases[0]!();
    releases[0]!();
    await settle();
    expect(started).toEqual([1, 2, 3]);
    releases[1]!();
    await settle();
    expect(started).toEqual([1, 2, 3, 4]);
  });
});

describe("a turn that hangs", () => {
  const MINUTE = 60_000;
  function stuckEvents(sent: [Ws, AgentChatEventEnvelope][]) {
    return sent
      .filter(([, envelope]) => envelope.event === "agent_chat.stuck")
      .map(([, envelope]) =>
        envelope.data.type === "stuck" ? envelope.data.stuck : 0,
      );
  }
  async function hanging(extra: Partial<ConversationServiceOptions<Ws>> = {}) {
    const context = setup(undefined, { stuckCheckMs: MINUTE, ...extra });
    const ws = { name: "w" };
    context.service.subscribe(ws, PANE);
    await context.service.handover(PANE, "conversation");
    await settle();
    await context.service.send(PANE, { text: "work" });
    await settle();
    return { ...context, proc: context.spawner.spawned[0]!.fake };
  }
  /** Moves the clock on, letting the checks it fires run. */
  async function advance(ms: number) {
    for (let left = ms; left > 0; left -= MINUTE) {
      jest.advanceTimersByTime(Math.min(MINUTE, left));
      await settle();
    }
  }

  test("nothing from Claude for 10 minutes: the chat says it seems stuck, until it says something", async () => {
    jest.useFakeTimers();
    try {
      const { service, sent, proc } = await hanging();
      const started = Date.now();
      await advance(9 * MINUTE);
      expect(service.state(PANE).stuck).toBeUndefined();
      await advance(2 * MINUTE);
      expect(service.state(PANE).stuck).toEqual({
        since: new Date(started).toISOString(),
        reason: "silent",
      });
      expect(stuckEvents(sent)).toEqual([
        { since: new Date(started).toISOString(), reason: "silent" },
      ]);
      // It comes back to life: the notice goes.
      proc.push({
        type: "assistant",
        message: { id: "m1", content: [{ type: "text", text: "here" }] },
      });
      await settle();
      expect(service.state(PANE).stuck).toBeUndefined();
      expect(stuckEvents(sent).at(-1)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a tool that runs gets longer, and a transcript that grows counts as Claude at work", async () => {
    jest.useFakeTimers();
    try {
      let transcriptAt = Date.now();
      const { service, proc } = await hanging({
        transcriptStat: async () => ({ mtimeMs: transcriptAt }),
      });
      proc.push({
        type: "assistant",
        message: {
          id: "m1",
          content: [
            { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
          ],
        },
      });
      await settle();
      // A long build prints nothing until it ends: no notice at 30 min.
      await advance(30 * MINUTE);
      expect(service.state(PANE).stuck).toBeUndefined();
      // Its transcript changes (a subagent at work, say): still none.
      transcriptAt = Date.now();
      await advance(40 * MINUTE);
      expect(service.state(PANE).stuck).toBeUndefined();
      // Nothing at all for 45 minutes while the tool runs: stuck.
      await advance(6 * MINUTE);
      expect(service.state(PANE).stuck).toEqual({
        since: new Date(transcriptAt).toISOString(),
        reason: "silent",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test("a question waiting for the user, or a turn over, is no hang", async () => {
    jest.useFakeTimers();
    try {
      const { service, proc } = await hanging();
      proc.push(RESULT);
      await settle();
      await advance(30 * MINUTE);
      expect(service.state(PANE).stuck).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test("Stop that Claude does not answer: after 10 s the chat says so, and Restart Claude is offered", async () => {
    jest.useFakeTimers();
    try {
      const { service, sent, proc } = await hanging();
      // Its request hangs: nothing answers the interrupt.
      proc.process.write = () => {};
      const stopping = service.interrupt(PANE);
      await settle();
      jest.advanceTimersByTime(50);
      await settle();
      expect(await stopping).toBe(false);
      jest.advanceTimersByTime(5000);
      await settle();
      expect(service.state(PANE).stuck).toBeUndefined();
      jest.advanceTimersByTime(5000);
      await settle();
      expect(service.state(PANE).stuck).toMatchObject({
        reason: "stop_unanswered",
      });
      expect(stuckEvents(sent)).toEqual([
        expect.objectContaining({ reason: "stop_unanswered" }),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("Stop that Claude answers leaves no notice", async () => {
    jest.useFakeTimers();
    try {
      const { service } = await hanging();
      expect(await service.interrupt(PANE)).toBe(true);
      jest.advanceTimersByTime(20_000);
      await settle();
      expect(service.state(PANE).stuck).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("a claude started by hand in a pane", () => {
  test("conversation mode takes it once Claude is up: /exit, then the holder in that pane", async () => {
    // Tries a millisecond apart, in real time: Herdr catches up meanwhile.
    const { service, fake } = setup(undefined, {
      autoStart: { sleep: () => Bun.sleep(1) },
    });
    // Herdr has not seen it yet.
    const agent = fake.pane.agent;
    fake.pane.agent = null;
    expect(service.autoStart(PANE, fake.sessionId)).toEqual({ ok: true });
    await settle();
    expect(service.state(PANE).phase).toBe("terminal");
    fake.pane.agent = agent;
    await eventually(() => service.state(PANE).phase === "conversation");
    expect(service.state(PANE).session_id).toBe(fake.sessionId);
    const actions = fake.calls
      .filter((call) => call[0] === "prompt" || call[0] === "sendText")
      .map((call) => call.slice(2));
    expect(actions).toEqual([["/exit"], [`hold ${fake.sessionId}\r`]]);
    // Taken already: a second start changes nothing.
    expect(service.autoStart(PANE, fake.sessionId)).toMatchObject({
      ok: false,
    });
  });

  test("a claude with something typed in its prompt box stays in the terminal", async () => {
    const clock = virtualClock();
    const { service, fake } = setup(undefined, {
      autoStart: { sleep: clock.sleep, now: clock.now },
    });
    fake.pane.screen = fake.pane.screen.replace("❯ ", "❯ half a thought");
    expect(service.autoStart(PANE, fake.sessionId)).toEqual({ ok: true });
    for (let index = 0; index < 20; index += 1) await settle();
    expect(service.state(PANE).phase).toBe("terminal");
    expect(fake.calls.some((call) => call[0] === "prompt")).toBe(false);
  });

  test("the claude a hand-back resumes is not taken again", async () => {
    const { service, fake, startHolder } = setup();
    await service.handover(PANE, "conversation");
    await settle();
    heldPane(fake);
    startHolder();
    await settle();
    const back = await service.handover(PANE, "terminal");
    expect(back.ok).toBe(true);
    fake.resumed();
    expect(service.autoStart(PANE, fake.sessionId)).toEqual({
      ok: false,
      reason: "This pane's session just went back to the terminal",
    });
  });
});

describe("an Anthropic API key in the pane's environment", () => {
  const HOLDER = "e".repeat(32);
  const holderStatus = (apiKey?: HolderStatus["apiKey"]): HolderStatus => ({
    holderId: HOLDER,
    applied: 0,
    child: 0,
    childAlive: false,
    childPid: 0,
    logSize: 0,
    epochOffset: 0,
    ...(apiKey ? { apiKey } : {}),
  });
  const questionEvents = (sent: [Ws, AgentChatEventEnvelope][]) =>
    sent
      .filter(
        ([, envelope]) => envelope.event === "agent_chat.api_key_question",
      )
      .map(
        ([, envelope]) =>
          (envelope.data as { api_key_question?: unknown }).api_key_question ??
          null,
      );

  for (const [apiKey, why] of [
    ["none", "no key"],
    ["approved", "the key approved in Claude Code"],
    ["rejected", "the key rejected in Claude Code"],
    [undefined, "a holder too old to say"],
  ] as const)
    test(`${why}: Claude starts at once, nothing asked`, async () => {
      const { service, spawner, sent } = setup(
        undefined,
        {},
        { status: holderStatus(apiKey) },
      );
      service.subscribe({ name: "w" }, PANE);
      expect((await service.handover(PANE, "conversation")).ok).toBe(true);
      await eventually(() => spawner.spawned.length === 1);
      expect(spawner.spawned[0]!.options.apiKeyAnswer).toBeUndefined();
      expect(service.state(PANE).api_key_question).toBeUndefined();
      expect(questionEvents(sent)).toEqual([]);
    });

  for (const [use, answer] of [
    ["login", "reject"],
    ["api_key", "approve"],
  ] as const)
    test(`no answer yet: the chat asks, messages wait, and "${use}" goes to the start for the holder to file`, async () => {
      const { service, spawner, sent } = setup(
        undefined,
        {},
        { status: holderStatus("new") },
      );
      const ws = { name: "w" };
      service.subscribe(ws, PANE);
      expect((await service.handover(PANE, "conversation")).ok).toBe(true);
      await eventually(() => !!service.state(PANE).api_key_question);
      expect(questionEvents(sent)).toEqual([{ asked_at: expect.any(String) }]);
      // Nothing starts until the user says; what is sent waits.
      expect(await service.send(PANE, { text: "hello", uuid: "m1" })).toEqual({
        status: "queued",
        id: "m1",
      });
      await settle();
      expect(spawner.spawned).toHaveLength(0);
      expect(service.state(PANE)).toMatchObject({
        status: "starting",
        queue: [expect.objectContaining({ id: "m1" })],
      });
      expect(
        await handleAgentChatRpc(
          service,
          null,
          ws,
          "agent_chat.api_key.answer",
          {
            pane_id: PANE,
            use,
          },
        ),
      ).toEqual({ ok: true });
      await eventually(() => spawner.spawned.length === 1);
      expect(spawner.spawned[0]!.options.apiKeyAnswer).toBe(answer);
      await eventually(() => userTexts(spawner.spawned[0]!.fake).length === 1);
      expect(userTexts(spawner.spawned[0]!.fake)).toEqual(["hello"]);
      expect(service.state(PANE).api_key_question).toBeUndefined();
      expect(questionEvents(sent).at(-1)).toBeNull();
      // Answered: a second answer has nothing to go to.
      expect(service.answerApiKey(PANE, "login")).toEqual({
        ok: false,
        reason: "No question about the API key waits here",
      });
    });

  test("answered in a terminal meanwhile: the holder says so and the start goes on, with nothing to file", async () => {
    const { service, spawner, sent } = setup(
      undefined,
      {},
      { status: holderStatus("new") },
    );
    service.subscribe({ name: "w" }, PANE);
    await service.handover(PANE, "conversation");
    await eventually(() => !!service.state(PANE).api_key_question);
    const polls = new AbortController();
    disposeLater(() => polls.abort());
    void service.holder.hold({
      paneId: PANE,
      sessionId: service.state(PANE).session_id!,
      signal: polls.signal,
      status: holderStatus("approved"),
    });
    await eventually(() => spawner.spawned.length === 1);
    expect(spawner.spawned[0]!.options.apiKeyAnswer).toBeUndefined();
    expect(service.state(PANE).api_key_question).toBeUndefined();
    expect(questionEvents(sent).at(-1)).toBeNull();
  });

  test("handed back to the terminal while asked: the question goes, nothing starts", async () => {
    const { service, spawner, sent } = setup(
      undefined,
      {},
      { status: holderStatus("new") },
    );
    service.subscribe({ name: "w" }, PANE);
    await service.handover(PANE, "conversation");
    await eventually(() => !!service.state(PANE).api_key_question);
    await service.handover(PANE, "terminal");
    await settle();
    expect(service.state(PANE).api_key_question).toBeUndefined();
    expect(questionEvents(sent).at(-1)).toBeNull();
    expect(spawner.spawned).toHaveLength(0);
  });

  test("the answer RPC checks what it is given", async () => {
    const { service } = setup();
    const ws = { name: "w" };
    expect(
      await handleAgentChatRpc(service, null, ws, "agent_chat.api_key.answer", {
        pane_id: PANE,
        use: "login",
      }),
    ).toEqual({
      ok: false,
      reason: "No question about the API key waits here",
    });
    expect(() =>
      handleAgentChatRpc(service, null, ws, "agent_chat.api_key.answer", {
        pane_id: PANE,
        use: "yes",
      }),
    ).toThrow("use is api_key or login");
    expect(isAgentChatMethod("agent_chat.api_key.answer")).toBe(true);
  });
});
