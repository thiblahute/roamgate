import { expect, test } from "bun:test";

test("no :has() sits on a review container that holds the comment editor", async () => {
  const css = await Bun.file(
    new URL("./ReviewOverlay.css", import.meta.url),
  ).text();
  // A :has() on an element re-checks it on every change under it: on the
  // review's containers, each key typed in a comment restyled every diff
  // line. Set a class from the component instead.
  const containers = /\.review-(overlay|main|diff|body)\b[^\s,{>+~]*:has\(/;
  const offending = css
    .split(/[{}]/)
    .filter((part) => part.includes(":has("))
    .flatMap((selectors) => selectors.split(","))
    .map((selector) => selector.trim())
    .filter((selector) => containers.test(selector));
  expect(offending).toEqual([]);
});
