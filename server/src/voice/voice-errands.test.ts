import { describe, expect, test } from "bun:test";
import { TurnCauses } from "./turn-causes";
import {
  type ErrandEntry,
  type ErrandSessionStatus,
  type ErrandState,
  VoiceErrands,
} from "./voice-errands";

const timing = { poll: 5, settled: 20, working: 150, repeat: 300, limit: 2000 };
const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("VoiceErrands", () => {
  test("sends the errand and gives back the answer once it settles", async () => {
    let entries: ErrandEntry[] = [
      { id: "old", role: "assistant", kind: "message", text: "Earlier." },
    ];
    const prompted: string[] = [];
    const errands = new VoiceErrands(
      {
        read: async () => entries,
        prompt: async (connectionId, paneId, text) => {
          prompted.push(`${connectionId} ${paneId} ${text}`);
          entries = [
            ...entries,
            { id: "q", role: "user", kind: "message", text },
            { id: "t", role: "assistant", kind: "tool_call", text: "search" },
          ];
          setTimeout(() => {
            entries = [
              ...entries,
              { id: "m", role: "assistant", kind: "message", text: "Looking." },
              { id: "a", role: "assistant", kind: "message", text: "2 to 1." },
            ];
          }, 30);
        },
      },
      timing,
    );
    const job = await errands.start("local/wF:p5", "[Voice] The score?");
    expect(prompted).toEqual(["local wF:p5 [Voice] The score?"]);
    expect(errands.state(job)).toEqual({
      done: false,
      answer: null,
      notice: null,
    });
    await until(() => errands.state(job)!.done);
    expect(errands.state(job)).toEqual({
      done: true,
      // The whole answer, not only its last message.
      answer: "Looking.\n\n2 to 1.",
      notice: null,
    });
  });

  /** A session that took the errand and is busy on a tool step. */
  const busySession = (status: () => ErrandSessionStatus | null) => {
    let entries: ErrandEntry[] = [];
    const errands = new VoiceErrands(
      {
        read: async () => entries,
        prompt: async () => {
          entries = [
            { id: "q", role: "user", kind: "message", text: "Send it" },
            { id: "t", role: "assistant", kind: "tool_call", text: "send" },
          ];
        },
        status: async () => status(),
      },
      timing,
    );
    return errands;
  };
  const notices = (errands: VoiceErrands, job: string) => {
    const told: ErrandState["notice"][] = [];
    const timer = setInterval(() => {
      const notice = errands.state(job)?.notice ?? null;
      if (notice && told[told.length - 1]?.seq !== notice.seq)
        told.push(notice);
    }, 2);
    return { told, stop: () => clearInterval(timer) };
  };
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  test("a session quietly at work is not told as stuck early", async () => {
    const errands = busySession(() => ({
      status: "working",
      waiting: null,
      queued: 0,
    }));
    const job = await errands.start("local/wF:p5", "Send it");
    // Well past the time it used to be called stuck: nothing to tell.
    await sleep(90);
    expect(errands.state(job)!.notice).toBeNull();
  });

  test("a long quiet turn is told as still working, again only after a while", async () => {
    const errands = busySession(() => ({
      status: "working",
      waiting: null,
      queued: 0,
    }));
    const job = await errands.start("local/wF:p5", "Send it");
    const watch = notices(errands, job);
    await until(() => errands.state(job)!.notice !== null);
    expect(errands.state(job)!.notice).toMatchObject({
      kind: "working",
      minutes: 0,
    });
    // Not repeated before the repeat time.
    await sleep(150);
    expect(watch.told).toHaveLength(1);
    await until(() => watch.told.length > 1);
    watch.stop();
    expect(watch.told.map((notice) => notice?.kind)).toEqual([
      "working",
      "working",
    ]);
  });

  test("a session waiting on a prompt is told at once, with what it asks", async () => {
    const errands = busySession(() => ({
      status: "blocked",
      waiting: "git push origin main",
      queued: 0,
    }));
    const job = await errands.start("local/wF:p5", "Send it");
    await until(() => errands.state(job)!.notice !== null);
    expect(errands.state(job)!.notice).toMatchObject({
      kind: "waiting",
      what: "git push origin main",
    });
  });

  test("messages queued for an idle-looking session count as busy", async () => {
    let queued = 1;
    const errands = busySession(() => ({
      status: "idle",
      waiting: null,
      queued,
    }));
    const job = await errands.start("local/wF:p5", "Send it");
    await until(() => errands.state(job)!.notice !== null);
    expect(errands.state(job)!.notice?.kind).toBe("working");
    // Idle with nothing queued: it is not working, nothing more is told.
    queued = 0;
    const seq = errands.state(job)!.notice!.seq;
    await sleep(400);
    expect(errands.state(job)!.notice!.seq).toBe(seq);
  });

  test("only the oldest job on a session tells how it goes", async () => {
    const errands = busySession(() => ({
      status: "working",
      waiting: null,
      queued: 1,
    }));
    const first = await errands.start("local/wF:p5", "Send it");
    const second = await errands.start("local/wF:p5", "And this");
    await until(() => errands.state(first)!.notice !== null);
    await sleep(30);
    expect(errands.state(first)!.notice?.kind).toBe("working");
    expect(errands.state(second)!.notice).toBeNull();
  });

  test("the turn an errand starts is noted as the companion's", async () => {
    const causes = new TurnCauses();
    const errands = new VoiceErrands(
      { read: async () => [], prompt: async () => {}, causes },
      timing,
    );
    await errands.start("local/wF:p5", "[Voice] The score?");
    expect(causes.turn("local", "wF:p5").cause).toMatchObject({
      by: "companion",
    });
    expect(causes.turn("local", "wF:p5").userAt).toBeNull();
  });
});
