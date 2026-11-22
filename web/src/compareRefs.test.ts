import { describe, expect, test } from "bun:test";
import {
  type CompareRefs,
  isBackupRef,
  rankCompareRefs,
  refLabel,
} from "./compareRefs";

const day = 86_400;
const listed: CompareRefs = {
  current: "refs/heads/dogfood",
  upstream: "refs/remotes/fork/dogfood",
  base: "refs/remotes/origin/main",
  near: ["refs/heads/up/voice-setup", "refs/heads/up/work-view"],
  refs: [
    { name: "refs/heads/android-rust", date: 100 * day },
    {
      name: "refs/heads/backup/20260914-restructure/up/review",
      date: 200 * day,
    },
    { name: "refs/heads/dogfood", date: 300 * day },
    { name: "refs/heads/main", date: 50 * day },
    { name: "refs/heads/up/voice-setup", date: 299 * day },
    { name: "refs/heads/up/work-view", date: 298 * day },
    { name: "refs/heads/up/review-compare", date: 120 * day },
    { name: "refs/heads/phone-landscape", date: 150 * day },
    { name: "refs/remotes/origin/main", date: 60 * day },
    { name: "refs/remotes/fork/dogfood", date: 290 * day },
    { name: "refs/remotes/origin/android-rust", date: 90 * day },
    { name: "refs/tags/v0.8.15", date: 40 * day },
  ],
};
const labels = (search: string, options = {}) =>
  rankCompareRefs(listed, search, options).map((ref) => ref.label);

describe("the refs Changes compares", () => {
  test("are named without refs/heads/, refs/remotes/ or refs/tags/", () => {
    expect(refLabel("refs/heads/android-rust")).toBe("android-rust");
    expect(refLabel("refs/remotes/origin/main")).toBe("origin/main");
    expect(refLabel("refs/tags/v0.8.15")).toBe("v0.8.15");
    expect(isBackupRef("refs/heads/backup/20260914-restructure/x")).toBe(true);
    expect(isBackupRef("refs/heads/backup-old")).toBe(true);
    expect(isBackupRef("refs/heads/up/backups-view")).toBe(false);
  });

  test("with no search: the automatic base, the upstream, the stack, then branches by date, remote ones, tags, backups last; the checked-out one left out", () => {
    expect(labels("")).toEqual([
      "origin/main",
      "fork/dogfood",
      "up/voice-setup",
      "up/work-view",
      "phone-landscape",
      "up/review-compare",
      "android-rust",
      "main",
      "origin/android-rust",
      "v0.8.15",
      "backup/20260914-restructure/up/review",
    ]);
  });

  test("a search matches names in parts, fzf-style, the best first", () => {
    expect(labels("ar ru")[0]).toBe("android-rust");
    expect(labels("ar ru")).toContain("origin/android-rust");
    expect(labels("up/work")[0]).toBe("up/work-view");
    expect(labels("rev comp")[0]).toBe("up/review-compare");
    expect(labels("v0.8")).toEqual(["v0.8.15"]);
    expect(labels("zzz")).toEqual([]);
    // The matched letters, to mark.
    const [first] = rankCompareRefs(listed, "up/work");
    expect(first?.highlights).toEqual([0, 1, 3, 4, 5, 6]);
  });

  test("the head's side offers the checked-out branch first; the other side is left out", () => {
    expect(labels("", { withCurrent: true })[0]).toBe("dogfood");
    expect(rankCompareRefs(listed, "", { withCurrent: true })[0]?.reason).toBe(
      "checked out",
    );
    expect(labels("", { exclude: "refs/remotes/origin/main" })).not.toContain(
      "origin/main",
    );
  });
});
