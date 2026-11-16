import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";

test("no :has() sits on a review container that holds the comment editor", async () => {
  // Every stylesheet applies to the review in Changes: the components' and
  // the app's.
  const sheets = [
    ...readdirSync(new URL(".", import.meta.url))
      .filter((name) => name.endsWith(".css"))
      .map((name) => new URL(`./${name}`, import.meta.url)),
    ...readdirSync(new URL("../styles/", import.meta.url))
      .filter((name) => name.endsWith(".css"))
      .map((name) => new URL(`../styles/${name}`, import.meta.url)),
  ];
  // A :has() on an element re-checks it on every change under it: on the
  // containers of the review in Changes (the inspector around it, its diff,
  // a file's section, a thread, the comments panel), each key typed in a
  // comment restyled every diff line. Set a class from the component
  // instead.
  const containers =
    /\.(workspace-inspector(-slot|-resource|-detail)?|inspector-changes-resource|diff-content-view|diff-file-section(-body)?|diff-review-(thread|overall|general|composer|reply)|chat-review|diff-threads|threads-panel(-list|-item)?)\b[^\s,{>+~]*:has\(/;
  // Two rules of other views stand: the phone's History and the Files
  // preview's Review only, never shown with the review's comment editor
  // (pending the user: plans/review-into-inspector-changes.tsv).
  const away =
    /^(\.workspace-inspector\[data-view="history"\]:has\(\.agent-history-drawer\)|\.workspace-inspector:has\(\.file-preview\.is-zen\))/;
  const offending: string[] = [];
  for (const sheet of sheets) {
    const css = (await Bun.file(sheet).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    const name = sheet.pathname.split("/").slice(-2).join("/");
    for (const selector of css
      .split(/[{}]/)
      .filter((part) => part.includes(":has("))
      .flatMap((selectors) => selectors.split(/,(?![^(]*\))/))
      .map((selector) => selector.trim().replace(/\s+/g, " ")))
      if (containers.test(selector) && !away.test(selector))
        offending.push(`${name}: ${selector}`);
  }
  expect(offending).toEqual([]);
});
