import { expect, test } from "bun:test";

// A statement pasted between JSX tags is valid TSX: it renders as visible
// text instead of failing to compile. Flag declaration lines that sit next to
// JSX markup, where a real statement cannot appear.
const DECLARATION = /^\s*(?:const|let|var)\s+[\w{[].*;\s*$/;

function nextContent(lines: string[], from: number, step: 1 | -1) {
  for (let i = from + step; i >= 0 && i < lines.length; i += step) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

test("no stray statements render as JSX text", async () => {
  const root = new URL(".", import.meta.url).pathname;
  const strays: string[] = [];
  for await (const file of new Bun.Glob("**/*.tsx").scan(root)) {
    const lines = (await Bun.file(`${root}${file}`).text()).split("\n");
    lines.forEach((line, index) => {
      if (!DECLARATION.test(line)) return;
      const before = nextContent(lines, index, -1);
      const after = nextContent(lines, index, 1);
      if (after.startsWith("<") || /(?:\)\}|\/>|[^=]>)$/.test(before)) {
        strays.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  expect(strays).toEqual([]);
});
