import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MrItem, MrReviewsPush } from "../../../shared/mrReviews";
import { updateGuiSettings } from "../config/gui-settings";
import { createMrReviews } from "./module";
import { openMrStore } from "./store";

// settings.json is this test's own.
const dir = mkdtempSync(join(tmpdir(), "mr-order-"));
const previousPath = process.env.ROAMGATE_SETTINGS_PATH;
process.env.ROAMGATE_SETTINGS_PATH = join(dir, "settings.json");
afterAll(() => {
  if (previousPath === undefined) delete process.env.ROAMGATE_SETTINGS_PATH;
  else process.env.ROAMGATE_SETTINGS_PATH = previousPath;
  rmSync(dir, { recursive: true, force: true });
});

const HOST = "gl.example";
const item = (n: number, extra: Partial<MrItem> = {}): MrItem => ({
  provider: "gitlab",
  host: HOST,
  project: "g/p",
  number: n,
  key: `gitlab:${HOST}/g/p#${n}`,
  url: `https://${HOST}/g/p/-/merge_requests/${n}`,
  title: `MR ${n}`,
  author: "alice",
  draft: false,
  state: "open",
  updatedAt: `2026-11-0${n}T00:00:00Z`,
  headSha: "a".repeat(40),
  sourceBranch: "x",
  targetBranch: "main",
  pipeline: null,
  notes: 0,
  reasons: [],
  ...extra,
});
const key = (n: number) => item(n).key;

/** 1 and 2 are for the user, 3 to 6 are suggestions (6 the best scored). */
async function setup() {
  await updateGuiSettings((current) => ({
    ...current,
    mr_reviews: {
      hosts: [{ host: HOST, provider: "gitlab" }],
    },
  }));
  const store = openMrStore(join(dir, `state-${Math.random()}.json`));
  store.update((state) => {
    state.items = [
      item(1, { reasons: ["review_requested"] }),
      item(2, { reasons: ["assigned"] }),
      item(3),
      item(4),
      item(5),
      item(6),
    ];
    for (const n of [3, 4, 5, 6])
      state.ranked[key(n)] = {
        updatedAt: item(n).updatedAt,
        version: "v",
        pick: true,
        score: n * 10,
        reason: `reason ${n}`,
        at: "t",
      };
  });
  const pushes: MrReviewsPush[] = [];
  const reviews = createMrReviews({
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    store,
    discoverHosts: () => [],
    publish: (push) => pushes.push(push),
  });
  const shown = async (section: "pinned" | "mine" | "suggested") =>
    (await reviews.order.view()).sections[section].map((entry) => entry.number);
  const call = (method: string, params: Record<string, unknown> = {}) =>
    reviews.handle(`bridge.mr_reviews.${method}`, params) as Promise<any>;
  return { reviews, pushes, shown, call };
}

const persisted = () =>
  JSON.parse(readFileSync(process.env.ROAMGATE_SETTINGS_PATH!, "utf8"))
    .mr_reviews;

describe("the user's order on the server", () => {
  beforeEach(async () => {
    await updateGuiSettings((current) => ({ ...current, mr_reviews: {} }));
  });

  test("an operation is applied, saved with a version and pushed", async () => {
    const t = await setup();
    // The inbox's own order: suggestions by score.
    expect(await t.shown("suggested")).toEqual([6, 5, 4, 3]);
    const result = await t.reviews.order.apply(
      { op: "top", keys: [key(3), key(4)] },
      {
        by: "agent",
        undoable: true,
        describe: (moved) => `Claude moved ${moved.length}`,
      },
    );
    expect(result.changed).toBe(true);
    expect(await t.shown("suggested")).toEqual([3, 4, 6, 5]);
    expect(t.pushes).toHaveLength(1);
    expect(t.pushes[0]).toMatchObject({
      version: 1,
      by: "agent",
      summary: "Claude moved 2",
      undo: 1,
      changed: ["order"],
    });
    expect(t.pushes[0]!.order.slice(0, 4)).toEqual([
      key(2),
      key(1),
      key(3),
      key(4),
    ]);
    // The inbox every page reads carries the order and its version.
    const inbox = (await t.call("inbox", { viewer: false })) as any;
    expect(inbox.orderVersion).toBe(1);
    expect(inbox.order).toEqual(t.pushes[0]!.order);
    // Persisted atomically in settings.json.
    expect(persisted().order_version).toBe(1);
    expect(persisted().order).toEqual(t.pushes[0]!.order);
    // Nothing changed: no new version, no push.
    await t.reviews.order.apply({ op: "top", keys: [key(3)] }, { by: "agent" });
    expect(t.pushes).toHaveLength(1);
  });

  test("the manual order wins over the inbox's sort, in Suggested and every section", async () => {
    const t = await setup();
    await t.call("order", { op: "bottom", keys: [key(6)] });
    await t.call("order", { op: "top", keys: [key(2)] });
    expect(await t.shown("suggested")).toEqual([5, 4, 3, 6]);
    expect(await t.shown("mine")).toEqual([2, 1]);
    // A new suggestion (no place yet) shows first, then the order stands.
    t.reviews.store.update((state) => {
      state.items.push(item(7));
      state.ranked[key(7)] = {
        updatedAt: item(7).updatedAt,
        version: "v",
        pick: true,
        score: 1,
        reason: "r",
        at: "t",
      };
    });
    expect(await t.shown("suggested")).toEqual([7, 5, 4, 3, 6]);
    // The inbox's sort changing (a better score) does not reshuffle it.
    t.reviews.store.update((state) => {
      state.ranked[key(3)]!.score = 99;
    });
    expect(await t.shown("suggested")).toEqual([7, 5, 4, 3, 6]);
  });

  test("concurrent changes from the user and the agent both apply", async () => {
    const t = await setup();
    await Promise.all([
      t.call("order", { op: "top", keys: [key(3)] }),
      t.reviews.order.apply({ op: "bottom", keys: [key(6)] }, { by: "agent" }),
      t.call("order", { op: "before", keys: [key(4)], target: key(5) }),
    ]);
    expect(await t.shown("suggested")).toEqual([3, 4, 5, 6]);
    expect(t.pushes.map((push) => push.version)).toEqual([1, 2, 3]);
  });

  test("a stale whole list is rebased, not written over the latest order", async () => {
    const t = await setup();
    // A page loads the inbox at version 0...
    const first = (await t.call("inbox", { viewer: false })) as any;
    expect(first.orderVersion).toBe(0);
    // ... the agent moves 3 to the top and the user moves 6 down...
    await t.reviews.order.apply({ op: "top", keys: [key(3)] }, { by: "agent" });
    await t.call("order", { op: "bottom", keys: [key(6)] });
    expect(await t.shown("suggested")).toEqual([3, 5, 4, 6]);
    // ... then the stale page, which saw [2 1 | 6 5 4 3], saves the whole
    // list with only 4 moved to the top of Suggested.
    await t.call("settings.update", {
      settings: {
        order: [key(2), key(1), key(4), key(6), key(5), key(3)],
        orderVersion: 0,
      },
    });
    // Its move is applied; the agent's and the user's stay.
    expect(await t.shown("suggested")).toEqual([4, 3, 5, 6]);
  });

  test("undo takes the change back, on the latest order", async () => {
    const t = await setup();
    await t.reviews.order.apply(
      { op: "top", keys: [key(3)] },
      { by: "agent", undoable: true, describe: () => "Claude moved 1" },
    );
    const version = t.pushes[0]!.undo!;
    // The user moved another one meanwhile.
    await t.call("order", { op: "bottom", keys: [key(6)] });
    await t.call("order", { op: "undo", version });
    // 3 is back where it was (the end); the user's own move stands.
    expect(await t.shown("suggested")).toEqual([5, 4, 6, 3]);
    // Nothing since: back to the order as it was.
    await t.reviews.order.apply(
      { op: "top", keys: [key(4)] },
      { by: "agent", undoable: true },
    );
    await t.call("order", { op: "undo", version: t.pushes.at(-1)!.undo! });
    expect(await t.shown("suggested")).toEqual([5, 4, 6, 3]);
    await expect(t.call("order", { op: "undo", version: 999 })).rejects.toThrow(
      /undone/,
    );
  });

  test("unknown keys and other sections are reported", async () => {
    const t = await setup();
    const result = await t.reviews.order.apply(
      { op: "after", keys: [key(3), key(1), "ghost"], target: key(6) },
      { by: "agent" },
    );
    expect(result.unknown).toEqual(["ghost"]);
    expect(result.elsewhere).toEqual([key(1)]);
    expect(result.moved).toEqual([key(3)]);
    expect(await t.shown("suggested")).toEqual([6, 3, 5, 4]);
    await expect(
      t.call("order", { op: "sideways", keys: [key(1)] }),
    ).rejects.toThrow(/op/);
  });

  test("pins and removals take a version and are pushed too", async () => {
    const t = await setup();
    await t.call("hide", {
      key: key(3),
      by: "agent",
      summary: "Claude removed",
    });
    expect(t.pushes.at(-1)).toMatchObject({
      changed: ["hidden"],
      by: "agent",
      summary: "Claude removed",
    });
    // An agent's removal can be taken back too.
    expect(t.pushes.at(-1)!.undo).toBe(1);
    await t.call("unhide", { key: key(3) });
    expect(t.pushes.map((push) => push.version)).toEqual([1, 2]);
    await t.call("hide", { key: key(4), by: "agent", summary: "x" });
    await t.call("order", { op: "undo", version: t.pushes.at(-1)!.undo! });
    expect(await t.shown("suggested")).toContain(4);
  });

  test("Undo takes back an agent's override, unless changed since", async () => {
    const t = await setup();
    await t.call("override", {
      key: key(1),
      set: { next: "ping bob", labels: ["infra"] },
    });
    await t.call("override", {
      key: key(1),
      set: { whose: "reviewer", next: "wait for bob" },
      by: "agent",
      summary: "Claude set the next step",
    });
    const push = t.pushes.at(-1)!;
    expect(push).toMatchObject({ changed: ["overrides"], by: "agent" });
    await t.call("override", { key: key(2), set: { next: "mine" } });
    await t.call("order", { op: "undo", version: push.undo! });
    const settings = await t.reviews.settings();
    expect(settings.overrides[key(1)]).toMatchObject({
      next: "ping bob",
      labels: ["infra"],
    });
    expect(settings.overrides[key(1)]!.whose).toBeUndefined();
    // The user's own change after it stands.
    expect(settings.overrides[key(2)]!.next).toBe("mine");
    // Changed again since: kept as it is.
    await t.call("override", {
      key: key(2),
      set: { next: "agent's" },
      by: "agent",
    });
    const second = t.pushes.at(-1)!.undo!;
    await t.call("override", { key: key(2), set: { next: "user's" } });
    await t.call("order", { op: "undo", version: second });
    expect((await t.reviews.settings()).overrides[key(2)]!.next).toBe("user's");
  });

  test("the order and its version survive a restart", async () => {
    const t = await setup();
    await t.call("order", { op: "top", keys: [key(4)] });
    await t.call("order", { op: "top", keys: [key(5)] });
    // A new server on the same settings.json: same order, next version.
    const again = createMrReviews({
      run: async () => ({ code: 1, stdout: "", stderr: "" }),
      store: t.reviews.store,
      discoverHosts: () => [],
    });
    expect((await again.order.view()).version).toBe(2);
    expect(
      (await again.order.view()).sections.suggested.map((e) => e.number),
    ).toEqual([5, 4, 6, 3]);
  });

  test("two clients follow the same order, by push or by the next poll", async () => {
    const t = await setup();
    /** A page: what it holds, and how it takes a push or a poll. */
    const client = () => {
      const page = { order: [] as string[], version: 0 };
      return {
        page,
        push: (push: MrReviewsPush) => {
          if (push.version <= page.version) return;
          page.order = push.order;
          page.version = push.version;
        },
        poll: async () => {
          const inbox = (await t.call("inbox", { viewer: false })) as any;
          if ((inbox.orderVersion ?? 0) > page.version) {
            page.order = inbox.order ?? [];
            page.version = inbox.orderVersion;
          }
        },
      };
    };
    const desktop = client();
    const phone = client();
    let delivered = 0;
    const deliver = () => {
      for (const push of t.pushes.slice(delivered)) {
        desktop.push(push);
        // The phone's connection drops after the first push.
        if (delivered === 0) phone.push(push);
        delivered++;
      }
    };
    await t.reviews.order.apply({ op: "top", keys: [key(3)] }, { by: "agent" });
    await t.call("order", { op: "bottom", keys: [key(3)] });
    await t.call("order", { op: "top", keys: [key(5)] });
    deliver();
    expect(desktop.page.version).toBe(3);
    expect(desktop.page.order).toEqual(persisted().order);
    expect(phone.page.version).toBe(1);
    // Reconnected, the phone's next poll catches up to the same order.
    await phone.poll();
    expect(phone.page).toEqual(desktop.page);
    // A push the desktop already had (or an older one) changes nothing.
    desktop.push(t.pushes[0]!);
    expect(desktop.page.version).toBe(3);
  });
});
