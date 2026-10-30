import { describe, expect, test } from "bun:test";
import {
  createHolderChannel,
  type HolderSaved,
  type HolderStatus,
  parseHolderStatus,
} from "./pane-child";
import { settle } from "./testing";

const HOLDER = "a".repeat(32);

function status(extra: Partial<HolderStatus> = {}): HolderStatus {
  return {
    holderId: HOLDER,
    applied: 0,
    child: 0,
    childAlive: false,
    childPid: 0,
    logSize: 0,
    epochOffset: 0,
    ...extra,
  };
}

/** A holder's log, as the holder writes it: whole lines, byte offsets. */
function holderLog() {
  let text = "";
  return {
    size: () => Buffer.byteLength(text),
    add(...values: unknown[]) {
      const start = Buffer.byteLength(text);
      for (const value of values)
        text += `${typeof value === "string" ? value : JSON.stringify(value)}\n`;
      return start;
    },
    from(offset: number) {
      return Buffer.from(text).subarray(offset).toString();
    },
  };
}

function setup(saved?: HolderSaved) {
  let work = 0;
  const offsets: number[] = [];
  const channel = createHolderChannel({
    paneId: "p1",
    saved: saved ?? null,
    onWork: () => {
      work += 1;
    },
    onOffset: (_id, offset) => offsets.push(offset),
  });
  const log = holderLog();
  /** The holder sends what Roamgate asks for, from where it asks. */
  const send = (offset: number) =>
    channel.receive({
      holderId: HOLDER,
      offset,
      end: log.size(),
      data: log.from(offset),
    });
  return { channel, log, send, work: () => work, offsets };
}

async function collect(lines: AsyncIterable<string>, count: number) {
  const out: string[] = [];
  for await (const line of lines) {
    out.push(line);
    if (out.length === count) break;
  }
  return out;
}

describe("holder status", () => {
  test("is read from the poll's fields; none from an older holder", () => {
    expect(
      parseHolderStatus(
        new URLSearchParams({
          holder_id: HOLDER,
          applied: "3",
          child: "2",
          child_alive: "1",
          child_pid: "77",
          log_size: "1200",
          epoch_offset: "800",
        }),
      ),
    ).toEqual({
      holderId: HOLDER,
      applied: 3,
      child: 2,
      childAlive: true,
      childPid: 77,
      logSize: 1200,
      epochOffset: 800,
    });
    expect(parseHolderStatus(new URLSearchParams({ pane: "p1" }))).toBeNull();
    expect(
      parseHolderStatus(
        new URLSearchParams({ holder_id: HOLDER, applied: "-1" }),
      ),
    ).toBeNull();
  });

  test("says what Claude Code answered about the pane's API key, never the key", () => {
    const base = {
      holder_id: HOLDER,
      applied: "0",
      child: "0",
      log_size: "0",
      epoch_offset: "0",
    };
    const apiKey = (value?: string) =>
      parseHolderStatus(
        new URLSearchParams(
          value === undefined ? base : { ...base, api_key: value },
        ),
      )?.apiKey;
    expect(apiKey("")).toBe("none");
    expect(apiKey("approved")).toBe("approved");
    expect(apiKey("rejected")).toBe("rejected");
    expect(apiKey("new")).toBe("new");
    // An older holder (or anything else): unknown, nothing asked.
    expect(apiKey()).toBeUndefined();
    expect(apiKey("sk-ant-api03-xyz")).toBeUndefined();
  });
});

describe("holder channel", () => {
  test("starts a child through the holder and relays both ways", async () => {
    const { channel, log, send, work } = setup();
    channel.update(status());
    expect(channel.hasWork()).toBe(true);
    expect(channel.work()).toEqual({ output_from: 0 });
    const spawning = channel.spawn({ command: { argv: ["claude"] } });
    await settle();
    expect(work()).toBe(1);
    const { commands } = channel.work();
    expect(commands).toEqual([{ seq: 1, op: "start", argv: ["claude"] }]);
    // The holder applied it and says so: it is not sent again.
    channel.update(status({ applied: 1, child: 1, childAlive: true }));
    expect(channel.work().commands).toBeUndefined();
    log.add({ type: "roamgate_child", event: "start", child: 1, pid: 99 });
    log.add({ type: "system", subtype: "init" });
    expect(send(0)).toEqual({ offset: log.size() });
    const child = (await spawning)!;
    expect(child.pid).toBe(99);
    expect(child.replayed).toBe(0);
    child.write(`${JSON.stringify({ type: "user", message: "hi" })}\n`);
    child.write(
      JSON.stringify({
        type: "control_response",
        response: { request_id: "r1" },
      }),
    );
    expect(channel.work().commands).toEqual([
      {
        seq: 2,
        op: "input",
        child: 1,
        line: '{"type":"user","message":"hi"}',
        kind: "user",
      },
      {
        seq: 3,
        op: "input",
        child: 1,
        line: '{"type":"control_response","response":{"request_id":"r1"}}',
        kind: "control_response",
        request_id: "r1",
      },
    ]);
    expect(await collect(child.lines, 1)).toEqual([
      '{"type":"system","subtype":"init"}',
    ]);
    child.end();
    expect(() => child.write("{}")).toThrow(/closing/);
    expect(channel.work().commands?.at(-1)).toEqual({
      seq: 4,
      op: "end",
      child: 1,
    });
    const at = log.size();
    log.add({ type: "result" });
    log.add({ type: "roamgate_child", event: "exit", child: 1, code: 0 });
    send(at);
    expect(await child.exited).toBe(0);
  });

  test("takes each line once: a resend or a gap is refused", () => {
    const { channel, log, send } = setup();
    channel.update(status());
    log.add({ type: "roamgate_child", event: "start", child: 1, pid: 1 });
    const second = log.add({ type: "a" });
    expect(send(0)).toEqual({ offset: log.size() });
    // Sent again (its answer was lost): refused, told where to go on.
    expect(send(second)).toEqual({ offset: log.size() });
    const third = log.add({ type: "b" });
    log.add({ type: "c" });
    // Ahead of what was read: refused too.
    expect(
      channel.receive({
        holderId: HOLDER,
        offset: third + 10,
        end: log.size(),
        data: "",
      }),
    ).toEqual({ offset: third });
    // Another holder's log: nothing to do with this one.
    expect(
      channel.receive({
        holderId: "b".repeat(32),
        offset: 0,
        end: 0,
        data: "",
      }),
    ).toEqual({});
  });

  test("a new reader reads on from where the one before stopped", async () => {
    // The runtime before read the child's start and two lines.
    const first = setup();
    first.channel.update(status());
    first.log.add({ type: "roamgate_child", event: "start", child: 1, pid: 5 });
    first.log.add({ type: "user", text: "work" });
    first.log.add({ type: "system", subtype: "status", status: "requesting" });
    first.send(0);
    const read = first.log.size();
    const spawning = first.channel.spawn({ command: {}, attachOnly: true });
    expect(await spawning).not.toBeNull();
    // A write it had not seen confirmed goes with it.
    first.channel.update(status({ child: 1, childAlive: true, logSize: read }));
    const saved = first.channel.save()!;
    expect(saved).toEqual({ id: HOLDER, offset: read });
    // Meanwhile the child went on.
    const second = setup({
      ...saved,
      pending: [{ seq: 7, op: "input", child: 1, line: "{}" }],
    });
    second.log.add(first.log.from(0));
    second.log.add({ type: "stream_event", text: "more" });
    second.channel.update(
      status({
        applied: 6,
        child: 1,
        childAlive: true,
        logSize: second.log.size(),
        epochOffset: 0,
      }),
    );
    // Asked from the child's start; the unconfirmed write is sent again
    // under its own number (the holder takes it once).
    expect(second.channel.work()).toEqual({
      commands: [{ seq: 7, op: "input", child: 1, line: "{}" }],
      output_from: 0,
    });
    const attaching = second.channel.spawn({ command: {}, attachOnly: true });
    second.send(0);
    const child = (await attaching)!;
    expect(child.replayed).toBe(2);
    expect(await collect(child.lines, 3)).toEqual([
      '{"type":"user","text":"work"}',
      '{"type":"system","subtype":"status","status":"requesting"}',
      '{"type":"stream_event","text":"more"}',
    ]);
    // New commands number on after the carried one.
    child.kill();
    expect(second.channel.work().commands?.at(-1)).toMatchObject({
      seq: 8,
      op: "kill",
    });
  });

  test("a reader with a saved state reads on from where its lines were handled", async () => {
    // The runtime before handled the child's start and two lines.
    const first = setup();
    first.channel.update(status());
    const epoch = first.log.add({
      type: "roamgate_child",
      event: "start",
      child: 1,
      pid: 5,
    });
    first.log.add({ type: "user", text: "work" });
    first.log.add({ type: "system", subtype: "status", status: "requesting" });
    first.send(0);
    const child = (await first.channel.spawn({
      command: {},
      attachOnly: true,
    }))!;
    const startLine = `${JSON.stringify({ type: "roamgate_child", event: "start", child: 1, pid: 5 })}\n`;
    // Nothing handled yet but its start line.
    expect(child.position?.()).toEqual({
      child: 1,
      epoch_offset: epoch,
      offset: Buffer.byteLength(startLine),
    });
    // Only once the next line is asked for is the one before handled.
    const handled = Buffer.byteLength(
      `${startLine}${JSON.stringify({ type: "user", text: "work" })}\n`,
    );
    const lines = child.lines[Symbol.asyncIterator]();
    await lines.next();
    await lines.next();
    expect(child.position?.()?.offset).toBe(handled);
    const saved: HolderSaved = {
      ...first.channel.save()!,
      resume: { ...child.position!()!, state: { said: "work" } },
    };
    // Meanwhile the child went on.
    const second = setup(saved);
    second.log.add(first.log.from(0));
    second.log.add({ type: "stream_event", text: "more" });
    second.channel.update(
      status({
        child: 1,
        childAlive: true,
        childPid: 5,
        logSize: second.log.size(),
        epochOffset: epoch,
      }),
    );
    // Asked from the first line not handled: nothing is read again.
    expect(second.channel.work()).toEqual({ output_from: handled });
    const attaching = second.channel.spawn({ command: {}, attachOnly: true });
    second.send(handled);
    const next = (await attaching)!;
    expect(next.replayed).toBe(0);
    expect(next.resume).toEqual({ said: "work" });
    expect(next.pid).toBe(5);
    expect(await collect(next.lines, 2)).toEqual([
      '{"type":"system","subtype":"status","status":"requesting"}',
      '{"type":"stream_event","text":"more"}',
    ]);
  });

  test("a saved state of another child, or a log cut short, is read again from the child's start", async () => {
    const resume = { child: 1, epoch_offset: 0, offset: 40, state: {} };
    for (const [why, extra] of [
      ["a later child", { child: 2, epochOffset: 0 }],
      ["the child started elsewhere", { child: 1, epochOffset: 10 }],
      [
        "a log shorter than the save",
        { child: 1, epochOffset: 0, logSize: 20 },
      ],
    ] as const) {
      const { channel } = setup({ id: HOLDER, offset: 40, resume });
      channel.update(status({ childAlive: true, logSize: 100, ...extra }));
      expect(channel.work().output_from, why).toBe(extra.epochOffset);
    }
    // Another holder: its own log, from its child's start.
    const other = setup({ id: "b".repeat(32), offset: 40, resume });
    other.channel.update(
      status({ child: 1, childAlive: true, logSize: 100, epochOffset: 0 }),
    );
    expect(other.channel.work().output_from).toBe(0);
  });

  test("a child that ended unread is handed over, one read already is not", async () => {
    const log = holderLog();
    log.add({ type: "roamgate_child", event: "start", child: 1, pid: 5 });
    log.add({ type: "roamgate_child", event: "exit", child: 1, code: 0 });
    const seen = log.size();
    log.add({ type: "roamgate_child", event: "start", child: 2, pid: 6 });
    log.add({ type: "user", text: "work" });
    log.add({ type: "roamgate_child", event: "exit", child: 2, code: 137 });
    // The runtime before had read up to child 2's start.
    const ready = setup({ id: HOLDER, offset: seen });
    ready.log.add(log.from(0));
    ready.channel.update(
      status({ child: 2, logSize: ready.log.size(), epochOffset: seen }),
    );
    const attaching = ready.channel.spawn({ command: {}, attachOnly: true });
    ready.send(seen);
    const child = (await attaching)!;
    expect(child.replayed).toBe(0);
    expect(await child.exited).toBe(137);
    expect(await collect(child.lines, 1)).toEqual([
      '{"type":"user","text":"work"}',
    ]);
    // Nothing else unread: an attach finds nothing.
    expect(
      await ready.channel.spawn({ command: {}, attachOnly: true }),
    ).toBeNull();
  });

  test("a line longer than a chunk comes in pieces, put back together", async () => {
    const { channel, log, offsets } = setup();
    channel.update(status());
    log.add({ type: "roamgate_child", event: "start", child: 1, pid: 3 });
    // A tool result with screenshots: past the socket's 1 MiB, with
    // characters of several bytes where the pieces are cut.
    const big = JSON.stringify({ type: "user", text: "é€😀".repeat(200_000) });
    const bigStart = log.add(big);
    log.add({ type: "after" });
    const bytes = Buffer.from(log.from(0));
    const holderPiece = (from: number, size: number) => {
      // As the holder cuts: whole lines, else a piece between characters.
      let piece = bytes.subarray(from, Math.min(bytes.length, from + size));
      const newline = piece.lastIndexOf(10);
      if (newline >= 0) piece = piece.subarray(0, newline + 1);
      else {
        // Back to the last character's first byte: kept if it is whole.
        let back = 1;
        while ((piece[piece.length - back]! & 0xc0) === 0x80) back += 1;
        const lead = piece[piece.length - back]!;
        const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
        if (back < size) piece = piece.subarray(0, piece.length - back);
      }
      return piece;
    };
    let at = 0;
    let pieces = 0;
    let midLine: number | null = null;
    while (at < bytes.length) {
      // Cut just past the last character's start: drops its tail bytes.
      const piece = holderPiece(at, 256 * 1024 + 1);
      const answer = channel.receive({
        holderId: HOLDER,
        offset: at,
        end: at + piece.length,
        data: piece.toString(),
      });
      at += piece.length;
      expect(answer).toEqual({ offset: at });
      pieces += 1;
      if (at > bigStart && at < bigStart + Buffer.byteLength(big))
        midLine ??= channel.save()!.offset;
    }
    expect(pieces).toBeGreaterThan(4);
    // Saved mid-line, a later reader starts at that line, not inside it.
    expect(midLine).toBe(bigStart);
    expect(channel.save()!.offset).toBe(log.size());
    expect(offsets.at(-1)).toBe(log.size());
    const child = (await channel.spawn({ command: {}, attachOnly: true }))!;
    expect(await collect(child.lines, 2)).toEqual([big, '{"type":"after"}']);
  });

  test("a log that cannot be read is given up: its child ends, reading starts at its end", async () => {
    const { channel, log, send, work } = setup();
    log.add({ type: "roamgate_child", event: "start", child: 3, pid: 9 });
    log.add({ type: "stream_event", text: "stuck here" });
    channel.update(
      status({ applied: 4, child: 3, childAlive: true, logSize: log.size() }),
    );
    // Nothing of the log comes through: the attach gives up.
    await expect(
      channel.spawn({ command: {}, attachOnly: true, timeoutMs: 20 }),
    ).rejects.toThrow("The pane holder's log could not be read");
    const before = work();
    const abandoning = channel.abandon({ timeoutMs: 1000 });
    await settle();
    expect(work()).toBeGreaterThan(before);
    expect(channel.work().commands).toEqual([{ seq: 5, op: "kill", child: 3 }]);
    // The holder killed it: its exit is in the log, which goes on.
    log.add({ type: "roamgate_child", event: "exit", child: 3, code: -9 });
    channel.update(
      status({ applied: 5, child: 3, childAlive: false, logSize: log.size() }),
    );
    await abandoning;
    expect(channel.work()).toEqual({ output_from: log.size() });
    expect(channel.save()).toEqual({ id: HOLDER, offset: log.size() });
    // A new child starts on the session.
    const spawning = channel.spawn({ command: { argv: ["claude"] } });
    await settle();
    expect(channel.work().commands).toEqual([
      { seq: 6, op: "start", argv: ["claude"] },
    ]);
    const at = log.size();
    log.add({ type: "roamgate_child", event: "start", child: 4, pid: 10 });
    channel.update(
      status({ applied: 6, child: 4, childAlive: true, logSize: log.size() }),
    );
    send(at);
    expect((await spawning)!.pid).toBe(10);
  });

  test("a start the holder refuses fails at once", async () => {
    const { channel, log, send } = setup();
    channel.update(status());
    const spawning = channel.spawn({ command: { argv: ["claude"] } });
    await settle();
    log.add({
      type: "roamgate_child",
      event: "refused",
      reason: "claude did not start: not found",
    });
    send(0);
    await expect(spawning).rejects.toThrow("claude did not start: not found");
  });

  test("another holder in the pane ends the children of the one before", async () => {
    const { channel, log, send } = setup();
    channel.update(status());
    log.add({ type: "roamgate_child", event: "start", child: 1, pid: 5 });
    send(0);
    const child = (await channel.spawn({ command: {}, attachOnly: true }))!;
    channel.update(status({ holderId: "c".repeat(32) }));
    expect(await child.exited).toBe(-1);
  });

  test("the user messages its child never got are handed back at its exit", async () => {
    const { channel, log, send } = setup();
    channel.update(status());
    log.add({ type: "roamgate_child", event: "start", child: 1, pid: 5 });
    send(0);
    const child = (await channel.spawn({ command: {}, attachOnly: true }))!;
    const user = (text: string) =>
      JSON.stringify({ type: "user", uuid: text, message: text });
    // Applied; dropped (its stdin closed); and one still unconfirmed when
    // the child exits (the holder drops it too, after the exit line).
    child.write(user("applied"));
    child.write(user("dropped"));
    child.write(user("late"));
    channel.update(status({ applied: 2, child: 1, childAlive: true }));
    const at = log.size();
    log.add({
      type: "roamgate_input",
      seq: 1,
      child: 1,
      kind: "user",
    });
    log.add({
      type: "roamgate_input",
      seq: 2,
      child: 1,
      kind: "user",
      dropped: true,
    });
    log.add({ type: "roamgate_child", event: "exit", child: 1, code: 0 });
    send(at);
    expect(await child.exited).toBe(0);
    expect(child.undelivered?.()).toEqual([user("dropped"), user("late")]);
    // Nothing more goes to a child that is gone.
    expect(channel.work().commands).toBeUndefined();
  });

  test("each new command is saved at once", async () => {
    let saves = 0;
    const channel = createHolderChannel({
      paneId: "p1",
      onWork: () => {},
      onPending: () => {
        saves += 1;
      },
    });
    const log = holderLog();
    channel.update(status());
    log.add({ type: "roamgate_child", event: "start", child: 1, pid: 5 });
    channel.receive({
      holderId: HOLDER,
      offset: 0,
      end: log.size(),
      data: log.from(0),
    });
    const child = (await channel.spawn({ command: {}, attachOnly: true }))!;
    child.write('{"type":"user","message":"hi"}');
    expect(saves).toBe(1);
    expect(channel.save()?.pending).toHaveLength(1);
  });

  test("a long log read slowly is waited for while it comes in", async () => {
    const { channel, log } = setup();
    log.add({ type: "roamgate_child", event: "start", child: 1, pid: 5 });
    for (let index = 0; index < 6; index += 1) log.add({ type: "line", index });
    channel.update(status({ logSize: log.size(), child: 1, childAlive: true }));
    const attaching = channel.spawn({
      command: {},
      attachOnly: true,
      timeoutMs: 40,
    });
    // One line every 25 ms: more than the timeout in all, never stalled.
    const lines = log.from(0).split("\n").slice(0, -1);
    let offset = 0;
    for (const text of lines) {
      await Bun.sleep(25);
      const end = offset + Buffer.byteLength(text) + 1;
      channel.receive({ holderId: HOLDER, offset, end, data: `${text}\n` });
      offset = end;
    }
    const child = (await attaching)!;
    expect(child.catchUp).toBe(6);
  });

  test("a holder that never answers is no process", async () => {
    const { channel } = setup();
    await expect(channel.spawn({ command: {}, timeoutMs: 5 })).rejects.toThrow(
      /not connected/,
    );
  });
});
