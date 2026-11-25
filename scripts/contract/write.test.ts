import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alignMarkdownTables,
  formattedJson,
  sameContent,
  writeContractFile,
  yamlFileText,
  yamlText,
  yamlWithAdditions,
} from "./write";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function dir(): string {
  const path = mkdtempSync(join(tmpdir(), "contract-write-"));
  dirs.push(path);
  return path;
}

test("a file that already says the same keeps its hand formatting", () => {
  const path = join(dir(), "openapi.yaml");
  const hand =
    'paths:\n  /x:\n    get:\n      responses:\n        "4XX": { description: "Not logged in, or no such connection." }\n';
  writeFileSync(path, hand);
  const value = Bun.YAML.parse(hand);
  expect(writeContractFile(path, yamlText(value))).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(hand);
});

test("a changed value is written, and reads back as itself", () => {
  const path = join(dir(), "openapi.yaml");
  writeFileSync(path, "a: 1\n");
  const value = { a: 2, b: { description: "commas, colons: and # marks" } };
  expect(writeContractFile(path, yamlText(value))).toBe(true);
  expect(Bun.YAML.parse(readFileSync(path, "utf8"))).toEqual(value);
});

test("JSON compares by value and Markdown tables by their cells", () => {
  expect(
    sameContent(
      "a.json",
      '{"a": [1, 2]}',
      '{\n  "a": [\n    1,\n    2\n  ]\n}',
    ),
  ).toBe(true);
  expect(sameContent("a.json", '{"a": 1}', '{"a": 2}')).toBe(false);
  expect(
    sameContent(
      "env.md",
      "| `A` | one |\n| --- | --- |\n",
      "| `A`    | one   |\n| ------ | ----- |\n",
    ),
  ).toBe(true);
  expect(sameContent("env.md", "| `A` | one |\n", "| `A` | two |\n")).toBe(
    false,
  );
});

test("an addition goes into a YAML file as it is: anchors, flow mappings and quotes kept", () => {
  const hand = `paths:
  /a:
    get:
      responses:
        "200": &ok
          description: Fine.
        "4XX": { description: "Not logged in." }
  "/b/{id}":
    get:
      responses:
        "200": *ok
# the end
`;
  const value = Bun.YAML.parse(hand) as {
    paths: Record<string, Record<string, unknown>>;
  };
  value.paths["/c"] = { get: { summary: "/c" } };
  value.paths["/a"]!.post = { summary: "posted: yes" };
  const text = yamlWithAdditions(hand, value)!;
  expect(Bun.YAML.parse(text)).toEqual(value);
  expect(text).toContain('"200": &ok');
  expect(text).toContain('"4XX": { description: "Not logged in." }');
  expect(text).toContain('"200": *ok');
  expect(text.split("\n").slice(0, 7)).toEqual(hand.split("\n").slice(0, 7));
  expect(text).toContain("  /c:\n    get:\n      summary: /c\n");
});

test("a YAML change other than an addition is refused, not rewritten", () => {
  const path = join(dir(), "openapi.yaml");
  const hand = "a: { b: 1 }\nc:\n  d: 2\n";
  writeFileSync(path, hand);
  expect(yamlFileText(path, { a: { b: 1 }, c: { d: 2 } })).toBe(hand);
  expect(yamlWithAdditions(hand, { a: { b: 1 }, c: { d: 3 } })).toBeNull();
  expect(yamlWithAdditions(hand, { a: { b: 1 } })).toBeNull();
  // Under a flow mapping there is no line to add.
  expect(
    yamlWithAdditions(hand, { a: { b: 1, e: 1 }, c: { d: 2 } }),
  ).toBeNull();
  expect(() => yamlFileText(path, { a: { b: 2 }, c: { d: 2 } })).toThrow(
    /make it by hand/,
  );
});

test("appended Markdown rows are padded like the table's", () => {
  expect(
    alignMarkdownTables(
      "# T\n\n| Name | Kind |\n| ---- | ---- |\n| `a` | one |\n| `longer` | two |\n",
    ),
  ).toBe(
    "# T\n\n| Name     | Kind |\n| -------- | ---- |\n| `a`      | one  |\n| `longer` | two  |\n",
  );
});

test("JSON is written as the formatter writes it", () => {
  expect(formattedJson("a.json", { a: [1, 2], b: { c: "d" } })).toBe(
    '{\n  "a": [1, 2],\n  "b": {\n    "c": "d"\n  }\n}\n',
  );
});
