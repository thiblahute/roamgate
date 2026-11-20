import { describe, expect, test } from "bun:test";
import {
  anchorAt,
  anchorDetached,
  anchorInFile,
  anchoredInFile,
  placeInFile,
  renderedWords,
} from "./fileAnchors";
import type { ReviewAnchor } from "./review";

/*
 * A TODO list as the Files preview shows it, its items commented on, then
 * edited: an item moved as it was, one reworded and moved, one deleted.
 */
const before = [
  "# TODO",
  "",
  "## Waiting",
  "",
  "- [ ] Firefox: old Roamgate notifications pile up since first use. What is",
  "      wanted: clear them when they no longer apply? (asked",
  "      2026-11-20 00:xx, no answer yet)",
  "- [ ] Headset (boom mic) muting after each turn: fixed twice on",
  "      2026-11-19, needs one real headset call to confirm.",
  "- [ ] Call 1 on 2026-11-19 stopped listening at 23:31 after another voice.",
  "- [ ] Learn my music tastes: nothing built yet.",
  "",
  "## Done",
  "",
  "- [x] Something older.",
];
const after = [
  "# TODO",
  "",
  "## Waiting",
  "",
  "- [ ] Learn my music tastes: nothing built yet.",
  "",
  "## Done",
  "",
  "- [x] Something older.",
  "- [x] Headset (boom mic) muting after each turn: fixed twice on",
  "      2026-11-19, needs one real headset call to confirm.",
  "- [x] Firefox: old Roamgate notifications piling up (the user says it is fixed, 2026-11-20).",
];

/** A thread written in the Files preview on an item's lines. */
function onItem(line: number, endLine: number | undefined, quote: string) {
  const note = {
    source: "file",
    anchor: "quote",
    path: "/repo/todo.md",
    quote,
    line,
    ...(endLine !== undefined ? { endLine } : {}),
  };
  const anchor: ReviewAnchor = {
    path: "todo.md",
    line,
    ...(endLine !== undefined ? { endLine } : {}),
    side: "new",
    text: before[(endLine ?? line) - 1]!,
    render: { quote },
    feedback: JSON.stringify(note),
  };
  return anchor;
}

const firefox = onItem(
  5,
  7,
  "Firefox: old Roamgate notifications pile up since first use. What is\nwanted: clear them when they no longer apply? (asked\n2026-11-20 00:xx, no answer yet)",
);
const headset = onItem(
  8,
  9,
  "Headset (boom mic) muting after each turn: fixed twice on\n2026-11-19, needs one real headset call to confirm.",
);
const call = onItem(
  10,
  undefined,
  "Call 1 on 2026-11-19 stopped listening at 23:31 after another voice.",
);
const music = onItem(
  11,
  undefined,
  "Learn my music tastes: nothing built yet.",
);

describe("placeInFile", () => {
  test("a thread stays on its lines while they read as written", () => {
    for (const anchor of [firefox, headset, call, music])
      expect(placeInFile(anchor, before)).toEqual({
        line: anchor.line!,
        ...(anchor.endLine !== undefined ? { endLine: anchor.endLine } : {}),
        text: anchor.text!,
        quote: anchor.render!.quote!,
        how: "kept",
      });
  });

  test("an item moved as it was is found by its last line's text, its lines with it", () => {
    expect(placeInFile(headset, after)).toEqual({
      line: 10,
      endLine: 11,
      text: headset.text!,
      quote: headset.render!.quote!,
      how: "text",
    });
    // Its lines shifted up: still its words.
    expect(placeInFile(music, after)).toMatchObject({ line: 5, how: "text" });
  });

  test("an item reworded and moved is found by its first words, its quote now as it reads", () => {
    expect(placeInFile(firefox, after)).toEqual({
      line: 12,
      text: after[11]!,
      quote:
        "Firefox: old Roamgate notifications piling up (the user says it is fixed, 2026-11-20).",
      how: "words",
    });
  });

  test("a deleted item is found nowhere: never on what its lines hold now", () => {
    expect(placeInFile(call, after)).toBeNull();
    // Its old line (10) is the headset item now.
    expect(after[9]).toContain("Headset");
  });

  test("an item too changed is not found: most of its first words must read on", () => {
    const lines = [
      "- [ ] Files source view: `c` comments on the cursor line (asked 2026-11-20).",
      "- [ ] Files source view: threads inline under their lines (asked 2026-11-20).",
    ];
    const anchor: ReviewAnchor = {
      path: "a.md",
      line: 1,
      side: "new",
      text: lines[0]!,
      render: { quote: "Files source view: c comments on" },
    };
    expect(placeInFile(anchor, lines)).toMatchObject({ line: 1, how: "kept" });
    // The first item gone: the second shares only "Files source view".
    expect(placeInFile(anchor, lines.slice(1))).toBeNull();
    // Reworded in place, most of its first words still in their order:
    // found there, its quote now as it reads.
    expect(
      placeInFile(anchor, [
        "- [ ] Files source view: `c` now comments on the cursor's line.",
      ]),
    ).toEqual({
      line: 1,
      text: "- [ ] Files source view: `c` now comments on the cursor's line.",
      quote: "Files source view: c now comments on the cursor's line.",
      how: "words",
    });
  });

  test("a short quote must read whole, a reworded first line keeps the lines after it", () => {
    const lines = [
      "- Rejected",
      "- Accepted",
      "- The parser, rewritten: reads each line twice, which",
      "  is slow on large files, and keeps the old numbering",
      "  for its errors.",
      "- Another item.",
    ];
    const short = onItem(2, undefined, "Rejected");
    // "Rejected" is on line 1 now.
    expect(placeInFile(short, lines)).toMatchObject({ line: 1, how: "words" });
    expect(placeInFile(onItem(2, undefined, "Rejecting"), lines)).toBeNull();
    const long: ReviewAnchor = {
      path: "a.md",
      line: 20,
      endLine: 22,
      side: "new",
      text: "  for its errors.",
      render: {
        quote:
          "The parser: reads each line twice, which\nis slow on large files, and keeps the old numbering\nfor its errors.",
      },
    };
    expect(placeInFile(long, lines)).toEqual({
      line: 3,
      endLine: 5,
      text: "  for its errors.",
      quote:
        "The parser, rewritten: reads each line twice, which\nis slow on large files, and keeps the old numbering\nfor its errors.",
      how: "words",
    });
  });

  test("a last line read on another item does not keep the thread there", () => {
    const lines = [
      "- [ ] Review search on desktop: N does nothing, n must wrap",
      "      (asked 2026-11-20).",
      "- [ ] Review on desktop: too much context shown, gg does not scroll",
      "      (asked 2026-11-20).",
    ];
    const anchor: ReviewAnchor = {
      path: "a.md",
      line: 1,
      endLine: 2,
      side: "new",
      text: "      (asked 2026-11-20).",
      render: {
        quote:
          "Review on desktop: too much context shown, gg does not scroll\n(asked 2026-11-20).",
      },
    };
    // Written on the second item, read back as the first's lines: the
    // text matches there, the words do not.
    expect(placeInFile(anchor, lines)).toMatchObject({
      line: 3,
      endLine: 4,
      how: "text",
    });
    expect(placeInFile(anchor, lines.slice(0, 2))).toBeNull();
  });

  test("a thread with no line text (an agent's) is kept where its words are, and given it", () => {
    const anchor: ReviewAnchor = {
      path: "todo.md",
      line: 8,
      endLine: 9,
      side: "new",
      render: { quote: "Headset (boom mic) muting after each turn" },
    };
    expect(placeInFile(anchor, before)).toMatchObject({
      line: 8,
      endLine: 9,
      text: before[8],
      how: "kept",
    });
    // Its words still read whole on the item's first line: the quote stays.
    expect(placeInFile(anchor, after)).toEqual({
      line: 10,
      text: after[9]!,
      quote: "Headset (boom mic) muting after each turn",
      how: "words",
    });
    // Neither text nor words: nothing to find it by, kept.
    expect(
      placeInFile({ path: "todo.md", line: 3, side: "new" }, after),
    ).toMatchObject({ line: 3, text: "## Waiting", how: "kept" });
  });

  test("a thread off its lines is placed again once its words are back", () => {
    const detached = anchorDetached(call);
    expect(detached.line).toBeUndefined();
    expect(placeInFile(detached, after)).toBeNull();
    expect(placeInFile(detached, before)).toMatchObject({
      line: 10,
      how: "text",
    });
  });

  test("a graphic's region, a removed line and a message part are not looked for", () => {
    const graphic: ReviewAnchor = {
      path: "d.md",
      line: 3,
      side: "new",
      text: "```mermaid",
      render: { graphic: "diagram 1", region: { x: 0, y: 0, w: 0, h: 0 } },
    };
    expect(placeInFile(graphic, ["", "", "```mermaid", "```"])).toMatchObject({
      line: 3,
      how: "kept",
    });
    expect(placeInFile(graphic, ["x", "y"])).toBeNull();
    expect(placeInFile({ ...call, side: "old" }, before)).toBeNull();
    expect(
      anchoredInFile({
        ...call,
        message: { thread: "t", comment: "c", quote: "q" },
      }),
    ).toBe(false);
    expect(anchoredInFile(call)).toBe(true);
    expect(anchoredInFile({ path: "a.md" })).toBe(false);
  });
});

describe("anchors written back", () => {
  test("a moved anchor says its lines, text and words, its note too", () => {
    const moved = anchorAt(firefox, placeInFile(firefox, after)!);
    expect(moved.line).toBe(12);
    expect(moved.endLine).toBeUndefined();
    expect(moved.text).toBe(after[11]!);
    expect(moved.render?.quote).toBe(
      "Firefox: old Roamgate notifications piling up (the user says it is fixed, 2026-11-20).",
    );
    expect(JSON.parse(moved.feedback!)).toMatchObject({
      source: "file",
      line: 12,
      quote: moved.render?.quote,
    });
    expect(JSON.parse(moved.feedback!)).not.toHaveProperty("endLine");
  });

  test("a detached anchor keeps its words and text, off any line, its note too", () => {
    const detached = anchorDetached(call);
    expect(detached).not.toHaveProperty("line");
    expect(detached.text).toBe(call.text!);
    expect(detached.render?.quote).toBe(call.render!.quote!);
    const note = JSON.parse(detached.feedback!);
    expect(note).not.toHaveProperty("line");
    expect(note.quote).toBe(call.render!.quote!);
  });

  test("anchorInFile changes nothing kept, moves or detaches the rest", () => {
    expect(anchorInFile(headset, before)).toBeNull();
    expect(anchorInFile(headset, after)).toMatchObject({
      line: 10,
      endLine: 11,
    });
    expect(anchorInFile(call, after)).toEqual(anchorDetached(call));
    expect(anchorInFile(anchorDetached(call), after)).toBeNull();
    // A thread with no text yet is given its line's.
    const bare: ReviewAnchor = { path: "todo.md", line: 1, side: "new" };
    expect(anchorInFile(bare, before)).toMatchObject({
      line: 1,
      text: "# TODO",
    });
    expect(anchorInFile({ path: "todo.md" }, before)).toBeNull();
  });
});

test("renderedWords reads source lines as the preview shows them, near enough", () => {
  expect(
    renderedWords([
      "- [x] **Firefox**: old `notifications` _pile up_ ([bug](http://x)).",
      "      with a second line \\*kept\\*",
      "",
      "> quoted ~~gone~~ words",
      "## A heading",
    ]),
  ).toBe(
    "Firefox: old notifications pile up (bug).\nwith a second line *kept*\nquoted gone words\nA heading",
  );
});
