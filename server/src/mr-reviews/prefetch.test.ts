import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MrItem } from "../../../shared/mrReviews";
import { DEFAULT_MR_REVIEWS_SETTINGS } from "../../../shared/mrReviews";
import { createCloneFinder } from "./clones";
import { createMrOpener } from "./open";
import { openMrStore } from "./store";

const item = (n: number, extra: Partial<MrItem> = {}): MrItem => ({
  provider: "gitlab",
  host: "h",
  project: "g/p",
  number: n,
  key: `gitlab:h/g/p#${n}`,
  url: `https://h/g/p/-/merge_requests/${n}`,
  title: `MR ${n}`,
  author: "a",
  draft: false,
  state: "open",
  updatedAt: "2026-11-04T00:00:00Z",
  headSha: `${n}`.padEnd(40, "a"),
  sourceBranch: "x",
  targetBranch: "main",
  pipeline: null,
  notes: 0,
  reasons: [],
  ...extra,
});

test("prefetch: only the user's requests and the picks, once per head", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-pre-"));
  try {
    const store = openMrStore(join(dir, "state.json"));
    store.update((state) => {
      state.projects["h/g/p"] = {
        connectionId: "c",
        clone: "/src/p",
        worktree: "/src/p.worktrees/review",
        remote: "upstream",
      };
      state.ranked[item(3).key] = {
        updatedAt: "t",
        pick: true,
        score: 80,
        reason: "r",
        at: "t",
      };
    });
    const scripts: string[] = [];
    const opener = createMrOpener({
      inbox: { item: () => undefined, markSeen: () => true } as any,
      store,
      settings: async () => DEFAULT_MR_REVIEWS_SETTINGS,
      saveClone: async () => {},
      clones: createCloneFinder(),
      openReview: () => {
        throw new Error("not opened");
      },
      connections: () => [
        {
          id: "c",
          label: "C",
          dirs: async () => [],
          herdr: async () => ({}),
          run: async (script) => {
            scripts.push(script);
            // Each wanted head: fetched.
            const numbers = [...script.matchAll(/nums="\$nums (\d+)"/g)].map(
              (match) => match[1],
            );
            return {
              code: 0,
              stdout: numbers.map((n) => `FETCHED ${n}\n`).join(""),
              stderr: "",
            };
          },
        },
      ],
    });
    const items = [
      item(1, { reasons: ["review_requested"] }),
      // A followed project's request nobody picked: never fetched.
      item(2),
      item(3),
      // Merged: never fetched.
      item(4, { reasons: ["assigned"], state: "merged" }),
    ];
    await opener.prefetch(items);
    expect(scripts).toHaveLength(1);
    const wanted = [
      ...scripts[0]!.matchAll(/merge-requests\/(\d+)\/head/g),
    ].map((match) => Number(match[1]));
    expect(wanted.sort()).toEqual([1, 3]);
    // The same heads: no git command at all.
    await opener.prefetch(items);
    expect(scripts).toHaveLength(1);
    // A push to !1: only it.
    await opener.prefetch(
      items.map((each) =>
        each.number === 1 ? { ...each, headSha: "f".repeat(40) } : each,
      ),
    );
    expect(scripts).toHaveLength(2);
    expect(
      [...scripts[1]!.matchAll(/merge-requests\/(\d+)\/head/g)].map(
        (m) => m[1],
      ),
    ).toEqual(["1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new project waits for the default connection; a known one does not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-def-"));
  try {
    const store = openMrStore(join(dir, "state.json"));
    let scans = 0;
    const opener = createMrOpener({
      inbox: {
        item: (key: string) =>
          [item(1), item(2, { project: "g/q", key: "gitlab:h/g/q#2" })].find(
            (each) => each.key === key,
          ),
        markSeen: () => true,
      } as any,
      store,
      settings: async () => DEFAULT_MR_REVIEWS_SETTINGS,
      saveClone: async () => {},
      clones: createCloneFinder(),
      openReview: () => ({ session: { id: "s" } }) as any,
      defaultConnection: () => ({
        id: "desktop",
        label: "desktop",
        ready: false,
      }),
      connections: () => [
        {
          id: "local",
          label: "Local",
          dirs: async () => {
            scans++;
            return ["/src/q"];
          },
          herdr: async () => ({}),
          run: async () => ({ code: 0, stdout: "", stderr: "" }),
        },
      ],
    });
    await expect(opener.open("gitlab:h/g/q#2")).rejects.toThrow(
      /desktop, the default connection, is not connected/,
    );
    // Nothing was looked for elsewhere meanwhile.
    expect(scans).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
