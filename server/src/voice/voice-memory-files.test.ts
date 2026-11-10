import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompanionMemoryFiles,
  MAX_INDEX_LINES,
  parseMemoryFile,
} from "./voice-memory-files";

let root: string;
let files: CompanionMemoryFiles;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memory-files-"));
  files = new CompanionMemoryFiles(join(root, "memories"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const fact = (name: string) =>
  `---\nname: ${name}\ndescription: about ${name}\ntype: user\n---\nThe fact of ${name}.\n`;

describe("CompanionMemoryFiles", () => {
  test("parses frontmatter, and a file without it", () => {
    expect(parseMemoryFile(fact("Cat")).name).toBe("Cat");
    expect(parseMemoryFile("no frontmatter").body).toBe("no frontmatter");
    expect(parseMemoryFile("---\nname: only").name).toBe("");
  });

  test("lists memories, never the index or stray names", () => {
    writeFileSync(join(files.dir, "cat.md"), fact("Cat"));
    writeFileSync(join(files.dir, "MEMORY.md"), "- [Cat](cat.md) - c\n");
    writeFileSync(join(files.dir, "notes.txt"), "x");
    expect(files.list().map((one) => one.name)).toEqual(["Cat"]);
  });

  test("removes a memory and its index line only", () => {
    writeFileSync(join(files.dir, "cat.md"), fact("Cat"));
    writeFileSync(join(files.dir, "dog.md"), fact("Dog"));
    writeFileSync(
      join(files.dir, "MEMORY.md"),
      "- [Cat](cat.md) - c\n- [Dog](dog.md) - d\n",
    );
    expect(files.remove("cat.md")).toBe(true);
    expect(files.list().map((one) => one.name)).toEqual(["Dog"]);
    expect(readFileSync(join(files.dir, "MEMORY.md"), "utf8")).toBe(
      "- [Dog](dog.md) - d\n",
    );
  });

  test("refuses paths out of the directory and the index", () => {
    expect(files.remove("../x.md")).toBe(false);
    expect(files.remove("MEMORY.md")).toBe(false);
    expect(files.read("../../etc/passwd.md")).toBeNull();
  });

  test("a corrupted file is listed by its name, harmlessly", () => {
    writeFileSync(join(files.dir, "bad.md"), "---\nname: \x00\n---\n");
    expect(files.list().map((one) => one.file)).toEqual(["bad.md"]);
  });

  test("sweep drops a file that lost its line, not a new one", () => {
    writeFileSync(join(files.dir, "old.md"), fact("Old"));
    writeFileSync(join(files.dir, "kept.md"), fact("Kept"));
    writeFileSync(join(files.dir, "MEMORY.md"), "- [Kept](kept.md) - k\n");
    const started = Date.now() + 60_000;
    files.sweep(started);
    expect(files.list().map((one) => one.file)).toEqual(["kept.md"]);
    writeFileSync(join(files.dir, "new.md"), fact("New"));
    files.sweep(Date.now() - 60_000);
    expect(
      files
        .list()
        .map((one) => one.file)
        .sort(),
    ).toEqual(["kept.md", "new.md"]);
  });

  test("the index's title names a memory in the list", () => {
    writeFileSync(join(files.dir, "x.md"), fact("slug-title"));
    writeFileSync(join(files.dir, "MEMORY.md"), "- [Joli titre](x.md) - d\n");
    expect(files.list()[0]!.name).toBe("Joli titre");
  });

  test("sweep keeps the index within what a session loads", () => {
    writeFileSync(
      join(files.dir, "MEMORY.md"),
      "- line\n".repeat(MAX_INDEX_LINES + 50),
    );
    files.sweep();
    expect(files.index().split("\n").length).toBeLessThanOrEqual(
      MAX_INDEX_LINES,
    );
  });
});
