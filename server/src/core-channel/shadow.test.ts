import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Timers } from "./channel";
import type { ShadowSettings } from "./owners";
import {
  SHADOW_FILE,
  SHADOW_ROTATE_BYTES,
  type ShadowRequest,
  ShadowSampler,
} from "./shadow";

/** A clock only the test moves; timers fire when it passes them. */
function manualTimers() {
  let now = 1_000_000;
  const timers: { at: number; run: () => void }[] = [];
  const api: Timers & { advance: (ms: number) => void } = {
    now: () => now,
    setTimeout: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      const at = timers.indexOf(handle as never);
      if (at >= 0) timers.splice(at, 1);
    },
    advance: (ms) => {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
  };
  return api;
}

function sampler(
  options: {
    settings?: ShadowSettings;
    gaming?: () => boolean | null;
    random?: number;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "shadow-"));
  const timers = manualTimers();
  const warnings: string[] = [];
  let gameAsked = 0;
  const instance = new ShadowSampler({
    settings: () => options.settings ?? { enabled: true, rate: 1 },
    directory: dir,
    gameMode: async () => {
      gameAsked++;
      return options.gaming?.() ?? false;
    },
    warn: (message) => warnings.push(message),
    timers,
    random: () => options.random ?? 0,
  });
  return {
    instance,
    dir,
    timers,
    warnings,
    gameAsked: () => gameAsked,
    lines: () => {
      try {
        return readFileSync(join(dir, SHADOW_FILE), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function request(
  method: string,
  result: unknown,
  other: unknown,
): ShadowRequest {
  return {
    method,
    family: "f",
    owner: "bun",
    params: {},
    result,
    run: async () => other,
  };
}

describe("shadow reads", () => {
  test("drawn at the rate, never when disabled", async () => {
    const never = sampler({
      settings: { enabled: true, rate: 0.5 },
      random: 0.5,
    });
    expect(await never.instance.offer(request("m", 1, 1))).toBe("skipped");
    never.done();
    const off = sampler({ settings: { enabled: false, rate: 1 } });
    expect(await off.instance.offer(request("m", 1, 1))).toBe("skipped");
    off.done();
    const always = sampler({
      settings: { enabled: true, rate: 0.5 },
      random: 0.49,
    });
    expect(await always.instance.offer(request("m", 1, 1))).toBe("done");
    always.done();
  });

  test("once per method every 5 s, at most two at a time, cheap reads only", async () => {
    const s = sampler();
    expect(await s.instance.offer(request("a", 1, 1))).toBe("done");
    expect(await s.instance.offer(request("a", 1, 1))).toBe("skipped");
    expect(await s.instance.offer(request("b", 1, 1))).toBe("done");
    s.timers.advance(5000);
    expect(await s.instance.offer(request("a", 1, 1))).toBe("done");
    const hanging = (method: string): ShadowRequest => ({
      ...request(method, 1, 1),
      run: () => new Promise(() => {}),
    });
    const first = s.instance.offer(hanging("c"));
    const second = s.instance.offer(hanging("d"));
    await Bun.sleep(1);
    expect(await s.instance.offer(request("e", 1, 1))).toBe("skipped");
    s.timers.advance(10_000);
    expect(await first).toBe("done");
    expect(await second).toBe("done");
    expect(s.lines().map((line) => line.error)).toEqual([
      "no answer within 10 s, abandoned",
      "no answer within 10 s, abandoned",
    ]);
    // A run that gives up on the abort itself (the channel cancels the
    // call, rejecting it with "cancelled") still logs the deadline.
    s.timers.advance(5000);
    const cancelled = s.instance.offer({
      ...request("c", 1, 1),
      run: (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () =>
            reject(new Error("cancelled")),
          ),
        ),
    });
    await Bun.sleep(1);
    s.timers.advance(10_000);
    expect(await cancelled).toBe("done");
    expect(s.lines().at(-1)?.error).toBe("no answer within 10 s, abandoned");
    // A read the other side declines (it does not own what the read
    // needs) is skipped, not logged.
    s.timers.advance(5000);
    const lines = s.lines().length;
    expect(
      await s.instance.offer({
        ...request("g", 1, 1),
        run: () =>
          Promise.reject(
            Object.assign(new Error("the core does not own the reviews"), {
              code: "shadow_declined",
            }),
          ),
      }),
    ).toBe("skipped");
    expect(s.lines().length).toBe(lines);
    const big = "x".repeat(256 * 1024 + 1);
    expect(await s.instance.offer(request("f", big, big))).toBe("skipped");
    s.done();
  });

  test("paused while a game runs, GameMode asked at most every 30 s", async () => {
    let gaming = true;
    const s = sampler({ gaming: () => gaming });
    expect(await s.instance.offer(request("a", 1, 2))).toBe("skipped");
    gaming = false;
    s.timers.advance(5000);
    expect(await s.instance.offer(request("a", 1, 2))).toBe("skipped");
    expect(s.gameAsked()).toBe(1);
    s.timers.advance(30_000);
    expect(await s.instance.offer(request("a", 1, 2))).toBe("done");
    expect(s.gameAsked()).toBe(2);
    expect(s.lines()).toHaveLength(1);
    s.done();
  });

  test("compares answers as the wire carries them: undefined keys are absent", async () => {
    const s = sampler();
    expect(
      await s.instance.offer(
        request(
          "wire",
          { base: undefined, snapshot_id: undefined, entries: [1, undefined] },
          { entries: [1, null] },
        ),
      ),
    ).toBe("done");
    expect(s.lines()).toEqual([]);
    expect(s.warnings).toEqual([]);
    s.done();
  });

  test("differences are logged once and written, rotated past 5 MiB", async () => {
    const s = sampler();
    expect(await s.instance.offer(request("same", { a: 1 }, { a: 1 }))).toBe(
      "done",
    );
    expect(s.lines()).toEqual([]);
    expect(s.warnings).toEqual([]);
    await s.instance.offer(request("diff", { a: 1, b: [1] }, { a: "1" }));
    expect(s.warnings).toEqual([
      "diff on rust 2 difference(s): type $.a, missing $.b",
    ]);
    expect(s.lines()).toEqual([
      {
        at: new Date(s.timers.now()).toISOString(),
        method: "diff",
        family: "f",
        owner: "bun",
        diffs: [
          { path: "$.a", kind: "type", owner: "number", other: "string" },
          { path: "$.b", kind: "missing" },
        ],
        truncated: false,
      },
    ]);
    expect(statSync(join(s.dir, SHADOW_FILE)).mode & 0o777).toBe(0o600);
    writeFileSync(
      join(s.dir, SHADOW_FILE),
      "x".repeat(SHADOW_ROTATE_BYTES + 1),
    );
    await s.instance.offer(request("other", 1, 2));
    expect(statSync(join(s.dir, `${SHADOW_FILE}.1`)).size).toBe(
      SHADOW_ROTATE_BYTES + 1,
    );
    expect(s.lines()).toHaveLength(1);
    s.done();
  });
});
