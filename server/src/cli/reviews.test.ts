import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  exportReviews,
  importChanges,
  parseReviewsExport,
  stableJson,
  withoutSecrets,
} from "../mr-reviews/export";
import { createReviewsCommand } from "./reviews";
import { createTestCli, type TestCli } from "./test-context";

const clis: TestCli[] = [];
afterEach(() => {
  for (const cli of clis.splice(0)) cli.cleanup();
});

const NOW = () => Date.parse("2026-11-16T12:00:00Z");

/** A home with settings.json and one effort's files, as the server leaves them. */
function seeded() {
  const cli = createTestCli();
  clis.push(cli);
  const data = join(cli.home, ".config", "roamgate");
  mkdirSync(join(data, "mr-reviews", "efforts", "e1"), { recursive: true });
  writeFileSync(
    join(data, "settings.json"),
    JSON.stringify({
      theme: "dark",
      gitlab_token: "glpat-abcdefghijklmnopqrstu",
      mr_reviews: {
        hosts: [{ host: "gitlab.example.org", provider: "gitlab" }],
        followed: [
          { host: "gitlab.example.org", provider: "gitlab", project: "g/p" },
        ],
        hints: "I maintain g/p; my token ghp_abcdefghijklmnopqrstuvwx1234",
        clones: {
          "gitlab.example.org/g/p": { connection_id: "local", path: "/x" },
        },
        order_version: 7,
        order: [
          "gitlab:gitlab.example.org/g/p#2",
          "gitlab:gitlab.example.org/g/p#1",
        ],
        overrides: {
          "gitlab:gitlab.example.org/g/p#1": {
            next: "Ask bob, token glpat-abcdefghijklmnopqrstu",
            at: "2026-11-10T00:00:00Z",
            by: "user",
            marker: "m",
          },
        },
        views: [{ name: "media", query: "project:media/*" }],
        efforts: [
          {
            id: "e1",
            group: "g1",
            name: "Big",
            clone: { connection_id: "local", path: "/clone" },
            source: "refs/heads/big",
            target: { remote: "origin", branch: "main" },
          },
        ],
      },
    }),
  );
  writeFileSync(
    join(data, "mr-reviews", "efforts", "e1", "ledger.json"),
    JSON.stringify({
      version: 3,
      entries: {
        k1: {
          disposition: "not_for_upstream",
          reason: "debug",
          subject: "x",
          authorDate: 1,
          sha: "a",
          at: "2026-11-10T00:00:00Z",
          by: "user",
        },
      },
      aliases: {},
      matches: {},
      plans: [],
      journal: [{ id: 1, at: "", by: "user", summary: "s", before: {} }],
    }),
  );
  writeFileSync(
    join(data, "mr-reviews", "efforts", "e1", "derived.json"),
    JSON.stringify({ commits: [{ subject: "derived" }] }),
  );
  writeFileSync(
    join(data, "mr-reviews", "efforts", "e1", "history.jsonl"),
    `${JSON.stringify({ key: "k1", sha: "a", where: "source" })}\n`,
  );
  return { cli, data };
}

test("export: the authored state only, key-sorted, stable, without secrets", async () => {
  const { cli, data } = seeded();
  const command = createReviewsCommand({ now: NOW });
  expect(await command.run(["export"], cli.context)).toBe(0);
  const text = cli.output.join("\n");
  const value = JSON.parse(text);
  expect(Object.keys(value.mr_reviews)).toEqual([
    "efforts",
    "followed",
    "hints",
    "hosts",
    "order",
    "overrides",
    "views",
  ]);
  // The hosts, followed projects and hints too (D30), a secret masked.
  expect(value.mr_reviews.hosts).toEqual([
    { host: "gitlab.example.org", provider: "gitlab" },
  ]);
  expect(value.mr_reviews.followed).toEqual([
    { host: "gitlab.example.org", provider: "gitlab", project: "g/p" },
  ]);
  expect(value.mr_reviews.hints).toBe("I maintain g/p; my token [removed]");
  expect(text).not.toContain("ghp_");
  // Not the clones, version, theme; nor derived data or the Undo journal.
  expect(text).not.toContain("clones");
  expect(text).not.toContain("order_version");
  expect(text).not.toContain("derived");
  expect(text).not.toContain("journal");
  expect(value.efforts.e1.history).toEqual([
    { key: "k1", sha: "a", where: "source" },
  ]);
  // No secret reaches it, by key or by value.
  expect(text).not.toContain("glpat-");
  expect(text).toContain("Ask bob, token [removed]");
  // Stable: the same state gives the same text.
  cli.output.length = 0;
  await command.run(
    ["export", "--out", join(cli.home, "out.json")],
    cli.context,
  );
  expect(readFileSync(join(cli.home, "out.json"), "utf8")).toBe(`${text}\n`);
  expect(text.indexOf('"efforts"')).toBeLessThan(text.indexOf('"exported_at"'));
  void data;
});

test("secrets are dropped by key and masked by value, at any depth", () => {
  const value = withoutSecrets({
    a: {
      api_key: "x",
      Password: "y",
      note: "ghp_abcdefghijklmnopqrstuvwx1234",
    },
    list: [{ authorization: "Bearer z", author: "kept" }],
    pem: "-----BEGIN OPENSSH PRIVATE KEY-----",
  });
  expect(value).toEqual({
    a: { note: "[removed]" },
    list: [{ author: "kept" }],
    pem: "[removed]",
  });
});

test("import: what it would change, nothing without --apply, then applied", async () => {
  const { cli, data } = seeded();
  const command = createReviewsCommand({ now: NOW });
  await command.run(
    ["export", "--out", join(cli.home, "mine.json")],
    cli.context,
  );
  const exported = parseReviewsExport(
    readFileSync(join(cli.home, "mine.json"), "utf8"),
  );
  const incoming = structuredClone(exported);
  incoming.mr_reviews.order = ["gitlab:gitlab.example.org/g/p#1"];
  (incoming.mr_reviews.overrides as any)["gitlab:gitlab.example.org/g/p#1"].at =
    "2026-11-01T00:00:00Z";
  (incoming.mr_reviews.overrides as any)[
    "gitlab:gitlab.example.org/g/p#1"
  ].next = "Older";
  incoming.mr_reviews.views = [];
  incoming.mr_reviews.pinned = [
    {
      provider: "gitlab",
      host: "gitlab.example.org",
      project: "g/p",
      number: 9,
    },
  ];
  incoming.mr_reviews.hosts = [
    { host: "gitlab.example.org", provider: "gitlab" },
    { host: "github.com", provider: "github" },
  ];
  incoming.mr_reviews.followed = [];
  incoming.mr_reviews.hints = "I maintain g/p and g/q";
  incoming.efforts.e1!.ledger.entries = {};
  incoming.efforts.e1!.history.push({ key: "k1", sha: "b", where: "source" });
  writeFileSync(join(cli.home, "theirs.json"), stableJson(incoming));
  expect(
    importChanges(exported, incoming).map((change) => [
      change.kind,
      change.path,
      change.newerLocal ?? false,
    ]),
  ).toEqual([
    ["removed", "efforts.e1.entries.k1", false],
    ["changed", "efforts.e1.history", false],
    ["removed", "mr_reviews.followed[gitlab:gitlab.example.org/g/p]", false],
    ["changed", "mr_reviews.hints", false],
    ["added", "mr_reviews.hosts[github:github.com]", false],
    ["changed", "mr_reviews.order", false],
    ["changed", "mr_reviews.overrides.gitlab:gitlab.example.org/g/p#1", true],
    ["added", "mr_reviews.pinned[gitlab:gitlab.example.org/g/p#9]", false],
    ["removed", "mr_reviews.views[media]", false],
  ]);
  cli.output.length = 0;
  const before = readFileSync(join(data, "settings.json"), "utf8");
  expect(
    await command.run(["import", join(cli.home, "theirs.json")], cli.context),
  ).toBe(0);
  expect(cli.output.join("\n")).toContain(
    "~ mr_reviews.overrides.gitlab:gitlab.example.org/g/p#1  (yours is newer)",
  );
  expect(cli.output.at(-1)).toBe("9 changes; --apply to make them.");
  expect(readFileSync(join(data, "settings.json"), "utf8")).toBe(before);
  expect(
    await command.run(
      ["import", join(cli.home, "theirs.json"), "--apply"],
      cli.context,
    ),
  ).toBe(0);
  const settings = JSON.parse(
    readFileSync(join(data, "settings.json"), "utf8"),
  );
  expect(settings.theme).toBe("dark");
  expect(settings.mr_reviews.order).toEqual([
    "gitlab:gitlab.example.org/g/p#1",
  ]);
  expect(settings.mr_reviews.views).toEqual([]);
  expect(settings.mr_reviews.hosts).toHaveLength(2);
  expect(settings.mr_reviews.followed ?? []).toEqual([]);
  expect(settings.mr_reviews.hints).toBe("I maintain g/p and g/q");
  expect(settings.mr_reviews.clones).toBeDefined();
  expect(settings.mr_reviews.order_version).toBe(8);
  const ledger = JSON.parse(
    readFileSync(
      join(data, "mr-reviews", "efforts", "e1", "ledger.json"),
      "utf8",
    ),
  );
  expect(ledger.entries).toEqual({});
  expect(ledger.journal).toEqual([]);
  expect(ledger.version).toBe(4);
  expect(
    readFileSync(
      join(data, "mr-reviews", "efforts", "e1", "history.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n"),
  ).toHaveLength(2);
  // Once applied, nothing more would change.
  const after = exportReviews({
    stored: settings.mr_reviews,
    effortsRoot: join(data, "mr-reviews", "efforts"),
  });
  expect(importChanges(after, incoming)).toEqual([]);
  // Anything else is refused.
  writeFileSync(join(cli.home, "bad.json"), '{"format":"other"}');
  expect(
    await command.run(["import", join(cli.home, "bad.json")], cli.context),
  ).toBe(1);
  expect(cli.errors.at(-1)).toContain("not a Reviews export");
});

test("import of a version 1 export keeps the hosts, followed projects and hints", async () => {
  const { cli, data } = seeded();
  const command = createReviewsCommand({ now: NOW });
  await command.run(
    ["export", "--out", join(cli.home, "mine.json")],
    cli.context,
  );
  const old = JSON.parse(readFileSync(join(cli.home, "mine.json"), "utf8"));
  old.version = 1;
  delete old.mr_reviews.hosts;
  delete old.mr_reviews.followed;
  delete old.mr_reviews.hints;
  writeFileSync(join(cli.home, "old.json"), stableJson(old));
  const local = parseReviewsExport(
    readFileSync(join(cli.home, "mine.json"), "utf8"),
  );
  expect(importChanges(local, parseReviewsExport(stableJson(old)))).toEqual([]);
  expect(
    await command.run(
      ["import", join(cli.home, "old.json"), "--apply"],
      cli.context,
    ),
  ).toBe(0);
  const settings = JSON.parse(
    readFileSync(join(data, "settings.json"), "utf8"),
  );
  expect(settings.mr_reviews.hosts).toEqual([
    { host: "gitlab.example.org", provider: "gitlab" },
  ]);
  expect(settings.mr_reviews.followed).toHaveLength(1);
  expect(settings.mr_reviews.hints).toContain("I maintain g/p");
});
