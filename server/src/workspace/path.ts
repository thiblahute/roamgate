import { access, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { WorkspacePathInfo } from "../../../shared/workspacePath";
import { sshReadCommandArgv } from "../bridge/ssh-command";
import { powershellCommand } from "../bridge/ssh-windows";
import type { RemotePlatform } from "../connections/unix-only";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import { LIST_DIRECTORY_PS1, LIST_DIRECTORY_SH, fillTemplate } from "../assets";

const DIRECTORY_LIMIT = 50;

async function realDirectoryPath(path: string): Promise<string> {
  // Bun realpath drops the separator from Windows drive roots, changing C:\ into C:.
  if (process.platform === "win32" && /^[a-z]:[/\\]+$/i.test(path)) return path;
  // shortcut: retain symlink spelling for trailing Unix backslashes until Bun realpath preserves them.
  return process.platform !== "win32" && path.endsWith("\\")
    ? path
    : realpath(path);
}

export async function inspectWorkspacePath(
  value: unknown,
  connection: { host?: string; remotePlatform?: RemotePlatform },
  suggestions = true,
): Promise<WorkspacePathInfo> {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error("Enter a valid directory path.");
  const input = value.trim();
  const windows = connection.host
    ? connection.remotePlatform === "windows"
    : process.platform === "win32";
  const homePath = (windows ? /^~(?:[/\\]|$)/ : /^~(?:\/|$)/).test(input);
  if (
    !(windows ? /^(?:[a-z]:[/\\]|[/\\]{2})/i.test(input) : isAbsolute(input)) &&
    !homePath
  )
    throw new Error("Use an absolute path or a path starting with ~/.");

  if (connection.host) {
    const command = windows
      ? powershellCommand(
          fillTemplate(LIST_DIRECTORY_PS1, {
            path: input.replaceAll("'", "''"),
            suggestions: suggestions ? "$true" : "$false",
            limit: DIRECTORY_LIMIT,
          }),
        )
      : `bash -c ${shQuote(fillTemplate(LIST_DIRECTORY_SH, { path: shQuote(input), suggestions: suggestions ? "1" : "0", limit: DIRECTORY_LIMIT }))}`;
    const result = await runProcessWithCodeTimeout(
      sshReadCommandArgv(connection.host, command, [], "workspace.path"),
      8000,
    );
    if (result.code !== 0)
      throw new Error("Could not check the directory on the connected host.");
    const info: WorkspacePathInfo = { path: "", error: null, directories: [] };
    for (const line of result.stdout.split(/\r?\n/)) {
      const [kind, encoded = ""] = line.split("\t");
      const text = Buffer.from(encoded, "base64").toString("utf8");
      if (kind === "PATH") info.path = text;
      if (kind === "ERROR") info.error = text || null;
      if (kind === "DIRECTORY") info.directories.push(text);
    }
    if (!info.path)
      throw new Error("Invalid directory response from the connected host.");
    return info;
  }

  const info: WorkspacePathInfo = {
    path: resolve(homePath ? join(homedir(), input.slice(2)) : input),
    error: null,
    directories: [],
  };
  try {
    if (!(await stat(info.path)).isDirectory()) {
      info.error = "Path is not a directory.";
    } else {
      await access(info.path, constants.X_OK);
      info.path = await realDirectoryPath(info.path);
    }
  } catch (error) {
    info.error = ["ENOENT", "ENOTDIR"].includes(
      (error as NodeJS.ErrnoException).code ?? "",
    )
      ? "Directory does not exist."
      : "Directory is not accessible.";
  }
  if (suggestions) {
    const directory = await realDirectoryPath(
      info.error ? dirname(info.path) : info.path,
    ).catch(() => null);
    if (!directory) return info;
    const prefix = info.error ? basename(info.path) : "";
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    const matches = entries
      .filter(
        (entry) =>
          (windows
            ? entry.name.toLowerCase().startsWith(prefix.toLowerCase())
            : entry.name.startsWith(prefix)) &&
          (prefix.startsWith(".") || !entry.name.startsWith(".")) &&
          !/[\x00-\x1f\x7f]/.test(entry.name),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of matches) {
      const path = join(directory, entry.name);
      if (
        entry.isDirectory() ||
        (entry.isSymbolicLink() &&
          (await stat(path).catch(() => null))?.isDirectory())
      )
        info.directories.push(path);
      if (info.directories.length === DIRECTORY_LIMIT) break;
    }
  }
  return info;
}
