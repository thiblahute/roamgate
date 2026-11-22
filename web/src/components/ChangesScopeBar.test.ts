import { describe, expect, test } from "bun:test";
import {
  changesReviewShortLabel,
  changesScopeChoice,
  changesScopeFacts,
  changesScopeOptions,
  shownAgo,
  workspaceReviewLabel,
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
    // A base picked is named as a branch, not a ref.
    expect(
      changesScopeChoice("branch-main", "dogfood", "refs/heads/android-rust"),
    ).toBe("branch dogfood vs android-rust");
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

describe("the reviews a workspace's Changes offers", () => {
  const snapshot = (
    target: Record<string, unknown>,
    title = "t",
    mergeRequest?: { url: string; title: string },
  ) =>
    ({
      session: { id: "s", title, target },
      threads: [],
      ...(mergeRequest ? { mergeRequest } : {}),
    }) as unknown as Parameters<typeof workspaceReviewLabel>[0];
  const sha = "d272642486c9f06335ef462e866f0798d7a3a4ad";

  test("each is named as what it shows", () => {
    expect(
      workspaceReviewLabel(
        snapshot({ kind: "range", base: `${sha}^`, head: sha }),
        "d2726424 Fix the pads",
      ),
    ).toBe("commit d2726424 Fix the pads");
    expect(
      workspaceReviewLabel(
        snapshot({ kind: "range", base: `${sha}^`, head: sha }),
      ),
    ).toBe("commit d2726424");
    expect(
      workspaceReviewLabel(
        snapshot({ kind: "range", base: "a".repeat(40), head: sha }),
      ),
    ).toBe("range aaaaaaaa..d2726424");
    expect(
      workspaceReviewLabel(
        snapshot({ kind: "range", base: "main", head: "topic" }),
      ),
    ).toBe("branch topic vs main");
    expect(
      workspaceReviewLabel(
        snapshot({
          kind: "range",
          base: "topic-old",
          head: "topic",
          compare: true,
        }),
      ),
    ).toBe("topic-old vs topic");
    const url = "https://gitlab.example/g/p/-/merge_requests/12";
    expect(
      workspaceReviewLabel(
        snapshot({ kind: "mr", url }, "x", { url, title: "Fix the pads" }),
      ),
    ).toBe("MR !12 Fix the pads");
    expect(workspaceReviewLabel(snapshot({ kind: "mr", url }))).toBe("MR !12");
    expect(workspaceReviewLabel(undefined, "kept name")).toBe("kept name");
  });

  test("the picker lists them after the review shown, the latest first, an outdated one said so", () => {
    const options = changesScopeOptions({
      review: { label: "topic vs main" },
      reviews: [
        { id: "a", label: "commit d2726424 Fix", when: "5 min ago" },
        { id: "b", label: "MR !12 Fix", when: "2 d ago", outdated: true },
      ],
      baseBranch: "",
      baseBranches: [],
      elsewhere: false,
    });
    expect(options.slice(0, 3)).toEqual([
      { value: "review", label: "topic vs main", detail: "the review shown" },
      {
        value: "review:a",
        label: "commit d2726424 Fix",
        detail: "opened here 5 min ago",
      },
      {
        value: "review:b",
        label: "MR !12 Fix",
        detail: "outdated: its code is gone, its open threads kept · 2 d ago",
      },
    ]);
    expect(shownAgo(NOW_AGO - 30_000, NOW_AGO)).toBe("now");
    expect(shownAgo(NOW_AGO - 5 * 60_000, NOW_AGO)).toBe("5 min ago");
    expect(shownAgo(NOW_AGO - 3 * 3_600_000, NOW_AGO)).toBe("3 h ago");
    expect(shownAgo(NOW_AGO - 3 * 86_400_000, NOW_AGO)).toBe("3 d ago");
  });
});

const NOW_AGO = Date.parse("2026-11-19T12:00:00Z");
