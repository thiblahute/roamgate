import { expect, test } from "bun:test";
import { scanDiff, withoutSecrets } from "./secrets";

test("withoutSecrets drops secret keys and replaces secret values", () => {
  expect(
    withoutSecrets({
      name: "x",
      ANTHROPIC_AUTH_TOKEN: "abc",
      env: { password: "p", HOME: "/h" },
      note: "my token glpat-abcdefghijklmnop here",
      list: ["ghp_abcdefghijklmnopqrstuvwx1234", 1],
    }),
  ).toEqual({
    name: "x",
    env: { HOME: "/h" },
    note: "my token [removed] here",
    list: ["[removed]", 1],
  });
});

test("scanDiff names the file and line of each secret a diff adds", () => {
  const diff = [
    "diff --git a/work/items/a.md b/work/items/a.md",
    "--- a/work/items/a.md",
    "+++ b/work/items/a.md",
    "@@ -3,0 +4,2 @@",
    "+fine",
    "+token glpat-abcdefghijklmnop",
    "diff --git a/reviews/x.md b/reviews/x.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/reviews/x.md",
    "@@ -0,0 +1,3 @@",
    "+-----BEGIN OPENSSH PRIVATE KEY-----",
    "+ok",
    "+sk-abcdefghijklmnopqrstuvwxyz",
    "diff --git a/gone.md b/gone.md",
    "--- a/gone.md",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-glpat-abcdefghijklmnop",
  ].join("\n");
  expect(scanDiff(diff)).toEqual([
    { file: "work/items/a.md", line: 5, kind: "glpat-... token" },
    { file: "reviews/x.md", line: 1, kind: "private key" },
    { file: "reviews/x.md", line: 3, kind: "sk-... token" },
  ]);
});

test("a removed secret or a clean diff is no hit", () => {
  expect(
    scanDiff("+++ b/a\n@@ -1 +1 @@\n-ghp_abcdefghijklmnopqrstuvwx1234\n+clean"),
  ).toEqual([]);
});
