import { expect, test } from "bun:test";
import { mergeRequestNumber, reviewMrSwitch } from "./reviewMrSwitch";

const url = "https://gitlab.example/gst/gstreamer/-/merge_requests/10046";
const found = { url, title: "Fix the leak", number: 10046 };
const range = { kind: "range" as const, base: "main", head: "HEAD" };

test("a local review with a merge request offers its review on GitLab", () => {
  expect(reviewMrSwitch({ target: range }, null, null, true)).toBeNull();
  const chip = reviewMrSwitch({ target: range }, null, found, true);
  expect(chip).toMatchObject({
    label: "MR !10046",
    mode: "local",
    on: false,
    action: "gitlab",
  });
  expect(chip?.title.startsWith("Fix the leak\n")).toBe(true);
});

test("a local review never shows itself as GitLab, whatever its flag", () => {
  // Reviews saved in the old GitLab mode are local reviews.
  expect(reviewMrSwitch({ target: range }, null, found, true)).toMatchObject({
    mode: "local",
    on: false,
    action: "gitlab",
  });
  expect(
    reviewMrSwitch({ target: { kind: "worktree" } }, null, null, true),
  ).toBeNull();
});

test("a merge request review offers its branch's local review", () => {
  const target = { kind: "mr" as const, url };
  expect(reviewMrSwitch({ target }, null, null, true)).toBeNull();
  expect(reviewMrSwitch({ target }, null, found, false)).toBeNull();
  expect(reviewMrSwitch({ target }, null, found, true)).toMatchObject({
    label: "MR !10046",
    action: "local",
    on: true,
  });
});

test("merge request numbers", () => {
  expect(mergeRequestNumber(`${url}/diffs`)).toBe(10046);
  expect(mergeRequestNumber("https://gitlab.example/x/-/issues/3")).toBeNull();
});
