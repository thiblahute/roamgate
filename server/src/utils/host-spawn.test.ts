import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostSpawnPath, runnable } from "./host-spawn";

describe("hostSpawnPath", () => {
  let root = "";

  /** A host-spawn file in root/dir, with mode and content. */
  function put(dir: string, mode: number, content = "#!/bin/sh\n"): string {
    mkdirSync(join(root, dir), { recursive: true });
    const path = join(root, dir, "host-spawn");
    writeFileSync(path, content);
    chmodSync(path, mode);
    return path;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "host-spawn-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("skips an empty, non-executable host-spawn first on PATH", () => {
    const broken = put("local-bin", 0o600, "");
    const real = put("usr-bin", 0o755);
    expect(runnable(broken)).toBe(false);
    expect(
      hostSpawnPath(
        [join(root, "local-bin"), join(root, "usr-bin")].join(":"),
        [],
      ),
    ).toBe(real);
  });

  test("skips an empty executable one and a non-executable one", () => {
    put("empty", 0o755, "");
    put("noexec", 0o644);
    const real = put("real", 0o755);
    const path = ["empty", "noexec", "", "missing", "real"]
      .map((dir) => (dir ? join(root, dir) : ""))
      .join(":");
    expect(hostSpawnPath(path, [])).toBe(real);
  });

  test("prefers the known paths to PATH", () => {
    const onPath = put("path", 0o755);
    const known = put("known", 0o755);
    expect(hostSpawnPath(join(root, "path"), [known])).toBe(known);
    // A known path that does not run falls back to PATH.
    expect(
      hostSpawnPath(join(root, "path"), [join(root, "none", "host-spawn")]),
    ).toBe(onPath);
  });

  test("null when none runs", () => {
    put("broken", 0o600, "");
    expect(hostSpawnPath(join(root, "broken"), [])).toBeNull();
    expect(hostSpawnPath("", [])).toBeNull();
  });
});
