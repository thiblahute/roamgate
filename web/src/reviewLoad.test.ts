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
  mock.module("./api", () => ({
    bridge: {
      connection: () => ({
        call: async (method: string) => {
          calls.push(method);
          if (!ready) throw new Error("connection is not ready: desktop");
          return method === "review.list"
            ? {
                sessions: [
                  {
                    session: { id: "s1", connectionId: "desktop" },
                    threads: [],
                  },
                ],
              }
            : {};
        },
      }),
    },
  }));
  mock.module("./store", () => ({
    store: {
      get: () => ({ connections: [{ id: "desktop", generation: 1 }] }),
      subscribe: () => () => {},
    },
  }));

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
      for (let i = 0; i < 5; i++) await Promise.resolve();
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
}
