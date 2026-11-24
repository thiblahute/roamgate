import { lstatSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { roamgateEnv } from "../config/environment";
import {
  escapeSystemdExecPath,
  xmlEscape,
} from "../config/service-definitions";
import {
  compareVersion,
  curlTransportArgs,
  fetchLatestUpdateManifest,
  normalizeUpdateBaseUrl,
  renderUpdateInstallScript,
  resolveUpdateTarget,
  type RunProcessWithCodeTimeout,
  UPDATE_INSTALL_TIMEOUT_MS,
} from "../http/update";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import {
  type CliCommand,
  type CliContext,
  EXIT_FAILURE,
  EXIT_OK,
  isStandaloneBinary,
  parseCommandArgs,
  printJson,
  wantsHelp,
} from "./command";
import {
  readServiceSetup,
  restartRunningService,
  serviceStatus,
} from "./service-context";

export interface UpdateDependencies {
  runProcess?: RunProcessWithCodeTimeout;
}

function updateHelp(): string {
  return `Update the standalone roamgate executable to the latest release.

Usage:
  roamgate update [--check] [--json]

Options:
  --check   only report whether a newer release exists
  --json    print machine-readable output (with --check)

The release manifest, archive checksum, package VERSION and binary version are
verified before the executable is replaced in place. The previous executable is
kept as roamgate.previous, and the Pi sidecar roamgate-pi beside it as
roamgate-pi.previous; \`roamgate rollback\` restores them. When the executable is
already the latest release but its roamgate-pi is missing, update installs it.
A running managed service that uses this executable is restarted afterwards.

ROAMGATE_UPDATE_BASE_URL selects a mirror (from the shell, else the service
config). To install a specific version, rerun the installer with
ROAMGATE_VERSION=X.Y.Z. Windows builds update by downloading a release.
`;
}

function rollbackHelp(): string {
  return `Swap the roamgate executable with roamgate.previous.

Usage:
  roamgate rollback

The update command and installer keep the replaced executable as
roamgate.previous, and the replaced Pi sidecar roamgate-pi as
roamgate-pi.previous. Rollback swaps each pair, so running it again undoes the
rollback. A running managed service that uses this executable is restarted.
`;
}

function serviceEnv(context: CliContext): Record<string, string> {
  try {
    return readServiceSetup(context.runtime).env;
  } catch {
    return {};
  }
}

/** Restart the managed service only when its definition runs this executable. */
function restartServiceUsing(context: CliContext, executable: string): number {
  let status: ReturnType<typeof serviceStatus>;
  try {
    status = serviceStatus(context);
  } catch {
    return EXIT_OK;
  }
  if (!status.installed || !status.active) {
    context.log("Restart any running roamgate process to use the new version.");
    return EXIT_OK;
  }
  const definition = readFileSync(status.definition, "utf8");
  const forms = [
    executable,
    escapeSystemdExecPath(executable),
    xmlEscape(executable),
  ];
  if (!forms.some((form) => definition.includes(form))) {
    context.log(
      `The managed service runs a different executable (${status.definition}); it was not restarted.`,
    );
    return EXIT_OK;
  }
  const code = restartRunningService(context);
  if (code === 0) context.log("Restarted the service.");
  return code ?? EXIT_OK;
}

export function createUpdateCommand(
  dependencies: UpdateDependencies = {},
): CliCommand {
  const runProcess = dependencies.runProcess ?? runProcessWithCodeTimeout;
  return {
    name: "update",
    summary: "update roamgate to the latest release",
    flags: ["--check", "--json"],
    help: updateHelp,
    async run(args, context) {
      if (wantsHelp(args)) {
        context.log(updateHelp());
        return EXIT_OK;
      }
      const { values } = parseCommandArgs(args, {
        check: { type: "boolean" },
        json: { type: "boolean" },
      });
      const { runtime } = context;
      const target = resolveUpdateTarget(runtime.platform, runtime.arch);
      if (!target) {
        context.error(
          `roamgate update: no update package for ${runtime.platform}-${runtime.arch}; download it from https://github.com/powerfooI/roamgate/releases/latest`,
        );
        return EXIT_FAILURE;
      }
      const baseUrl = normalizeUpdateBaseUrl(
        roamgateEnv("UPDATE_BASE_URL", runtime.env) ??
          roamgateEnv("UPDATE_BASE_URL", serviceEnv(context)),
      );
      const manifest = await fetchLatestUpdateManifest({
        baseUrl,
        target,
        runProcessWithCodeTimeout: runProcess,
      });
      const order = compareVersion(manifest.version, context.version);
      const available = order > 0;
      // The latest release already, but without the Pi sidecar beside it:
      // the same installer adds it and keeps the executable.
      const sidecarMissing =
        order === 0 &&
        isStandaloneBinary(runtime) &&
        !regularFile(piSidecarPath(runtime.execPath));

      if (values.check) {
        if (values.json) {
          printJson(context, {
            current_version: context.version,
            latest_version: manifest.version,
            update_available: available,
            platform: target.platform,
          });
        } else {
          context.log(`Current: roamgate ${context.version}`);
          context.log(`Latest:  roamgate ${manifest.version}`);
          context.log(
            available
              ? "An update is available: run `roamgate update`."
              : "Up to date.",
          );
        }
        return EXIT_OK;
      }
      if (!available && !sidecarMissing) {
        context.log(`roamgate ${context.version} is up to date.`);
        return EXIT_OK;
      }
      if (!isStandaloneBinary(runtime)) {
        context.error(
          "roamgate update: only the standalone binary can update itself; pull and rebuild source checkouts.",
        );
        return EXIT_FAILURE;
      }

      if (available) {
        context.log(
          `Updating roamgate ${context.version} -> ${manifest.version}...`,
        );
      }
      const script = renderUpdateInstallScript({
        targetPath: runtime.execPath,
        target,
        manifest,
        archiveUrl: `${baseUrl}/${target.archiveName}`,
        curlTransport: curlTransportArgs(baseUrl).map(shQuote).join(" "),
        shQuote,
      });
      const result = await runProcess(
        ["sh", "-c", script],
        UPDATE_INSTALL_TIMEOUT_MS,
      );
      if (result.code !== 0) {
        context.error(
          `roamgate update: ${(result.stderr || result.stdout || `install exited ${result.code}`).trim().slice(0, 1000)}`,
        );
        return EXIT_FAILURE;
      }
      if (!available) {
        const sidecar = piSidecarPath(runtime.execPath);
        if (!regularFile(sidecar)) {
          context.log(`roamgate ${context.version} is up to date.`);
          return EXIT_OK;
        }
        context.log(`Installed roamgate-pi ${manifest.version} at ${sidecar}.`);
        return restartServiceUsing(context, runtime.execPath);
      }
      context.log(
        `Installed roamgate ${manifest.version} at ${runtime.execPath}.`,
      );
      context.log(`Previous executable: ${runtime.execPath}.previous`);
      return restartServiceUsing(context, runtime.execPath);
    },
  };
}

/** The Pi sidecar beside the executable (Linux and macOS). */
function piSidecarPath(executable: string): string {
  return join(dirname(executable), "roamgate-pi");
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Swaps two files through a parked name; a missing side stays missing. */
function swap(current: string, previous: string): void {
  const parked = join(
    dirname(current),
    `.${basename(current)}.rollback-${process.pid}`,
  );
  const hadCurrent = exists(current);
  if (hadCurrent) renameSync(current, parked);
  if (exists(previous)) {
    try {
      renameSync(previous, current);
    } catch (error) {
      if (hadCurrent) renameSync(parked, current);
      throw error;
    }
  }
  if (hadCurrent) renameSync(parked, previous);
}

function regularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export const rollbackCommand: CliCommand = {
  name: "rollback",
  summary: "restore the executable replaced by the last update",
  help: rollbackHelp,
  async run(args, context) {
    if (wantsHelp(args)) {
      context.log(rollbackHelp());
      return EXIT_OK;
    }
    parseCommandArgs(args, {});
    const { runtime } = context;
    if (!isStandaloneBinary(runtime) || runtime.platform === "win32") {
      context.error(
        "roamgate rollback: only the standalone Linux and macOS binary can roll back.",
      );
      return EXIT_FAILURE;
    }
    const current = runtime.execPath;
    const previous = `${current}.previous`;
    if (!regularFile(current) || !regularFile(previous)) {
      context.error(`roamgate rollback: no previous executable at ${previous}`);
      return EXIT_FAILURE;
    }
    const probe = Bun.spawnSync([previous, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const previousVersion = probe.stdout.toString().trim();
    if (probe.exitCode !== 0 || !/^roamgate \S+$/.test(previousVersion)) {
      context.error(
        `roamgate rollback: ${previous} is not a working roamgate executable; nothing changed.`,
      );
      return EXIT_FAILURE;
    }
    // roamgate-pi and roamgate-pi.previous swap with the executables;
    // either may be missing, never something else.
    const pi = piSidecarPath(current);
    for (const path of [pi, `${pi}.previous`]) {
      if (exists(path) && !regularFile(path)) {
        context.error(
          `roamgate rollback: ${path} is not a regular file; nothing changed.`,
        );
        return EXIT_FAILURE;
      }
    }
    swap(current, previous);
    swap(pi, `${pi}.previous`);
    context.log(
      `Rolled back roamgate ${context.version} -> ${previousVersion.slice("roamgate ".length)}.`,
    );
    context.log("Run `roamgate rollback` again to undo.");
    return restartServiceUsing(context, current);
  },
};
