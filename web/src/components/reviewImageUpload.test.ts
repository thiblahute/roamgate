import { expect, test } from "bun:test";
import { summaryLine } from "./reviewImageUpload";

test("a folded thread names a comment's images instead of their paths", () => {
  expect(
    summaryLine(
      "See ![shot.png](</home/u/reviews/images/0123/abcd.png>) and ![](/tmp/a.png)\nmore",
    ),
  ).toBe("See [shot.png] and [image]");
  expect(summaryLine("Plain words")).toBe("Plain words");
});
