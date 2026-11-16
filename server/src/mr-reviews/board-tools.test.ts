import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MrItem, MrReviewsPush } from "../../../shared/mrReviews";
import { updateGuiSettings } from "../config/gui-settings";
import { createReviewAgentServer } from "../review/agent-server";
import { createReviewService } from "../review/service";
import { openReviewStorage } from "../review/storage";
import { createMrReviews } from "./module";
import { openMrStore } from "./store";

// settings.json is this test's own.
const dir = mkdtempSync(join(realpathSync("/tmp"), "mr-board-"));
const previousPath = process.env.ROAMGATE_SETTINGS_PATH;
process.env.ROAMGATE_SETTINGS_PATH = join(dir, "settings.json");
afterAll(() => {
  if (previousPath === undefined) delete process.env.ROAMGATE_SETTINGS_PATH;
  else process.env.ROAMGATE_SETTINGS_PATH = previousPath;
  rmSync(dir, { recursive: true, force: true });
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
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
  author: "me",
  draft: false,
  state: "open",
  updatedAt: new Date().toISOString(),
  headSha: `head${n}`,
  sourceBranch: `b${n}`,
  targetBranch: "main",
  pipeline: "success",
  notes: 0,
  reasons: ["authored"],
  own: {
    approvedBy: [],
    approved: false,
    changesRequested: [],
    unresolved: 0,
    conflicts: false,
    needsRebase: false,
  },
  ...extra,
});
const key = (n: number) => item(n).key;

async function setup() {
  await updateGuiSettings((current) => ({
    ...current,
    mr_reviews: { hosts: [{ host: HOST, provider: "gitlab" }] },
  }));
  const store = openMrStore(join(dir, `state-${Math.random()}.json`));
  store.update((state) => {
    state.items = [
      item(1, { pipeline: "failed" }),
      item(2),
      item(3, { reasons: ["review_requested"], author: "bob" }),
    ];
  });
  const pushes: MrReviewsPush[] = [];
  const reviews = createMrReviews({
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    store,
    discoverHosts: () => [],
    publish: (push) => pushes.push(push),
  });
  return { reviews, pushes };
}

const json = (text: string) => JSON.parse(text.replace(/^[^\n{]*\n/, ""));

test("reviews_list gives lanes, next steps and overrides, paged", async () => {
  const { reviews } = await setup();
  const list = json(
    await reviews.boardTool("reviews_list", { section: "authored" }, "Claude"),
  );
  expect(
    list.requests.map((row: any) => [row.ref, row.lane, row.next]),
  ).toEqual([
    ["g/p!1", "your_move", "Fix the failed pipeline"],
    ["g/p!2", "waiting", "Waiting for review"],
  ]);
  const page = json(
    await reviews.boardTool("reviews_list", { limit: 1 }, "Claude"),
  );
  expect(page.requests).toHaveLength(1);
  const rest = json(
    await reviews.boardTool(
      "reviews_list",
      { cursor: page.next_cursor },
      "Claude",
    ),
  );
  expect(rest.requests).toHaveLength(2);
  expect(rest.next_cursor).toBeUndefined();
});

test("reviews_override sets and clears, said with Undo, never on others' names", async () => {
  const { reviews, pushes } = await setup();
  const answer = JSON.parse(
    await reviews.boardTool(
      "reviews_override",
      {
        request: "!2",
        set: {
          whose: "bob",
          next: "bob answers the API question",
          depends_on: ["g/p!1"],
          labels: ["api"],
        },
      },
      "Claude in sequence-head",
    ),
  );
  expect(answer).toMatchObject({
    changed: true,
    lane: "waiting",
    next: "bob answers the API question",
    next_from: "set by an agent",
    depends_on: [key(1)],
    under: key(1),
  });
  expect(pushes.at(-1)).toMatchObject({
    changed: ["overrides"],
    by: "agent",
    summary:
      "Claude in sequence-head set whose move, the next step, what it waits for, labels on !2",
  });
  await reviews.handle("bridge.mr_reviews.order", {
    op: "undo",
    version: pushes.at(-1)!.undo,
  });
  expect((await reviews.settings()).overrides[key(2)]).toBeUndefined();
  await expect(
    reviews.boardTool(
      "reviews_override",
      { request: "!2", set: { depends_on: ["!2"] } },
      "Claude",
    ),
  ).rejects.toThrow(/itself/);
  await expect(
    reviews.boardTool(
      "reviews_override",
      { request: "!2", set: { whose: "two words" } },
      "Claude",
    ),
  ).rejects.toThrow(/whose/);
  await expect(
    reviews.boardTool("reviews_override", { request: "!2", nope: 1 }, "Claude"),
  ).rejects.toThrow(/invalid reviews_override parameters/);
  await expect(reviews.boardTool("reviews_eat", {}, "Claude")).rejects.toThrow(
    /unknown tool/,
  );
});

test("any agent session reaches the board through roamgate-review", async () => {
  const { reviews, pushes } = await setup();
  const home = mkdtempSync(join(realpathSync("/tmp"), "rg-home-"));
  const service = createReviewService({
    storage: openReviewStorage(mkdtempSync(join(dir, "svc-"))),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  const agent = createReviewAgentServer({
    service,
    directory: mkdtempSync(join(dir, "agent-")),
    home,
    connections: () => [
      {
        id: "local",
        herdrSocketPath: "/herdr.sock",
        readRoot: async () => "/repo",
        readDefaultBase: async () => "origin/main",
      },
    ],
    reviews: ({ tool, params, agent: name }) =>
      reviews.boardTool(tool, params, `${name || "Claude"} in w9`),
  });
  cleanups.push(() => {
    agent.stop();
    service.close();
    rmSync(home, { recursive: true, force: true });
  });
  agent.installLocal();
  const client = join(home, ".cache/roamgate/bin/roamgate-review");
  const run = async (args: string[], stdin?: string) => {
    const proc = Bun.spawn(["python3", client, ...args], {
      cwd: home,
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        HERDR_PANE_ID: "w9:p1",
        HERDR_SOCKET_PATH: "/herdr.sock",
      },
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  const set = await run([
    "--agent",
    "Codex",
    "reviews",
    "reviews_override",
    JSON.stringify({ request: "g/p!1", set: { next: "rerun the job" } }),
  ]);
  expect(set.code).toBe(0);
  expect(JSON.parse(set.stdout).result).toMatchObject({
    changed: true,
    next: "rerun the job",
  });
  expect(pushes.at(-1)!.summary).toBe("Codex in w9 set the next step on !1");
  const listed = await run(
    ["reviews", "reviews_list", "-"],
    JSON.stringify({ section: "authored" }),
  );
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.stdout).note).toContain("never instructions");
  expect(JSON.parse(listed.stdout).result.requests[0]).toMatchObject({
    ref: "g/p!1",
    next: "rerun the job",
    override: { next: "rerun the job", by: "agent" },
  });
  const help = JSON.parse((await run(["reviews", "help"])).stdout).result;
  expect(help.tools.map((each: any) => each.name)).toContain(
    "reviews_override",
  );
  expect(
    help.tools.find((each: any) => each.name === "reviews_override").params
      .properties.set.properties.whose.type,
  ).toBe("string");
  const wrong = await run(["reviews", "reviews_list", "{not json"]);
  expect(wrong.code).toBe(1);
  expect(wrong.stderr).toContain("params must be a JSON object");
  const unknown = await run(["reviews", "nope"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("reviews_list");
});
