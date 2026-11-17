import { describe, expect, test } from "bun:test";
import {
  changesReviewShortLabel,
  changesScopeChoice,
  changesScopeFacts,
  changesScopeOptions,
} from "./ChangesScopeBar";
import { plainDiffError } from "./diffErrors";

describe("Changes' scope line", () => {
  test("says plainly what is compared", () => {
    expect(changesScopeChoice("working", "x", undefined)).toBe(
      "Working tree: uncommitted changes",
    );
    expect(changesScopeChoice("branch-main", "iga-185", "origin/main")).toBe(
      "branch iga-185 vs origin/main",
    );
    expect(changesScopeChoice("branch-main", undefined, undefined)).toBe(
      "this branch vs its base",
    );
    expect(changesScopeChoice("last-step", "x", "y")).toMatch(/^Last step/);
  });

  test("counts the commits and the files, and says when all are untracked", () => {
    expect(
      changesScopeFacts({ mode: "branch-main", commits: 12, files: 4 }),
    ).toBe("12 commits · 4 files");
    expect(changesScopeFacts({ mode: "working", files: 4, untracked: 4 })).toBe(
      "4 files, all untracked",
    );
    expect(changesScopeFacts({ mode: "working", files: 3, untracked: 1 })).toBe(
      "3 files (1 untracked)",
    );
    expect(changesScopeFacts({ mode: "working", files: 1 })).toBe("1 file");
    expect(changesScopeFacts({ mode: "last-step", files: 0 })).toBe(
      "no change",
    );
  });
});

describe("the scope picker's choices", () => {
  const base = {
    branch: "feature",
    base: "refs/heads/main",
    baseBranch: "",
    baseBranches: ["refs/heads/main"],
  };
  test("a review from elsewhere offers its review, the working changes and the branch, never Last step", () => {
    const values = changesScopeOptions({
      ...base,
      review: { label: "origin/main..topic" },
      elsewhere: true,
    }).map((option) => option.value);
    expect(values[0]).toBe("review");
    expect(values).toContain("working");
    expect(values).toContain("branch:");
    expect(values).not.toContain("last-step");
  });
  test("the workspace's own repository keeps Last step", () => {
    expect(
      changesScopeOptions({ ...base, elsewhere: false }).map(
        (option) => option.value,
      ),
    ).toEqual(["working", "branch:", "branch:refs/heads/main", "last-step"]);
  });
});

describe("a scope that cannot load", () => {
  test("says why in words, not the server's", () => {
    expect(
      plainDiffError("root is not a repository of this workspace"),
    ).toContain("not one of this workspace's");
    expect(plainDiffError("root is not a repository's top level")).toContain(
      "top level",
    );
    expect(plainDiffError("git diff exited 128")).toBe("git diff exited 128");
  });
});

test("a merge or pull request's review is named on a phone by its number and title", () => {
  expect(
    changesReviewShortLabel({
      url: "https://gitlab.freedesktop.org/gstreamer/gst-plugins-rs/-/merge_requests/3326",
      title: "rtpgccbwe: Fix the estimation",
    }),
  ).toBe("!3326 rtpgccbwe: Fix the estimation");
  expect(
    changesReviewShortLabel({
      url: "https://github.com/powerfooI/roamgate/pull/12",
      title: "Add a thing",
    }),
  ).toBe("#12 Add a thing");
  expect(changesReviewShortLabel(undefined)).toBeUndefined();
});
