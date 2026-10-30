import { expect, test } from "bun:test";
import { parseUnifiedDiff } from "./patch";

test("parses git diffs with renames, additions and numbered lines", () => {
  const files = parseUnifiedDiff(
    [
      "diff --git a/src/old.c b/src/new.c",
      "similarity index 90%",
      "rename from src/old.c",
      "rename to src/new.c",
      "--- a/src/old.c",
      "+++ b/src/new.c",
      "@@ -10,3 +10,4 @@ int main(void)",
      " a",
      "-b",
      "+c",
      "+d",
      " e",
      "diff --git a/added.txt b/added.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/added.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "\\ No newline at end of file",
      "",
    ].join("\n"),
  );
  expect(files.map((f) => [f.oldPath, f.path])).toEqual([
    ["src/old.c", "src/new.c"],
    ["added.txt", "added.txt"],
  ]);
  expect(files[0]!.hunks[0]!.lines).toEqual([
    { kind: " ", old: 10, new: 10, text: "a" },
    { kind: "-", old: 11, new: null, text: "b" },
    { kind: "+", old: null, new: 11, text: "c" },
    { kind: "+", old: null, new: 12, text: "d" },
    { kind: " ", old: 12, new: 13, text: "e" },
  ]);
  expect(files[1]!.hunks[0]!.lines).toEqual([
    { kind: "+", old: null, new: 1, text: "hello" },
  ]);
});

test("a mailed patch: '--- ' after a finished hunk starts the next file", () => {
  const files = parseUnifiedDiff(
    [
      "--- a/one.c",
      "+++ b/one.c",
      "@@ -1,2 +1,2 @@",
      "-x",
      "+y",
      " z",
      "--- a/two.c",
      "+++ b/two.c",
      "@@ -5 +5 @@",
      "--- removed line that starts with dashes",
      "+new",
      "-- ",
      "2.47.0",
    ].join("\n"),
  );
  expect(files.map((f) => f.path)).toEqual(["one.c", "two.c"]);
  expect(files[1]!.hunks[0]!.lines.map((l) => [l.kind, l.text])).toEqual([
    ["-", "-- removed line that starts with dashes"],
    ["+", "new"],
  ]);
});

test("binary files and deletions", () => {
  const files = parseUnifiedDiff(
    [
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "diff --git a/gone.c b/gone.c",
      "deleted file mode 100644",
      "--- a/gone.c",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n"),
  );
  expect(files[0]).toMatchObject({ path: "img.png", binary: true });
  expect(files[1]).toMatchObject({ path: "gone.c", oldPath: "gone.c" });
  expect(files[1]!.hunks[0]!.lines).toEqual([
    { kind: "-", old: 1, new: null, text: "bye" },
  ]);
});
