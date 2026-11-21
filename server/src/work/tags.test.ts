import { expect, test } from "bun:test";
import { autoWorkTags, WORK_AUTO_TAGS, workWords } from "./tags";

test("the project's own tags, named by their words, in the order the text names them", () => {
  const vocabulary = ["rfc-0052", "caps", "work-board", "p6", "docs"];
  expect(
    autoWorkTags(
      "RFC-0052 says the caps negotiation should move to p6; see the docs",
      vocabulary,
    ),
  ).toEqual(["rfc-0052", "caps", "p6", "docs"]);
  // A plural names the tag too; a word inside another word does not.
  expect(autoWorkTags("Fix the doc of the capsule", vocabulary)).toEqual([
    "docs",
  ]);
  expect(autoWorkTags("Nothing to see here", vocabulary)).toEqual([]);
});

test("areas of the app by their words and synonyms, spelt as the project spells them", () => {
  // No such tag in the project yet: the area's own word.
  expect(autoWorkTags("The header scrolls away on mobile", [])).toEqual([
    "phone",
  ]);
  // The project says mobile: mobile, whichever word the text uses.
  expect(
    autoWorkTags("On my phone the header scrolls away", ["mobile"]),
  ).toEqual(["mobile"]);
  expect(autoWorkTags("The MR's discussions stay pinned", [])).toEqual([
    "reviews",
  ]);
  expect(autoWorkTags("A merge request thread", ["review", "voice"])).toEqual([
    "review",
  ]);
  expect(autoWorkTags("TTS starts late in a call", [])).toEqual(["voice"]);
  expect(autoWorkTags("Hide the files pane", [])).toEqual(["files"]);
  expect(autoWorkTags("A free-text item on the work board", [])).toEqual([
    "work-board",
  ]);
});

test("common words name an area only as a phrase, or as the project's own tag", () => {
  expect(autoWorkTags("Keep my changes and the files I made", [])).toEqual([]);
  expect(autoWorkTags("The changes view folds a chunk", [])).toEqual([
    "changes",
  ]);
  expect(autoWorkTags("Keep my changes", ["changes"])).toEqual(["changes"]);
  expect(autoWorkTags("Call me back", [])).toEqual([]);
});

test("at most a few tags; images and links are not words", () => {
  expect(
    autoWorkTags("phone android review voice chat terminal", []).length,
  ).toBe(WORK_AUTO_TAGS);
  expect(
    workWords("See ![voice](</images/voice.png>) at https://x.org/phone ok"),
  ).toEqual(["see", "at", "ok"]);
  expect(
    autoWorkTags("See ![voice](</images/voice.png>) https://x.org/phone", []),
  ).toEqual([]);
});
