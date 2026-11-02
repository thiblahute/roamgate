import { expect, jest, test } from "bun:test";
import { createHistoryRefreshGate } from "./historyRefresh";

/** A read that answers when told to, counting how many ran. */
function reads() {
  const pending: (() => void)[] = [];
  let started = 0;
  return {
    read: () => {
      started += 1;
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    answer: async () => {
      pending.shift()?.();
      // Let the gate's finally run.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    get started() {
      return started;
    },
    get inFlight() {
      return pending.length;
    },
  };
}

test("many changes during a read make one read after it, not a storm", async () => {
  jest.useFakeTimers();
  try {
    const gate = createHistoryRefreshGate(400);
    const r = reads();
    gate.request(r.read);
    expect(r.started).toBe(1);
    // A transcript written continuously: fifty pushes while the read runs.
    for (let i = 0; i < 50; i++) gate.request(r.read);
    expect(r.started).toBe(1);
    expect(gate.busy).toBe(true);
    await r.answer();
    expect(gate.busy).toBe(false);
    // Not at once: after a short pause.
    expect(r.started).toBe(1);
    jest.advanceTimersByTime(399);
    expect(r.started).toBe(1);
    jest.advanceTimersByTime(1);
    expect(r.started).toBe(2);
    expect(r.inFlight).toBe(1);
    await r.answer();
    // Nothing changed meanwhile: no more reads.
    jest.advanceTimersByTime(10_000);
    expect(r.started).toBe(2);
  } finally {
    jest.useRealTimers();
  }
});

test("a steady stream of changes is read a few times a second at most", async () => {
  jest.useFakeTimers();
  try {
    const gate = createHistoryRefreshGate(400);
    const r = reads();
    // A push every 50 ms for 10 s; each read answers within 100 ms.
    for (let t = 0; t < 10_000; t += 50) {
      gate.request(r.read);
      jest.advanceTimersByTime(50);
      if (t % 100 === 50 && r.inFlight) await r.answer();
    }
    // At most one read per 400 ms pause: 25 in 10 s, where reading on
    // every push would be 200.
    expect(r.started).toBeLessThanOrEqual(25);
    expect(r.started).toBeGreaterThanOrEqual(15);
  } finally {
    jest.useRealTimers();
  }
});

test("a change after a quiet while is read at once", async () => {
  jest.useFakeTimers();
  try {
    const gate = createHistoryRefreshGate(400);
    const r = reads();
    gate.request(r.read);
    await r.answer();
    jest.advanceTimersByTime(1000);
    gate.request(r.read);
    expect(r.started).toBe(2);
  } finally {
    jest.useRealTimers();
  }
});

test("a reset forgets the running read and what was asked", async () => {
  jest.useFakeTimers();
  try {
    const gate = createHistoryRefreshGate(400);
    const r = reads();
    gate.request(r.read);
    gate.request(r.read);
    gate.reset();
    expect(gate.busy).toBe(false);
    // Another pane reads at once, and the old read ending changes nothing.
    gate.request(r.read);
    expect(r.started).toBe(2);
    await r.answer();
    await r.answer();
    jest.advanceTimersByTime(10_000);
    expect(r.started).toBe(2);
  } finally {
    jest.useRealTimers();
  }
});

test("a read that fails does not stop later ones", async () => {
  jest.useFakeTimers();
  try {
    const gate = createHistoryRefreshGate(400);
    let started = 0;
    const failing = () => {
      started += 1;
      return Promise.reject(new Error("timeout: agent_history.get"));
    };
    gate.request(failing);
    gate.request(failing);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    jest.advanceTimersByTime(400);
    expect(started).toBe(2);
  } finally {
    jest.useRealTimers();
  }
});

test("what the reader asks for skips the pause, still one read at a time", async () => {
  jest.useFakeTimers();
  try {
    const gate = createHistoryRefreshGate(400);
    const r = reads();
    gate.request(r.read);
    await r.answer();
    // In the pause: a push waits, a refresh does not.
    gate.request(r.read);
    expect(r.started).toBe(1);
    gate.request(r.read, true);
    expect(r.started).toBe(2);
    // Asked while a read runs: once, right after it.
    gate.request(r.read, true);
    gate.request(r.read, true);
    expect(r.started).toBe(2);
    await r.answer();
    expect(r.started).toBe(3);
    await r.answer();
    jest.advanceTimersByTime(10_000);
    expect(r.started).toBe(3);
  } finally {
    jest.useRealTimers();
  }
});
