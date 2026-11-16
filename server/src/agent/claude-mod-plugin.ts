import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { claudeModSources } from "./claude-mod-files" with { type: "macro" };

/**
 * Roamgate's Claude Code mod as Roamgate ships it: a directory marketplace
 * under `~/.cache/roamgate/claude-plugins` (written at start on this machine
 * and on each SSH host, like the review client) that lists the plugin by a
 * relative path, so Claude Code reads it in place and an update needs no
 * reinstall. Installing is the user's choice (Configuration > Integrations):
 * Roamgate runs Claude Code's own `claude plugin install` for it, and never
 * edits Claude's settings itself.
 */

/** Under the home directory, beside the review client. */
export const CLAUDE_MOD_MARKETPLACE_DIR = ".cache/roamgate/claude-plugins";
export const CLAUDE_MOD_NAME = "roamgate";
export const CLAUDE_MOD_MARKETPLACE = "roamgate";
export const CLAUDE_MOD_PLUGIN_ID = `${CLAUDE_MOD_NAME}@${CLAUDE_MOD_MARKETPLACE}`;
/**
 * Mods came in 2.1.287; 2.1.304 settled what a plugin's prompts do after
 * the user stops a turn, which the mod relies on.
 */
export const CLAUDE_MOD_MIN_CLAUDE = "2.1.304";

const MARKETPLACE = {
  name: CLAUDE_MOD_MARKETPLACE,
  owner: { name: "Roamgate" },
  plugins: [
    {
      name: CLAUDE_MOD_NAME,
      source: `./${CLAUDE_MOD_NAME}`,
      description:
        "Roamgate's link to Claude Code sessions: tools to answer review and chat comments and message other sessions, and in Herdr panes, messages as prompts once Claude is idle and exact turns, waits, model and usage.",
    },
  ],
};

/** Every file of the marketplace, by its path under it. */
export const CLAUDE_MOD_FILES: Record<string, string> = (() => {
  const files: Record<string, string> = {
    ".claude-plugin/marketplace.json": `${JSON.stringify(MARKETPLACE, null, 2)}\n`,
  };
  for (const [path, text] of Object.entries(claudeModSources()))
    files[`${CLAUDE_MOD_NAME}/${path}`] = text;
  return files;
})();

export const CLAUDE_MOD_CHECKSUM = createHash("sha256")
  .update(JSON.stringify(Object.entries(CLAUDE_MOD_FILES).sort()))
  .digest("hex")
  .slice(0, 16);

const CHECKSUM_FILE = ".roamgate-checksum";

/**
 * Writes the marketplace under `home` unless this version is there. Files
 * of an older version that this one no longer has are left: Claude reads
 * only what the manifests name.
 */
export function writeClaudeModPlugin(home: string): boolean {
  const base = join(home, CLAUDE_MOD_MARKETPLACE_DIR);
  try {
    if (
      readFileSync(join(base, CHECKSUM_FILE), "utf8").trim() ===
      CLAUDE_MOD_CHECKSUM
    )
      return false;
  } catch {}
  for (const [path, text] of Object.entries(CLAUDE_MOD_FILES)) {
    const target = join(base, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, text, { mode: 0o644 });
    renameSync(temp, target);
  }
  writeFileSync(join(base, CHECKSUM_FILE), `${CLAUDE_MOD_CHECKSUM}\n`);
  return true;
}

/** Removes the marketplace (tests). */
export function removeClaudeModPlugin(home: string): void {
  rmSync(join(home, CLAUDE_MOD_MARKETPLACE_DIR), {
    recursive: true,
    force: true,
  });
}

/**
 * The same for an SSH host, as lines of the review client's setup script
 * (python3 decodes; `$HOME` is the host's).
 */
/**
 * A shell command that writes `text` to standard output on a host with
 * python3, packed (deflate, then base64): the setup script travels as one
 * command argument, which Linux caps at 128 KiB.
 */
export function packedOutput(text: string): string {
  const packed = deflateSync(Buffer.from(text), { level: 9 }).toString(
    "base64",
  );
  return `python3 -c 'import base64,sys,zlib; sys.stdout.buffer.write(zlib.decompress(base64.b64decode(sys.argv[1])))' '${packed}'`;
}

export function remoteClaudeModScript(): string[] {
  const lines = [
    `m="$HOME/${CLAUDE_MOD_MARKETPLACE_DIR}"`,
    `if [ "$(cat "$m/${CHECKSUM_FILE}" 2>/dev/null)" != "${CLAUDE_MOD_CHECKSUM}" ]; then`,
  ];
  for (const [path, text] of Object.entries(CLAUDE_MOD_FILES))
    lines.push(
      `  mkdir -p "$m/${dirname(path)}"`,
      `  ${packedOutput(text)} > "$m/${path}.tmp" && mv "$m/${path}.tmp" "$m/${path}"`,
    );
  lines.push(
    `  printf '%s\\n' '${CLAUDE_MOD_CHECKSUM}' > "$m/${CHECKSUM_FILE}"`,
    "fi",
  );
  return lines;
}

/** Compares dotted versions: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) =>
    (value.match(/\d+(?:\.\d+)*/)?.[0] ?? "0").split(".").map(Number);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/**
 * A POSIX shell script that runs Claude Code's plugin command on a host:
 * finds `claude` (PATH, else its usual places), prints its version, then
 * the command's output. `action` is status, install or uninstall.
 */
export function claudeModHostScript(
  action: "status" | "install" | "uninstall",
): string {
  const marketplace = `"$HOME/${CLAUDE_MOD_MARKETPLACE_DIR}"`;
  const command =
    action === "install"
      ? `"$c" plugin install ${CLAUDE_MOD_NAME} --marketplace ${marketplace} --scope user --json; echo "ROAMGATE_EXIT=$?"; "$c" plugin enable ${CLAUDE_MOD_PLUGIN_ID} --scope user >/dev/null 2>&1; true`
      : action === "uninstall"
        ? `"$c" plugin uninstall ${CLAUDE_MOD_PLUGIN_ID} --scope user --json; echo "ROAMGATE_EXIT=$?"; "$c" plugin marketplace remove ${CLAUDE_MOD_MARKETPLACE} >/dev/null 2>&1; true`
        : "true";
  return [
    'c="$(command -v claude 2>/dev/null || true)"',
    'if [ -z "$c" ]; then for p in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do if [ -x "$p" ]; then c="$p"; break; fi; done; fi',
    'if [ -z "$c" ]; then echo "ROAMGATE_CLAUDE="; exit 0; fi',
    'echo "ROAMGATE_CLAUDE=$c"',
    'echo "ROAMGATE_VERSION=$("$c" --version 2>/dev/null | head -n 1)"',
    command,
    'echo "ROAMGATE_LIST_BEGIN"',
    '"$c" plugin list --json 2>/dev/null || true',
  ].join("\n");
}

export type ClaudeModInstallState = {
  /** Whether this host can have the mod. */
  available: boolean;
  /** Why not, or why the last action failed. */
  reason?: string;
  claude_version?: string;
  min_claude: string;
  installed: boolean;
  enabled: boolean;
  /** Installed from Roamgate's folder (so Roamgate's updates reach it). */
  from_roamgate: boolean;
  /** Claude sessions on this connection whose mod is live now. */
  sessions: number;
};

/** Reads what the host script printed. */
export function parseClaudeModHostOutput(output: string): {
  claude: string | null;
  version: string;
  exit: number | null;
  actionOutput: string;
  plugin: Record<string, unknown> | null;
} {
  const claude = /^ROAMGATE_CLAUDE=(.*)$/m.exec(output)?.[1]?.trim() ?? "";
  const version = /^ROAMGATE_VERSION=(.*)$/m.exec(output)?.[1]?.trim() ?? "";
  const exitText = /^ROAMGATE_EXIT=(\d+)$/m.exec(output)?.[1];
  const begin = output.indexOf("ROAMGATE_LIST_BEGIN");
  const versionEnd = output.indexOf("\n", output.indexOf("ROAMGATE_VERSION="));
  const actionOutput =
    versionEnd >= 0 && begin > versionEnd
      ? output
          .slice(versionEnd + 1, begin)
          .replace(/^ROAMGATE_EXIT=\d+$/m, "")
          .trim()
      : "";
  let plugin: Record<string, unknown> | null = null;
  if (begin >= 0) {
    try {
      const listed: unknown = JSON.parse(
        output.slice(begin + "ROAMGATE_LIST_BEGIN".length).trim() || "[]",
      );
      if (Array.isArray(listed))
        plugin =
          (listed.find(
            (each) =>
              !!each &&
              typeof each === "object" &&
              (each as { id?: unknown }).id === CLAUDE_MOD_PLUGIN_ID &&
              ((each as { scope?: unknown }).scope ?? "user") === "user",
          ) as Record<string, unknown> | undefined) ?? null;
    } catch {}
  }
  return {
    claude: claude || null,
    version,
    exit: exitText === undefined ? null : Number(exitText),
    actionOutput,
    plugin,
  };
}

/** The state a host's script output describes. */
export function claudeModStateOf(
  output: string,
  sessions: number,
): ClaudeModInstallState {
  const parsed = parseClaudeModHostOutput(output);
  const base = {
    min_claude: CLAUDE_MOD_MIN_CLAUDE,
    sessions,
    installed: !!parsed.plugin,
    enabled: parsed.plugin?.enabled === true,
    from_roamgate:
      typeof parsed.plugin?.readFromFolder === "string" &&
      parsed.plugin.readFromFolder.includes(
        `${CLAUDE_MOD_MARKETPLACE_DIR}/${CLAUDE_MOD_NAME}`,
      ),
  };
  if (!parsed.claude)
    return {
      ...base,
      available: false,
      reason: "Claude Code was not found on this host",
    };
  const version = /\d+\.\d+\.\d+/.exec(parsed.version)?.[0] ?? "";
  if (!version)
    return {
      ...base,
      available: false,
      reason: "Claude Code's version could not be read",
    };
  if (compareVersions(version, CLAUDE_MOD_MIN_CLAUDE) < 0)
    return {
      ...base,
      available: false,
      claude_version: version,
      reason: `Claude Code ${version} is older than ${CLAUDE_MOD_MIN_CLAUDE}; update it (claude update) for the mod`,
    };
  return { ...base, available: true, claude_version: version };
}
