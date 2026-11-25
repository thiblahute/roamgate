import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { releaseAssetNames } from "./check-release-assets.mjs";

// targets.toml is the release targets' single list (`cargo xtask`, the Rust
// CI, the release workflow, the installers); these tests pin the others to
// it.

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

test("release.yml publishes every target of targets.toml", () => {
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

test("the Rust workflows take their matrix from targets.toml and pin their actions", () => {
  for (const file of ["rust.yml", "rust-checks.yml"]) {
    checkRustWorkflow(file);
  }
});

function checkRustWorkflow(file: string) {
  const workflow = Bun.YAML.parse(read(`.github/workflows/${file}`)) as {
    jobs: Record<
      string,
      {
        uses?: string;
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
  const matrixJobs = file === "rust.yml" ? ["package", "check"] : [];
  for (const name of matrixJobs) {
    expect(workflow.jobs[name].strategy?.matrix.target).toBe(
      "${{ fromJSON(needs.targets.outputs.targets) }}",
    );
  }
  for (const job of Object.values(workflow.jobs)) {
    // A call of a reusable workflow (rust-checks.yml) has its own jobs.
    if (job.uses) {
      expect(job.uses).toStartWith("./.github/workflows/");
      continue;
    }
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    for (const step of job.steps) {
      // A local action (.github/actions) is this checkout's own.
      if (!step.uses || step.uses.startsWith("./.github/actions/")) continue;
      expect(step.uses).toMatch(/^[\w-]+\/[\w/-]+@[a-f0-9]{40}$/);
      if (step.uses.startsWith("actions/checkout@")) {
        expect(step.with).toEqual({ "persist-credentials": false });
      }
    }
  }
}
