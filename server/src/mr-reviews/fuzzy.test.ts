import { expect, test } from "bun:test";
import {
  parseUpstreamCandidates,
  proposeMatches,
  subjectWords,
  type UpstreamCandidate,
} from "./fuzzy";

const up = (
  sha: string,
  subject: string,
  files: string[],
  sizes: number[] = files.map(() => 10),
  author = "Ann",
): UpstreamCandidate => ({ sha, subject, author, at: 0, files, sizes });

test("subject words drop markers, stop words and punctuation", () => {
  expect(subjectWords("fixup! pool: Add the buffer-pool to the sink")).toEqual([
    "pool",
    "buffer",
    "sink",
  ]);
});

test("a reworded commit upstream is proposed first; noise is not", () => {
  const candidates = [
    up("aaa1111", "bufferpool: allocate buffers lazily in the sink", [
      "gst/pool/pool.c",
      "gst/pool/pool.h",
    ]),
    up("bbb2222", "docs: typo", ["docs/README.md"]),
    up("ccc3333", "pool: refactor locking", ["gst/pool/pool.c"], [400]),
    ...Array.from({ length: 50 }, (_, index) =>
      up(`fff${index}`, `misc change ${index}`, [`other/${index}.c`]),
    ),
  ];
  const proposals = proposeMatches(
    [
      {
        key: "k1",
        subject: "pool: allocate buffers lazily",
        author: "ann",
        files: ["gst/pool/pool.c", "gst/pool/pool.h"],
        sizes: [10, 10],
      },
      {
        key: "k2",
        subject: "Something unrelated entirely",
        author: "Bob",
        files: ["tools/x.py"],
        sizes: [3],
      },
    ],
    candidates,
  );
  expect(proposals.k1![0]).toMatchObject({ sha: "aaa1111" });
  expect(proposals.k1![0]!.why).toContain("same files");
  expect(proposals.k1![0]!.score).toBeGreaterThan(0.7);
  expect(proposals.k1!.length).toBeLessThanOrEqual(3);
  expect(proposals.k1!.some((each) => each.sha === "bbb2222")).toBe(false);
  expect(proposals.k2).toBeUndefined();
});

test("a rejected candidate is never proposed again", () => {
  const candidates = [
    up("aaa1111", "pool: allocate buffers lazily", ["a/pool.c"]),
    up("aaa2222", "pool: allocate buffers lazily again", ["a/pool.c"]),
  ];
  const commit = {
    key: "k1",
    subject: "pool: allocate buffers lazily",
    author: "Ann",
    files: ["a/pool.c"],
    sizes: [10],
  };
  expect(proposeMatches([commit], candidates).k1![0]!.sha).toBe("aaa1111");
  const after = proposeMatches([commit], candidates, (key) =>
    key === "k1" ? ["aaa1111"] : [],
  );
  expect(after.k1!.map((each) => each.sha)).toEqual(["aaa2222"]);
});

test("2000 commits against 3000 candidates stay quick", () => {
  const candidates = Array.from({ length: 3000 }, (_, index) =>
    up(`u${index}`, `area${index % 40}: change number ${index} of the thing`, [
      `dir${index % 40}/file${index % 300}.c`,
      `dir${index % 40}/x.h`,
    ]),
  );
  const commits = Array.from({ length: 2000 }, (_, index) => ({
    key: `k${index}`,
    subject: `area${index % 40}: change number ${index} of the thing`,
    author: "Ann",
    files: [`dir${index % 40}/file${index % 300}.c`],
    sizes: [10],
  }));
  const started = performance.now();
  const proposals = proposeMatches(commits, candidates);
  expect(performance.now() - started).toBeLessThan(15_000);
  expect(proposals.k5![0]!.sha).toBe("u5");
});

test("upstream candidates parse with their sizes; exact matches are left out", () => {
  const parsed = parseUpstreamCandidates(
    [
      "C\taaa\t100\tAnn\tpool: x",
      "",
      "3\t1\tgst/pool.c",
      "-\t-\tlogo.png",
      "C\tbbb\t90\tBob\tdocs",
      "",
      "1\t0\tREADME",
      "Q\tbbb",
    ].join("\n"),
  );
  expect(parsed.commits).toEqual([
    {
      sha: "aaa",
      at: 100,
      author: "Ann",
      subject: "pool: x",
      files: ["gst/pool.c", "logo.png"],
      sizes: [4, 0],
    },
  ]);
  expect([...parsed.exact]).toEqual(["bbb"]);
});
