import { afterEach, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "../../../shared/work";
import { openWorkStore } from "../work/store";
import type { HistoryArea } from "./area";
import type { PassInput, PassResult } from "./repo";
import { Debounce, HistoryRuntime } from "./runtime";
import { workArea } from "./work";

const dirs: string[] = [];
const runtimes: HistoryRuntime[] = [];
afterEach(async () => {
  jest.useRealTimers();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-history-rt-"));
  dirs.push(dir);
  return dir;
}

test("the debounce runs 30 s after the last change, at most 5 min after the first", () => {
  jest.useFakeTimers();
  let now = 0;
  let runs = 0;
  const debounce = new Debounce(
    () => runs++,
    30_000,
    300_000,
    () => now,
  );
  const advance = (ms: number) => {
    now += ms;
    jest.advanceTimersByTime(ms);
  };
  debounce.touch();
  advance(29_999);
  expect(runs).toBe(0);
  advance(1);
  expect(runs).toBe(1);
  // A change every 20 s: never quiet, so the 5 minute cap runs it.
  debounce.touch();
  for (let i = 0; i < 14; i++) {
    advance(20_000);
    debounce.touch();
  }
  expect(runs).toBe(1);
  advance(20_000);
  expect(runs).toBe(2);
  expect(debounce.pending).toBe(false);
  debounce.touch();
  debounce.flush();
  expect(runs).toBe(3);
  debounce.touch();
  debounce.cancel();
  advance(400_000);
  expect(runs).toBe(3);
});

/** A repo that records each pass instead of writing. */
function fakeRepo(passes: PassInput[]) {
  return (dir: string) =>
    ({
      dir,
      async pass(input: PassInput): Promise<PassResult> {
        passes.push(input);
        return { commits: 1, blocked: [], errors: [], ms: 1 };
      },
      async status() {
        return {
          exists: true,
          lastCommit: null,
          commits: 0,
          sizeBytes: 0,
          files: {},
          lastPass: null,
          blocked: [],
          errors: [],
        };
      },
    }) as never;
}

const area = (name: string, watch?: () => string[]): HistoryArea => ({
  name,
  watch,
  render: () => ({ files: new Map(), owns: [] }),
});

const names = (input: PassInput) =>
  input.areas.map(
    ({ area: each, ids }) => `${each.name}:${ids ? [...ids].join(",") : "all"}`,
  );

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test("changes wait for the debounce, then one pass takes the dirty areas", async () => {
  jest.useFakeTimers();
  const passes: PassInput[] = [];
  const runtime = new HistoryRuntime({
    areas: [area("work"), area("reviews"), area("settings")],
    place: async () => ({
      enabled: true,
      location: "/h",
      defaultLocation: "/h",
    }),
    reviews: () => null,
    repo: fakeRepo(passes),
    startDelayMs: 1e9,
    pollMs: 0,
  });
  runtimes.push(runtime);
  runtime.start();
  runtime.changed("reviews", "s1");
  runtime.changed("reviews", "s2");
  runtime.changed("settings");
  runtime.changed("unknown");
  jest.advanceTimersByTime(29_000);
  await settle();
  expect(passes).toHaveLength(0);
  jest.advanceTimersByTime(1_000);
  await settle();
  // The first pass at a new place is a full one.
  expect(passes.map(names)).toEqual([
    ["work:all", "reviews:all", "settings:all"],
  ]);
  runtime.changed("reviews", "s3");
  jest.advanceTimersByTime(30_000);
  await settle();
  expect(passes.map(names)[1]).toEqual(["reviews:s3"]);
  expect((await runtime.status()).pending).toEqual([]);
});

test("while a game runs, the full pass waits and the changes go alone", async () => {
  const passes: PassInput[] = [];
  let gaming = true;
  const runtime = new HistoryRuntime({
    areas: [area("work"), area("settings")],
    place: async () => ({
      enabled: true,
      location: "/h",
      defaultLocation: "/h",
    }),
    reviews: () => null,
    repo: fakeRepo(passes),
    gameMode: async () => gaming,
    startDelayMs: 1e9,
    pollMs: 0,
  });
  runtimes.push(runtime);
  runtime.changed("settings");
  await (runtime as any).runPass(true);
  expect(passes.map(names)).toEqual([["settings:all"]]);
  expect(passes[0]!.light).toBe(true);
  expect((await runtime.status()).deferred).toMatch(/game/);
  gaming = false;
  await (runtime as any).runPass(false);
  expect(passes.map(names)[1]).toEqual(["work:all", "settings:all"]);
  expect((await runtime.status()).deferred).toBeNull();
  // Asked for (Settings, the CLI): it does not wait.
  gaming = true;
  await runtime.commitNow();
  expect(passes.map(names)[2]).toEqual(["work:all", "settings:all"]);
});

test("history turned off drops the changes", async () => {
  const passes: PassInput[] = [];
  const runtime = new HistoryRuntime({
    areas: [area("settings")],
    place: async () => ({
      enabled: false,
      location: "/h",
      defaultLocation: "/h",
    }),
    reviews: () => null,
    repo: fakeRepo(passes),
    startDelayMs: 1e9,
    pollMs: 0,
  });
  runtimes.push(runtime);
  runtime.changed("settings");
  await runtime.commitNow();
  expect(passes).toHaveLength(0);
  expect((await runtime.status()).enabled).toBe(false);
});

test("a watched file changed by hand marks its area", async () => {
  const dir = temp();
  const file = join(dir, "voice.json");
  writeFileSync(file, "{}");
  const passes: PassInput[] = [];
  const runtime = new HistoryRuntime({
    areas: [
      area("voice", () => [file]),
      area("settings", () => [join(dir, "none")]),
    ],
    place: async () => ({
      enabled: true,
      location: "/h",
      defaultLocation: "/h",
    }),
    reviews: () => null,
    repo: fakeRepo(passes),
    startDelayMs: 1e9,
    pollMs: 0,
  });
  runtimes.push(runtime);
  await (runtime as any).poll(true);
  writeFileSync(file, '{"speech_rate":1.2}');
  utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  await (runtime as any).poll(false);
  expect((await runtime.status()).pending).toEqual(["voice"]);
});

test("each Work change is its own commit, by who made it, when", async () => {
  const dir = temp();
  const location = join(dir, "history");
  const store = openWorkStore(join(dir, "work"));
  const runtime = new HistoryRuntime({
    areas: [workArea({ work: join(dir, "work") }, () => null)],
    place: async () => ({ enabled: true, location, defaultLocation: location }),
    reviews: () => null,
    host: "desk",
    startDelayMs: 1e9,
    pollMs: 0,
  });
  runtimes.push(runtime);
  runtime.start();
  const item: WorkItem = {
    id: "1111222233334444",
    project: "roamgate",
    title: "Keep history",
    state: "open",
    tags: [],
    links: [],
    createdAt: "2026-11-20T08:00:00.000Z",
    updatedAt: "2026-11-20T08:00:00.000Z",
    by: "user",
  };
  store.saveItem(item, { state: "open" });
  store.saveItem(
    {
      ...item,
      state: "doing",
      by: "agent",
      updatedAt: "2026-11-21T09:15:00.000Z",
    },
    { state: "doing" },
    { by: "agent", address: "desktop/w2:p3", caller: "Claude in roamgate" },
  );
  store.removeItem(item.id, { by: "user" });
  const result = await runtime.commitNow();
  expect(result?.errors).toEqual([]);
  const log = Bun.spawnSync([
    "git",
    "-C",
    location,
    "log",
    "--format=%an|%ae|%aI|%s",
    "--",
    "work/items/1111222233334444.md",
  ]).stdout.toString();
  const lines = log.trim().split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(
    /\|work 11112222: removed "Keep history"|\|work 11112222: removed$/,
  );
  expect(lines[1]).toBe(
    'Claude (desktop/w2:p3)|agent@desk|2026-11-21T09:15:00Z|work 11112222: state doing "Keep history"',
  );
  expect(lines[2]).toEndWith(
    '|2026-11-20T08:00:00Z|work 11112222: state open "Keep history"',
  );
  // The batch after them: the store's history and nothing of the item.
  const batch = Bun.spawnSync([
    "git",
    "-C",
    location,
    "log",
    "-1",
    "--format=%an|%s",
  ]).stdout.toString();
  expect(batch).toStartWith("Roamgate|work: its history");
});
