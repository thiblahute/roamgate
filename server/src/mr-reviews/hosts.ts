import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ForgeProvider } from "../../../shared/forge";
import { validHost } from "../../../shared/forge";

/**
 * The forge hosts the user is signed in to on this machine, from glab's
 * and gh's own configuration: nothing is assumed. Only host names are
 * read out of the files; tokens are never kept or logged.
 */

export type ForgeHost = { host: string; provider: ForgeProvider };

/** The hosts of a YAML `hosts:` map: its keys, and their blocks' text. */
export function yamlHostBlocks(
  text: string,
  topLevel: boolean,
): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const blocks = new Map<string, string>();
  let inHosts = topLevel;
  let indent = topLevel ? 0 : -1;
  let current: string | null = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const lead = line.length - line.trimStart().length;
    if (!topLevel && lead === 0) {
      inHosts = /^hosts:\s*$/.test(line);
      indent = -1;
      current = null;
      continue;
    }
    if (!inHosts) continue;
    if (indent < 0) indent = lead;
    const key = /^\s*"?([A-Za-z0-9.:-]+)"?:\s*$/.exec(line);
    if (lead === indent && key) {
      current = key[1]!.toLowerCase();
      blocks.set(current, "");
    } else if (lead > indent && current)
      blocks.set(current, `${blocks.get(current)}${line.trim()}\n`);
    else if (lead <= indent) current = null;
  }
  return blocks;
}

function firstFile(paths: string[]): string | null {
  for (const path of paths) if (existsSync(path)) return path;
  return null;
}

export function glabConfigPath(env = process.env, home = homedir()) {
  return firstFile([
    ...(env.GLAB_CONFIG_DIR ? [join(env.GLAB_CONFIG_DIR, "config.yml")] : []),
    join(
      env.XDG_CONFIG_HOME ?? join(home, ".config"),
      "glab-cli",
      "config.yml",
    ),
    join(home, "Library", "Application Support", "glab-cli", "config.yml"),
  ]);
}

export function ghHostsPath(env = process.env, home = homedir()) {
  return firstFile([
    ...(env.GH_CONFIG_DIR ? [join(env.GH_CONFIG_DIR, "hosts.yml")] : []),
    join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "gh", "hosts.yml"),
  ]);
}

/** glab's hosts with a login: a token in the file, or the keyring's. */
export function glabHosts(text: string): string[] {
  const defaultHost = /^host:\s*"?(?:https?:\/\/)?([^"\s/]+)/m.exec(text)?.[1];
  const hosts: string[] = [];
  for (const [host, block] of yamlHostBlocks(text, false)) {
    const token = /^token:[ \t]*(\S.*)?$/m.exec(block)?.[1]?.trim();
    const signedIn =
      (!!token && token !== '""' && token !== "''") ||
      /^is_keyring_token:\s*true/m.test(block) ||
      host === defaultHost?.toLowerCase();
    if (signedIn && validHost(host)) hosts.push(host);
  }
  return hosts;
}

/** gh's hosts: each one in hosts.yml was signed in to. */
export function ghHosts(text: string): string[] {
  return [...yamlHostBlocks(text, true).keys()].filter(validHost);
}

/** The hosts to list requests from: the settings', else the logins'. */
export function discoverForgeHosts(
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
  paths = { glab: glabConfigPath(), gh: ghHostsPath() },
): ForgeHost[] {
  const out: ForgeHost[] = [];
  const add = (host: string, provider: ForgeProvider) => {
    if (!out.some((entry) => entry.host === host)) out.push({ host, provider });
  };
  try {
    if (paths.glab)
      for (const host of glabHosts(read(paths.glab))) add(host, "gitlab");
  } catch {}
  try {
    if (paths.gh)
      for (const host of ghHosts(read(paths.gh))) add(host, "github");
  } catch {}
  return out;
}
