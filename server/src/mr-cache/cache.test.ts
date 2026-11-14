import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForgeSession, ForgeStatus } from "../../../shared/forge";
import type { PullRequestStatus } from "../../../shared/pullRequest";
import { cardAnswerTtl } from "../workspace/pull-request";
import { forgeCacheTtl } from "../review/forge";
import {
  DEFAULT_MR_CACHE_SETTINGS,
  type MrCacheChange,
  createMrCache,
  normalizeMrCacheSettings,
} from "./cache";
import { mrCachePush } from "./push";

/** A forge that counts the reads it is asked for. */
function fakeForge(answers: (reads: number) => string = (n) => `v${n}`) {
  let reads = 0;
  return {
    reads: () => reads,
    load: async () => `${answers(++reads)}`,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(
  options: {
    path?: string | null;
    settings?: Partial<typeof DEFAULT_MR_CACHE_SETTINGS>;
  } = {},
) {
  const clock = { now: 1_000_000 };
  const changes: MrCacheChange[] = [];
  const cache = createMrCache({
    path: options.path ?? null,
    now: () => clock.now,
    settings: () => ({ ...DEFAULT_MR_CACHE_SETTINGS, ...options.settings }),
    publish: (change) => changes.push(change),
    saveDelayMs: 0,
  });
  return { clock, cache, changes };
}

const keep = (ms: number) => ({ ttl: () => ms });

describe("the MR cache", () => {
  test("a known answer is served without a forge call", async () => {
    const { cache } = setup();
    const forge = fakeForge();
    const a = await cache.get("k", { ...keep(60_000), load: forge.load });
    const b = await cache.get("k", { ...keep(60_000), load: forge.load });
    expect(forge.reads()).toBe(1);
    expect(a.value).toBe("v1");
    expect(b).toMatchObject({ value: "v1", stale: false });
  });

  test("an old answer is served at once and read again once, in the background", async () => {
    const { cache, clock, changes } = setup();
    const forge = fakeForge();
    await cache.get("k", { ...keep(60_000), load: forge.load });
    clock.now += 61_000;
    const old = await cache.get("k", { ...keep(60_000), load: forge.load });
    expect(old).toMatchObject({ value: "v1", stale: true });
    await settle();
    expect(forge.reads()).toBe(2);
    expect(cache.peek("k")?.value).toBe("v2");
    // The second device is told.
    expect(changes.at(-1)).toMatchObject({ key: "k", value: "v2" });
  });

  test("the TTL follows the state: running short, open at rest longer, settled longest", () => {
    const s = normalizeMrCacheSettings(undefined);
    const card = (request: any, ci?: string): PullRequestStatus => ({
      state: "ready",
      root: "/r",
      branch: "b",
      remotes: [],
      refreshedAt: "",
      request,
      ci,
    });
    const open = { state: "opened" };
    expect(cardAnswerTtl(card(open, "running"), s)).toBe(s.runningMs);
    expect(cardAnswerTtl(card(open, "success"), s)).toBe(s.openMs);
    expect(cardAnswerTtl(card({ state: "merged" }), s)).toBe(s.settledMs);
    expect(cardAnswerTtl({ ...card(undefined), state: "no_match" }, s)).toBe(
      s.noneMs,
    );
    expect(
      cardAnswerTtl({ ...card(undefined), state: "unauthenticated" }, s),
    ).toBe(s.unavailableMs);
    expect(cardAnswerTtl({ ...card(undefined), state: "error" }, s)).toBe(0);
    const chip = (request: any): ForgeStatus => ({
      ref: { provider: "gitlab", host: "h", project: "p/q", number: 1 },
      state: "ready",
      fetchedAt: "",
      request,
    });
    expect(
      forgeCacheTtl(
        chip({ state: "open", pipeline: { status: "running" } }),
        s,
      ),
    ).toBe(s.runningMs);
    expect(
      forgeCacheTtl(chip({ state: "open", pipeline: { status: "failed" } }), s),
    ).toBe(s.openMs);
    expect(forgeCacheTtl(chip({ state: "merged" }), s)).toBe(s.settledMs);
    expect(s.runningMs).toBeLessThan(s.openMs);
    expect(s.openMs).toBeLessThan(s.settledMs);
  });

  test("every surface asking at once shares one read", async () => {
    const { cache } = setup();
    let reads = 0;
    let release: (value: string) => void = () => {};
    const load = () => {
      reads++;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    const asks = [1, 2, 3, 4].map(() =>
      cache.get("k", { ...keep(1000), load }),
    );
    release("shared");
    const answers = await Promise.all(asks);
    expect(reads).toBe(1);
    expect(answers.map((answer) => answer.value)).toEqual(
      Array(4).fill("shared"),
    );
  });

  test("a negative lookup is cached, then read again after a commit, and at once on another branch", async () => {
    const { cache, clock } = setup();
    let head = "refs/heads/feature\nabc";
    const forge = fakeForge(
      (n) => ["", "no MR", "MR opened", "other branch"][n]!,
    );
    const ask = () =>
      cache.get("card", {
        ttl: () => 15 * 60_000,
        load: forge.load,
        head: async () => head,
      });
    expect((await ask()).value).toBe("no MR");
    clock.now += 60_000;
    expect((await ask()).value).toBe("no MR");
    expect(forge.reads()).toBe(1);
    // A new commit on the branch: the answer shows, a read follows.
    head = "refs/heads/feature\ndef";
    expect(await ask()).toMatchObject({ value: "no MR", stale: true });
    await settle();
    expect(cache.peek("card")?.value).toBe("MR opened");
    // Another branch in the checkout never gets the first one's answer.
    head = "refs/heads/other\n123";
    expect((await ask()).value).toBe("other branch");
  });

  test("a failed read keeps the answer and waits before the next one", async () => {
    const { cache, clock } = setup();
    let fail = false;
    let reads = 0;
    const options = {
      ttl: () => 1000,
      failed: (value: string) => value === "429",
      load: async () => {
        reads++;
        return fail ? "429" : "ok";
      },
    };
    await cache.get("k", options);
    fail = true;
    clock.now += 2000;
    await cache.get("k", options);
    await settle();
    expect(reads).toBe(2);
    expect(cache.peek("k")?.value).toBe("ok");
    // Within the backoff nothing is asked, however often.
    clock.now += 10_000;
    for (let i = 0; i < 5; i++) await cache.get("k", options);
    expect(reads).toBe(2);
    // After it, one more.
    clock.now += 60_000;
    await cache.get("k", options);
    await settle();
    expect(reads).toBe(3);
  });

  test("a forge that asked to be left alone is not read before its pause", async () => {
    const { cache, clock } = setup();
    const forge = fakeForge();
    let pause = 0;
    const options = {
      ...keep(1000),
      load: forge.load,
      pausedUntil: () => pause,
    };
    await cache.get("k", options);
    clock.now += 5000;
    pause = clock.now + 120_000;
    expect(await cache.get("k", options)).toMatchObject({ stale: true });
    await settle();
    expect(forge.reads()).toBe(1);
    clock.now += 121_000;
    await cache.get("k", options);
    await settle();
    expect(forge.reads()).toBe(2);
  });

  test("background reads stay within the budget per minute", async () => {
    const { cache, clock } = setup({ settings: { budgetPerMinute: 3 } });
    const forge = fakeForge();
    const keys = Array.from({ length: 8 }, (_, i) => `k${i}`);
    for (const key of keys)
      await cache.get(key, { ...keep(1000), load: forge.load });
    const before = forge.reads();
    // The budget was spent by the cold reads: switching around back and
    // forth later, past the TTL, asks the forge for nothing at first.
    clock.now += 5000;
    for (const key of keys)
      await cache.get(key, { ...keep(1000), load: forge.load });
    await settle();
    expect(forge.reads()).toBe(before);
    // A minute on, three more at most.
    clock.now += 60_000;
    for (const key of keys)
      await cache.get(key, { ...keep(1000), load: forge.load });
    await settle();
    expect(forge.reads() - before).toBe(3);
  });

  test("a click on refresh reads at once, for that key only", async () => {
    const { cache } = setup({ settings: { budgetPerMinute: 1 } });
    const a = fakeForge();
    const b = fakeForge();
    await cache.get("a", { ...keep(60_000), load: a.load });
    await cache.get("b", { ...keep(60_000), load: b.load });
    const refreshed = await cache.get("a", {
      ...keep(60_000),
      load: a.load,
      fresh: true,
    });
    expect(refreshed.value).toBe("v2");
    expect(a.reads()).toBe(2);
    expect(b.reads()).toBe(1);
  });

  test("a failed refresh does not take the known answer away", async () => {
    const { cache } = setup();
    let bad = false;
    const options = {
      ...keep(60_000),
      failed: (value: string) => value === "bad",
      load: async () => (bad ? "bad" : "good"),
    };
    await cache.get("k", options);
    bad = true;
    const answer = await cache.get("k", { ...options, fresh: true });
    expect(answer).toMatchObject({ value: "good", stale: true });
  });

  test("an invalidated key is read again", async () => {
    const { cache } = setup();
    const forge = fakeForge();
    await cache.get("card\0x", { ...keep(60_000), load: forge.load });
    cache.invalidate((key) => key.startsWith("card"));
    await cache.get("card\0x", { ...keep(60_000), load: forge.load });
    expect(forge.reads()).toBe(2);
  });

  test("answers survive a restart, and a cap forgets the oldest", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mr-cache-"));
    try {
      const path = join(directory, "mr-cache", "state.json");
      const first = setup({ path });
      const forge = fakeForge();
      await first.cache.get("k", { ...keep(60_000), load: forge.load });
      first.cache.flush();
      const second = createMrCache({
        path,
        now: () => first.clock.now + 1000,
      });
      const answer = await second.get("k", {
        ...keep(60_000),
        load: forge.load,
      });
      expect(answer).toMatchObject({ value: "v1", stale: false });
      expect(forge.reads()).toBe(1);

      const small = setup({ settings: { maxEntries: 50 } });
      for (let i = 0; i < 60; i++) {
        small.clock.now += 1;
        await small.cache.get(`k${i}`, { ...keep(60_000), load: forge.load });
      }
      expect(small.cache.size()).toBe(50);
      expect(small.cache.peek("k0")).toBeUndefined();
      expect(small.cache.peek("k59")).toBeDefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("settings: seconds, bounded, defaults for what is invalid", () => {
    expect(
      normalizeMrCacheSettings({
        running_seconds: 30,
        open_seconds: "soon",
        budget_per_minute: 0,
        max_entries: 200,
      }),
    ).toMatchObject({
      runningMs: 30_000,
      openMs: DEFAULT_MR_CACHE_SETTINGS.openMs,
      budgetPerMinute: DEFAULT_MR_CACHE_SETTINGS.budgetPerMinute,
      maxEntries: 200,
    });
  });
});

describe("what the clients are told", () => {
  test("a chip, a card and a session are pushed; nothing else", () => {
    const status = { ref: {}, state: "ready" } as unknown as ForgeStatus;
    expect(
      mrCachePush({ key: "chip\0h\0r", value: status, fetchedAt: 5 }),
    ).toEqual({
      kind: "status",
      status,
    });
    const card = { state: "ready", root: "/r", branch: "b" };
    expect(
      mrCachePush({ key: "card\0x", value: card, fetchedAt: 5 }),
    ).toMatchObject({
      kind: "card",
      status: card,
      fetchedAt: new Date(5).toISOString(),
    });
    const session = { repos: [] } as unknown as ForgeSession;
    expect(
      mrCachePush({ key: "session\0x", value: session, fetchedAt: 5 }),
    ).toEqual({
      kind: "session",
      session,
    });
    expect(mrCachePush({ key: "other", value: {}, fetchedAt: 5 })).toBeNull();
  });
});
