import { expect, test } from "bun:test";
import {
  fileNameOf,
  jsonl,
  parseDoc,
  parseJsonl,
  renderDoc,
  stableJson,
} from "./format";

test("stableJson sorts every object's keys and ends with one newline", () => {
  expect(stableJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe(
    '{\n  "a": {\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
  );
  expect(stableJson({ b: 1, a: 2 })).toBe(stableJson({ a: 2, b: 1 }));
});

test("jsonl writes one value per line and reads back, skipping torn lines", () => {
  const values = [{ a: 1 }, { b: "x\ny" }];
  expect(jsonl(values)).toBe('{"a":1}\n{"b":"x\\ny"}\n');
  expect(parseJsonl(`${jsonl(values)}{"torn`)).toEqual(values);
  expect(jsonl([])).toBe("");
});

const roundTrip = (blocks: Parameters<typeof renderDoc>[0]) =>
  parseDoc(renderDoc(blocks));

test("a prose file reads back to the same blocks", () => {
  const blocks = [
    { tag: "thread", meta: { id: "t1", resolved: false }, body: "# Title" },
    {
      tag: "comment",
      meta: { id: "c1", author: "you" },
      body: "Hello\n\nworld",
    },
    { tag: "comment", meta: { id: "c2" }, body: "" },
    { tag: "comment", meta: { id: "c3" }, body: "ends with a newline\n" },
    { tag: "comment", meta: { id: "c4" }, body: "\n\nleading blank lines" },
  ];
  expect(roundTrip(blocks)).toEqual(blocks);
});

test("the headers are one line of JSON in an HTML comment", () => {
  const text = renderDoc([
    { tag: "item", meta: { title: "a --> b", z: 1, a: 2 }, body: "Body" },
  ]);
  expect(text).toBe(
    '<!-- roamgate:item {"a":2,"title":"a --\\u003e b","z":1} -->\nBody\n',
  );
  expect(parseDoc(text)[0]!.meta.title).toBe("a --> b");
});

test("a text holding a header-like line is kept in its header", () => {
  const body = "before\n<!-- roamgate:comment {} -->\nafter";
  const text = renderDoc([
    { tag: "comment", meta: { id: "c1" }, body },
    { tag: "comment", meta: { id: "c2" }, body: "next" },
  ]);
  expect(
    text.split("\n").filter((line) => line.startsWith("<!--")),
  ).toHaveLength(2);
  expect(parseDoc(text)).toEqual([
    { tag: "comment", meta: { id: "c1" }, body },
    { tag: "comment", meta: { id: "c2" }, body: "next" },
  ]);
});

test("a file Roamgate did not write is refused", () => {
  expect(() => parseDoc("no header\n")).toThrow();
  expect(() => parseDoc("<!-- roamgate:item {} -->\nno newline")).toThrow();
  expect(() => parseDoc("<!-- roamgate:item [1] -->\n")).toThrow();
});

test("ids become file names that never collide", () => {
  expect(fileNameOf("8a057f17bc9203bc")).toBe("8a057f17bc9203bc");
  expect(fileNameOf("roamgate")).toBe("roamgate");
  const odd = fileNameOf("a/b");
  expect(odd).toMatch(/^a-b-[0-9a-f]{12}$/);
  expect(odd).not.toBe(fileNameOf("a:b"));
  expect(fileNameOf("..")).toMatch(/^id-[0-9a-f]{12}$/);
  expect(fileNameOf(".hidden")).toMatch(/^hidden-/);
});
