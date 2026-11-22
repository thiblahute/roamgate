import { expect, test } from "bun:test";
import {
  fileLinkLabel,
  fileLinkTitle,
  findFileReferences,
  resolveFileLink,
} from "./reviewFileLinks";

const root = "/home/u/devel/roamgate.worktrees";
const checkout = "/home/u/devel/roamgate";
const scope = {
  root,
  checkouts: [root, checkout],
  documentPath: "plans/todo.md",
};

test("a path of the review's repository, relative to it", () => {
  expect(resolveFileLink("plans/work-view.md", scope)).toEqual({
    root,
    path: "plans/work-view.md",
  });
  expect(resolveFileLink("plans/work-view.md:1", scope)).toEqual({
    root,
    path: "plans/work-view.md",
    line: 1,
  });
  expect(resolveFileLink("web/src/a.ts:12-20", scope)).toEqual({
    root,
    path: "web/src/a.ts",
    line: 12,
    endLine: 20,
  });
  // tsc's path:line:column.
  expect(resolveFileLink("web/src/a.ts:12:5", scope)).toEqual({
    root,
    path: "web/src/a.ts",
    line: 12,
  });
  expect(resolveFileLink("docs/a.md#usage", scope)).toEqual({
    root,
    path: "docs/a.md",
    fragment: "usage",
  });
  // `./` and `../` are beside the commented file; a path above the
  // repository is nowhere.
  expect(resolveFileLink("./work-view.md", scope)).toEqual({
    root,
    path: "plans/work-view.md",
  });
  expect(resolveFileLink("../README.md", scope)).toEqual({
    root,
    path: "README.md",
  });
  expect(resolveFileLink("../../etc/passwd", scope)).toBeNull();
  // Without a commented file, beside the root.
  expect(resolveFileLink("./a.md", { root })).toEqual({ root, path: "a.md" });
  // Without a repository, a relative path is nothing to open.
  expect(resolveFileLink("plans/a.md", { checkouts: [checkout] })).toBeNull();
});

test("an absolute path in a checkout Roamgate knows, by its path there", () => {
  expect(resolveFileLink(`${root}/plans/work-view.md`, scope)).toEqual({
    root,
    path: "plans/work-view.md",
  });
  expect(resolveFileLink(`${checkout}/web/src/App.tsx:40`, scope)).toEqual({
    root: checkout,
    path: "web/src/App.tsx",
    line: 40,
  });
  expect(resolveFileLink(`${root}/plans/a%20b.md`, scope)).toEqual({
    root,
    path: "plans/a b.md",
  });
  expect(resolveFileLink(root, scope)).toBeNull();
});

test("an absolute path outside every checkout, by its path on the host", () => {
  expect(resolveFileLink("/tmp/notes.md", scope)).toEqual({
    root: "/",
    path: "tmp/notes.md",
  });
  expect(resolveFileLink(`${root}-other/a.md:4`, scope)).toEqual({
    root: "/",
    path: `${root.slice(1)}-other/a.md`,
    line: 4,
  });
  expect(resolveFileLink("C:\\Users\\me\\a.txt", scope)).toEqual({
    root: "C:/",
    path: "Users/me/a.txt",
  });
  expect(resolveFileLink("file:///tmp/out/a%20b.wav", scope)).toEqual({
    root: "/",
    path: "tmp/out/a b.wav",
  });
  // Not the root itself, nor a way out of a path.
  expect(resolveFileLink("/", scope)).toBeNull();
  expect(resolveFileLink("/tmp/../etc/passwd", scope)).toBeNull();
});

test("a ~/ path is in the host's home", () => {
  const link = resolveFileLink("~/.claude/tmp/out/fr-1.wav:3", scope);
  expect(link).toEqual({
    root: "~",
    path: ".claude/tmp/out/fr-1.wav",
    line: 3,
  });
  expect(fileLinkLabel(link!, scope)).toBe("~/.claude/tmp/out/fr-1.wav:3");
  expect(fileLinkTitle(link!)).toBe("~/.claude/tmp/out/fr-1.wav:3");
  expect(resolveFileLink("~", scope)).toBeNull();
  expect(resolveFileLink("~/../x", scope)).toBeNull();
});

test("a file:// URL names the file on this host", () => {
  expect(resolveFileLink(`file://${root}/plans/work-view.md`, scope)).toEqual({
    root,
    path: "plans/work-view.md",
  });
  expect(
    resolveFileLink(`file://localhost${root}/plans/a%20b.md#top`, scope),
  ).toEqual({ root, path: "plans/a b.md", fragment: "top" });
  expect(resolveFileLink("file://host/share/a.md", scope)).toBeNull();
});

test("web addresses and the comment's own headings are no files", () => {
  expect(resolveFileLink("https://example.com/plans/a.md", scope)).toBeNull();
  expect(resolveFileLink("http://host:8080", scope)).toBeNull();
  expect(resolveFileLink("mailto:me@example.com", scope)).toBeNull();
  expect(resolveFileLink("#usage", scope)).toBeNull();
  expect(resolveFileLink("//evil.example/a.md", scope)).toBeNull();
  expect(resolveFileLink("", scope)).toBeNull();
});

test("the label is review-relative with the lines; elsewhere the full path", () => {
  expect(
    fileLinkLabel({ root, path: "plans/work-view.md", line: 1 }, scope),
  ).toBe("plans/work-view.md:1");
  expect(
    fileLinkLabel(
      { root: checkout, path: "web/src/a.ts", line: 3, endLine: 5 },
      scope,
    ),
  ).toBe(`${checkout}/web/src/a.ts:3-5`);
});

test("plain path:line references in text, not words, times or URLs", () => {
  const texts = (text: string) =>
    findFileReferences(text).map((found) => found.text);
  expect(texts("See plans/work-view.md:1 and web/src/a.ts:12-20.")).toEqual([
    "plans/work-view.md:1",
    "web/src/a.ts:12-20",
  ]);
  // A bare name needs a directory or an extension (`Note:3` is no file).
  expect(texts("(Makefile:3, ./Makefile:3, /abs/x.ts:7:3)")).toEqual([
    "./Makefile:3",
    "/abs/x.ts:7:3",
  ]);
  expect(texts("at 12:30, ratio:2, Note:3")).toEqual([]);
  expect(texts("https://example.com/a.md:3 and host:8080")).toEqual([]);
  expect(texts("foo:12abc")).toEqual([]);
});

test("plain absolute and ~/ paths to a file, without a line", () => {
  const texts = (text: string) =>
    findFileReferences(text).map((found) => found.text);
  expect(
    texts("Wrote /var/home/u/out/fr-1.wav, see ~/notes and ~/a.md:3."),
  ).toEqual(["/var/home/u/out/fr-1.wav", "~/notes", "~/a.md:3"]);
  // A route or a directory without an extension is no file.
  expect(texts("the /api/file/download route, and/or /tmp")).toEqual([]);
  expect(texts("https://example.com/a/b.png host/a/b.png")).toEqual([]);
});
