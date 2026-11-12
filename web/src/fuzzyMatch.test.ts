import { describe, expect, test } from "bun:test";
import {
  compareSearchMatches,
  fuzzyMatch,
  highlightRuns,
  matchSearch,
  searchTokens,
} from "./fuzzyMatch";

describe("fuzzyMatch", () => {
  test("finds letters in order, across words, as fzf does", () => {
    expect(fuzzyMatch("rgand", "roamgate-android")?.positions).toEqual([
      0, 4, 9, 10, 11,
    ]);
    expect(fuzzyMatch("glft", "gl-float-transfer")?.positions).toEqual([
      0, 1, 3, 9,
    ]);
    expect(fuzzyMatch("rgand", "android-roamgate")).toBeNull();
  });

  test("ignores case and marks the original characters", () => {
    expect(fuzzyMatch("ocio", "Reviews · OpenColorIO")?.positions).toEqual([
      10, 14, 19, 20,
    ]);
  });

  test("rates word and path starts and runs over scattered letters", () => {
    const score = (token: string, text: string) =>
      fuzzyMatch(token, text)?.score ?? 0;
    expect(score("tasks", "/Documents/tasks")).toBeGreaterThan(
      score("tasks", "/Documents/subtasks"),
    );
    expect(score("gstv", "gst2-video")).toBeGreaterThan(
      score("gstv", "gstreamer-dev"),
    );
  });

  test("drops letters scattered with nothing to anchor them", () => {
    expect(
      fuzzyMatch("video", "/var/home/thiblahute/devel/gstreamer/2.0"),
    ).toBeNull();
    expect(fuzzyMatch("pi", "cps-iga177-hdr")).toBeNull();
  });

  test("always keeps a plain substring, even inside a word", () => {
    expect(fuzzyMatch("amga", "roamgate")?.positions).toEqual([2, 3, 4, 5]);
  });
});

describe("matchSearch", () => {
  const tier = (query: string, name: string, ...rest: string[]) =>
    matchSearch(searchTokens(query), [name, ...rest])?.tier ?? -1;

  test("ranks the exact name, its start, word starts, inside, letters", () => {
    const tiers = [
      tier("tasks", "tasks"),
      tier("tasks", "tasks-worktrees"),
      tier("tasks", "my-tasks"),
      tier("tasks", "subtasks"),
      tier("tsk", "tasks"),
      tier("tasks", "notes", "/Documents/tasks"),
    ];
    expect(tiers).toEqual([...tiers].sort((a, b) => b - a));
    expect(new Set(tiers).size).toBe(tiers.length);
  });

  test("puts every word in the name before words found elsewhere", () => {
    expect(tier("gst video", "gst2-video", "/2.0/gst2-video")).toBeGreaterThan(
      tier("gst video", "opengl-videoscope", "/gstreamer/opengl-videoscope"),
    );
  });

  test("needs every word, in any order", () => {
    expect(tier("video gst", "gst2-video")).toBe(
      tier("gst video", "gst2-video"),
    );
    expect(matchSearch(searchTokens("gst nothing"), ["gst2-video"])).toBeNull();
  });

  test("marks what each word matched in its field", () => {
    expect(
      matchSearch(searchTokens("mac tasks"), ["tasks", "Mac", "/V/tasks"])
        ?.highlights,
    ).toEqual([[0, 1, 2, 3, 4], [0, 1, 2], undefined]);
  });

  test("keeps near-equal scores in the caller's order", () => {
    expect(
      compareSearchMatches({ tier: 1, score: 100 }, { tier: 1, score: 101 }),
    ).toBe(0);
    expect(
      compareSearchMatches({ tier: 1, score: 200 }, { tier: 2, score: 0 }),
    ).toBeGreaterThan(0);
  });
});

test("highlightRuns splits text into marked and plain runs", () => {
  expect(highlightRuns("roamgate", [0, 1, 4])).toEqual([
    { text: "ro", matched: true },
    { text: "am", matched: false },
    { text: "g", matched: true },
    { text: "ate", matched: false },
  ]);
  expect(highlightRuns("roamgate", undefined)).toEqual([
    { text: "roamgate", matched: false },
  ]);
});
