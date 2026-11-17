import { expect, test } from "bun:test";
import type { ReviewDiff } from "../../shared/review";
import {
  type HunkUnit,
  type ReviewedFile,
  reviewedChanges,
} from "./reviewNavigation";
import {
  fileFingerprint,
  fileToggleChanges,
  fileToggleNotice,
  hunkToggle,
  hunkToggleNotice,
  pickHunks,
} from "./reviewToggle";

type File = ReviewDiff["files"][number];
const file = (lines: [string, string][][]): File =>
  ({
    path: "a.ts",
    hunks: lines.map((hunk) => ({
      lines: hunk.map(([kind, text]) => ({ kind, text })),
    })),
  }) as unknown as File;

test("a file's fingerprint changes with its lines, not with anything else", () => {
  const one = file([
    [
      ["+", "a"],
      [" ", "b"],
    ],
  ]);
  expect(fileFingerprint(one)).toBe(
    fileFingerprint(
      file([
        [
          ["+", "a"],
          [" ", "b"],
        ],
      ]),
    ),
  );
  expect(fileFingerprint(one)).toMatch(/^1:[0-9a-z]+$/);
  expect(fileFingerprint(one)).not.toBe(
    fileFingerprint(
      file([
        [
          ["+", "a"],
          [" ", "c"],
        ],
      ]),
    ),
  );
  expect(fileFingerprint(one)).not.toBe(
    fileFingerprint(
      file([
        [
          ["-", "a"],
          [" ", "b"],
        ],
      ]),
    ),
  );
  expect(fileFingerprint(file([[["+", "a"]], [[" ", "b"]]]))).toMatch(/^2:/);
});

test("a file's fingerprint stays the one reviewed marks were stored with", () => {
  expect(
    fileFingerprint(
      file([
        [
          ["+", "a"],
          [" ", "b"],
        ],
      ]),
    ),
  ).toBe("1:vx98p3");
  expect(
    fileFingerprint(
      file([
        [["+", "a"]],
        [
          [" ", "b"],
          ["-", "c"],
        ],
      ]),
    ),
  ).toBe("2:pc9gkh");
  expect(fileFingerprint(file([]))).toBe("0:45h");
});

// Rows: file 0 has hunk 0 (rows 0-1), context (2), hunk 1 (3); file 1 hunk 0 (4).
const units: HunkUnit[] = [
  { file: 0, hunk: 0 },
  { file: 0, hunk: 0 },
  null,
  { file: 0, hunk: 1 },
  { file: 1, hunk: 0 },
  null,
];
test("r takes the cursor's hunk, or every hunk the selection covers", () => {
  const near = (at: number) => units[at] ?? null;
  expect([...pickHunks(units, 1, null, near)]).toEqual([[0, new Set([0])]]);
  // On context, no hunk: the view marks the file instead.
  expect([...pickHunks(units, 2, null, near)]).toEqual([]);
  expect([...pickHunks(units, 4, 1, near)]).toEqual([
    [0, new Set([0, 1])],
    [1, new Set([0])],
  ]);
  // The selection's context rows pick nothing of their own.
  expect([...pickHunks(units, 2, 2, near)]).toEqual([]);
});

const files: ReviewedFile[] = [
  { path: "a.ts", fingerprint: "2:x", hunks: ["h0", "h1"] },
  { path: "b.ts", fingerprint: "1:y", hunks: ["k0"] },
];

test("marking a hunk writes its mark; the file is reviewed once its last hunk is", () => {
  const first = hunkToggle(new Map([[0, new Set([0])]]), files, [], "all", {});
  expect(first.marking).toBe(true);
  expect(first.fileDone).toBe(false);
  expect(first.chunks).toBe("1/2");
  expect(first.count).toBe(1);
  expect(first.files).toEqual([0]);
  expect(first.changes).toEqual(
    reviewedChanges(files[0]!, new Set([0]), "all", {}),
  );
  expect(Object.keys(first.changes).length).toBeGreaterThan(0);
  expect(hunkToggleNotice(first, 0, 2)).toBe(
    "Chunk reviewed (1/2 in the file)",
  );

  const last = hunkToggle(
    new Map([[0, new Set([1])]]),
    files,
    [new Set([0])],
    "all",
    {},
  );
  expect(last.fileDone).toBe(true);
  expect(last.changes["all:a.ts"]).toBe("2:x");
  expect(hunkToggleNotice(last, 0, 2)).toBe(
    "Chunk reviewed: the file is (1/2)",
  );
});

test("hunks all reviewed are unmarked; some not reviewed are all marked", () => {
  const off = hunkToggle(
    new Map([[0, new Set([0, 1])]]),
    files,
    [new Set([0, 1])],
    "all",
    { "all:a.ts": "2:x" },
  );
  expect(off.marking).toBe(false);
  expect(off.chunks).toBe("0/2");
  expect(off.changes).toEqual(
    reviewedChanges(files[0]!, new Set(), "all", { "all:a.ts": "2:x" }),
  );
  expect(off.changes["all:a.ts"]).not.toBe("2:x");
  expect(hunkToggleNotice(off, 1, 2)).toBe(
    "2 chunks no longer reviewed (0/2 in the file)",
  );
  const mixed = hunkToggle(
    new Map([
      [0, new Set([0])],
      [1, new Set([0])],
    ]),
    files,
    [new Set([0])],
    "all",
    {},
  );
  expect(mixed.marking).toBe(true);
  expect(mixed.files).toEqual([0, 1]);
  // The last file's count.
  expect(mixed.chunks).toBe("1/1");
});

test("a file of the picked hunks the view no longer has is left out", () => {
  const toggle = hunkToggle(new Map([[7, new Set([0])]]), files, [], "all", {});
  expect(toggle.files).toEqual([]);
  expect(toggle.changes).toEqual({});
  expect(toggle.count).toBe(1);
});

test("a whole file marks every hunk, or unmarks it and its hunks", () => {
  const on = fileToggleChanges(files[0]!, true, "c1", {});
  expect(on["c1:a.ts"]).toBe("2:x");
  const marks = on as Record<string, string>;
  const off = fileToggleChanges(files[0]!, false, "c1", marks);
  expect(off).toEqual(
    reviewedChanges(files[0]!, new Set(), "c1", marks, false),
  );
  expect(off["c1:a.ts"]).not.toBe("2:x");
  expect(fileToggleNotice(true, 3, 7)).toBe("Reviewed (4/7)");
  expect(fileToggleNotice(false, 3, 7)).toBe(
    "No longer reviewed, nor its chunks",
  );
});
