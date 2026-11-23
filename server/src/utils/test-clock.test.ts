import { describe, expect, test } from "bun:test";
import {
  answerTestClock,
  installTestClock,
  installTestClockFromEnv,
  TEST_CLOCK_ENV,
  TestClock,
} from "./test-clock";

const EPOCH = Date.UTC(2026, 0, 2, 3, 4, 5);

/** Real turns for zero-delay timers queued on the clock. */
async function turns(count = 5): Promise<void> {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("TestClock", () => {
  test("time moves only on advance, firing timers in deadline order", async () => {
    const clock = new TestClock(EPOCH);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push(`b@${clock.now() - EPOCH}`), 5);
    clock.setTimeout(() => fired.push(`c@${clock.now() - EPOCH}`), 10);
    clock.setTimeout(() => fired.push(`a@${clock.now() - EPOCH}`), 5);
    const interval = clock.setInterval(
      () => fired.push(`i@${clock.now() - EPOCH}`),
      4,
    );
    await turns();
    expect(fired).toEqual([]);
    expect(clock.now()).toBe(EPOCH);

    expect(await clock.advance(10)).toBe(EPOCH + 10);
    expect(fired).toEqual(["i@4", "b@5", "a@5", "i@8", "c@10"]);

    clock.clear(interval);
    await clock.advance(100);
    expect(fired).toHaveLength(5);
    expect(clock.pending()).toBe(0);
  });

  test("a timer set by a firing timer fires in the same advance when due", async () => {
    const clock = new TestClock(EPOCH);
    const fired: number[] = [];
    clock.setTimeout(() => {
      fired.push(clock.now() - EPOCH);
      clock.setTimeout(() => fired.push(clock.now() - EPOCH), 30);
    }, 20);
    await clock.advance(60);
    expect(fired).toEqual([20, 50]);
    expect(clock.now()).toBe(EPOCH + 60);
  });

  test("promise chains settle between timers", async () => {
    const clock = new TestClock(EPOCH);
    const seen: string[] = [];
    clock.setTimeout(async () => {
      await Promise.resolve();
      await Promise.resolve();
      seen.push("first done");
    }, 1);
    clock.setTimeout(() => seen.push("second"), 2);
    await clock.advance(2);
    expect(seen).toEqual(["first done", "second"]);
  });

  test("zero delays run without advancing time", async () => {
    const clock = new TestClock(EPOCH);
    const fired: number[] = [];
    clock.setTimeout(() => fired.push(clock.now()), 0);
    clock.setTimeout(() => fired.push(clock.now()), -5);
    clock.setTimeout(() => fired.push(clock.now()), Number.NaN);
    await turns();
    expect(fired).toEqual([EPOCH, EPOCH, EPOCH]);
  });

  test("refresh restarts a timer and ref tracking follows the timers", async () => {
    const clock = new TestClock(EPOCH);
    const refs: boolean[] = [];
    clock.onRefChange((hasRef) => refs.push(hasRef));
    let fired = 0;
    const timer = clock.setTimeout(() => fired++, 10);
    await clock.advance(8);
    timer.refresh();
    await clock.advance(8);
    expect(fired).toBe(0);
    timer.unref();
    expect(timer.hasRef()).toBe(false);
    timer.ref();
    await clock.advance(2);
    expect(fired).toBe(1);
    expect(refs).toEqual([false, true, false, true, false]);
  });

  test("advance rejects durations that are not whole milliseconds", async () => {
    const clock = new TestClock(EPOCH);
    await expect(clock.advance(-1)).rejects.toThrow();
    await expect(clock.advance(1.5)).rejects.toThrow();
    expect(clock.now()).toBe(EPOCH);
  });

  test("advance waits for its followers, which see the new time", async () => {
    const clock = new TestClock(EPOCH);
    const seen: number[] = [];
    let release = () => {};
    const unfollow = clock.follow(async (now) => {
      seen.push(now);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    let done = false;
    const advanced = clock.advance(500).then((now) => {
      done = true;
      return now;
    });
    for (let turn = 0; turn < 5 && !seen.length; turn++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([EPOCH + 500]);
    expect(done).toBe(false);
    release();
    expect(await advanced).toBe(EPOCH + 500);
    unfollow();
    clock.follow(async () => {
      throw new Error("behind");
    });
    expect(await clock.advance(1)).toBe(EPOCH + 501);
    expect(seen).toEqual([EPOCH + 500]);
  });
});

describe("installTestClock", () => {
  function fakeGlobals() {
    return {
      Date,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      performance: { now: () => performance.now() },
      Bun: { sleep: Bun.sleep },
      AbortSignal: { timeout: AbortSignal.timeout },
    };
  }

  test("routes Date, timers, performance.now, Bun.sleep and AbortSignal.timeout", async () => {
    const clock = new TestClock(EPOCH, { monotonicBase: 1000 });
    const target = fakeGlobals();
    const restore = installTestClock(clock, target);
    try {
      const VirtualDate = target.Date;
      expect(VirtualDate.now()).toBe(EPOCH);
      expect(new VirtualDate().getTime()).toBe(EPOCH);
      expect(new VirtualDate(0).getTime()).toBe(0);
      expect(new VirtualDate("2020-01-01T00:00:00Z").getTime()).toBe(
        Date.UTC(2020, 0, 1),
      );
      expect(new VirtualDate()).toBeInstanceOf(Date);
      expect((VirtualDate as unknown as () => string)()).toBe(
        new Date(EPOCH).toString(),
      );
      expect(VirtualDate.UTC(2020, 0, 1)).toBe(Date.UTC(2020, 0, 1));
      class Stamp extends VirtualDate {}
      expect(new Stamp().getTime()).toBe(EPOCH);
      expect(target.performance.now()).toBe(1000);

      let fired = 0;
      target.setTimeout(() => fired++, 1000);
      const interval = target.setInterval(() => fired++, 400);
      const cleared = target.setTimeout(() => fired++, 10);
      target.clearTimeout(cleared);
      let slept = false;
      void target.Bun.sleep(500).then(() => {
        slept = true;
      });
      const signal = target.AbortSignal.timeout(700);

      await clock.advance(600);
      expect(slept).toBe(true);
      expect(signal.aborted).toBe(false);
      expect(fired).toBe(1);
      await clock.advance(400);
      expect(signal.aborted).toBe(true);
      expect((signal.reason as DOMException).name).toBe("TimeoutError");
      expect(fired).toBe(3);
      target.clearInterval(interval);
      expect(target.Date.now()).toBe(EPOCH + 1000);
      expect(target.performance.now()).toBe(2000);
      expect(new target.Date().getTime()).toBe(EPOCH + 1000);

      // A real timer from before the install is still cleared for real.
      let realFired = false;
      const real = setTimeout(() => {
        realFired = true;
      }, 1);
      target.clearTimeout(real);
      await Bun.sleep(5);
      expect(realFired).toBe(false);
    } finally {
      restore();
    }
    expect(target.Date).toBe(Date);
    expect(target.setTimeout).toBe(setTimeout);
    expect(target.Bun.sleep).toBe(Bun.sleep);
  });
});

describe("control protocol", () => {
  test("answers now and advance, and refuses anything else", async () => {
    const clock = new TestClock(EPOCH);
    expect(await answerTestClock(clock, "now")).toBe(String(EPOCH));
    expect(await answerTestClock(clock, "advance 1500")).toBe(
      String(EPOCH + 1500),
    );
    expect(await answerTestClock(clock, "  now  ")).toBe(String(EPOCH + 1500));
    expect(await answerTestClock(clock, "advance -1")).toStartWith("error ");
    expect(await answerTestClock(clock, "advance 1.5")).toStartWith("error ");
    expect(await answerTestClock(clock, "advance")).toStartWith("error ");
    expect(await answerTestClock(clock, "set 0")).toStartWith("error ");
    expect(clock.now()).toBe(EPOCH + 1500);
  });
});

describe("installTestClockFromEnv", () => {
  test("does nothing without the variable", () => {
    expect(installTestClockFromEnv({}, process)).toBeNull();
    expect(installTestClockFromEnv({ [TEST_CLOCK_ENV]: "" }, process)).toBe(
      null,
    );
  });

  test("the standalone binary refuses it", () => {
    const environment = { [TEST_CLOCK_ENV]: "/tmp/clock.sock" };
    expect(() =>
      installTestClockFromEnv(environment, {
        execPath: "/usr/local/bin/roamgate",
        argv: ["/usr/local/bin/roamgate"],
      }),
    ).toThrow(/standalone binary/);
    expect(environment[TEST_CLOCK_ENV]).toBe("/tmp/clock.sock");
  });

  test("refuses an epoch that is not epoch milliseconds", () => {
    expect(() =>
      installTestClockFromEnv(
        {
          [TEST_CLOCK_ENV]: "/tmp/clock.sock",
          ROAMGATE_TEST_CLOCK_EPOCH: "yesterday",
        },
        { execPath: "/usr/bin/bun", argv: ["/usr/bin/bun", "src/index.ts"] },
      ),
    ).toThrow(/epoch milliseconds/);
  });
});
