import { describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHistoryWatcher,
  historyFilePath,
  type HistoryChanged,
  type RemoteStatSpawner,
} from "./history-watch";

type Ws = { name: string };

async function settle() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function localSetup(paths: Record<string, string | null>) {
  const sent: [Ws, HistoryChanged][] = [];
  const watches = new Map<string, () => void>();
  const closed: string[] = [];
  const watcher = createHistoryWatcher<Ws>({
    resolvePath: async (params) => paths[String(params.pane_id)] ?? null,
    send: (ws, event) => sent.push([ws, event]),
    watchLocal: (path, onChange) => {
      watches.set(path, onChange);
      return { close: () => closed.push(path) };
    },
    debounceMs: 100,
    reresolveMs: 30_000,
  });
  return { watcher, sent, watches, closed };
}

describe("history watcher", () => {
  test("a local change reaches the pane's subscribers once, debounced", async () => {
    jest.useFakeTimers();
    try {
      const { watcher, sent, watches } = localSetup({ p1: "/s/a.jsonl" });
      const a = { name: "a" };
      const b = { name: "b" };
      expect(await watcher.subscribe(a, { pane_id: "p1" })).toEqual({
        pane_id: "p1",
        path: "/s/a.jsonl",
      });
      await watcher.subscribe(b, { pane_id: "p1" });
      jest.advanceTimersByTime(100);
      sent.length = 0;
      const change = watches.get("/s/a.jsonl")!;
      change();
      change();
      change();
      jest.advanceTimersByTime(99);
      expect(sent).toEqual([]);
      jest.advanceTimersByTime(1);
      const event = {
        event: "agent_history.changed",
        data: { pane_id: "p1", path: "/s/a.jsonl" },
      } as const;
      expect(sent).toEqual([
        [a, event],
        [b, event],
      ]);
      watcher.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  test("the last subscriber leaving closes the watch", async () => {
    const { watcher, closed } = localSetup({ p1: "/s/a.jsonl" });
    const a = { name: "a" };
    const b = { name: "b" };
    await watcher.subscribe(a, { pane_id: "p1" });
    await watcher.subscribe(b, { pane_id: "p1" });
    watcher.unsubscribe(a, "p1");
    expect(closed).toEqual([]);
    watcher.cleanupWs(b);
    expect(closed).toEqual(["/s/a.jsonl"]);
    watcher.dispose();
  });

  test("a session moving to a new file is followed", async () => {
    jest.useFakeTimers();
    try {
      const paths: Record<string, string | null> = { p1: "/s/a.jsonl" };
      const { watcher, sent, watches, closed } = localSetup(paths);
      const a = { name: "a" };
      await watcher.subscribe(a, { pane_id: "p1" });
      jest.advanceTimersByTime(100);
      sent.length = 0;
      paths.p1 = "/s/b.jsonl";
      jest.advanceTimersByTime(30_000);
      await settle();
      jest.advanceTimersByTime(100);
      expect(closed).toEqual(["/s/a.jsonl"]);
      expect(watches.has("/s/b.jsonl")).toBe(true);
      expect(sent.map(([, event]) => event.data.path)).toEqual(["/s/b.jsonl"]);
      watcher.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a history read that resolved another file moves the watch at once", async () => {
    jest.useFakeTimers();
    try {
      const paths: Record<string, string | null> = { p1: "/s/a.jsonl" };
      const { watcher, sent, watches, closed } = localSetup(paths);
      await watcher.subscribe({ name: "a" }, { pane_id: "p1" });
      jest.advanceTimersByTime(100);
      sent.length = 0;
      // /clear in the terminal: the next read finds the new file.
      watcher.notePath("p1", "/s/b.jsonl");
      watcher.notePath("p1", null);
      jest.advanceTimersByTime(100);
      expect(closed).toEqual(["/s/a.jsonl"]);
      expect(watches.has("/s/b.jsonl")).toBe(true);
      expect(sent.map(([, event]) => event.data.path)).toEqual(["/s/b.jsonl"]);
      expect(historyFilePath({ file: { path: "/s/c.jsonl" } })).toBe(
        "/s/c.jsonl",
      );
      expect(historyFilePath({ path: "/s/d.jsonl" })).toBe("/s/d.jsonl");
      expect(historyFilePath({ file: null, path: "" })).toBeNull();
      watcher.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a remote connection runs one helper for all its files", async () => {
    jest.useFakeTimers();
    try {
      const helpers: {
        paths: string[];
        onLine: (line: string) => void;
        onExit: () => void;
        closed: boolean;
      }[] = [];
      const spawnRemote: RemoteStatSpawner = (paths, onLine, onExit) => {
        const helper = { paths, onLine, onExit, closed: false };
        helpers.push(helper);
        return { close: () => (helper.closed = true) };
      };
      const sent: [Ws, HistoryChanged][] = [];
      const files: Record<string, string> = {
        p1: "/r/a.jsonl",
        p2: "/r/b.jsonl",
      };
      const watcher = createHistoryWatcher<Ws>({
        resolvePath: async (params) => files[String(params.pane_id)] ?? null,
        send: (ws, event) => sent.push([ws, event]),
        spawnRemote,
        debounceMs: 10,
        restartMs: 500,
      });
      const a = { name: "a" };
      await watcher.subscribe(a, { pane_id: "p1" });
      await watcher.subscribe(a, { pane_id: "p2" });
      jest.advanceTimersByTime(500);
      expect(helpers.map((helper) => helper.paths)).toEqual([
        ["/r/a.jsonl", "/r/b.jsonl"],
      ]);
      jest.advanceTimersByTime(10);
      sent.length = 0;
      const helper = helpers[0]!;
      helper.onLine("/r/a.jsonl\t10 100 7");
      helper.onLine("/r/b.jsonl\t5 100 8");
      jest.advanceTimersByTime(10);
      // The first line of each file only sets its baseline.
      expect(sent).toEqual([]);
      helper.onLine("/r/a.jsonl\t20 101 7");
      helper.onLine("/r/b.jsonl\t5 100 8");
      jest.advanceTimersByTime(10);
      expect(sent.map(([, event]) => event.data.pane_id)).toEqual(["p1"]);
      // One file fewer: the helper restarts with the rest.
      watcher.unsubscribe(a, "p2");
      jest.advanceTimersByTime(500);
      expect(helper.closed).toBe(true);
      expect(helpers.at(-1)!.paths).toEqual(["/r/a.jsonl"]);
      // An exit restarts it.
      helpers.at(-1)!.onExit();
      jest.advanceTimersByTime(5000 + 500);
      expect(helpers).toHaveLength(3);
      watcher.dispose();
      expect(helpers.at(-1)!.closed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the default local watch sees appends to a real file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roamgate-watch-"));
    try {
      const path = join(dir, "s.jsonl");
      writeFileSync(path, "{}\n");
      const events: HistoryChanged[] = [];
      let wake: (() => void) | undefined;
      const watcher = createHistoryWatcher<Ws>({
        resolvePath: async () => path,
        send: (_ws, event) => {
          events.push(event);
          wake?.();
        },
        debounceMs: 0,
      });
      const next = (count: number) =>
        new Promise<void>((resolve) => {
          if (events.length >= count) return resolve();
          wake = () => events.length >= count && resolve();
        });
      await watcher.subscribe({ name: "a" }, { pane_id: "p1" });
      // The subscription itself reports the file once.
      await next(1);
      appendFileSync(path, "{}\n");
      await next(2);
      expect(events.at(-1)).toEqual({
        event: "agent_history.changed",
        data: { pane_id: "p1", path },
      });
      watcher.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
