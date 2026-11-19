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
  const answers = new Map<string, () => Promise<unknown>>();
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
        return answers.get(connectionId)!();
      }
      calls.push(method);
      if (!ready) throw new Error("connection is not ready: desktop");
      return method === "review.list"
        ? { sessions: [snapshot("s1", "desktop")] }
        : {};
    },
  });
  mock.module("./store", () => ({
    store: {
      get: () => ({
        connections: ["desktop", "a", "b", "c", "d"].map((id) => ({
          id,
          generation: 1,
        })),
      }),
      subscribe: () => () => {},
    },
  }));

  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  test("a list refused before the connection is ready is tried again", async () => {
    jest.useFakeTimers();
    try {
      const { loadReviews, getReviewSnapshot } = await import("./review");
      await expect(loadReviews("desktop")).rejects.toThrow("not ready");
      expect(calls).toEqual(["review.list"]);
      // Still not ready a second later: tried again, then later still.
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(calls).toEqual(["review.list", "review.list"]);
      ready = true;
      jest.advanceTimersByTime(2000);
      await settle();
      expect(getReviewSnapshot("s1")).toBeTruthy();
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
      const { loadReviews, getReviewSnapshot } = await import("./review");
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
      expect(getReviewSnapshot("sb")).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a malformed session in a list is dropped, the others kept", async () => {
    const { loadReviews, getReviewSnapshot } = await import("./review");
    const broken = snapshot("broken", "c") as Record<string, unknown>;
    broken.threads = [{ id: "t", kind: "draft", comments: [{ id: 1 }] }];
    answers.set("c", async () => ({
      sessions: [snapshot("fine", "c"), broken, null, { session: {} }],
    }));
    await loadReviews("c");
    expect(getReviewSnapshot("fine")).toBeTruthy();
    expect(getReviewSnapshot("broken")).toBeUndefined();
  });

  test("the connections whose list loaded are known", async () => {
    const { loadedReviewConnections } = await import("./review");
    expect(loadedReviewConnections().has("c")).toBe(true);
    expect(loadedReviewConnections().has("a")).toBe(false);
  });

  test("a list again sends only the reviews that changed", async () => {
    const { loadReviews, getReviewSnapshot } = await import("./review");
    answers.set("d", async () => ({
      sessions: [snapshot("d1", "d"), snapshot("d2", "d")],
      stamps: { d1: "x1", d2: "x2" },
    }));
    await loadReviews("d");
    expect(getReviewSnapshot("d2")).toBeTruthy();
    sentParams.length = 0;
    // d1 unchanged, d2 gone since.
    answers.set("d", async () => ({
      sessions: [],
      unchanged: ["d1"],
      stamps: { d1: "x1" },
    }));
    await loadReviews("d");
    expect(sentParams[0]).toEqual({ known: { d1: "x1", d2: "x2" } });
    expect(getReviewSnapshot("d1")).toBeTruthy();
    expect(getReviewSnapshot("d2")).toBeUndefined();
  });
}
