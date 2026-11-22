import { expect, jest, mock, test } from "bun:test";

// Mocks the bridge and the store for the whole process: in a process of
// its own, so no other test sees them.
if (process.env.ROAMGATE_REVIEW_LOAD_TEST !== "1") {
  test("review loading in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_REVIEW_LOAD_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 15_000);
} else {
  // A connection that is not ready answers the first list with an error and
  // keeps the same runtime once it is.
  let ready = false;
  const calls: string[] = [];
  /** Answers of the other connections, by connection, made by the tests. */
  const answers = new Map<
    string,
    (method?: string, params?: Record<string, unknown>) => Promise<unknown>
  >();
  const sentParams: unknown[] = [];
  const snapshot = (id: string, connectionId: string) => ({
    session: {
      id,
      connectionId,
      root: "/r",
      title: id,
      target: { kind: "range", base: "main", head: "HEAD" },
      summary: "",
      agent: {},
      createdAt: "2026-10-30",
      updatedAt: "2026-10-30",
    },
    threads: [],
  });
  const summary = (id: string, connectionId: string) => ({
    ...snapshot(id, connectionId),
    threads: undefined,
    counts: { threads: 0, open: 0, drafts: 0, comments: 0, waiting: 0 },
  });
  mock.module("./api", () => ({
    bridge: {
      callConnection: (
        connectionId: string,
        method: string,
        params?: unknown,
      ) => connectionClient(connectionId).call(method, params),
    },
  }));
  const connectionClient = (connectionId: string) => ({
    call: async (method: string, params?: unknown) => {
      if (connectionId !== "desktop") {
        calls.push(`${connectionId}:${method}`);
        sentParams.push(params);
        return answers.get(connectionId)!(
          method,
          params as Record<string, unknown>,
        );
      }
      calls.push(method);
      if (!ready) throw new Error("connection is not ready: desktop");
      return method === "review.list"
        ? { sessions: [snapshot("s1", "desktop")] }
        : {};
    },
  });
  /** Lists saved before a reload, by connection, and the ones saved since. */
  const savedLists = new Map<string, unknown>();
  const savedSince: Array<[string, unknown]> = [];
  mock.module("./reviewListCache", () => ({
    readReviewListCache: async (connectionId: string) =>
      savedLists.get(connectionId) ?? null,
    saveReviewListCache: (connectionId: string, value: unknown) => {
      savedSince.push([connectionId, value]);
    },
  }));
  mock.module("./store", () => ({
    store: {
      get: () => ({
        connections: ["desktop", "a", "b", "c", "d", "e", "f"].map((id) => ({
          id,
          generation: 1,
        })),
      }),
      subscribe: () => () => {},
    },
  }));

  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  test("a list refused before the connection is ready is tried again", async () => {
    jest.useFakeTimers();
    try {
      const { loadReviews, getReviewSummary } = await import("./review");
      await expect(loadReviews("desktop")).rejects.toThrow("not ready");
      expect(calls).toEqual(["review.list"]);
      // Still not ready a second later: tried again, then later still.
      jest.advanceTimersByTime(1000);
      await settle();
      expect(calls).toEqual(["review.list", "review.list"]);
      ready = true;
      jest.advanceTimersByTime(2000);
      await settle();
      expect(getReviewSummary("s1")).toBeTruthy();
      // Loaded: no more tries.
      const made = calls.filter((call) => call === "review.list").length;
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(calls.filter((call) => call === "review.list").length).toBe(made);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a connection left failing late does not cancel the next one's retry", async () => {
    jest.useFakeTimers();
    try {
      const { loadReviews, getReviewSummary } = await import("./review");
      calls.length = 0;
      // A answers slowly; the user moved to B, which is not ready yet.
      let failA!: (error: Error) => void;
      answers.set(
        "a",
        () =>
          new Promise((_, reject) => {
            failA = reject;
          }),
      );
      answers.set("b", async () => {
        throw new Error("connection is not ready: b");
      });
      const loadingA = loadReviews("a").catch(() => {});
      await expect(loadReviews("b")).rejects.toThrow("not ready");
      // A fails only now.
      failA(new Error("connection is not ready: a"));
      await loadingA;
      answers.set("b", async () => ({ sessions: [snapshot("sb", "b")] }));
      jest.advanceTimersByTime(1000);
      await settle();
      // The lists asked for (other calls may follow a loaded one).
      expect(calls.filter((call) => call.endsWith(":review.list"))).toEqual([
        "a:review.list",
        "b:review.list",
        "b:review.list",
      ]);
      expect(getReviewSummary("sb")).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a malformed session in a list is dropped, the others kept", async () => {
    const { loadReviews, getReviewSummary } = await import("./review");
    const broken = snapshot("broken", "c") as Record<string, unknown>;
    broken.threads = [{ id: "t", kind: "draft", comments: [{ id: 1 }] }];
    answers.set("c", async () => ({
      sessions: [snapshot("fine", "c"), broken, null, { session: {} }],
    }));
    await loadReviews("c");
    expect(getReviewSummary("fine")).toBeTruthy();
    expect(getReviewSummary("broken")).toBeUndefined();
  });

  test("the connections whose list loaded are known", async () => {
    const { loadedReviewConnections } = await import("./review");
    expect(loadedReviewConnections().has("c")).toBe(true);
    expect(loadedReviewConnections().has("a")).toBe(false);
  });

  test("a list again sends only the reviews that changed", async () => {
    const { loadReviews, getReviewSummary } = await import("./review");
    answers.set("d", async () => ({
      version: 1,
      summaries: [summary("d1", "d"), summary("d2", "d")],
      stamps: { d1: "x1", d2: "x2" },
    }));
    await loadReviews("d");
    expect(getReviewSummary("d2")).toBeTruthy();
    sentParams.length = 0;
    // d1 unchanged, d2 gone since.
    answers.set("d", async () => ({
      version: 1,
      summaries: [],
      unchanged: ["d1"],
      stamps: { d1: "x1" },
    }));
    await loadReviews("d");
    expect(sentParams[0]).toEqual({
      known: { d1: "x1", d2: "x2" },
      limit: 1000,
      summaries: 1,
    });
    expect(getReviewSummary("d1")).toBeTruthy();
    expect(getReviewSummary("d2")).toBeUndefined();
  });

  test("a load asked while one runs joins it", async () => {
    const { loadReviews } = await import("./review");
    let answer!: (value: unknown) => void;
    let asked = 0;
    answers.set("a", () =>
      asked++ === 0
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : Promise.resolve({}),
    );
    calls.length = 0;
    const first = loadReviews("a");
    const second = loadReviews("a");
    await settle();
    answer({ sessions: [snapshot("a1", "a")], stamps: { a1: "s" } });
    await Promise.all([first, second]);
    expect(calls.filter((call) => call === "a:review.list")).toEqual([
      "a:review.list",
    ]);
  });

  test("after a reload, the list saved before sends only what changed", async () => {
    const { loadReviews, getReviewSummary } = await import("./review");
    savedLists.set("e", {
      stamps: { e1: "s1", e2: "s2" },
      summaries: [summary("e1", "e"), summary("e2", "e")],
    });
    sentParams.length = 0;
    savedSince.length = 0;
    answers.set("e", async () => ({
      version: 1,
      summaries: [summary("e3", "e")],
      unchanged: ["e1"],
      stamps: { e1: "s1", e3: "s3" },
    }));
    await loadReviews("e");
    expect(sentParams[0]).toEqual({
      known: { e1: "s1", e2: "s2" },
      limit: 1000,
      summaries: 1,
    });
    expect(getReviewSummary("e1")).toBeTruthy();
    expect(getReviewSummary("e2")).toBeUndefined();
    expect(getReviewSummary("e3")).toBeTruthy();
    // Saved again for the next reload, with the new stamps.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [connection, saved] = savedSince[0] as [
      string,
      {
        stamps: Record<string, string>;
        summaries: { session: { id: string } }[];
      },
    ];
    expect(connection).toBe("e");
    expect(saved.stamps).toEqual({ e1: "s1", e3: "s3" });
    expect(saved.summaries.map((each) => each.session.id).sort()).toEqual([
      "e1",
      "e3",
    ]);
  });

  test("a device with no reviews yet reads the list in pages", async () => {
    const { loadReviews, getReviewSummary } = await import("./review");
    const pages = [
      {
        version: 1,
        summaries: [summary("f1", "f")],
        unchanged: [],
        stamps: { f1: "s1" },
        remaining: 1,
      },
      {
        version: 1,
        summaries: [summary("f2", "f")],
        unchanged: ["f1"],
        stamps: { f1: "s1", f2: "s2" },
        remaining: 0,
      },
    ];
    sentParams.length = 0;
    answers.set("f", async () => pages.shift() ?? {});
    await loadReviews("f");
    expect(sentParams.slice(0, 2)).toEqual([
      { known: {}, limit: 1000, summaries: 1 },
      { known: { f1: "s1" }, limit: 1000, summaries: 1 },
    ]);
    expect(getReviewSummary("f1")).toBeTruthy();
    expect(getReviewSummary("f2")).toBeTruthy();
  });

  test("a view's want reads its reviews whole in one call; pushes keep them current", async () => {
    const {
      acceptReviewPush,
      getReviewSnapshot,
      getReviewSummary,
      loadReviews,
      wantReviews,
    } = await import("./review");
    const asked: unknown[] = [];
    answers.set("g", async (method, params) => {
      if (method === "review.list")
        return {
          version: 1,
          summaries: [
            summary("g1", "g"),
            {
              ...summary("g2", "g"),
              session: { ...summary("g2", "g").session, root: "/other" },
            },
          ],
        };
      if (method === "review.snapshots") {
        asked.push(params?.ids);
        return {
          snapshots: (params!.ids as string[]).map((id) => snapshot(id, "g")),
          missing: [],
        };
      }
      return {};
    });
    await loadReviews("g");
    // Listed: summaries only.
    expect(getReviewSummary("g1")).toBeTruthy();
    expect(getReviewSnapshot("g1")).toBeUndefined();
    const release = wantReviews({ connectionId: "g", roots: ["/r/"] });
    await settle();
    expect(asked).toEqual([["g1"]]);
    expect(getReviewSnapshot("g1")?.threads).toEqual([]);
    expect(getReviewSnapshot("g2")).toBeUndefined();
    // A second view wanting the same reads nothing more.
    const again = wantReviews({ connectionId: "g", roots: ["/r"] });
    await settle();
    expect(asked).toHaveLength(1);
    const thread = {
      id: "t1",
      sessionId: "g1",
      kind: "discussion",
      anchor: {},
      comments: [
        {
          id: "c1",
          author: "claude",
          body: "Done",
          createdAt: "x",
          updatedAt: "x",
        },
      ],
      resolved: false,
      createdAt: "x",
      updatedAt: "x",
    };
    acceptReviewPush({
      type: "session",
      snapshot: { ...snapshot("g1", "g"), threads: [thread] },
    } as never);
    expect(getReviewSnapshot("g1")?.threads).toHaveLength(1);
    expect(getReviewSummary("g1")?.counts).toEqual({
      threads: 1,
      open: 1,
      drafts: 0,
      comments: 1,
      waiting: 1,
    });
    release();
    again();
  });

  test("a snapshot no view wants is let go after a while, its summary kept", async () => {
    jest.useFakeTimers();
    try {
      const { getReviewSnapshot, getReviewSummary, wantReviews } = await import(
        "./review"
      );
      const release = wantReviews({ connectionId: "g", ids: ["g1"] });
      await settle();
      expect(getReviewSnapshot("g1")).toBeTruthy();
      release();
      await settle();
      // Shown again soon: still there.
      jest.advanceTimersByTime(60_000);
      await settle();
      expect(getReviewSnapshot("g1")).toBeTruthy();
      jest.advanceTimersByTime(2 * 60_000);
      await settle();
      expect(getReviewSnapshot("g1")).toBeUndefined();
      expect(getReviewSummary("g1")).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a reconnect reads the wanted snapshots again; a review changed while read keeps the newer state", async () => {
    const { acceptReviewPush, getReviewSnapshot, loadReviews, wantReviews } =
      await import("./review");
    let reads = 0;
    let finish!: () => void;
    answers.set("h", async (method, params) => {
      if (method === "review.list")
        return { version: 1, summaries: [summary("h1", "h")] };
      if (method === "review.snapshots") {
        reads += 1;
        if (reads === 2)
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        return {
          snapshots: (params!.ids as string[]).map((id) => ({
            ...snapshot(id, "h"),
            session: { ...snapshot(id, "h").session, title: `read ${reads}` },
          })),
          missing: [],
        };
      }
      return {};
    });
    await loadReviews("h");
    const release = wantReviews({ connectionId: "h", ids: ["h1"] });
    await settle();
    expect(getReviewSnapshot("h1")?.session.title).toBe("read 1");
    // The list again (a reconnect): read again, held meanwhile.
    await loadReviews("h");
    await settle();
    expect(reads).toBe(2);
    expect(getReviewSnapshot("h1")?.session.title).toBe("read 1");
    // A push lands while that read is on its way: it wins.
    acceptReviewPush({
      type: "session",
      snapshot: {
        ...snapshot("h1", "h"),
        session: { ...snapshot("h1", "h").session, title: "pushed" },
      },
    } as never);
    finish();
    await settle();
    expect(getReviewSnapshot("h1")?.session.title).toBe("pushed");
    release();
  });

  test("a server from before review.snapshots: each review read with review.get", async () => {
    const { getReviewSnapshot, loadReviews, wantReviews } = await import(
      "./review"
    );
    const gets: unknown[] = [];
    let lists = 0;
    answers.set("i", async (method, params) => {
      if (method === "review.list")
        // Before summaries: whole sessions, summarized by the page; the
        // second time, named unchanged.
        return lists++ === 0
          ? {
              sessions: [snapshot("i1", "i"), snapshot("i2", "i")],
              stamps: { i1: "a", i2: "b" },
            }
          : {
              sessions: [],
              unchanged: ["i1", "i2"],
              stamps: { i1: "a", i2: "b" },
            };
      if (method === "review.snapshots") throw new Error("unknown method");
      if (method === "review.get") {
        gets.push(params?.session_id);
        return snapshot(params?.session_id as string, "i");
      }
      return {};
    });
    await loadReviews("i");
    // The whole sessions it listed are held until no view wants them.
    expect(getReviewSnapshot("i1")).toBeTruthy();
    const release = wantReviews({ connectionId: "i", ids: ["i1"] });
    // Read again after a reconnect: one review.get.
    await loadReviews("i");
    await settle();
    expect(gets).toEqual(["i1"]);
    expect(getReviewSnapshot("i1")).toBeTruthy();
    // i2, wanted by none and stale since the reconnect, is let go.
    expect(getReviewSnapshot("i2")).toBeUndefined();
    release();
  });
}
