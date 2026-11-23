import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_MOD_CHECKSUM,
  CLAUDE_MOD_FILES,
  CLAUDE_MOD_MARKETPLACE_DIR,
  claudeModHostScript,
  claudeModStateOf,
  compareVersions,
  remoteClaudeModScript,
  writeClaudeModPlugin,
} from "./claude-mod-plugin";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function temp() {
  const path = mkdtempSync(join(tmpdir(), "rg-modp-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("the binary carries the mod, its tests left out", () => {
  expect(Object.keys(CLAUDE_MOD_FILES).sort()).toEqual([
    ".claude-plugin/marketplace.json",
    "roamgate/.claude-plugin/plugin.json",
    "roamgate/hooks/catalog.gen.ts",
    "roamgate/hooks/client.ts",
    "roamgate/hooks/hooks.json",
    "roamgate/hooks/register.ts",
    "roamgate/hooks/tools.ts",
  ]);
  const manifest = JSON.parse(
    CLAUDE_MOD_FILES["roamgate/.claude-plugin/plugin.json"]!,
  );
  expect(manifest.name).toBe("roamgate");
  expect(
    JSON.parse(CLAUDE_MOD_FILES["roamgate/hooks/hooks.json"]!).modules,
  ).toEqual(["./register.ts"]);
});

test("the marketplace is written once per version", () => {
  const home = temp();
  expect(writeClaudeModPlugin(home)).toBe(true);
  const base = join(home, CLAUDE_MOD_MARKETPLACE_DIR);
  expect(readFileSync(join(base, "roamgate/hooks/register.ts"), "utf8")).toBe(
    CLAUDE_MOD_FILES["roamgate/hooks/register.ts"]!,
  );
  expect(statSync(join(base, "roamgate/hooks/client.ts")).mode & 0o777).toBe(
    0o644,
  );
  expect(writeClaudeModPlugin(home)).toBe(false);
  writeFileSync(join(base, ".roamgate-checksum"), "older\n");
  expect(writeClaudeModPlugin(home)).toBe(true);
});

test("an SSH host gets the same files", async () => {
  const home = temp();
  const script = ["set -e", ...remoteClaudeModScript()].join("\n");
  const proc = Bun.spawn(["/bin/sh", "-c", script], {
    env: { HOME: home, PATH: process.env.PATH },
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const base = join(home, CLAUDE_MOD_MARKETPLACE_DIR);
  for (const [path, text] of Object.entries(CLAUDE_MOD_FILES))
    expect(readFileSync(join(base, path), "utf8")).toBe(text);
  expect(readFileSync(join(base, ".roamgate-checksum"), "utf8").trim()).toBe(
    CLAUDE_MOD_CHECKSUM,
  );
});

test("versions compare by their numbers", () => {
  expect(compareVersions("2.1.280", "2.1.304")).toBeLessThan(0);
  expect(compareVersions("2.1.319 (Claude Code)", "2.1.304")).toBeGreaterThan(
    0,
  );
  expect(compareVersions("2.1.304", "2.1.304")).toBe(0);
  expect(compareVersions("2.2.0", "2.1.999")).toBeGreaterThan(0);
});

/** Runs the host script with a fake `claude` that records its arguments. */
async function hostRun(
  action: "status" | "install" | "uninstall",
  claude: { version: string; list: string; exit?: number } | null,
) {
  const home = temp();
  const bin = join(home, "bin");
  mkdirSync(bin);
  const calls = join(home, "calls");
  if (claude) {
    writeFileSync(
      join(bin, "claude"),
      [
        "#!/bin/sh",
        `echo "$*" >> '${calls}'`,
        'case "$1 $2" in',
        `  "--version ") echo '${claude.version}' ;;`,
        `  "plugin list") echo '${claude.list}' ;;`,
        `  "plugin install") echo '{"ok":false,"error":"boom"}'; exit ${claude.exit ?? 0} ;;`,
        "esac",
      ].join("\n"),
    );
    chmodSync(join(bin, "claude"), 0o755);
  }
  const proc = Bun.spawn(["/bin/sh", "-c", claudeModHostScript(action)], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
    stdout: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  let recorded = "";
  try {
    recorded = readFileSync(calls, "utf8");
  } catch {}
  return { output, calls: recorded.trim().split("\n"), home };
}

test("the state of a host without Claude, or with an old one", async () => {
  const none = await hostRun("status", null);
  expect(claudeModStateOf(none.output, 0)).toMatchObject({
    available: false,
    reason: "Claude Code was not found on this host",
  });
  const old = await hostRun("status", {
    version: "2.1.280 (Claude Code)",
    list: "[]",
  });
  expect(claudeModStateOf(old.output, 0)).toMatchObject({
    available: false,
    claude_version: "2.1.280",
    installed: false,
  });
});

test("installed from Roamgate's folder and enabled", async () => {
  const listed = JSON.stringify([
    { id: "other@x", scope: "user", enabled: true },
    {
      id: "roamgate@roamgate",
      scope: "user",
      enabled: true,
      readFromFolder: "/home/u/.cache/roamgate/claude-plugins/roamgate",
    },
  ]);
  const run = await hostRun("status", {
    version: "2.1.319 (Claude Code)",
    list: listed,
  });
  expect(claudeModStateOf(run.output, 2)).toEqual({
    available: true,
    claude_version: "2.1.319",
    min_claude: "2.1.304",
    installed: true,
    enabled: true,
    from_roamgate: true,
    sessions: 2,
  });
});

test("install runs Claude Code's own plugin command", async () => {
  const run = await hostRun("install", {
    version: "2.1.319 (Claude Code)",
    list: "[]",
  });
  expect(run.calls).toContain(
    `plugin install roamgate --marketplace ${run.home}/${CLAUDE_MOD_MARKETPLACE_DIR} --scope user --json`,
  );
  expect(run.calls).toContain("plugin enable roamgate@roamgate --scope user");
  expect(run.output).toContain("ROAMGATE_EXIT=0");
  const failed = await hostRun("install", {
    version: "2.1.319 (Claude Code)",
    list: "[]",
    exit: 3,
  });
  expect(failed.output).toContain("ROAMGATE_EXIT=3");
  const uninstall = await hostRun("uninstall", {
    version: "2.1.319 (Claude Code)",
    list: "[]",
  });
  expect(uninstall.calls).toContain(
    "plugin uninstall roamgate@roamgate --scope user --json",
  );
  expect(uninstall.calls).toContain("plugin marketplace remove roamgate");
});
