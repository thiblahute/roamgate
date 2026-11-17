import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MrItem, MrReviewsPush } from "../../../shared/mrReviews";
import type { MrConnection } from "./clones";
import { createMrReviews } from "./module";
import { openMrStore } from "./store";

// settings.json is this test's own.
const dir = mkdtempSync(join(realpathSync("/tmp"), "mr-panel-"));
const previousPath = process.env.ROAMGATE_SETTINGS_PATH;
process.env.ROAMGATE_SETTINGS_PATH = join(dir, "settings.json");
afterAll(() => {
  if (previousPath === undefined) delete process.env.ROAMGATE_SETTINGS_PATH;
  else process.env.ROAMGATE_SETTINGS_PATH = previousPath;
  rmSync(dir, { recursive: true, force: true });
});

const request: MrItem = {
  provider: "gitlab",
  host: "gitlab.example.org",
  project: "g/app",
  number: 7,
  key: "gitlab:gitlab.example.org/g/app#7",
  url: "https://gitlab.example.org/g/app/-/merge_requests/7",
  title: "Fix it",
  author: "bob",
  draft: false,
  state: "open",
  updatedAt: new Date().toISOString(),
  headSha: "abc",
  sourceBranch: "fix-it",
  targetBranch: "main",
  pipeline: null,
  notes: 0,
  reasons: ["review_requested"],
};

test("the panel's search and filter: kept in settings.json, pushed to every page, read back with the inbox, no new version", async () => {
  const store = openMrStore(join(dir, "state-1.json"));
  const pushes: MrReviewsPush[] = [];
  const reviews = createMrReviews({
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    store,
    discoverHosts: () => [],
    publish: (push) => pushes.push(push),
  });
  const before = (await reviews.settings()).orderVersion ?? 0;
  const first = (await reviews.handle("bridge.mr_reviews.panel", {
    search: "project:gstreamer/*",
  })) as { panel: { search: string; filter: string; at: string } };
  expect(first.panel).toMatchObject({
    search: "project:gstreamer/*",
    filter: "all",
  });
  const second = (await reviews.handle("bridge.mr_reviews.panel", {
    filter: "review",
  })) as { panel: { search: string; filter: string; at: string } };
  expect(second.panel.search).toBe("project:gstreamer/*");
  expect(second.panel.filter).toBe("review");
  expect(second.panel.at > first.panel.at).toBe(true);
  expect(pushes.map((push) => push.changed)).toEqual([["panel"], ["panel"]]);
  expect(pushes.every((push) => push.version === before)).toBe(true);
  const stored = JSON.parse(
    readFileSync(process.env.ROAMGATE_SETTINGS_PATH!, "utf8"),
  );
  expect(stored.mr_reviews.panel).toEqual(second.panel);
  expect(stored.mr_reviews.order_version ?? 0).toBe(before);
  // What another device reads with the inbox.
  expect(reviews.inbox.snapshot(await reviews.settings()).panel).toEqual(
    second.panel,
  );
  // A filter it does not know: everything.
  await reviews.handle("bridge.mr_reviews.panel", { filter: "<bad>" });
  expect((await reviews.settings()).panel.filter).toBe("all");
  await expect(reviews.handle("bridge.mr_reviews.panel", {})).rejects.toThrow(
    "search or filter is required",
  );
  // The home prompt is a setting of its own.
  await reviews.handle("bridge.mr_reviews.settings.update", {
    settings: { homePrompt: "Review {url}" },
  });
  expect((await reviews.settings()).homePrompt).toBe("Review {url}");
  expect((await reviews.settings()).panel.search).toBe("project:gstreamer/*");
  reviews.stop();
});

test("a request's recorded home is linked as its home; open with a home shows the review there", async () => {
  const store = openMrStore(join(dir, "state-2.json"));
  store.update((state) => {
    state.items = [request];
    state.homes = {
      [request.key]: {
        connectionId: "local",
        workspaceId: "w-home",
        path: "/w/home",
        branch: "fix-it",
        at: new Date().toISOString(),
      },
    };
  });
  const conn: MrConnection = {
    id: "local",
    label: "Desktop",
    dirs: async () => [],
    run: async (script) => {
      if (script.includes("--show-toplevel"))
        return { code: 0, stdout: "T\t/w/home\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    herdr: async (method) => {
      if (method === "workspace.list")
        return {
          workspaces: [
            { workspace_id: "w-home", label: "something", cwd: "/w/home" },
          ],
        };
      return { panes: [] };
    },
  };
  const opened: Record<string, unknown>[] = [];
  const reviews = createMrReviews({
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    store,
    discoverHosts: () => [],
    connections: () => [conn],
    openReview: (params) => {
      opened.push(params);
      return { session: { id: "rs" } } as any;
    },
  });
  // The inbox knows the request from its last read.
  (reviews.inbox as any).item = (key: string) =>
    key === request.key ? request : undefined;
  (reviews.inbox as any).items = () => [request];
  const links = (await reviews.handle("bridge.mr_reviews.links", {
    keys: [request.key],
  })) as { links: Record<string, { workspaceId: string; why: string[] }[]> };
  expect(links.links[request.key]).toEqual([
    expect.objectContaining({ workspaceId: "w-home", why: ["home"] }),
  ]);
  const shown = (await reviews.handle("bridge.mr_reviews.open", {
    key: request.key,
    home: { connection_id: "local", workspace_id: "w-home" },
  })) as { workspaceId: string; sessionId: string };
  expect(shown).toMatchObject({ workspaceId: "w-home", sessionId: "rs" });
  expect(opened).toEqual([
    expect.objectContaining({ workspaceId: "w-home", root: "/w/home" }),
  ]);
  expect(store.get().homes?.[request.key]?.sessionId).toBe("rs");
  await expect(
    reviews.handle("bridge.mr_reviews.open", {
      key: request.key,
      home: { connection_id: "local" },
    }),
  ).rejects.toThrow("connection_id and workspace_id are required");
  reviews.stop();
});
