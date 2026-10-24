import { expect, test } from "bun:test";
import { entryScript } from "./frontendFreshness";

test("the entry script is the hashed index chunk", () => {
  expect(
    entryScript(
      '<script type="module" crossorigin src="/assets/index-WHsScV4q.js"></script>',
    ),
  ).toBe("/assets/index-WHsScV4q.js");
  expect(entryScript("http://host:8787/assets/index-a_b-C.js")).toBe(
    "/assets/index-a_b-C.js",
  );
  // Vite's development page has none.
  expect(entryScript('<script type="module" src="/src/main.tsx">')).toBeNull();
});
