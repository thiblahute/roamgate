/**
 * Whether GameMode (gamemoded) runs: a game has the machine, so heavy
 * background work (voice models, the archive's text repo) yields to it.
 */
import { existsSync } from "node:fs";
import { hostSpawnPath } from "./host-spawn";
import { type LogFields, serverLogger } from "./logger";

const log = serverLogger.child("voice");

/** `gamemoded -s`'s answer: true active, false inactive, null unknown. */
export function parseGameMode(output: string): boolean | null {
  if (/gamemode is active/i.test(output)) return true;
  if (/gamemode is inactive/i.test(output)) return false;
  return null;
}

/**
 * The command asking GameMode whether it runs: on the host through
 * host-spawn when the server runs in a toolbox (gamemoded is the host's),
 * the host-spawn that runs (hostSpawnPath); null in a toolbox without one.
 */
export function gameModeCommand(
  inToolbox: boolean,
  hostSpawn: string | null = inToolbox ? hostSpawnPath() : null,
): string[] | null {
  if (!inToolbox) return ["gamemoded", "-s"];
  return hostSpawn ? [hostSpawn, "--no-pty", "gamemoded", "-s"] : null;
}

/** Whether this process runs in a toolbox (or another podman container). */
export function inToolbox(): boolean {
  return existsSync("/run/.toolboxenv");
}

let gameModeUnavailableLogged = false;

/** Why GameMode cannot be asked, logged once per process at debug. */
function gameModeUnavailable(reason: string, fields: LogFields = {}): null {
  if (!gameModeUnavailableLogged) {
    gameModeUnavailableLogged = true;
    log.debug(`GameMode detection unavailable: ${reason}`, fields);
  }
  return null;
}

/** Whether GameMode runs now; null when it cannot tell (none installed). */
export async function gameModeActive(
  command = gameModeCommand(inToolbox()),
  timeoutMs = 3000,
): Promise<boolean | null> {
  if (process.platform !== "linux") return null;
  if (!command) {
    return gameModeUnavailable("in a toolbox without a runnable host-spawn", {
      path: process.env.PATH ?? "",
    });
  }
  try {
    const child = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    const active = parseGameMode(`${out}\n${err}`);
    if (active !== null) return active;
    return gameModeUnavailable("no GameMode answer", {
      command: command.join(" "),
      code,
      output: `${out}\n${err}`.trim(),
    });
  } catch (error) {
    return gameModeUnavailable("the command did not run", {
      command: command.join(" "),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
