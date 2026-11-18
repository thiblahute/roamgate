import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mrEffortColumn } from "../../../shared/mrEffortBoard";
import type {
  MrEffort,
  MrInboxEntry,
  MrPlan,
  MrReviewsSettings,
} from "../../../shared/mrReviews";
import { effortPlanEntries } from "./effort-board";
import { handleEffortRpc } from "./effort-service";
import { createLedgerStore } from "./efforts";
import type { UpstreamBranch, UpstreamScanner } from "./upstream";

const HOST = "gitlab.example.org";
const PROJECT = "media/engine";

const entry = (
  number: number,
  extra: Partial<MrInboxEntry> = {},
): MrInboxEntry => ({
  provider: "gitlab",
  host: HOST,
  project: PROJECT,
  number,
  key: `gitlab:${HOST}/${PROJECT}#${number}`,
  url: `https://${HOST}/${PROJECT}/-/merge_requests/${number}`,
  title: `MR ${number}`,
  author: "me",
  draft: false,
  state: "open",
  updatedAt: new Date().toISOString(),
  headSha: `head${number}`,
  sourceBranch: `b${number}`,
  targetBranch: "main",
  pipeline: "success",
  notes: 0,
  reasons: ["authored"],
  section: "authored",
  unread: null,
  isNew: false,
  lane: "waiting",
  ...extra,
});

const branch = (
  name: string,
  path: string,
  patchIds: string[],
  group = "g1",
): UpstreamBranch => ({
  key: `branch:gitlab:${HOST}/${PROJECT}@${name}`,
  provider: "gitlab",
  host: HOST,
  project: PROJECT,
  branch: name,
  member: {
    connectionId: "local",
    workspaceId: `w-${name}`,
    path,
    label: name,
    group,
  } as UpstreamBranch["member"],
  connectionLabel: "local",
  head: `h-${name}`,
  dirty: 0,
  target: { ref: "origin/main", sha: "t", behind: 0, ahead: patchIds.length },
  commits: patchIds.map((id, index) => ({
    sha: `${name}-${index}`,
    subject: `${name} ${index}`,
    at: 1,
    patchId: id,
  })),
});

const plan = (
  id: string,
  part: Partial<NonNullable<MrPlan["part"]>> | null = {},
  extra: Partial<MrPlan> = {},
): MrPlan => ({
  id,
  name: `Plan ${id}`,
  commits: [`${id}-1`],
  dependsOn: [],
  state: "accepted",
  ...(part
    ? {
        part: {
          connectionId: "local",
          path: `/wt/${id}`,
          branch: `upstream/${id}`,
          ...part,
        },
      }
    : {}),
  at: "",
  by: "agent",
  ...extra,
});

const effort = { group: "g1" };

test("a part's branch links to its request by name, by patch ids, else is its branch row", () => {
  const plans = [
    plan("named"),
    plan("byIds"),
    plan("row"),
    plan("none"),
    plan("unscanned"),
    plan("merged"),
  ];
  const branches = [
    branch("upstream/named", "/wt/named", ["p1"]),
    // Renamed on the forge: found by its commits' patch ids.
    branch("upstream/byIds", "/wt/byIds", ["p2", "p3"]),
    branch("upstream/row", "/wt/row", ["p9"]),
  ];
  const entries = [
    // A GitHub-like cross-fork request from thiblahute:upstream/named.
    entry(1, { sourceBranch: "upstream/named", lane: "your_move" }),
    entry(2, { sourceBranch: "something-else", lane: "merging" }),
    entry(4, { sourceBranch: "upstream/unscanned", lane: "blocked" }),
    entry(5, {
      sourceBranch: "upstream/merged",
      state: "merged",
      lane: "done",
    }),
    // A closed one leaves the work unproposed.
    entry(6, { sourceBranch: "upstream/none", state: "closed", lane: "done" }),
    // The row the inbox draws for the branch with no request.
    {
      ...entry(0, { lane: "not_sent", sourceBranch: "upstream/row" }),
      key: branches[2]!.key,
      branch: {
        name: "upstream/row",
        connectionId: "local",
        connectionLabel: "local",
        workspaceId: "w-row",
        workspaceLabel: "row",
        path: "/wt/row",
        target: "origin/main",
        ahead: 1,
        behind: 0,
        dirty: 0,
        commits: [],
        group: "g1",
      },
    },
  ];
  const patchIds = new Map([[entries[1]!.key, new Set(["p2", "p3", "p4"])]]);
  const linked = effortPlanEntries({
    effort,
    plans,
    branches,
    entries,
    patchIds,
  });
  expect(linked.named?.number).toBe(1);
  expect(linked.byIds?.number).toBe(2);
  expect(linked.row?.key).toBe(branches[2]!.key);
  expect(linked.none).toBeUndefined();
  // Not read by the scan (not ahead, or outside the group): by its name.
  expect(linked.unscanned?.number).toBe(4);
  expect(linked.merged?.number).toBe(5);
  // Some of the branch's commits only: not that request.
  const partial = effortPlanEntries({
    effort,
    plans: [plan("byIds")],
    branches,
    entries,
    patchIds: new Map([[entries[1]!.key, new Set(["p2"])]]),
  });
  expect(partial.byIds).toBeUndefined();
  // A request of another project is not one of the effort's.
  const elsewhere = effortPlanEntries({
    effort,
    plans: [plan("unscanned")],
    branches,
    entries: [
      entry(4, { sourceBranch: "upstream/unscanned", project: "other/app" }),
    ],
    patchIds: new Map(),
  });
  expect(elsewhere.unscanned).toBeUndefined();

  // Their columns: the request's lane, Not proposed yet, Planned, Done.
  const column = (id: string) =>
    mrEffortColumn(plans.find((each) => each.id === id)!, linked[id]);
  expect(column("named")).toBe("your_move");
  expect(column("byIds")).toBe("merging");
  expect(column("row")).toBe("not_sent");
  expect(column("none")).toBe("not_sent");
  expect(column("unscanned")).toBe("blocked");
  expect(column("merged")).toBe("done");
  expect(mrEffortColumn(plan("p", null), undefined)).toBe("planned");
  expect(
    mrEffortColumn(plan("p", null, { state: "proposed" }), undefined),
  ).toBe("planned");
  expect(mrEffortColumn(plan("p", null), undefined, true)).toBe("done");
  expect(mrEffortColumn(plan("q", {}), entry(7, { lane: "stale" }))).toBe(
    "stale",
  );
});

const root = mkdtempSync(join(realpathSync("/tmp"), "mr-effort-board-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("effort.get gives each plan its inbox entry, from the entries computed", async () => {
  const store = createLedgerStore(root);
  const theEffort: MrEffort = {
    id: "e1",
    group: "g1",
    name: "Big",
    clone: { connectionId: "local", path: "/clone" },
    source: "refs/heads/big",
    target: { remote: "origin", branch: "main" },
    feeders: [],
  };
  store.writeLedger("e1", {
    ...store.ledger("e1"),
    plans: [plan("named"), plan("planned-only", null)],
  });
  let asked = 0;
  const settings = { efforts: [theEffort] } as unknown as MrReviewsSettings;
  const upstream = {
    branches: () => [branch("upstream/named", "/wt/named", ["p1"])],
    patchIds: () => new Map(),
    members: () => [],
  } as unknown as UpstreamScanner;
  const answer = (await handleEffortRpc(
    {
      service: {
        store,
        summaries: () => [],
        connectionOf: () => undefined,
      } as never,
      settings: async () => settings,
      edit: async (change) => change(),
      save: async (value) => value,
      upstream,
      entries: async () => {
        asked++;
        return [entry(1, { sourceBranch: "upstream/named" })];
      },
      groupLabel: async () => null,
    },
    "bridge.mr_reviews.effort.get",
    { id: "e1" },
  )) as { board: Record<string, MrInboxEntry> };
  expect(asked).toBe(1);
  expect(Object.keys(answer.board)).toEqual(["named"]);
  expect(answer.board.named?.number).toBe(1);
});
