import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The getting-started lines have one source, site/install.json: the README,
// the deployment guide and the site show them with its base, and
// `cargo xtask getting-started` runs them against a local mirror.
const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const install = JSON.parse(read("site/install.json")) as {
  base: string;
  variable: string;
  unix: string;
  windows: string;
  start: string;
  url: string;
};
const unix = install.unix.replace("{base}", install.base);
const windows = install.windows.replace("{base}", install.base);

test("the README and the deployment guide show the getting-started lines", () => {
  for (const path of ["README.md", "docs/DEPLOYMENT.md"]) {
    const text = read(path);
    expect(text).toContain(`\`\`\`bash\n${unix}\n\`\`\``);
    expect(text).toContain(`\`\`\`powershell\n${windows}\n\`\`\``);
    expect(text).toContain(`\`${install.url}\``);
  }
  // At the top of the README: before its first screenshot.
  const readme = read("README.md");
  expect(readme.indexOf(unix)).toBeLessThan(readme.indexOf("## Screenshots"));
});

test("the site shows them in one tab per system, copying the line itself", () => {
  const html = read("site/index.html");
  const commands = [...html.matchAll(/data-install-command="([^"]*)"/g)].map(
    (match) => match[1],
  );
  expect(commands).toEqual([unix, unix, windows]);
  for (const [system, line] of [
    ["linux", unix],
    ["macos", unix],
    ["windows", windows],
  ]) {
    expect(html).toContain(`id="install-tab-${system}"`);
    expect(html).toContain(`aria-controls="install-panel-${system}"`);
    expect(html).toContain(`</span>${line}</code>`);
  }
  expect(html).toContain('role="tablist"');
  // Near the top: the first section after the hero.
  expect(html.indexOf('id="install"')).toBeLessThan(
    html.indexOf('id="product"'),
  );
  // The script copies the shown line, not a copy of its own.
  expect(read("site/main.js")).not.toContain("install-roamgate.sh");
});

test("the installers download from the variable, else the lines' base", () => {
  const sh = read("scripts/install-roamgate.sh");
  const repository = /^github_repository="([^"]+)"$/m.exec(sh)?.[1];
  expect(`https://github.com/${repository}/releases/latest/download`).toBe(
    install.base,
  );
  expect(sh).toContain(install.variable);
  const ps1 = read("scripts/install-roamgate.ps1");
  const psRepository = /^\s*\$githubRepository = '([^']+)'$/m.exec(ps1)?.[1];
  expect(psRepository).toBe(repository);
  expect(ps1).toContain(
    "https://github.com/$githubRepository/releases/latest/download",
  );
  expect(ps1).toContain(
    `Setting '${install.variable.replace("ROAMGATE_", "")}'`,
  );
});
