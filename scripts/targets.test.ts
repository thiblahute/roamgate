import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveUpdateTarget } from "../server/src/http/update";
import { releaseAssetNames } from "./check-release-assets.mjs";

// targets.toml is the release targets' single list (`cargo xtask`, the Rust
// CI). Until the cut-over the Bun build keeps its own lists; these tests pin
// them to it.

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

type Target = {
  platform: string;
  triple: string;
  os: string;
  arch: string;
  binary: string;
  builder: string;
  runner: string;
  check: string;
  update: boolean;
  bun: string;
};

const targets = (Bun.TOML.parse(read("targets.toml")) as { target: Target[] })
  .target;
const platforms = targets.map((target) => target.platform);

test("targets.toml lists the seven release targets once", () => {
  expect(platforms).toEqual([
    "linux-x64",
    "linux-x64-musl",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "windows-x64",
    "windows-arm64",
  ]);
});

test("the Bun build compiles every target", () => {
  const scripts = JSON.parse(read("server/package.json")).scripts as Record<
    string,
    string
  >;
  const compiled = Object.entries(scripts)
    .filter(
      // compile:pi is the Pi sidecar for this machine (cargo xtask builds
      // it per target for the Rust package).
      ([name]) =>
        /^compile:[a-z0-9-]+$/.test(name) &&
        name !== "compile:all" &&
        name !== "compile:pi",
    )
    .map(([name, command]) => ({
      platform: name.slice("compile:".length),
      bun: /--target=(\S+)/.exec(command)?.[1],
    }));
  expect(compiled).toEqual(
    expect.arrayContaining(
      targets.map((target) => ({ platform: target.platform, bun: target.bun })),
    ),
  );
  expect(compiled.length).toBe(targets.length);
});

test("the updater serves exactly the update targets", () => {
  for (const target of targets) {
    const resolved = resolveUpdateTarget(target.os, target.arch);
    if (target.update) {
      expect(resolved?.platform as string | undefined).toBe(target.platform);
      expect(resolved?.archiveName).toBe(`roamgate-${target.platform}.tar.xz`);
    } else if (target.triple.endsWith("-musl")) {
      // Node cannot tell musl apart: it is the glibc build's platform.
      expect(resolved?.platform as string | undefined).not.toBe(
        target.platform,
      );
    } else {
      expect(resolved).toBeNull();
    }
  }
});

test("release.yml publishes every target of targets.toml; the Bun build packages the others", () => {
  const release = Bun.YAML.parse(read(".github/workflows/release.yml")) as {
    jobs: Record<
      string,
      { strategy?: { matrix: { target: string } }; steps: { run?: string }[] }
    >;
  };
  for (const name of ["package", "check"]) {
    expect(release.jobs[name].strategy?.matrix.target).toBe(
      "${{ fromJSON(needs.targets.outputs.targets) }}",
    );
  }
  expect(release.jobs.targets.steps.map((step) => step.run)).toContain(
    'echo "targets=$(cargo xtask targets --json)" >> "$GITHUB_OUTPUT"',
  );
  expect(
    release.jobs.package.steps.some((step) =>
      step.run?.startsWith("cargo xtask package "),
    ),
  ).toBe(true);
  const published = new Set(
    releaseAssetNames("1.0.0").map(
      (name) =>
        /^roamgate-(?:v1\.0\.0-)?([a-z0-9-]+?)(?:\.tar\.xz.*|\.update\.json)$/.exec(
          name,
        )?.[1],
    ),
  );
  expect([...published].sort()).toEqual([...platforms].sort());
  // `bun run package:<target>` (the Bun build, local only) has no musl build.
  const packaged = [
    ...read("scripts/package-release.sh").matchAll(/^ {2}([a-z0-9-]+)\)$/gm),
  ].map((match) => match[1]);
  expect(platforms.filter((platform) => !packaged.includes(platform))).toEqual([
    "linux-x64-musl",
  ]);
});

test("the installers name targets.toml's platforms", () => {
  const installed = [
    "scripts/install-roamgate.sh",
    "scripts/install-herdr-gui.sh",
  ].flatMap((path) =>
    [...read(path).matchAll(/platform="([a-z0-9-]+)"/g)].map((m) => m[1]),
  );
  const updatable = targets.filter((t) => t.update).map((t) => t.platform);
  expect([...new Set(installed)].sort()).toEqual([...updatable].sort());
  const windows = [
    ...read("scripts/install-plugin.ps1").matchAll(
      /\$platform = '([a-z0-9-]+)'/g,
    ),
  ].map((match) => match[1]);
  expect(windows.sort()).toEqual(
    targets
      .filter((t) => t.os === "win32")
      .map((t) => t.platform)
      .sort(),
  );
});

test("the Rust workflow takes its matrix from targets.toml and pins its actions", () => {
  const workflow = Bun.YAML.parse(read(".github/workflows/rust.yml")) as {
    jobs: Record<
      string,
      {
        "timeout-minutes": number;
        strategy?: { matrix: { target: string } };
        steps: {
          uses?: string;
          with?: Record<string, unknown>;
          run?: string;
        }[];
      }
    >;
  };
  for (const name of ["package", "check"]) {
    expect(workflow.jobs[name].strategy?.matrix.target).toBe(
      "${{ fromJSON(needs.targets.outputs.targets) }}",
    );
  }
  for (const job of Object.values(workflow.jobs)) {
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    for (const step of job.steps) {
      if (!step.uses) continue;
      expect(step.uses).toMatch(/^[\w-]+\/[\w/-]+@[a-f0-9]{40}$/);
      if (step.uses.startsWith("actions/checkout@")) {
        expect(step.with).toEqual({ "persist-credentials": false });
      }
    }
  }
});
