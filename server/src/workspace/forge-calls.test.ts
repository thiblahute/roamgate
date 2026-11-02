import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createLogger } from "../utils/logger";
import {
  ForgeBusyError,
  type ProcessOutput,
  createForgeGate,
  rateLimitPause,
  splitIncluded,
} from "./forge-calls";

const ok = (body: unknown, headers: string[] = []): ProcessOutput => ({
  code: 0,
  stdout: `HTTP/2.0 200 OK\r\n${headers.join("\r\n")}\r\n\r\n${JSON.stringify(body)}`,
  stderr: "",
});

function gate(options: { perMinute?: number; concurrency?: number } = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
  });
  return { gate: createForgeGate({ ...options, logger }), lines };
}

const call = { host: "gitlab.example.com", feature: "badge", kind: "mr-list" };
const argv = ["glab", "api", "--hostname", "gitlab.example.com", "projects/1"];

describe("the forge gate", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test("keeps to its calls per minute, queueing the rest in order", async () => {
    const { gate: g } = gate({ perMinute: 2 });
    const owner = {};
    const started: number[] = [];
    const spawn = async () => {
      started.push(Date.now());
      return ok({});
    };
    const t0 = Date.now();
    const answers = [1, 2, 3].map(() => g.run(owner, call, argv, spawn));
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toHaveLength(2);
    jest.advanceTimersByTime(59_000);
    await Promise.resolve();
    expect(started).toHaveLength(2);
    jest.advanceTimersByTime(1_000);
    await Promise.all(answers);
    expect(started).toHaveLength(3);
    expect(started[2]! - t0).toBe(60_000);
    // Another forge host has its own budget.
    await g.run(owner, { ...call, host: "github.com" }, argv, spawn);
    expect(started).toHaveLength(4);
  });

  test("a call that cannot start before its deadline gives up", async () => {
    const { gate: g } = gate({ perMinute: 1 });
    const owner = {};
    await g.run(owner, call, argv, async () => ok({}));
    const late = g.run(
      owner,
      { ...call, deadline: Date.now() + 5_000 },
      argv,
      async () => ok({}),
    );
    jest.advanceTimersByTime(5_000);
    await expect(late).rejects.toBeInstanceOf(ForgeBusyError);
  });

  test("a 429 pauses the host for Retry-After, then calls go on", async () => {
    const { gate: g } = gate();
    const owner = {};
    const limited: ProcessOutput = {
      code: 1,
      stdout: "HTTP/2.0 429 Too Many Requests\r\nRetry-After: 30\r\n\r\n{}",
      stderr: "glab: HTTP 429",
    };
    const first = await g.run(
      owner,
      { ...call, include: true },
      argv,
      async () => limited,
    );
    expect(first.status).toBe(429);
    expect(first.code).toBe(1);
    expect(g.pausedUntil(owner, "", call.host)).toBe(Date.now() + 30_000);
    let started = false;
    const next = g.run(owner, call, argv, async () => {
      started = true;
      return ok({});
    });
    jest.advanceTimersByTime(29_000);
    await Promise.resolve();
    expect(started).toBe(false);
    jest.advanceTimersByTime(1_000);
    await next;
    expect(started).toBe(true);
  });

  test("RateLimit-Remaining 0 waits for the reset; a bare 429 a minute", () => {
    const now = Date.parse("2026-11-02T19:00:00Z");
    expect(
      rateLimitPause(
        200,
        new Map([
          ["ratelimit-remaining", "0"],
          ["ratelimit-reset", String(now / 1000 + 120)],
        ]),
        now,
      ),
    ).toBe(now + 120_000);
    expect(rateLimitPause(429, new Map(), now)).toBe(now + 60_000);
    expect(
      rateLimitPause(200, new Map([["x-ratelimit-remaining", "4000"]]), now),
    ).toBeNull();
    expect(
      rateLimitPause(
        429,
        new Map([["retry-after", "Mon, 02 Nov 2026 19:00:10 GMT"]]),
        now,
      ),
    ).toBe(now + 10_000);
  });

  test("a 429 seen only on stderr pauses the host too", async () => {
    const { gate: g } = gate();
    const owner = {};
    await g.run(owner, call, argv, async () => ({
      code: 1,
      stdout: "",
      stderr: "glab: 429 Too Many Requests (HTTP 429)",
    }));
    expect(g.pausedUntil(owner, "", call.host)).toBe(Date.now() + 60_000);
  });

  test("GETs come back with If-None-Match; a 304 answers with what was known", async () => {
    const { gate: g, lines } = gate();
    const owner = {};
    const seen: string[][] = [];
    const first = await g.run(
      owner,
      { ...call, conditional: true },
      argv,
      async (final) => {
        seen.push(final);
        return ok({ id: 1 }, ['Etag: W/"abc"']);
      },
    );
    expect(JSON.parse(first.stdout)).toEqual({ id: 1 });
    expect(seen[0]).toEqual([
      "glab",
      "api",
      "--include",
      "--hostname",
      "gitlab.example.com",
      "projects/1",
    ]);
    const second = await g.run(
      owner,
      { ...call, conditional: true },
      argv,
      async (final) => {
        seen.push(final);
        return {
          code: 1,
          stdout: 'HTTP/2.0 304 Not Modified\r\nEtag: W/"abc"\r\n\r\n',
          stderr: "glab: HTTP 304",
        };
      },
    );
    expect(seen[1]).toContain("--header");
    expect(seen[1]).toContain('If-None-Match: W/"abc"');
    expect(second.code).toBe(0);
    expect(second.notModified).toBe(true);
    expect(JSON.parse(second.stdout)).toEqual({ id: 1 });
    // One debug line per call: host, feature and kind.
    const logged = lines.filter((line) => line.includes("forge call"));
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("feature=badge");
    expect(logged[0]).toContain("kind=mr-list");
    expect(logged[0]).toContain("host=gitlab.example.com");
    expect(logged[1]).toContain("not_modified=true");
  });

  test("identical calls share one in flight and its answer for a while; failures are not kept", async () => {
    const { gate: g, lines } = gate();
    const owner = {};
    let calls = 0;
    const spawn = async () => {
      calls++;
      return ok({ n: calls });
    };
    const reuse = { ...call, reuseMs: 10_000 };
    const [a, b] = await Promise.all([
      g.run(owner, reuse, argv, spawn),
      g.run(owner, reuse, argv, spawn),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    // Another feature asking the same thing shares it too.
    await g.run(owner, { ...reuse, feature: "chip" }, argv, spawn);
    expect(calls).toBe(1);
    jest.advanceTimersByTime(10_000);
    await g.run(owner, reuse, argv, spawn);
    expect(calls).toBe(2);
    const failing = async () => {
      calls++;
      return { code: 1, stdout: "", stderr: "HTTP 500" };
    };
    const other = [...argv, "x"];
    await g.run(owner, reuse, other, failing);
    await g.run(owner, reuse, other, failing);
    expect(calls).toBe(4);
    expect(lines.filter((line) => line.includes("forge call"))).toHaveLength(4);
  });

  test("the response headers are cut off the body", () => {
    expect(
      splitIncluded(
        "HTTP/1.1 100 Continue\r\n\r\nHTTP/2.0 201 Created\nETag: x\n\n[1]",
      ),
    ).toEqual({ status: 201, headers: new Map([["etag", "x"]]), body: "[1]" });
    expect(splitIncluded("[1]").body).toBe("[1]");
    expect(splitIncluded("[1]").status).toBeUndefined();
  });
});
