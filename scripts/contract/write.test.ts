import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sameContent, writeContractFile, yamlText } from "./write";

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
