import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MR_REVIEWS_SETTINGS,
  type MrReviewsSettings,
} from "../../../shared/mrReviews";
import { estimateComplexity } from "./complexity";
import { createMrInbox } from "./inbox";
import {
  createOwnForge,
  type FakeRequest,
  fakeRequests,
} from "./own-forge.fixture";
import { gitlabOwnListQuery, ownDetailsQuery } from "./queries";
import { openMrStore } from "./store";
import { runVectors } from "../../../contract/vectors/vectors";
import * as complexity from "./complexity";
import * as queries from "./queries";

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

// The cases are contract/vectors/mr-complexity.json, the Rust side's too.
runVectors("mr-complexity", { complexity, queries });
