import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMrReviews } from "./module";
import { openMrStore } from "./store";

test("a closed request's review is dropped after the retention days", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-mod-"));
  try {
    const store = openMrStore(join(dir, "state.json"));
    const old = new Date(Date.now() - 4 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    store.update((state) => {
      state.reviews.a = { connectionId: "c", sessionId: "sa", closedAt: old };
      state.reviews.b = {
        connectionId: "c",
        sessionId: "sb",
        closedAt: recent,
      };
      state.reviews.c = { connectionId: "c", sessionId: "sc" };
      state.seen.a = { at: old, updatedAt: old, headSha: "x", notes: 0 };
      state.projects.p = {
        connectionId: "c",
        clone: "/x",
        worktree: "/x.worktrees/review",
      };
    });
    const removed: string[] = [];
    const reviews = createMrReviews({
      run: async () => ({ code: 1, stdout: "", stderr: "" }),
      store,
      readSettings: async () => ({ mr_reviews: { retention_days: 3 } }) as any,
      discoverHosts: () => [],
      removeReview: (id) => removed.push(id),
    });
    await reviews.lifecycle();
    expect(removed).toEqual(["sa"]);
    expect(Object.keys(store.get().reviews).sort()).toEqual(["b", "c"]);
    expect(store.get().seen.a).toBeUndefined();
    // The project's review worktree stays.
    expect(store.get().projects.p).toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
