import { afterEach, describe, expect, test } from "bun:test";
import { ownershipChanged, setOwnershipCheck } from "../core-channel/owners";
import {
  mrCacheLoad,
  mrCacheRelease,
  setMrCacheCore,
  sharedMrCache,
} from "./shared";

/** A core that keeps nothing: each get asks the reader back, as a miss. */
function fakeCore() {
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  return {
    calls,
    callInternal: async (family: string, op: string, params: unknown) => {
      expect(family).toBe("mr_cache");
      const p = params as Record<string, unknown>;
      calls.push({ op, params: p });
      if (op !== "get") return {};
      const paused = (await mrCacheLoad({
        token: p.token,
        op: "paused",
        value: "known",
      })) as { paused_until: number };
      const loaded = (await mrCacheLoad({ token: p.token, op: "load" })) as {
        value?: unknown;
        error?: string;
        ttl_ms?: number;
        failed?: boolean;
        paused_until: number;
      };
      if (loaded.error)
        throw Object.assign(new Error(loaded.error), { code: "load_failed" });
      return {
        value: { loaded, paused },
        fetchedAt: 5,
        stale: false,
      };
    },
  };
}

function give(toCore: boolean) {
  setOwnershipCheck((family) => !(toCore && family === "mr_cache"));
  ownershipChanged();
}

afterEach(() => {
  give(false);
  setMrCacheCore(null);
  setOwnershipCheck(null);
});

describe("the MR cache while the core owns it", () => {
  test("a read asks the core, which asks the reader back for the forge read and its pause", async () => {
    const core = fakeCore();
    setMrCacheCore(core);
    give(true);
    const answer = await sharedMrCache().get<unknown>("card\0k", {
      ttl: (value) => (value === "v" ? 60_000 : 0),
      load: async () => "v",
      head: async () => "refs/heads/a\nabc",
      failed: () => false,
      pausedUntil: (value) => (value === "known" ? 42 : 7),
    });
    expect(core.calls[0]).toMatchObject({
      op: "get",
      params: { key: "card\0k", fresh: false, head: "refs/heads/a\nabc" },
    });
    expect(answer).toEqual({
      value: {
        loaded: { value: "v", ttl_ms: 60_000, failed: false, paused_until: 7 },
        paused: { paused_until: 42 },
      },
      fetchedAt: 5,
      stale: false,
    });
  });

  test("a failed read reaches the caller; a core that does not answer leaves the read uncached", async () => {
    const core = fakeCore();
    setMrCacheCore(core);
    give(true);
    await expect(
      sharedMrCache().get("chip\0k", {
        ttl: () => 1000,
        load: async () => {
          throw new Error("glab failed");
        },
      }),
    ).rejects.toThrow("glab failed");
    setMrCacheCore({
      callInternal: async () => {
        throw new Error("core gone");
      },
    });
    const answer = await sharedMrCache().get("chip\0k", {
      ttl: () => 1000,
      load: async () => "direct",
    });
    expect(answer).toMatchObject({ value: "direct", stale: false });
  });

  test("Bun's own answers go when the core takes the family, and come from the file after the core wrote it", async () => {
    const core = fakeCore();
    setMrCacheCore(core);
    let reads = 0;
    const ask = () =>
      sharedMrCache().get("k", {
        ttl: () => 60_000,
        load: async () => ++reads,
      });
    expect((await ask()).value).toBe(1);
    expect((await ask()).value).toBe(1);
    give(true);
    expect(sharedMrCache().peek("k")).toBeUndefined();
    expect(await mrCacheRelease()).toEqual({});
    give(false);
    // Back to Bun: the core was asked to write its file first.
    expect(core.calls.at(-1)?.op).toBe("flush");
    // Tests keep no file: the answer is read again.
    expect((await ask()).value).toBe(2);
    await expect(mrCacheLoad({ token: "nope", op: "load" })).rejects.toThrow(
      "unknown MR cache reader",
    );
  });
});
