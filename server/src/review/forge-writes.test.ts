import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Roamgate never publishes to a forge from the review code: the only
 * writes are the user's drafts (GitLab draft notes, the pending GitHub
 * review's comments and body). This reads the sources and lists every
 * write they can make.
 */

const DIRS = [import.meta.dir, join(import.meta.dir, "../mr-reviews")];

function sources(): [string, string][] {
  return DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name): [string, string] => [
        name,
        readFileSync(join(dir, name), "utf8"),
      ]),
  );
}

test("the only GitLab writes are draft notes", () => {
  const writes: string[] = [];
  for (const [name, text] of sources())
    for (const match of text.matchAll(
      /glab\(\s*context,\s*[^,]+,\s*"(POST|PUT|DELETE)",\s*([^,]+),/g,
    ))
      writes.push(`${name} ${match[1]} ${match[2]!.trim()}`);
  expect(writes.length).toBeGreaterThan(0);
  for (const write of writes) expect(write).toMatch(/draft_notes|"graphql"/);
});

test("the only GitHub mutations are the pending review's drafts", () => {
  const allowed = new Set([
    "addPullRequestReview",
    "addPullRequestReviewThread",
    "addPullRequestReviewThreadReply",
    "updatePullRequestReviewComment",
    "deletePullRequestReviewComment",
    "updatePullRequestReview",
  ]);
  const found = new Set<string>();
  for (const [, text] of sources())
    for (const match of text.matchAll(/mutation\([^)]*\)\s*\{\s*(\w+)/g))
      found.add(match[1]!);
  expect([...found].filter((name) => !allowed.has(name))).toEqual([]);
  const all = sources()
    .map(([, text]) => text)
    .join("\n");
  // Nothing submits, publishes, resolves or comments publicly.
  for (const word of [
    "submitPullRequestReview",
    "resolveReviewThread",
    "addComment(",
    "bulk_publish",
    "/notes`",
    "/discussions`, [",
    "resolved=true",
    "--method PATCH",
  ])
    expect(all).not.toContain(word);
  // No REST write to GitHub at all.
  expect(all).not.toMatch(/ghApi\([^)]*"(POST|PATCH|PUT|DELETE)",\s*`repos/);
  // The GitLab GraphQL writes would be mutations: there are none.
  expect(all).not.toMatch(/glab\([^)]*"graphql"[^)]*mutation/);
});
