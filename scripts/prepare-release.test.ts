import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  RELEASE_FILES,
  parseCargoVersion,
  parseManifestVersion,
  parsePackageVersion,
  replaceCargoLockVersions,
  replaceCargoVersion,
  replaceManifestVersion,
  replacePackageVersion,
  resolveNextVersion,
} from "./prepare-release";

const PACKAGE_JSON = `{
  "name": "herdr-gui",
  "private": true,
  "version": "0.4.1",
  "scripts": {
    "test": "bun test"
  }
}
`;

const PLUGIN_MANIFEST = `id = "herdr.studio"
name = "Herdr Studio"
version = "0.4.1"
min_herdr_version = "0.7.2"
`;

describe("parsePackageVersion", () => {
  test("reads the top-level version", () => {
    expect(parsePackageVersion(PACKAGE_JSON)).toBe("0.4.1");
  });

  test("rejects package.json without a version", () => {
    expect(() => parsePackageVersion(`{ "name": "x" }`)).toThrow("version");
  });
});

describe("replacePackageVersion", () => {
  test("replaces only the version line and preserves the rest", () => {
    const next = replacePackageVersion(PACKAGE_JSON, "0.4.1", "0.4.2");
    expect(parsePackageVersion(next)).toBe("0.4.2");
    expect(next).toBe(
      PACKAGE_JSON.replace('"version": "0.4.1"', '"version": "0.4.2"'),
    );
  });

  test("rejects an unexpected current version", () => {
    expect(() => replacePackageVersion(PACKAGE_JSON, "9.9.9", "0.4.2")).toThrow(
      "expected",
    );
  });
});

describe("parseManifestVersion", () => {
  test("reads the top-level version", () => {
    expect(parseManifestVersion(PLUGIN_MANIFEST)).toBe("0.4.1");
  });

  test("rejects a manifest without a version", () => {
    expect(() => parseManifestVersion(`id = "x"`)).toThrow("version");
  });

  test("tolerates leading whitespace like the package version parser", () => {
    const indented = PLUGIN_MANIFEST.replace(
      'version = "0.4.1"',
      '  version = "0.4.1"',
    );
    expect(parseManifestVersion(indented)).toBe("0.4.1");
    expect(
      parseManifestVersion(replaceManifestVersion(indented, "0.4.1", "0.4.2")),
    ).toBe("0.4.2");
  });
});

describe("replaceManifestVersion", () => {
  test("replaces only the version line and preserves the rest", () => {
    const next = replaceManifestVersion(PLUGIN_MANIFEST, "0.4.1", "0.4.2");
    expect(parseManifestVersion(next)).toBe("0.4.2");
    expect(next).toBe(
      PLUGIN_MANIFEST.replace('version = "0.4.1"', 'version = "0.4.2"'),
    );
  });

  test("rejects an unexpected current version", () => {
    expect(() =>
      replaceManifestVersion(PLUGIN_MANIFEST, "9.9.9", "0.4.2"),
    ).toThrow("expected");
  });
});

describe("resolveNextVersion", () => {
  test("supports patch, minor, and major keywords", () => {
    expect(resolveNextVersion("0.4.1", "patch")).toBe("0.4.2");
    expect(resolveNextVersion("0.4.1", "minor")).toBe("0.5.0");
    expect(resolveNextVersion("0.4.1", "major")).toBe("1.0.0");
  });

  test("accepts an explicit version greater than the current one", () => {
    expect(resolveNextVersion("0.4.1", "0.4.10")).toBe("0.4.10");
    expect(resolveNextVersion("0.4.1", "0.5.0")).toBe("0.5.0");
  });

  test("rejects versions that are not greater than the current one", () => {
    expect(() => resolveNextVersion("0.4.1", "0.4.1")).toThrow("greater");
    expect(() => resolveNextVersion("0.4.1", "0.3.9")).toThrow("greater");
    expect(() => resolveNextVersion("0.4.1", "0.4.0")).toThrow("greater");
  });

  test("rejects malformed input", () => {
    expect(() => resolveNextVersion("0.4.1", "0.4")).toThrow("X.Y.Z");
    expect(() => resolveNextVersion("0.4.1", "next")).toThrow("X.Y.Z");
    expect(() => resolveNextVersion("0.4.1", "")).toThrow("X.Y.Z");
    expect(() => resolveNextVersion("0.4", "patch")).toThrow("X.Y.Z");
  });
});

const CARGO_TOML = `[workspace]
members = ["crates/roamgate"]

[workspace.package]
# The release version.
version = "0.4.1"
edition = "2024"

[workspace.dependencies]
version = "not this one"
`;

const CARGO_LOCK = `version = 4

[[package]]
name = "roamgate"
version = "9.9.9"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "00"

[[package]]
name = "roamgate"
version = "0.4.1"
dependencies = [
 "axum",
]

[[package]]
name = "roamgate-voice"
version = "0.4.1"
`;

describe("Cargo workspace version", () => {
  test("reads and replaces only [workspace.package]'s version", () => {
    expect(parseCargoVersion(CARGO_TOML)).toBe("0.4.1");
    const next = replaceCargoVersion(CARGO_TOML, "0.4.1", "0.4.2");
    expect(next).toBe(
      CARGO_TOML.replace('version = "0.4.1"', 'version = "0.4.2"'),
    );
    expect(() => replaceCargoVersion(CARGO_TOML, "0.4.0", "0.4.2")).toThrow(
      "expected 0.4.0",
    );
    expect(() => parseCargoVersion("[workspace]\n")).toThrow(
      "workspace.package",
    );
  });

  test("bumps the workspace crate in Cargo.lock, not a registry namesake", () => {
    const next = replaceCargoLockVersions(CARGO_LOCK, "0.4.1", "0.4.2");
    expect(next).toBe(
      CARGO_LOCK.replace(
        'name = "roamgate"\nversion = "0.4.1"',
        'name = "roamgate"\nversion = "0.4.2"',
      ),
    );
    expect(next).toContain('name = "roamgate-voice"\nversion = "0.4.1"');
    expect(() =>
      replaceCargoLockVersions(CARGO_LOCK, "0.4.0", "0.4.2"),
    ).toThrow("expected 0.4.0");
  });

  test("the repository's Cargo files carry the release version", () => {
    const root = new URL("../", import.meta.url);
    const version = parsePackageVersion(
      readFileSync(new URL("package.json", root), "utf8"),
    );
    expect(
      parseCargoVersion(readFileSync(new URL("Cargo.toml", root), "utf8")),
    ).toBe(version);
    const lock = readFileSync(new URL("Cargo.lock", root), "utf8");
    expect(replaceCargoLockVersions(lock, version, version)).toBe(lock);
  });
});

test("the Prepare Release workflow commits every file it bumps", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/prepare-release.yml", import.meta.url),
    "utf8",
  );
  const added = /git add ([^\n]+)/.exec(workflow)?.[1].split(" ") ?? [];
  expect([...added].sort()).toEqual([...RELEASE_FILES].sort());
});
