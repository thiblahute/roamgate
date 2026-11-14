import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyArchiveWarning, resolveArchiveDir } from "./dir";

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "archive-dir-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("resolveArchiveDir", () => {
  test("an explicit directory wins and nothing is moved", () => {
    const data = root();
    mkdirSync(join(data, "claude-archive"));
    expect(resolveArchiveDir("/somewhere", data)).toBe("/somewhere");
    expect(existsSync(join(data, "claude-archive"))).toBe(true);
  });

  test("the default is archive under the data root", () => {
    const data = root();
    expect(resolveArchiveDir(undefined, data)).toBe(join(data, "archive"));
  });

  test("the legacy directory is renamed once, keeping its files", () => {
    const data = root();
    mkdirSync(join(data, "claude-archive"));
    writeFileSync(join(data, "claude-archive", "index.sqlite"), "x");
    const logs: string[] = [];
    expect(resolveArchiveDir(undefined, data, (m) => logs.push(m))).toBe(
      join(data, "archive"),
    );
    expect(existsSync(join(data, "claude-archive"))).toBe(false);
    expect(existsSync(join(data, "archive", "index.sqlite"))).toBe(true);
    expect(logs).toHaveLength(1);
    resolveArchiveDir(undefined, data, (m) => logs.push(m));
    expect(logs).toHaveLength(1);
  });

  test("with both present the new one is used and health warns", () => {
    const data = root();
    mkdirSync(join(data, "claude-archive"));
    mkdirSync(join(data, "archive"));
    const dir = resolveArchiveDir(undefined, data);
    expect(dir).toBe(join(data, "archive"));
    expect(existsSync(join(data, "claude-archive"))).toBe(true);
    expect(legacyArchiveWarning(dir)).toContain("still exists");
  });
});
