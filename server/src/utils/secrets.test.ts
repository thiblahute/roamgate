import { expect, test } from "bun:test";
import {
  redactSecrets,
  scanDiff,
  SECRET_MARK,
  withoutSecrets,
} from "./secrets";

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

test("redactSecrets replaces tokens, keys, credentials and secret pairs", () => {
  const cases: Array<[string, string]> = [
    ["token glpat-abcdefghij1234567890 here", `token ${SECRET_MARK} here`],
    [`gh ghp_${"a".repeat(36)}`, `gh ${SECRET_MARK}`],
    [`key sk-ant-${"x".repeat(40)}`, `key ${SECRET_MARK}`],
    ["aws AKIAABCDEFGHIJKLMNOP", `aws ${SECRET_MARK}`],
    [
      "https://user:hunter2pass@example.com/repo",
      `https://user:${SECRET_MARK}@example.com/repo`,
    ],
    [
      "Authorization: Bearer abc.def.ghi123",
      `Authorization: Bearer ${SECRET_MARK}`,
    ],
    ['password="correct-horse"', `password=${SECRET_MARK}`],
    ["export API_KEY=Zx81kdP2qq9", `export API_KEY=${SECRET_MARK}`],
    [
      "-----BEGIN OPENSSH PRIVATE KEY----- \u23ce b3BlbnNzaC1rZXk \u23ce -----END OPENSSH PRIVATE KEY-----",
      SECRET_MARK,
    ],
  ];
  for (const [input, expected] of cases) {
    const out = redactSecrets(input);
    expect(out.text).toBe(expected);
    expect(out.count).toBeGreaterThan(0);
  }
});

test("redactSecrets leaves ordinary text and code alone", () => {
  for (const text of [
    "the secret is to keep going",
    "const password = getPassword();",
    "token = os.environ['TOKEN']",
    "sk-learn is a library",
    "https://example.com/path?x=1",
  ]) {
    const out = redactSecrets(text);
    expect(out.text).toBe(text);
    expect(out.count).toBe(0);
  }
});
