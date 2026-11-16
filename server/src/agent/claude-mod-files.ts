import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Claude mod's files (server/claude-mod), read when Roamgate is built
 * or loaded: a Bun macro, so the standalone binary carries them. Tests and
 * the engine's own type files are not shipped.
 */
export const CLAUDE_MOD_SOURCE_FILES = [
  ".claude-plugin/plugin.json",
  "hooks/hooks.json",
  "hooks/register.ts",
  "hooks/client.ts",
  "hooks/tools.ts",
] as const;

export function claudeModSources(): Record<string, string> {
  const root = join(import.meta.dir, "..", "..", "claude-mod");
  const files: Record<string, string> = {};
  for (const path of CLAUDE_MOD_SOURCE_FILES)
    files[path] = readFileSync(join(root, path), "utf8");
  return files;
}
