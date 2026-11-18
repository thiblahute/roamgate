import { afterEach, describe, expect, jest, test } from "bun:test";
import type { AgentChatEventEnvelope } from "../../../shared/agentChat";
import { idleStopRefusal } from "./idle-stop";
import type { ConversationServiceOptions } from "./service";
import {
  disposeServices,
  heldPane,
  PANE,
  setupService as setup,
  userTexts,
  type Ws,
} from "./service-testing";
import {
  answerInterrupts,
  fakeClaudeProcess,
  fakeSpawner,
  RESULT,
  settle,
} from "./testing";

afterEach(disposeServices);

test("the rules: what keeps a session's process up", () => {
  const idle = {
    limitMs: 30 * 60_000,
    now: 31 * 60_000,
    idleSince: 0,
    lastPeerAt: null,
    conversation: true,
    alive: true,
    status: "idle" as const,
    busy: false,
    queued: 0,
    backgroundTasks: 0,
    shellRunning: false,
    apiKeyQuestion: false,
    keptAwake: null,
  };
  expect(idleStopRefusal(idle)).toBeNull();
  for (const [change, why] of [
    [{ limitMs: 0 }, "idle stop is off"],
    [{ conversation: false }, "not in conversation mode"],
    [{ alive: false }, "no process runs"],
    [{ status: "blocked" }, "it asks the user something"],
    [{ apiKeyQuestion: true }, "the API key question waits"],
    [{ busy: true }, "it works"],
    [{ status: "working" }, "it works"],
    [{ queued: 1 }, "messages wait in its queue"],
    [{ backgroundTasks: 2 }, "background work runs"],
    [{ shellRunning: true }, "a shell line runs"],
    [{ keptAwake: "a voice call is open" }, "a voice call is open"],
    [{ lastPeerAt: 25 * 60_000 }, "another session messaged it lately"],
    [{ idleSince: 2 * 60_000 }, "not idle long enough"],
  ] as const)
    expect(idleStopRefusal({ ...idle, ...change })).toBe(why);
  // A peer's message 10 minutes old no longer counts.
  expect(idleStopRefusal({ ...idle, lastPeerAt: 21 * 60_000 })).toBeNull();
});

describe("idle stop", () => {
  const MINUTE = 60_000;
  /** A session idle after one turn, its process up, idle stop at `minutes`. */
  async function idleSession(
    extra: Partial<ConversationServiceOptions<Ws>> = {},
    minutes = 30,
    make?: () => ReturnType<typeof fakeClaudeProcess>,
  ) {
    const context = setup(undefined, {
      idleStopMinutes: () => minutes,
      idleCheckMs: MINUTE,
      stuckCheckMs: 0,
      ...(make ? { spawn: fakeSpawnerWith(make).spawn } : {}),
      ...extra,
    });
    const ws = { name: "w" };
    context.service.subscribe(ws, PANE);
    await context.service.handover(PANE, "conversation");
    await settle();
    await context.service.send(PANE, { text: "work" });
    await settle();
    const proc = context.spawner.spawned[0]?.fake ?? spawnedWith[0]!;
    proc.push(RESULT);
    await settle();
    return { ...context, proc };
  }
  // Processes started by a custom spawner (tests that hold the exit).
  const spawnedWith: ReturnType<typeof fakeClaudeProcess>[] = [];
  function fakeSpawnerWith(make: () => ReturnType<typeof fakeClaudeProcess>) {
    spawnedWith.length = 0;
    const spawner = fakeSpawner(() => {
      const fake = make();
      spawnedWith.push(fake);
      return fake;
    });
    return spawner;
  }
  async function advance(ms: number) {
    for (let left = ms; left > 0; left -= MINUTE) {
      jest.advanceTimersByTime(Math.min(MINUTE, left));
      await settle();
    }
  }
  function asleepEvents(sent: [Ws, AgentChatEventEnvelope][]) {
    return sent
      .filter(([, envelope]) => envelope.event === "agent_chat.asleep")
      .map(([, envelope]) =>
        envelope.data.type === "asleep" ? envelope.data.asleep : undefined,
      );
  }
  async function withFakeTimers(run: () => Promise<void>) {
    jest.useFakeTimers();
    try {
      await run();
    } finally {
      jest.useRealTimers();
    }
  }

  test("an idle session's process stops after the setting; its holder keeps the pane", () =>
    withFakeTimers(async () => {
      const { service, proc, sent, holderPolls } = await idleSession();
      await advance(29 * MINUTE);
      expect(proc.ended).toBe(false);
      await advance(2 * MINUTE);
      expect(proc.ended).toBe(true);
      expect(proc.alive).toBe(false);
      const state = service.state(PANE);
      expect(state.phase).toBe("conversation");
      expect(state.status).toBe("stopped");
      expect(state.asleep?.since).toBeString();
      expect(asleepEvents(sent)).toHaveLength(1);
      // The holder was never told to resume claude in the pane.
      const replies = (await Promise.all(holderPolls)) as {
        action?: string;
      }[];
      expect(replies.length).toBeGreaterThan(0);
      expect(replies.some((reply) => reply.action === "resume")).toBe(false);
    }));

  test("the next message wakes it: started, then delivered once, the chat saying Waking", () =>
    withFakeTimers(async () => {
      const { service, proc, sent, spawner } = await idleSession();
      await advance(31 * MINUTE);
      expect(proc.ended).toBe(true);
      const before = sent.length;
      expect(
        (await service.send(PANE, { text: "wake up", uuid: "u-1" })).status,
      ).toBe("sent");
      await settle();
      expect(spawner.spawned).toHaveLength(2);
      const next = spawner.spawned[1]!.fake;
      expect(userTexts(next)).toEqual(["wake up"]);
      expect(userTexts(proc)).toEqual(["work"]);
      const activities = sent
        .slice(before)
        .filter(([, envelope]) => envelope.data.type === "status")
        .map(([, envelope]) =>
          envelope.data.type === "status" ? envelope.data.activity : null,
        );
      expect(activities).toContain("waking");
      expect(service.state(PANE).asleep).toBeUndefined();
      expect(asleepEvents(sent).at(-1)).toBeNull();
      // The same message again (a retried call) is not sent twice.
      await service.send(PANE, { text: "wake up", uuid: "u-1" });
      await settle();
      expect(userTexts(next)).toEqual(["wake up"]);
    }));

  test("a message written while the process stops waits for it, then goes once", () =>
    withFakeTimers(async () => {
      const { service, spawner } = await idleSession({}, 30, () =>
        fakeClaudeProcess({ respond: answerInterrupts }),
      );
      const first = spawnedWith[0]!;
      // Checked at 30 minutes: stdin closed, the process not gone yet.
      await advance(30 * MINUTE);
      expect(first.ended).toBe(true);
      expect(first.alive).toBe(true);
      const sending = service.send(PANE, { text: "during the stop" });
      await settle();
      first.exit(0);
      await sending;
      await settle();
      expect(spawnedWith).toHaveLength(2);
      expect(userTexts(first)).toEqual(["work"]);
      expect(userTexts(spawnedWith[1]!)).toEqual(["during the stop"]);
      expect(spawner.spawned).toHaveLength(0);
    }));

  test("never with a turn running", () =>
    withFakeTimers(async () => {
      const { service, proc } = await idleSession();
      await service.send(PANE, { text: "long work" });
      await settle();
      await advance(90 * MINUTE);
      expect(proc.ended).toBe(false);
      expect(service.state(PANE).asleep).toBeUndefined();
    }));

  test("never with background work running, until it ends", () =>
    withFakeTimers(async () => {
      const { proc } = await idleSession();
      proc.push({ type: "system", subtype: "task_started", task_id: "t1" });
      await settle();
      await advance(60 * MINUTE);
      expect(proc.ended).toBe(false);
      proc.push({
        type: "system",
        subtype: "task_notification",
        task_id: "t1",
        status: "completed",
      });
      await settle();
      await advance(31 * MINUTE);
      expect(proc.ended).toBe(true);
    }));

  test("never with a question or permission waiting for the user", () =>
    withFakeTimers(async () => {
      const { proc } = await idleSession({
        ask: () => new Promise(() => {}),
      });
      proc.push({
        type: "control_request",
        request_id: "perm-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "ls" },
        },
      });
      await settle();
      await advance(90 * MINUTE);
      expect(proc.ended).toBe(false);
    }));

  test("never during a voice call or a companion job", () =>
    withFakeTimers(async () => {
      let reason: string | null = "a voice call is open";
      const { proc } = await idleSession({ keepAwake: () => reason });
      await advance(90 * MINUTE);
      expect(proc.ended).toBe(false);
      reason = "a companion job runs on it";
      await advance(10 * MINUTE);
      expect(proc.ended).toBe(false);
      reason = null;
      await advance(2 * MINUTE);
      expect(proc.ended).toBe(true);
    }));

  test("never within 10 minutes of another session's message, Roamgate's or Claude Code's", () =>
    withFakeTimers(async () => {
      const { service, proc } = await idleSession({}, 5);
      await advance(3 * MINUTE);
      await service.prompt(PANE, "from a peer", undefined, { peer: true });
      await settle();
      proc.push(RESULT);
      await settle();
      // Idle 5 minutes, but the peer's message is 6 minutes old.
      await advance(6 * MINUTE);
      expect(proc.ended).toBe(false);
      await advance(5 * MINUTE);
      expect(proc.ended).toBe(true);

      const claude = await idleSession({}, 5);
      claude.proc.push({
        type: "user",
        message: {
          role: "user",
          content:
            'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1.sock">hi</cross-session-message>',
        },
        origin: { kind: "peer" },
      });
      await settle();
      await advance(6 * MINUTE);
      expect(claude.proc.ended).toBe(false);
      await advance(5 * MINUTE);
      expect(claude.proc.ended).toBe(true);
    }));

  test("0 turns it off, and the setting is read at each check", () =>
    withFakeTimers(async () => {
      let minutes = 0;
      const { proc } = await idleSession({ idleStopMinutes: () => minutes });
      await advance(120 * MINUTE);
      expect(proc.ended).toBe(false);
      minutes = 60;
      await advance(MINUTE);
      expect(proc.ended).toBe(true);
    }));

  test("asleep across a restart: the next start still says Waking", () =>
    withFakeTimers(async () => {
      const first = await idleSession();
      await advance(31 * MINUTE);
      expect(first.proc.ended).toBe(true);
      const second = setup(first.store, {
        carriedQueueDelayMs: 0,
        idleStopMinutes: () => 30,
        stuckCheckMs: 0,
      });
      heldPane(second.fake);
      second.startHolder();
      await advance(MINUTE);
      expect(second.service.state(PANE).asleep?.since).toBe(
        first.service.state(PANE).asleep?.since,
      );
      const before = second.sent.length;
      second.service.subscribe({ name: "w2" }, PANE);
      await second.service.send(PANE, { text: "back" });
      await settle();
      expect(
        second.sent
          .slice(before)
          .some(
            ([, envelope]) =>
              envelope.data.type === "status" &&
              envelope.data.activity === "waking",
          ),
      ).toBe(true);
      expect(second.service.state(PANE).asleep).toBeUndefined();
    }));
});
