import { expect, test } from "bun:test";
import {
  ABSENT_RETRY_MS,
  createModClient,
  RESTART_RETRY_MS,
  type ModCommand,
} from "../../claude-mod/hooks/client";

/**
 * The mod's client (server/claude-mod/hooks/client.ts) with a fake engine
 * and a fake Roamgate: what `claude plugin test` checks against the real
 * engine, here in every `bun test` run.
 */

type Sent = { command: ModCommand; body: Record<string, string | number> };

function fake(
  options: {
    socket?: boolean;
    answers?: ((body: Record<string, string | number>) => unknown)[];
    submits?: string[];
  } = {},
) {
  const sent: Sent[] = [];
  const submitted: string[] = [];
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const answers = options.answers ?? [];
  const submits = options.submits ?? [];
  let pendingSubmit: ((reason: string) => void) | null = null;
  let socket = options.socket !== false;
  let holdSubmits = false;
  const client = createModClient({
    client: "c1",
    identity: {
      pane: "w1-2",
      workspace: "w1",
      herdr_socket: "/herdr.sock",
      session: "s1",
      cwd: "/work",
      claude: "2.1.319",
    },
    host: {
      async request(command, body) {
        sent.push({ command, body });
        if (command !== "mod_poll") return { ok: true };
        const next = answers.shift();
        if (!next) return { protocol: 1, epoch: "e1", messages: [] };
        return next(body);
      },
      socketExists: async () => socket,
      submit(text) {
        submitted.push(text);
        if (holdSubmits)
          return new Promise((resolve) => {
            pendingSubmit = resolve;
          });
        return Promise.resolve(submits.shift() ?? "");
      },
      after(ms, fn) {
        const timer = { ms, fn, cancelled: false };
        timers.push(timer);
        return {
          cancel() {
            timer.cancelled = true;
          },
        };
      },
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return {
    client,
    sent,
    submitted,
    timers,
    setSocket(value: boolean) {
      socket = value;
    },
    holdSubmits(value: boolean) {
      holdSubmits = value;
    },
    finishSubmit(reason = "") {
      const resolve = pendingSubmit;
      pendingSubmit = null;
      resolve?.(reason);
    },
    /** Fires every timer due, one round. */
    async tick() {
      const due = timers.splice(0).filter((each) => !each.cancelled);
      for (const timer of due) timer.fn();
      await settle();
    },
    acks: () =>
      sent
        .filter((each) => each.command === "mod_ack")
        .map((each) => `${each.body.id}:${each.body.outcome}`),
  };
}

const inbox =
  (...messages: { id: number; text: string }[]) =>
  (body: Record<string, string | number>) => ({
    protocol: 1,
    epoch: "e1",
    messages: messages.filter((each) => each.id > Number(body.after)),
  });

test("messages are submitted one at a time, in order, each once", async () => {
  const f = fake({
    answers: [
      inbox({ id: 1, text: "one" }, { id: 2, text: "two" }),
      // Sent again (the server had no acknowledgement yet): not again.
      () => ({
        protocol: 1,
        epoch: "e1",
        messages: [
          { id: 1, text: "one" },
          { id: 2, text: "two" },
        ],
      }),
    ],
  });
  f.holdSubmits(true);
  f.client.start();
  await f.tick();
  // The second waits for the first's turn to start.
  expect(f.submitted).toEqual(["one"]);
  f.finishSubmit();
  await f.tick();
  expect(f.submitted).toEqual(["one", "two"]);
  f.finishSubmit();
  await f.tick();
  await f.tick();
  expect(f.submitted).toEqual(["one", "two"]);
  // The copy of "one" sent again is acknowledged, not submitted.
  expect(f.acks()).toEqual(["1:submitted", "1:submitted", "2:submitted"]);
  const poll = f.sent.find((each) => each.command === "mod_poll")!;
  expect(poll.body).toMatchObject({
    pane: "w1-2",
    session: "s1",
    herdr_socket: "/herdr.sock",
    protocol: 1,
    after: 0,
    wait_ms: 20_000,
  });
  expect(
    f.sent.filter((each) => each.command === "mod_poll").at(-1)?.body.after,
  ).toBe(2);
});

test("a stop holds the queue until the session's next turn ends", async () => {
  const f = fake({
    answers: [inbox({ id: 4, text: "after the stop" })],
    submits: ["the session was stopped and nobody has sent input since"],
  });
  f.client.start();
  await f.tick();
  expect(f.acks()).toEqual(["4:held"]);
  f.client.turnComplete();
  await f.tick();
  expect(f.submitted).toEqual(["after the stop", "after the stop"]);
  expect(f.acks()).toEqual(["4:held", "4:submitted"]);
});

test("a prompt removed from the queue by a stop is retried too", async () => {
  const f = fake({
    answers: [inbox({ id: 1, text: "queued" })],
    submits: ["the prompt was removed from the queue before it ran"],
  });
  f.client.start();
  await f.tick();
  expect(f.client.state().held).toBe(true);
  f.client.turnComplete();
  await f.tick();
  expect(f.acks()).toEqual(["1:held", "1:submitted"]);
});

test("another refusal drops that message and goes on", async () => {
  const f = fake({
    answers: [inbox({ id: 1, text: "refused" }, { id: 2, text: "fine" })],
    submits: ["Prompt dropped by a hook: no"],
  });
  f.client.start();
  await f.tick();
  expect(f.acks()).toEqual(["1:failed", "2:submitted"]);
});

test("without Roamgate's socket it only looks again later", async () => {
  const f = fake({ socket: false });
  f.client.start();
  await f.tick();
  expect(f.sent).toEqual([]);
  expect(f.timers.map((each) => each.ms)).toEqual([ABSENT_RETRY_MS]);
});

test("a failed poll backs off", async () => {
  const f = fake({
    answers: [
      () => {
        throw new Error("connection refused");
      },
      () => {
        throw new Error("connection refused");
      },
    ],
  });
  f.client.start();
  await f.tick();
  expect(f.timers.at(-1)?.ms).toBe(1000);
  await f.tick();
  expect(f.timers.at(-1)?.ms).toBe(2000);
});

test("superseded by a newer session in the pane, it stops", async () => {
  const f = fake({ answers: [() => ({ protocol: 1, superseded: true })] });
  f.client.start();
  await f.tick();
  expect(f.client.state().stopped).toBe(true);
  expect(f.timers).toEqual([]);
});

test("another inbox (its file lost) is read from the start", async () => {
  const f = fake({
    answers: [
      inbox({ id: 9, text: "old" }),
      () => ({ protocol: 1, epoch: "e2", messages: [] }),
      (body) => ({
        protocol: 1,
        epoch: "e2",
        messages: Number(body.after) === 0 ? [{ id: 1, text: "new" }] : [],
      }),
    ],
  });
  f.client.start();
  await f.tick();
  await f.tick();
  await f.tick();
  expect(f.submitted).toEqual(["old", "new"]);
});

test("events and the goodbye carry the session", async () => {
  const f = fake();
  f.client.report({ type: "turn_start" });
  f.client.setSession("s2");
  f.client.stop("prompt_input_exit");
  f.client.report({ type: "turn_start" });
  await f.tick();
  const events = f.sent.map((each) => [
    each.body.session,
    JSON.parse(String(each.body.event)).type,
  ]);
  expect(events).toEqual([
    ["s1", "turn_start"],
    ["s2", "bye"],
  ]);
});

test("a socket gone right after a working poll (a restart) is looked for often", async () => {
  const f = fake();
  f.client.start();
  await f.tick();
  f.setSocket(false);
  await f.tick();
  expect(f.timers.map((each) => each.ms)).toEqual([RESTART_RETRY_MS]);
});
