import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClaudeModHub,
  type ClaudeModTypeResult,
  createClaudeModHub,
  overlayModPanes,
} from "./claude-mod";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function hub(
  options: {
    file?: string | null;
    type?: (
      connectionId: string,
      paneId: string,
      text: string,
    ) => Promise<ClaudeModTypeResult>;
  } = {},
) {
  let at = 1_000_000;
  const changes: string[] = [];
  const made = createClaudeModHub({
    file: options.file ?? null,
    now: () => at,
    type: options.type,
    sweepMs: 3_600_000,
    onChange: (connectionId, paneId, change) =>
      changes.push(`${connectionId}/${paneId} ${change}`),
  });
  cleanups.push(() => made.dispose());
  return {
    hub: made,
    changes,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

const POLL = {
  connectionId: "local",
  paneId: "w1-2",
  sessionId: "11111111-2222",
  client: "c1",
  claude: "2.1.319",
  protocol: 1,
  after: 0,
  waitMs: 0,
};

test("nothing goes to a pane whose Claude runs no live mod", async () => {
  const { hub: h, advance } = hub();
  expect(h.deliver("local", "w1-2", "hello")).toBeNull();
  await h.poll(POLL);
  expect(h.live("local", "w1-2")).toBe(true);
  expect(h.deliver("local", "w1-2", "hello")).toEqual({ id: 1 });
  advance(60_000);
  expect(h.live("local", "w1-2")).toBe(false);
  expect(h.deliver("local", "w1-2", "late")).toBeNull();
});

test("a waiting poll answers as soon as a message comes, until acknowledged", async () => {
  const { hub: h } = hub();
  await h.poll(POLL);
  const waiting = h.poll({ ...POLL, waitMs: 5_000 });
  h.deliver("local", "w1-2", "first", "review");
  const answered = await waiting;
  expect(answered).toMatchObject({
    protocol: 1,
    messages: [{ id: 1, text: "first" }],
  });
  // Above the cursor only.
  expect((await h.poll({ ...POLL, after: 1 })).messages).toEqual([]);
  // Not acknowledged: a mod that starts over gets it again.
  expect((await h.poll(POLL)).messages).toEqual([{ id: 1, text: "first" }]);
  h.ack({ ...POLL, id: 1, outcome: "submitted", reason: "" });
  expect((await h.poll(POLL)).messages).toEqual([]);
  expect(h.waiting("local", "w1-2")).toBe(0);
});

test("a newer mod in the pane takes it; the older one is told", async () => {
  const { hub: h, changes } = hub();
  await h.poll(POLL);
  h.deliver("local", "w1-2", "for whoever runs there");
  const older = h.poll({ ...POLL, after: 1, waitMs: 5_000 });
  const newer = await h.poll({ ...POLL, client: "c2", sessionId: "33333333" });
  expect(newer.messages).toEqual([{ id: 1, text: "for whoever runs there" }]);
  expect(await older).toEqual({ protocol: 1, superseded: true });
  expect(await h.poll(POLL)).toEqual({ protocol: 1, superseded: true });
  expect(h.pane("local", "w1-2")?.session_id).toBe("33333333");
  expect(changes.filter((each) => each.endsWith("attach"))).toHaveLength(2);
});

test("what the mod says of its session", async () => {
  const { hub: h, changes } = hub();
  await h.poll(POLL);
  const event = (value: Record<string, unknown>, client = "c1") =>
    h.event({ ...POLL, client, event: value });
  event({ type: "turn_start" });
  expect(h.pane("local", "w1-2")?.status).toBe("working");
  event({ type: "blocked" });
  expect(h.pane("local", "w1-2")?.status).toBe("blocked");
  event({ type: "unblocked" });
  expect(h.pane("local", "w1-2")?.status).toBe("working");
  event({
    type: "turn_complete",
    reason: "error",
    model: "claude-opus-5-5",
    context: { tokens: 50_000, window: 200_000, percent: 25 },
    rate_limits: [
      {
        kind: "five_hour",
        percent_used: 100,
        resets_at: "2026-11-09T10:00:00Z",
      },
      { kind: "seven_day", percent_used: "lots" },
    ],
  });
  const pane = h.pane("local", "w1-2")!;
  expect(pane.status).toBe("idle");
  expect(pane.turn_reason).toBe("error");
  expect(pane.usage).toMatchObject({
    model: "claude-opus-5-5",
    context: { percent: 25 },
    rate_limits: [
      {
        kind: "five_hour",
        percent_used: 100,
        resets_at: "2026-11-09T10:00:00Z",
      },
    ],
  });
  expect(changes).toContain("local/w1-2 turn_complete");
  event({ type: "bye", reason: "prompt_input_exit" });
  expect(h.pane("local", "w1-2")).toBeNull();
  expect(h.live("local", "w1-2")).toBe(false);
});

test("a stop holds a message until a turn starts", async () => {
  const { hub: h } = hub();
  await h.poll(POLL);
  h.deliver("local", "w1-2", "held one");
  h.ack({ ...POLL, id: 1, outcome: "held", reason: "stopped" });
  expect(h.pane("local", "w1-2")).toMatchObject({ waiting: 1, held: 1 });
  h.event({ ...POLL, event: { type: "turn_start" } });
  expect(h.pane("local", "w1-2")).toMatchObject({ waiting: 1, held: 0 });
  h.ack({ ...POLL, id: 1, outcome: "failed", reason: "a hook dropped it" });
  expect(h.waiting("local", "w1-2")).toBe(0);
});

test("what a mod left is typed once its agent is idle, unless it comes back", async () => {
  const typed: string[] = [];
  let answer: ClaudeModTypeResult = "wait";
  const { hub: h, advance } = hub({
    type: async (_connection, _pane, text) => {
      if (answer === "typed") typed.push(text);
      return answer;
    },
  });
  await h.poll(POLL);
  h.deliver("local", "w1-2", "one");
  h.deliver("local", "w1-2", "two");
  // Gone but not long enough: nothing is typed.
  advance(60_000);
  await h.sweep();
  expect(typed).toEqual([]);
  advance(40_000);
  await h.sweep();
  expect(typed).toEqual([]);
  expect(h.waiting("local", "w1-2")).toBe(2);
  // Back meanwhile: the mod has them again.
  await h.poll(POLL);
  expect(h.live("local", "w1-2")).toBe(true);
  advance(100_000);
  answer = "typed";
  await h.sweep();
  await h.sweep();
  expect(typed).toEqual(["one", "two"]);
  expect(h.waiting("local", "w1-2")).toBe(0);
});

test("a message for a pane with no agent left is dropped", async () => {
  const { hub: h, advance } = hub({ type: async () => "gone" });
  await h.poll(POLL);
  h.deliver("local", "w1-2", "nobody");
  h.event({ ...POLL, event: { type: "bye", reason: "other" } });
  await h.sweep();
  expect(h.waiting("local", "w1-2")).toBe(0);
  advance(1);
});

test("the inbox and its ids survive a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-mod-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "claude-mod-inbox.json");
  const first = hub({ file });
  await first.hub.poll(POLL);
  first.hub.deliver("local", "w1-2", "kept", "message");
  first.hub.deliver("local", "w1-2", "taken");
  first.hub.ack({ ...POLL, id: 2, outcome: "submitted", reason: "" });
  const { epoch } = (await first.hub.poll({ ...POLL, after: 2 })) as {
    epoch: string;
  };
  first.hub.flush();
  first.hub.dispose();

  const second: ClaudeModHub = hub({ file }).hub;
  const again = await second.poll({ ...POLL, client: "c9" });
  expect(again).toMatchObject({
    epoch,
    messages: [{ id: 1, text: "kept" }],
  });
  expect(second.deliver("local", "w1-2", "next")).toEqual({ id: 3 });
});

test("a pane's inbox is bounded", async () => {
  const { hub: h } = hub();
  await h.poll(POLL);
  for (let index = 0; index < 50; index++) h.deliver("local", "w1-2", "x");
  expect(() => h.deliver("local", "w1-2", "one too many")).toThrow(
    "50 messages already wait",
  );
});

const MOD = {
  connection_id: "local",
  pane_id: "w1-2",
  session_id: "mod-session",
  claude: "2.1.319",
  protocol: 1,
  waiting: 0,
  held: 0,
  since: "",
  updated_at: "",
} as const;

test("the mod's state is laid over Herdr's screen detection", () => {
  const herdr = (status: string, agent = "claude") => ({
    panes: [
      {
        pane_id: "w1-2",
        agent,
        agent_status: status,
        agent_session: { source: "herdr:claude", kind: "id", value: "old" },
      },
      { pane_id: "w1-3", agent: "claude", agent_status: "working" },
    ],
  });
  const over = (status: string, mod: "idle" | "working" | "blocked") =>
    (
      overlayModPanes("pane.list", {}, herdr(status), [
        { ...MOD, status: mod },
      ]) as { panes: Record<string, unknown>[] }
    ).panes;
  expect(over("working", "idle")[0]!.agent_status).toBe("idle");
  // Idle and unseen stays done.
  expect(over("done", "idle")[0]!.agent_status).toBe("done");
  expect(over("idle", "working")[0]!.agent_status).toBe("working");
  // A dialog on screen during a turn is blocked.
  expect(over("blocked", "working")[0]!.agent_status).toBe("blocked");
  expect(over("idle", "blocked")[0]!.agent_status).toBe("blocked");
  expect(over("working", "idle")[0]!.agent_session).toEqual({
    source: "roamgate:mod",
    agent: "claude",
    kind: "id",
    value: "mod-session",
  });
  // Another pane, or another agent, is left as Herdr says.
  expect(over("working", "idle")[1]!.agent_status).toBe("working");
  const codex = overlayModPanes("pane.list", {}, herdr("working", "codex"), [
    { ...MOD, status: "idle" },
  ]) as { panes: Record<string, unknown>[] };
  expect(codex.panes[0]!.agent_status).toBe("working");
  const single = overlayModPanes(
    "agent.get",
    { target: "w1-2" },
    { agent: { agent: "claude", agent_status: "working" } },
    [{ ...MOD, status: "idle" }],
  ) as { agent: Record<string, unknown> };
  expect(single.agent.agent_status).toBe("idle");
});

test("a mod's first event says hello too; a replaced one speaks for nothing", async () => {
  const { hub: h } = hub();
  // Before its first poll: the usage it reports at start is kept.
  expect(
    h.event({ ...POLL, event: { type: "usage", model: "haiku" } }).known,
  ).toBe(true);
  expect(h.pane("local", "w1-2")?.usage?.model).toBe("haiku");
  // A newer claude in the pane: the older one's events change nothing.
  await h.poll({ ...POLL, client: "c2" });
  expect(h.event({ ...POLL, event: { type: "turn_start" } }).known).toBe(false);
  expect(h.event({ ...POLL, event: { type: "bye", reason: "x" } }).known).toBe(
    false,
  );
  expect(h.pane("local", "w1-2")?.status).toBe("idle");
});

const TOOLS = {
  connectionId: "local",
  paneId: "w1-2",
  sessionId: "11111111-2222",
  client: "t1",
  headless: false,
  gone: false,
};

test("a terminal session has the tools while it says so, until it leaves", () => {
  const { hub: made, advance } = hub();
  expect(made.hasTools("local", "w1-2")).toBe(false);
  made.tools(TOOLS);
  expect(made.hasTools("local", "w1-2")).toBe(true);
  expect(made.hasTools("local", "w1-3")).toBe(false);
  // Its hellos come every few minutes: one missed for ten, it is gone.
  advance(9 * 60_000);
  expect(made.hasTools("local", "w1-2")).toBe(true);
  advance(2 * 60_000);
  expect(made.hasTools("local", "w1-2")).toBe(false);
  made.tools(TOOLS);
  // Another session's goodbye changes nothing; its own does.
  made.tools({ ...TOOLS, client: "t0", gone: true });
  expect(made.hasTools("local", "w1-2")).toBe(true);
  made.tools({ ...TOOLS, gone: true });
  expect(made.hasTools("local", "w1-2")).toBe(false);
  expect(() => made.tools({ ...TOOLS, client: "" })).toThrow("client id");
});

test("a headless session's tools outlive its process and a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-mod-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "claude-mod-inbox.json");
  const first = hub({ file });
  first.hub.tools({ ...TOOLS, headless: true });
  first.hub.tools({ ...TOOLS, paneId: "w1-3", client: "t2" });
  first.hub.flush();
  first.hub.dispose();

  const second = hub({ file });
  // Stopped when idle, started again with the same tools.
  second.advance(24 * 60 * 60_000);
  expect(second.hub.hasTools("local", "w1-2")).toBe(true);
  // A terminal session's hello is long stale.
  expect(second.hub.hasTools("local", "w1-3")).toBe(false);
  second.advance(7 * 24 * 60 * 60_000);
  expect(second.hub.hasTools("local", "w1-2")).toBe(false);
});
