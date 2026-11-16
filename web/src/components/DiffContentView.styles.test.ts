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

test("every custom property the review in Changes reads with no fallback is defined", async () => {
  const sheets = [
    ...readdirSync(new URL(".", import.meta.url))
      .filter((name) => name.endsWith(".css"))
      .map((name) => new URL(`./${name}`, import.meta.url)),
    ...readdirSync(new URL("../styles/", import.meta.url), {
      recursive: true,
    })
      .map(String)
      .filter((name) => name.endsWith(".css"))
      .map((name) => new URL(`../styles/${name}`, import.meta.url)),
  ];
  const defined = new Set<string>();
  for (const sheet of sheets)
    for (const [, name] of (await Bun.file(sheet).text()).matchAll(
      /(--[\w-]+)\s*:/g,
    ))
      defined.add(name!);
  const css = (
    await Bun.file(new URL("./DiffContentView.css", import.meta.url)).text()
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  // An undefined one makes its declaration nothing: `--sans-font`, never
  // set, gave the comments and their editor the diff's code font.
  const missing = [
    ...new Set(
      [...css.matchAll(/var\((--[\w-]+)\)/g)].map(([, name]) => name!),
    ),
  ].filter((name) => !defined.has(name));
  expect(missing).toEqual([]);
});

test("the comment editor in Changes reads as the classic review's: its sans at 13px, in the panel's box", async () => {
  const css = (
    await Bun.file(new URL("./DiffContentView.css", import.meta.url)).text()
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => {
    // The rule of that selector alone (the last: after a shared one).
    const at = css.lastIndexOf(`\n${selector} {`);
    expect(at).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
  };
  for (const selector of [".diff-review-composer", ".diff-review-reply"]) {
    expect(rule(selector)).toContain("font-family: var(--sans-font);");
    expect(rule(selector)).toContain("font-size: 13px;");
  }
  const box = rule(".diff-review-composer.chat-review,\n.diff-review-reply");
  expect(box).toContain("--rv-surface: var(--shell-panel);");
  expect(box).toContain("--rv-surface-2: var(--panel-2);");
  const tokens = await Bun.file(
    new URL("../styles/tokens.css", import.meta.url),
  ).text();
  expect(tokens).toContain(
    '--sans-font: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;',
  );
});
