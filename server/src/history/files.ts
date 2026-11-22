import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type HistoryArea, type HistoryPaths, count } from "./area";
import { fileNameOf, stableJson } from "./format";
import { withoutSecrets } from "../utils/secrets";

/**
 * The areas kept as the stores' own small files: settings (one file per
 * top-level key, from an allowlist), connections, move hosts, session
 * profiles, the companion's memories and the voice settings. JSON goes
 * through withoutSecrets and is written key-sorted; Markdown is copied as
 * it is (the scan before the commit keeps a secret out).
 */

/**
 * The keys of settings.json the history keeps, each as
 * `settings/<key>.json`. `mr_reviews` is the mr-reviews area's (its
 * authored part); a key not listed here is never written.
 */
export const HISTORY_SETTINGS_KEYS = [
  "version",
  "archive",
  "title_suffix",
  "auto_rename_agent_tabs",
  "worktree_command",
  "worktree_remove_command",
  "repositories",
  "workspace_auto_sync",
  "terminal_transport",
  "activity",
  "time_report",
  "claude_start_mode",
  "conversation",
  "limit_resume",
  "mr_cache",
  "profiles",
  "custom",
  "ui",
  "workspace_tree",
  "rendered_sites",
  "rendered_site_roots",
  "history",
] as const;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function settingsArea(
  paths: Pick<HistoryPaths, "settings">,
): HistoryArea {
  return {
    name: "settings",
    watch: () => [paths.settings],
    render() {
      const files = new Map<string, string>();
      const settings = readJson(paths.settings);
      if (settings && typeof settings === "object" && !Array.isArray(settings))
        for (const key of HISTORY_SETTINGS_KEYS) {
          const value = (settings as Record<string, unknown>)[key];
          if (value !== undefined)
            files.set(
              `settings/${key}.json`,
              stableJson(withoutSecrets(value)),
            );
        }
      return { files, owns: ["settings/"] };
    },
    describe: (changed) =>
      changed
        .map((path) => path.replace(/^settings\//, "").replace(/\.json$/, ""))
        .join(", "),
  };
}

/** One source of a files area: a JSON file, or a directory of files. */
type Source =
  | {
      kind: "json";
      from: string;
      to: string;
      /** Only these keys (the authored part of a mixed file). */
      keys?: readonly string[];
    }
  | {
      kind: "dir";
      from: string;
      /** The directory in the repo, ending in `/`. */
      to: string;
      /** The entries taken. */
      match: RegExp;
      json: boolean;
    };

function entries(dir: string, match: RegExp): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => match.test(name) && !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

function filesArea(name: string, sources: readonly Source[]): HistoryArea {
  return {
    name,
    watch: () =>
      sources.flatMap((source) =>
        source.kind === "json"
          ? [source.from]
          : [
              source.from,
              ...entries(source.from, source.match).map((file) =>
                join(source.from, file),
              ),
            ],
      ),
    render() {
      const files = new Map<string, string>();
      for (const source of sources) {
        if (source.kind === "json") {
          let value = readJson(source.from);
          if (value === undefined) continue;
          if (source.keys && value && typeof value === "object")
            value = Object.fromEntries(
              source.keys.flatMap((key) =>
                (value as Record<string, unknown>)[key] === undefined
                  ? []
                  : [[key, (value as Record<string, unknown>)[key]]],
              ),
            );
          files.set(source.to, stableJson(withoutSecrets(value)));
          continue;
        }
        for (const file of entries(source.from, source.match)) {
          const target = `${source.to}${fileNameOf(file)}`;
          if (source.json) {
            const value = readJson(join(source.from, file));
            if (value !== undefined)
              files.set(target, stableJson(withoutSecrets(value)));
          } else {
            try {
              files.set(target, readFileSync(join(source.from, file), "utf8"));
            } catch {}
          }
        }
      }
      return { files, owns: sources.map((source) => source.to) };
    },
    describe: (changed) => count(changed.length, "file"),
  };
}

export function connectionsArea(
  paths: Pick<HistoryPaths, "connections">,
): HistoryArea {
  return filesArea("connections", [
    { kind: "json", from: paths.connections, to: "connections.json" },
  ]);
}

export function moveHostsArea(paths: Pick<HistoryPaths, "data">): HistoryArea {
  return filesArea("move-hosts", [
    {
      kind: "json",
      from: join(paths.data, "move-hosts.json"),
      to: "move-hosts.json",
    },
  ]);
}

export function sessionProfilesArea(
  paths: Pick<HistoryPaths, "data">,
): HistoryArea {
  return filesArea("session-profiles", [
    {
      kind: "json",
      from: join(paths.data, "session-profiles.json"),
      to: "session-profiles.json",
    },
  ]);
}

/** The companion: its memory, the rules the user taught it, the taste the user set. */
export function companionArea(paths: Pick<HistoryPaths, "data">): HistoryArea {
  return filesArea("companion", [
    {
      kind: "json",
      from: join(paths.data, "companion-memory.json"),
      to: "companion/memory.json",
    },
    {
      kind: "dir",
      from: join(paths.data, "companion-memories"),
      to: "companion/memories/",
      match: /\.md$/,
      json: false,
    },
    {
      kind: "json",
      from: join(paths.data, "taste.json"),
      to: "companion/taste.json",
      // The profile is read again from the music service; these are the user's.
      keys: ["version", "avoid", "picks"],
    },
  ]);
}

export function voiceArea(
  paths: Pick<HistoryPaths, "data" | "voiceData">,
): HistoryArea {
  return filesArea("voice", [
    {
      kind: "json",
      from: join(paths.data, "voice.json"),
      to: "voice/voice.json",
    },
    {
      kind: "dir",
      from: join(paths.data, "voice-profiles"),
      to: "voice/profiles/",
      match: /\.json$/,
      json: true,
    },
    {
      kind: "json",
      from: join(paths.voiceData, "low-gpu.json"),
      to: "voice/low-gpu.json",
    },
  ]);
}
