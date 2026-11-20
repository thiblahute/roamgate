import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window as BrowserWindow } from "happy-dom";
import { renderInlineMarkdown, renderMarkdown } from "./markdown";

/*
 * A review comment's links to files (reviewFileLinks), as the sanitizer
 * marks them for the comment's view to open in Files.
 */

const browser = new BrowserWindow({ url: "http://localhost:8787/" });
const globalsUsed = {
  DOMParser: browser.DOMParser,
  NodeFilter: browser.NodeFilter,
};
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  for (const [key, value] of Object.entries(globalsUsed)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
});

afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const root = "/home/u/devel/roamgate.worktrees";
const fileLinks = {
  root,
  checkouts: [root, "/home/u/devel/roamgate"],
  documentPath: "plans/todo.md",
};

type Link = {
  text: string;
  href: string | null;
  path: string | null;
  root: string | null;
  line: string | null;
  end: string | null;
  target: string | null;
};

function links(html: string): Link[] {
  const doc = new browser.DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("a")].map((a) => ({
    text: a.textContent ?? "",
    href: a.getAttribute("href"),
    path: a.getAttribute("data-file-path"),
    root: a.getAttribute("data-file-root"),
    line: a.getAttribute("data-file-line"),
    end: a.getAttribute("data-file-end"),
    target: a.getAttribute("target"),
  }));
}

test("a Markdown link to a file of the review, in every form", () => {
  const found = links(
    renderMarkdown(
      [
        "[plans/work-view.md](plans/work-view.md)",
        `[the plan](${root}/plans/work-view.md)`,
        `[in brackets](<${root}/plans/work-view.md:3>)`,
        `[as a URL](file://${root}/plans/work-view.md)`,
        "[beside](./work-view.md#goals)",
      ].join("\n\n"),
      { fileLinks },
    ),
  );
  expect(found.map((link) => link.path)).toEqual([
    "plans/work-view.md",
    "plans/work-view.md",
    "plans/work-view.md",
    "plans/work-view.md",
    "plans/work-view.md",
  ]);
  expect(found.every((link) => link.root === root)).toBe(true);
  expect(found.every((link) => link.href === "#")).toBe(true);
  expect(found.every((link) => link.target === null)).toBe(true);
  expect(found[2]!.line).toBe("3");
  expect(found.map((link) => link.text)).toEqual([
    "plans/work-view.md",
    "the plan",
    "in brackets",
    "as a URL",
    "beside",
  ]);
});

test("a link's text that is its path is shortened to the review's", () => {
  const found = links(
    renderMarkdown(
      `[${root}/plans/work-view.md:1](${root}/plans/work-view.md:1) [file://${root}/plans/a%20b.md](file://${root}/plans/a%20b.md)`,
      { fileLinks },
    ),
  );
  expect(found.map((link) => link.text)).toEqual([
    "plans/work-view.md:1",
    "plans/a b.md",
  ]);
  expect(found[0]!.line).toBe("1");
});

test("plain path:line references become links, in backticks too", () => {
  const found = links(
    renderMarkdown(
      `See plans/work-view.md:1, \`web/src/a.ts:12-20\` and ${root}/plans/b.md:4.`,
      { fileLinks },
    ),
  );
  expect(
    found.map((link) => [link.text, link.path, link.line, link.end]),
  ).toEqual([
    ["plans/work-view.md:1", "plans/work-view.md", "1", null],
    ["web/src/a.ts:12-20", "web/src/a.ts", "12", "20"],
    ["plans/b.md:4", "plans/b.md", "4", null],
  ]);
  // In backticks, a bare name with its line is a file too.
  expect(
    links(renderMarkdown("run `Makefile:3`, not Note:3", { fileLinks })).map(
      (link) => [link.text, link.path, link.line],
    ),
  ).toEqual([["Makefile:3", "Makefile", "3"]]);
  // A table cell's too.
  expect(
    links(renderInlineMarkdown("fix `web/src/a.ts:3`", { fileLinks })).map(
      (link) => link.path,
    ),
  ).toEqual(["web/src/a.ts"]);
});

test("links elsewhere stay as they were", () => {
  const found = links(
    renderMarkdown(
      "[web](https://example.com/plans/a.md) [out](/tmp/a.md:3) [head](#goals) plain text at 12:30",
      { fileLinks },
    ),
  );
  expect(found.map((link) => link.path)).toEqual([null, null, null]);
  expect(found.map((link) => link.target)).toEqual(["_blank", "_blank", null]);
  expect(found.map((link) => link.href)).toEqual([
    "https://example.com/plans/a.md",
    "/tmp/a.md:3",
    "#goals",
  ]);
  // A file:// URL is still no link when nothing resolves it.
  expect(links(renderMarkdown(`[a](file://${root}/a.md)`))).toEqual([
    expect.objectContaining({ href: null, path: null }),
  ]);
  // Without a scope, nothing changes: a comment outside a review.
  expect(links(renderMarkdown("plans/work-view.md:1"))).toEqual([]);
});

test("references inside code blocks are left alone", () => {
  expect(
    links(renderMarkdown("```\nplans/work-view.md:1\n```", { fileLinks })),
  ).toEqual([]);
});
