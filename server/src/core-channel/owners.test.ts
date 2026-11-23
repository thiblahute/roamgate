import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TABLE,
  parseOwners,
  readOwners,
  watchOwners,
  type OwnersTable,
} from "./owners";
import { until } from "./testdata/test-family";

describe("the owners table", () => {
  test("reads owners and shadow settings, defaults for the rest", () => {
    expect(parseOwners('{"version":1}')).toEqual(DEFAULT_TABLE);
    expect(
      parseOwners(
        '{"version":1,"owners":{"a":"rust","b":"bun"},"shadow":{"rate":0.5}}',
      ),
    ).toEqual({
      owners: { a: "rust", b: "bun" },
      shadow: { enabled: true, rate: 0.5 },
    });
    expect(
      parseOwners('{"version":1,"shadow":{"enabled":false}}').shadow,
    ).toEqual({ enabled: false, rate: 0.1 });
  });

  test("refuses what is not one", () => {
    for (const text of [
      "[]",
      "{",
      '{"version":2}',
      '{"version":1,"owners":[]}',
      '{"version":1,"owners":{"a":"go"}}',
      '{"version":1,"shadow":{"rate":2}}',
      '{"version":1,"shadow":{"enabled":"yes"}}',
    ])
      expect(() => parseOwners(text)).toThrow();
  });

  test("a missing or invalid file gives every family to Bun", () => {
    const dir = mkdtempSync(join(tmpdir(), "owners-"));
    const warnings: string[] = [];
    expect(readOwners(dir, (m) => warnings.push(m))).toBe(DEFAULT_TABLE);
    expect(warnings).toEqual([]);
    writeFileSync(join(dir, "owners.json"), "{");
    expect(readOwners(dir, (m) => warnings.push(m))).toBe(DEFAULT_TABLE);
    expect(warnings).toHaveLength(1);
    rmSync(dir, { recursive: true });
  });

  test("a change of the file is seen, an invalid one warned of once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owners-"));
    const seen: OwnersTable[] = [];
    const warnings: string[] = [];
    const watcher = watchOwners(dir, {
      onChange: (table) => seen.push(table),
      warn: (message) => warnings.push(message),
    });
    try {
      expect(watcher.table()).toBe(DEFAULT_TABLE);
      writeFileSync(
        join(dir, "owners.json"),
        '{"version":1,"owners":{"x":"rust"}}',
      );
      await until(() => seen.length === 1);
      expect(watcher.table().owners).toEqual({ x: "rust" });
      writeFileSync(join(dir, "owners.json"), "{");
      await until(() => seen.length === 2);
      writeFileSync(join(dir, "owners.json"), "{ ");
      await Bun.sleep(400);
      expect(seen).toHaveLength(2);
      expect(watcher.table()).toBe(DEFAULT_TABLE);
      expect(warnings).toHaveLength(1);
    } finally {
      watcher.stop();
      rmSync(dir, { recursive: true });
    }
  });
});
