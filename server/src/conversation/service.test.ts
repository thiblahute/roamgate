import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentChatEventEnvelope } from "../../../shared/agentChat";
import { withOwnedSessions } from "../agent/agent-sessions";
import { createLeaseStore, type LeaseStore } from "./lease";
import { handleAgentChatRpc, isAgentChatMethod } from "./rpc";
import {
  type ConversationServiceOptions,
  createConversationService,
} from "./service";
import {
  answerInterrupts,
  fakeClaudeProcess,
  fakeHerdr,
  fakeSpawner,
  settle,
  virtualClock,
} from "./testing";

const PANE = "w1:p1";
type Ws = { name: string };
const services: { dispose(): void }[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

function setup(
  leases?: LeaseStore,
  extra: Partial<ConversationServiceOptions<Ws>> = {},
) {
  const clock = virtualClock();
  const sent: [Ws, AgentChatEventEnvelope][] = [];
  const spawner = fakeSpawner();
  const ref: {
    service?: ReturnType<typeof createConversationService<Ws>>;
  } = {};
  const holderPolls: Promise<unknown>[] = [];
  const holderAborts: AbortController[] = [];
  const startHolder = () => {
    const controller = new AbortController();
    holderAborts.push(controller);
    holderPolls.push(
      ref.service!.holder.hold({
        paneId: PANE,
        sessionId: fake.sessionId,
        signal: controller.signal,
      }),
    );
  };
  const fake = fakeHerdr({ onHolder: startHolder });
  const store = leases ?? createLeaseStore({ connectionId: "c1", file: null });
  const service = createConversationService<Ws>({
    connectionId: "c1",
    herdr: fake.herdr,
    leases: store,
    spawn: spawner.spawn,
    ask: async () => "allow",
    readImage: async () => ({ media_type: "image/png", data: "" }),
    send: (ws, envelope) => sent.push([ws, envelope]),
    holderCommand: (id) => `hold ${id}\r`,
    handover: { sleep: clock.sleep, now: clock.now, confirmTimeoutMs: 1000 },
    session: { stopWaitMs: 50, interruptWaitMs: 50 },
    holdPollMs: 60_000,
    ...extra,
  });
  ref.service = service;
  services.push({
    dispose() {
      for (const controller of holderAborts) controller.abort();
      service.dispose();
    },
  });
  return {
    service,
    fake,
    spawner,
    sent,
    store,
    holderPolls,
    startHolder,
    clock,
  };
}

/** The pane as conversation mode leaves it: the holder in its shell. */
function heldPane(fake: ReturnType<typeof fakeHerdr>) {
  fake.live.delete(fake.claudePid);
  fake.pane.agent = null;
  fake.pane.process = {
    shell_pid: 800,
    foreground_process_group_id: 950,
    foreground_processes: [{ pid: 950, argv: ["python3", "roamgate-hold"] }],
  };
}

const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
};

describe("conversation service", () => {
  test("refuses to send while the terminal owns the session", async () => {
    const { service } = setup();
    expect(() => service.send(PANE, { text: "hi" })).toThrow(/terminal owns/);
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
    const second = setup(first.store);
    second.fake.pane.agent = null;
    second.fake.pane.process = {
      shell_pid: 800,
      foreground_process_group_id: 800,
      foreground_processes: [],
    };
    await expect(second.service.send(PANE, { text: "hi" })).rejects.toThrow(
      /holder is not running/,
    );
    expect(second.spawner.spawned).toHaveLength(0);
    // A holder for another session does not count either.
    void second.service.holder.hold({
      paneId: PANE,
      sessionId: "99999999-0000-0000-0000-000000000000",
      signal: new AbortController().signal,
    });
    await expect(second.service.send(PANE, { text: "hi" })).rejects.toThrow(
      /another session/,
    );
    expect(second.spawner.spawned).toHaveLength(0);
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

  test("a holder with no lease resumes claude at once", async () => {
    const { service } = setup();
    expect(
      await service.holder.hold({
        paneId: PANE,
        sessionId: "abc",
        signal: new AbortController().signal,
      }),
    ).toEqual({ action: "resume", session_id: "abc", cwd: "" });
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

describe("leases on disk", () => {
  test("survive a restart, per connection", () => {
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
      const again = createLeaseStore({ connectionId: "c1", file });
      expect(again.get("p")).toMatchObject({
        connection_id: "c1",
        session_id: "s1",
        owner: "conversation",
      });
      again.delete("p");
      expect(
        createLeaseStore({ connectionId: "c1", file }).get("p"),
      ).toBeNull();
      expect(
        createLeaseStore({ connectionId: "c2", file }).get("p")?.session_id,
      ).toBe("s2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("automatic handovers across devices", () => {
  const rpc = (
    service: ReturnType<typeof setup>["service"],
    ws: Ws,
    method: string,
    params: Record<string, unknown>,
  ) =>
    handleAgentChatRpc(service, null, ws, method, { pane_id: PANE, ...params });

  test("the server arbitrates: no switch away from what another device shows", async () => {
    const { service } = setup();
    const phone = { name: "phone" };
    const desktop = { name: "desktop" };
    await rpc(service, phone, "agent_chat.subscribe", { view: "chat" });
    await rpc(service, desktop, "agent_chat.subscribe", { view: "terminal" });
    // The phone's chat would take it over, but the desktop shows it as a
    // terminal: refused, and the desktop's own view needs nothing.
    expect(
      await rpc(service, phone, "agent_chat.handover", {
        to: "conversation",
        auto: true,
      }),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/as a terminal on another device/),
    });
    expect(service.state(PANE).phase).toBe("terminal");
    // The desktop hides its page: the phone's showing has its way.
    await rpc(service, desktop, "agent_chat.view", { view: null });
    expect(
      await rpc(service, phone, "agent_chat.handover", {
        to: "conversation",
        auto: true,
      }),
    ).toMatchObject({ ok: true });
    await settle();
    // The desktop comes back to its terminal: it may not take it back
    // automatically while the phone shows the chat.
    await rpc(service, desktop, "agent_chat.view", { view: "terminal" });
    expect(
      await rpc(service, desktop, "agent_chat.handover", {
        to: "terminal",
        auto: true,
      }),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/as a chat on another device/),
    });
    expect(service.state(PANE).phase).toBe("conversation");
    // The user's own switch goes ahead.
    expect(
      await rpc(service, desktop, "agent_chat.handover", { to: "terminal" }),
    ).toMatchObject({ ok: true, owner: "terminal" });
    // And the phone, still on its chat, cannot take it straight back.
    expect(
      await rpc(service, phone, "agent_chat.handover", {
        to: "conversation",
        auto: true,
      }),
    ).toMatchObject({ ok: false });
    expect(service.state(PANE).phase).toBe("terminal");
  });

  test("a device that goes away stops counting", async () => {
    const { service } = setup();
    const phone = { name: "phone" };
    const desktop = { name: "desktop" };
    await rpc(service, desktop, "agent_chat.subscribe", { view: "terminal" });
    service.cleanupWs(desktop);
    expect(
      await rpc(service, phone, "agent_chat.handover", {
        to: "conversation",
        auto: true,
      }),
    ).toMatchObject({ ok: true });
    await expect(
      rpc(service, phone, "agent_chat.view", { view: "sideways" }),
    ).rejects.toThrow(/view is/);
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
