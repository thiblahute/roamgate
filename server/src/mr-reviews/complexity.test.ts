import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MR_REVIEWS_SETTINGS,
  type MrReviewsSettings,
} from "../../../shared/mrReviews";
import {
  ComplexityError,
  complexityRefusal,
  createComplexityGuard,
  estimateComplexity,
  GITLAB_MAX_COMPLEXITY,
} from "./complexity";
import { createMrInbox } from "./inbox";
import {
  createOwnForge,
  type FakeRequest,
  fakeRequests,
} from "./own-forge.fixture";
import {
  gitlabInboxQuery,
  gitlabOwnListQuery,
  inboxParts,
  mergeAnswers,
  ownDetailsQuery,
} from "./queries";
import { openMrStore } from "./store";

const REFUSED =
  "GitLab: glab: Query has complexity of 272, which exceeds max complexity of 250";

describe("query complexity", () => {
  test("the estimate counts fields, resolvers and the items they load", () => {
    expect(estimateComplexity("query { a b c }")).toBe(3);
    expect(estimateComplexity("query { a { b c } }")).toBe(3);
    // A resolver: its selection, 1, 1 for the sort, 1% per item loaded.
    expect(
      estimateComplexity("query { list(sort: X, first: 50) { nodes { a } } }"),
    ).toBe(Math.ceil((2 + 1 + 1) * 1.5));
    // Asked by id: no per-item part.
    expect(
      estimateComplexity('query { list(iids: ["1"], first: 50) { a } }'),
    ).toBe(2);
    // Strings with parentheses and fragments.
    expect(
      estimateComplexity(
        'query { x: p(path: "a(b)") { ... on T { a b } __typename } }',
      ),
    ).toBe(Math.ceil((2 + 1) * 2));
    expect(estimateComplexity("")).toBe(0);
  });

  test("the to-review query with three followed projects goes over GitLab's default", () => {
    const followed = ["a/one", "a/two", "a/three"];
    expect(estimateComplexity(gitlabInboxQuery(followed))).toBeGreaterThan(
      GITLAB_MAX_COMPLEXITY,
    );
    // Each part fits on its own.
    for (const part of inboxParts(followed))
      expect(
        estimateComplexity(gitlabInboxQuery(followed, [part])),
      ).toBeLessThan(GITLAB_MAX_COMPLEXITY);
  });

  test("a refusal is read from an error or an answer", () => {
    expect(complexityRefusal(new Error(REFUSED))).toEqual({
      complexity: 272,
      max: 250,
    });
    expect(
      complexityRefusal({
        errors: [
          {
            message:
              "Query has complexity of 301, which exceeds max complexity of 200",
          },
        ],
      }),
    ).toEqual({ complexity: 301, max: 200 });
    expect(complexityRefusal(new Error("GitLab: 502 Bad Gateway"))).toBeNull();
    expect(complexityRefusal({ data: {} })).toBeNull();
  });

  test("batches stay under the budget; a refusal splits, learns and is not seen", async () => {
    const guard = createComplexityGuard();
    const build = (part: number[]) =>
      `query { ${part.map((n) => `f${n}: p { a b c d e f g h i }`).join(" ")} }`;
    const units = Array.from({ length: 30 }, (_, n) => n);
    // 10 per unit: 25 fit in 250.
    expect(
      guard.pack("h", "gitlab", units, build).map((b) => b.length),
    ).toEqual([25, 5]);
    expect(guard.pack("h", "gitlab", units, build, 10)).toHaveLength(3);
    // GitHub has no such limit until it says so.
    expect(guard.pack("g", "github", units, build)).toHaveLength(1);

    // The forge counts twice the estimate, with a limit of 100.
    const asked: number[][] = [];
    const answers = await guard.run(
      "h",
      "gitlab",
      units,
      build,
      async (query, part) => {
        const real = estimateComplexity(query) * 2;
        if (real > 100)
          throw new Error(
            `GitLab: glab: Query has complexity of ${real}, which exceeds max complexity of 100`,
          );
        asked.push(part);
        return { data: part };
      },
    );
    expect(answers.flatMap((answer) => answer.data)).toEqual(units);
    expect(
      asked.every((part) => estimateComplexity(build(part)) * 2 <= 100),
    ).toBe(true);
    expect(guard.limit("h")?.max).toBe(100);
    // Learned: the next run is cut right at once.
    for (const part of guard.pack("h", "gitlab", units, build))
      expect(estimateComplexity(build(part)) * 2).toBeLessThanOrEqual(100);

    // One unit refused on its own: the error says so.
    await expect(
      guard.run("h", "gitlab", [1], build, async () => {
        throw new Error(REFUSED);
      }),
    ).rejects.toBeInstanceOf(ComplexityError);
    // Other errors pass through.
    await expect(
      guard.run("h", "gitlab", [1], build, async () => {
        throw new Error("GitLab: 502");
      }),
    ).rejects.toThrow("502");
  });

  test("answers asked in parts merge into one", () => {
    expect(
      mergeAnswers([
        { data: { currentUser: { username: "me", op: 1 } } },
        { data: { currentUser: { mg: 2 }, f0: { x: 1 } } },
        { errors: [{ message: "gone" }] },
      ]),
    ).toEqual({
      data: { currentUser: { username: "me", op: 1, mg: 2 }, f0: { x: 1 } },
      errors: [{ message: "gone" }],
    });
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("the inbox under a GitLab complexity limit", () => {
  const host = "gitlab.freedesktop.org";
  const followed = [
    "gstreamer/gstreamer",
    "gstreamer/gst-plugins-rs",
    "gstreamer/gstreamer-rs",
  ];
  const settings: MrReviewsSettings = {
    ...DEFAULT_MR_REVIEWS_SETTINGS,
    hosts: [{ host, provider: "gitlab" }],
    followed: followed.map((project) => ({
      host,
      provider: "gitlab",
      project,
    })),
  };
  const at = (index: number) =>
    new Date(
      Date.parse("2026-11-10T00:00:00Z") + index * 3_600_000,
    ).toISOString();
  const projects = [
    "gstreamer/gstreamer",
    "gstreamer/gst-plugins-rs",
    "gstreamer/cerbero",
    "gstreamer/orc",
    "gstreamer/gstreamer-rs",
    "pipewire/wireplumber",
  ];
  const mine: FakeRequest[] = fakeRequests(30, "open", at, 1, projects).map(
    (r) => ({ ...r, pipeline: "success", approvedBy: ["bob"] }),
  );
  const others: FakeRequest[] = followed.map((project, index) => ({
    project,
    number: 900 + index,
    state: "open",
    createdAt: at(index),
    updatedAt: at(index),
  }));

  let stored: ReturnType<typeof openMrStore>;
  function inboxOf(
    forge: ReturnType<typeof createOwnForge>,
    fetchers = forge.fetchers,
  ) {
    const dir = mkdtempSync(join(tmpdir(), "mr-cx-"));
    dirs.push(dir);
    stored = openMrStore(join(dir, "state.json"));
    return createMrInbox({
      fetchers,
      settings: async () => settings,
      store: stored,
      now: () => Date.parse("2026-11-17T12:00:00Z"),
    });
  }

  test("the details and the followed projects arrive in more queries, without an error", async () => {
    // The forge counts above the estimate, so the first queries are refused.
    const forge = createOwnForge("gitlab", host, mine, {
      maxComplexity: 250,
      complexityScale: 1.5,
      followed: others,
    });
    // Unguarded, the details of all six projects in one query are refused.
    expect(
      estimateComplexity(ownDetailsQuery("gitlab", mine)) * 1.5,
    ).toBeGreaterThan(250);
    const inbox = inboxOf(forge);
    await inbox.refresh();
    const snapshot = inbox.snapshot(settings);
    expect(snapshot.hosts).toEqual([
      expect.objectContaining({ host, state: "ok" }),
    ]);
    expect(snapshot.hosts[0]!.message).toBeUndefined();
    const authored = snapshot.entries.filter(
      (entry) => entry.section === "authored",
    );
    expect(authored).toHaveLength(30);
    expect(
      authored.every(
        (entry) => entry.pipeline === "success" && entry.own?.approved,
      ),
    ).toBe(true);
    // The followed projects' requests are there too.
    expect(
      stored
        .get()
        .items.filter((item) => item.number >= 900)
        .map((item) => item.number)
        .sort(),
    ).toEqual([900, 901, 902]);
    expect(forge.refused.length).toBeGreaterThan(0);
    const calls = forge.take();
    expect(
      calls.filter((call) => call.kind === "details").length,
    ).toBeGreaterThan(1);
    expect(
      calls.filter((call) => call.kind === "inbox").length,
    ).toBeGreaterThan(1);
    // Every request's details were asked once among the answered queries.
    expect(
      calls
        .filter((call) => call.kind === "details")
        .flatMap((call) => call.numbers)
        .sort((a, b) => a - b),
    ).toEqual(mine.map((r) => r.number));

    // The next refresh uses the learned limit: no refusal at all.
    forge.refused.splice(0);
    forge.update((list) =>
      list.map((r) => ({
        ...r,
        updatedAt: at(100 + r.number),
        pipeline: "failed",
      })),
    );
    await inbox.refresh();
    expect(forge.refused).toEqual([]);
    const again = inbox.snapshot(settings);
    expect(again.hosts[0]!.state).toBe("ok");
    expect(
      again.entries
        .filter((entry) => entry.section === "authored")
        .every((entry) => entry.pipeline === "failed"),
    ).toBe(true);
  });

  test("the light list is split too when its lists are too much together", async () => {
    // A host that refuses the first page's lists together (as a smaller
    // limit would), and takes each on its own.
    const forge = createOwnForge("gitlab", host, mine, { followed: others });
    const together = estimateComplexity(gitlabOwnListQuery());
    let refusals = 0;
    const inbox = inboxOf(forge, {
      ...forge.fetchers,
      async gitlab(where, query, call) {
        const complexity = estimateComplexity(query);
        if (
          query.includes("authoredMergeRequests") &&
          complexity > together - 10
        ) {
          refusals++;
          throw new Error(
            `GitLab: glab: Query has complexity of ${complexity}, which exceeds max complexity of ${together - 10}`,
          );
        }
        return forge.fetchers.gitlab(where, query, call);
      },
    });
    await inbox.refresh();
    expect(refusals).toBe(1);
    const snapshot = inbox.snapshot(settings);
    expect(snapshot.hosts[0]!.state).toBe("ok");
    expect(
      snapshot.entries.filter((entry) => entry.section === "authored"),
    ).toHaveLength(30);
  });

  test("a field refusal still falls back to fewer fields", async () => {
    const forge = createOwnForge("gitlab", host, mine, {
      refuseFull: true,
      maxComplexity: 250,
      complexityScale: 1.5,
    });
    const inbox = inboxOf(forge);
    await inbox.refresh();
    const authored = inbox
      .snapshot(settings)
      .entries.filter((entry) => entry.section === "authored");
    expect(authored).toHaveLength(30);
    expect(authored.every((entry) => entry.own)).toBe(true);
  });
});
