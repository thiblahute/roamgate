import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ACTIVITY_SETTINGS,
  normalizeActivitySettings,
  normalizeWorktreeDirectory,
  normalizeWorktreeCommand,
  repoSettingsKey,
  workspaceAutoSyncSettingsKey,
  workspaceRepoSettingsKey,
  worktreeCommandFor,
  worktreeRemoveCommandFor,
} from "./gui-settings";

test("terminal codec preferences survive a fresh process and default to enabled", async () => {
  const home = await mkdtemp(join(tmpdir(), "roamgate-settings-"));
  const source = JSON.stringify(import.meta.resolve("./gui-settings"));
  const run = async (script: string) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { readGuiSettings, updateGuiSettings, terminalSurfaceCodecsEnabled } from ${source}; ${script}`,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          APPDATA: join(home, "AppData"),
          ROAMGATE_SETTINGS_PATH: undefined,
          HERDR_GUI_SETTINGS_PATH: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return JSON.parse(stdout);
  };
  try {
    expect(
      await run(
        `const settings = await readGuiSettings(); console.log(JSON.stringify([terminalSurfaceCodecsEnabled(settings), terminalSurfaceCodecsEnabled(settings, "alpha")]));`,
      ),
    ).toEqual([true, true]);
    expect(
      await run(
        `await updateGuiSettings(s => ({ ...s, custom: { keep: "yes" }, terminal_transport: { "legacy-default": { surface_codecs: false }, alpha: { surface_codecs: false }, beta: { surface_codecs: true } } })); console.log("true");`,
      ),
    ).toBe(true);
    expect(
      await run(
        `const s = await readGuiSettings(); console.log(JSON.stringify([terminalSurfaceCodecsEnabled(s), terminalSurfaceCodecsEnabled(s, "alpha"), terminalSurfaceCodecsEnabled(s, "beta"), terminalSurfaceCodecsEnabled(s, "new"), s.custom.keep]));`,
      ),
    ).toEqual([false, false, true, true, "yes"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("explicit settings paths isolate writes and bypass legacy migration", async () => {
  const home = await mkdtemp(join(tmpdir(), "roamgate-settings-override-"));
  const source = JSON.stringify(import.meta.resolve("./gui-settings"));
  const legacyPath = join(home, ".config", "herdr-gui", "settings.json");
  const defaultPath = join(home, ".config", "roamgate", "settings.json");
  const overridePath = join(home, "isolated", "settings.json");
  const aliasPath = join(home, "alias", "settings.json");
  const legacySettings = JSON.stringify({
    version: 1,
    custom: { legacy: true },
  });
  const run = async (
    currentPath: string | undefined,
    legacyOverride: string | undefined,
    script: string,
  ) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { guiSettingsPath, readGuiSettings, updateGuiSettings } from ${source}; ${script}`,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          APPDATA: join(home, "AppData"),
          ROAMGATE_SETTINGS_PATH: currentPath,
          HERDR_GUI_SETTINGS_PATH: legacyOverride,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return JSON.parse(stdout);
  };
  try {
    await mkdir(join(home, ".config", "herdr-gui"), { recursive: true });
    await writeFile(legacyPath, legacySettings);
    expect(
      await run(
        overridePath,
        aliasPath,
        `const before = await readGuiSettings(); await updateGuiSettings(s => ({ ...s, custom: { isolated: true } })); console.log(JSON.stringify([guiSettingsPath(), before.custom]));`,
      ),
    ).toEqual([overridePath, {}]);
    expect(JSON.parse(await readFile(overridePath, "utf8")).custom).toEqual({
      isolated: true,
    });
    expect(await readFile(legacyPath, "utf8")).toBe(legacySettings);
    expect(await Bun.file(defaultPath).exists()).toBe(false);
    expect(await Bun.file(aliasPath).exists()).toBe(false);
    expect(
      await run(
        undefined,
        aliasPath,
        `console.log(JSON.stringify(guiSettingsPath()));`,
      ),
    ).toBe(aliasPath);
    expect(
      await run(
        "",
        aliasPath,
        `console.log(JSON.stringify(guiSettingsPath()));`,
      ),
    ).toBe("");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("settings keys preserve legacy format and isolate connection identities", () => {
  const workspace = {
    worktree: {
      repo_key: "same-repo",
      checkout_path: "/same/checkout",
    },
  };

  expect(repoSettingsKey("same-repo")).toBe("local:same-repo");
  expect(repoSettingsKey("same-repo", undefined, "legacy-default")).toBe(
    "local:same-repo",
  );
  expect(repoSettingsKey("same-repo", "same-host", "legacy-default")).toBe(
    "ssh:same-host:same-repo",
  );

  expect(workspaceRepoSettingsKey(workspace, undefined, "alpha")).toBe(
    "connection:alpha:local:same-repo",
  );
  expect(workspaceRepoSettingsKey(workspace, undefined, "beta")).toBe(
    "connection:beta:local:same-repo",
  );
  expect(
    workspaceAutoSyncSettingsKey("/same/checkout", "same-host", "alpha"),
  ).toBe("connection:alpha:ssh:same-host:/same/checkout");
  expect(
    workspaceAutoSyncSettingsKey("/same/checkout", "same-host", "beta"),
  ).toBe("connection:beta:ssh:same-host:/same/checkout");
  expect(repoSettingsKey("same", undefined, "alpha:local:beta")).toBe(
    "connection:alpha%3Alocal%3Abeta:local:same",
  );
});

test("a repository's worktree directory is kept only when absolute", () => {
  expect(normalizeWorktreeDirectory("  /srv/trees//  ")).toBe("/srv/trees");
  expect(normalizeWorktreeDirectory("/")).toBe("/");
  for (const value of ["", "   ", "trees", "./trees", "~/trees", 3, null])
    expect(normalizeWorktreeDirectory(value)).toBeUndefined();
});

test("worktree commands are trimmed templates, and a repository's wins", () => {
  expect(normalizeWorktreeCommand("  mk {path}\n")).toBe("mk {path}");
  for (const value of [undefined, 1, "", "  ", "a\0b", "x".repeat(4097)])
    expect(normalizeWorktreeCommand(value)).toBeUndefined();
  const settings = {
    version: 1 as const,
    worktree_command: "global",
    repositories: { "local:/a": { worktree_command: "repo" }, "local:/b": {} },
    workspace_auto_sync: {},
    custom: {},
    ui: {},
  };
  expect(worktreeCommandFor(settings, "local:/a")).toBe("repo");
  expect(worktreeCommandFor(settings, "local:/b")).toBe("global");
  expect(worktreeCommandFor(settings, null)).toBe("global");
  expect(
    worktreeCommandFor(
      { ...settings, worktree_command: undefined },
      "local:/b",
    ),
  ).toBeUndefined();
});

test("the removal command follows the same rule as creation's", () => {
  const settings = {
    version: 1 as const,
    worktree_command: "add",
    worktree_remove_command: "global rm",
    repositories: {
      "local:/a": { worktree_remove_command: "repo rm" },
      "local:/b": { worktree_command: "repo add" },
    },
    workspace_auto_sync: {},
    custom: {},
    ui: {},
  };
  expect(worktreeRemoveCommandFor(settings, "local:/a")).toBe("repo rm");
  expect(worktreeRemoveCommandFor(settings, "local:/b")).toBe("global rm");
  expect(
    worktreeRemoveCommandFor(
      { ...settings, worktree_remove_command: undefined },
      "local:/b",
    ),
  ).toBeUndefined();
});

test("activity settings default to off and keep each valid field", () => {
  expect(normalizeActivitySettings(undefined)).toEqual(
    DEFAULT_ACTIVITY_SETTINGS,
  );
  expect(DEFAULT_ACTIVITY_SETTINGS).toMatchObject({
    enabled: false,
    retention_days: 90,
    idle_seconds: 300,
    day_start: "00:00",
    record_agent_titles: false,
  });
  expect(
    normalizeActivitySettings({
      enabled: true,
      retention_days: 30,
      idle_seconds: 600,
      day_start: "05:30",
      subject_roots: ["~/devel/clients", 3, ""],
      record_agent_titles: true,
      exclude: { connections: ["work"], subjects: ["private"] },
    }),
  ).toEqual({
    enabled: true,
    retention_days: 30,
    idle_seconds: 600,
    day_start: "05:30",
    subject_roots: ["~/devel/clients"],
    record_agent_titles: true,
    exclude: { connections: ["work"], subjects: ["private"] },
  });
  expect(
    normalizeActivitySettings({
      enabled: "yes",
      retention_days: 0,
      idle_seconds: 1.5,
      day_start: "24:00",
      exclude: "all",
    }),
  ).toEqual(DEFAULT_ACTIVITY_SETTINGS);
});

test("activity settings survive other settings writes, and are not added", async () => {
  const home = await mkdtemp(join(tmpdir(), "roamgate-settings-"));
  const path = join(home, "settings.json");
  const source = JSON.stringify(import.meta.resolve("./gui-settings"));
  const update = async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { updateGuiSettings } from ${source}; await updateGuiSettings((s) => ({ ...s, title_suffix: "x" }));`,
      ],
      {
        env: { ...process.env, HOME: home, ROAMGATE_SETTINGS_PATH: path },
        stderr: "pipe",
      },
    );
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await child.exited).toBe(0);
    return JSON.parse(await readFile(path, "utf8"));
  };
  try {
    await writeFile(path, JSON.stringify({ version: 1 }));
    expect((await update()).activity).toBeUndefined();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        activity: { enabled: true, subject_roots: ["~/devel/clients"] },
      }),
    );
    expect((await update()).activity).toEqual({
      ...DEFAULT_ACTIVITY_SETTINGS,
      enabled: true,
      subject_roots: ["~/devel/clients"],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
