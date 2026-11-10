import type { BackgroundMemoryLaunch, CompanionMemoryDriver } from "./types";

/**
 * Claude Code reads the memory directory by itself once told where it is
 * (`autoMemoryDirectory`): MEMORY.md is loaded at the start of a session and
 * its own rules for keeping files apply. `--safe-mode` turns memory off, so
 * these sessions leave it out and stay bare another way: no user or project
 * settings (so no CLAUDE.md, no hooks, plugins or settings of the user's
 * own) and hooks off for what `--settings` itself could bring.
 *
 * The writer runs in `dontAsk` mode, with its file tools allowed for that
 * directory only: outside of it Read, Write and Edit are denied, whatever
 * the conversation it summarizes wrote.
 */
function settings(dir: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    autoMemoryDirectory: dir,
    disableAllHooks: true,
    ...extra,
  });
}

export const claudeMemoryDriver: CompanionMemoryDriver = {
  reader(dir): BackgroundMemoryLaunch {
    return {
      args: ["--setting-sources", "", "--settings", settings(dir)],
      tools: "",
    };
  },
  writer(dir): BackgroundMemoryLaunch {
    return {
      args: [
        "--setting-sources",
        "",
        "--permission-mode",
        "dontAsk",
        "--settings",
        settings(dir, {
          permissions: {
            allow: [
              `Read(${dir}/**)`,
              `Write(${dir}/**)`,
              `Edit(${dir}/**)`,
              "Glob",
            ],
          },
        }),
      ],
      tools: "Read,Write,Edit,Glob",
      cwd: dir,
    };
  },
};
