import {
  GAMING_HOLDER,
  LOW_GPU_PROFILE,
  type LowGpuStatus,
} from "../../../shared/voiceLowGpu";
import {
  formatBytes,
  VOICE_COMPONENTS,
  type VoiceChoices,
  type VoiceComponent,
} from "../../../shared/voiceSetup";
import { dataRoot } from "../config/data-paths";
import { readVoiceConfig, voiceConfigPath } from "../voice/voice-helper";
import {
  holdLowGpu,
  isHolderName,
  lowGpuPath,
  setLowGpuModels,
  VoiceLowGpu,
} from "../voice/voice-low-gpu";
import { defaultModelsDir } from "../voice/voice-models";
import {
  type CliCommand,
  type CliContext,
  displayPath,
  EXIT_OK,
  parseCommandArgs,
  printJson,
  UsageError,
  wantsHelp,
} from "./command";

const HELP = `Usage: roamgate voice profile low-gpu on|off|status|models [options]
       roamgate voice gaming on|off|status [options]

The low-GPU profile: while it is on, the voice helper starts with a lighter
set of models, leaving the GPU to a game or another job: the setup
assistant's light tier among the models already here (Parakeet without
Whisper reading again, Kokoro reading on the CPU, the speaker and turn
models). voice.json is not changed. A helper running with the other set
switches once the call or listening it serves ends, or at once with --now
(the call goes on after a short notice and a few seconds' gap).

It is on while someone holds it, or while GameMode (gamemoded) runs as a
call starts. \`gaming\` is \`profile low-gpu --by gaming\`.

Actions:
  on              hold it on (as --by, "manual" by default)
  off             let it go (as --by; without --by, every holder)
  status          who holds it, and the models it uses
  models [PART=ID ...]
                  set parts of its set by hand (the ids \`roamgate setup
                  voice list\` shows; PART is ${VOICE_COMPONENTS.join(", ")});
                  --reset goes back to the light tier

Options:
  --by NAME       who holds it: a game hook, a job ("gaming", "render")
  --now           switch a call going on now, not when it ends
  --reset         with models: the light tier for every part
  --json          status as JSON

The state is kept in low-gpu.json in the voice data directory
(~/.local/share/roamgate/voice), which the running server follows.
`;

type VoicePaths = { path: string; configPath: string; modelsDir: string };

function pathsFor(context: CliContext): VoicePaths {
  const { homeDir, platform, appDataDir } = context.runtime;
  return {
    path: lowGpuPath(homeDir, platform, appDataDir),
    configPath: voiceConfigPath(dataRoot(homeDir, platform, appDataDir)),
    modelsDir: defaultModelsDir(homeDir, platform, appDataDir),
  };
}

/** The status as this process sees it: no helper of its own. */
export function lowGpuStatus(paths: VoicePaths): LowGpuStatus {
  return new VoiceLowGpu({
    path: paths.path,
    readConfig: () => readVoiceConfig(paths.configPath),
    modelsDir: paths.modelsDir,
    helper: {
      runningProfile: () => null,
      reloadModels: () => "not-running",
      reloadModelsAndWait: async () => "not-running",
      restartModels: () => false,
      currentCallId: () => undefined,
      speakInCall: async () => {
        throw new Error("no helper");
      },
    },
  }).status();
}

function printStatus(status: LowGpuStatus, context: CliContext, json: boolean) {
  if (json) {
    printJson(context, status);
    return;
  }
  context.log(
    status.active
      ? `Low-GPU voice: on, for ${status.holders.join(", ")}`
      : "Low-GPU voice: off",
  );
  context.log(
    `(GameMode running as a call starts turns it on too; the server says what the running helper has.)`,
  );
  if (status.error) context.log(`Its models cannot be chosen: ${status.error}`);
  else {
    context.log(
      `Its models (about ${formatBytes(status.gpuBytes)} of GPU memory):`,
    );
    for (const model of status.models)
      context.log(
        `  ${model.title}: ${model.name}${model.runsOn === "none" ? "" : ` (${model.runsOn === "any" ? "CPU or GPU" : model.runsOn.toUpperCase()})`}`,
      );
  }
  if (Object.keys(status.overrides).length)
    context.log(
      `Set by hand: ${Object.entries(status.overrides)
        .map(([part, id]) => `${part}=${id}`)
        .join(" ")}`,
    );
  context.log(`State: ${displayPath(status.path, context.runtime)}`);
}

function parseModels(words: string[]): VoiceChoices {
  const models: VoiceChoices = {};
  for (const word of words) {
    const [part, id] = word.split("=", 2);
    const component = part?.replace(/-/g, "_") as VoiceComponent;
    if (!id || !(VOICE_COMPONENTS as readonly string[]).includes(component))
      throw new UsageError(
        `${word}: PART=ID, PART one of ${VOICE_COMPONENTS.join(", ")}`,
      );
    models[component] = id;
  }
  return models;
}

/** on, off, status, models for `holder` (undefined: as --by says). */
async function runProfile(
  args: string[],
  context: CliContext,
  holder?: string,
): Promise<number> {
  const action = args[0];
  const { values, positionals } = parseCommandArgs(
    args.slice(1),
    {
      by: { type: "string" },
      now: { type: "boolean" },
      reset: { type: "boolean" },
      json: { type: "boolean" },
    },
    action === "models" ? 32 : 0,
  );
  const by = holder ?? values.by;
  if (by !== undefined && !isHolderName(by))
    throw new UsageError(
      `--by ${by}: letters, digits, dots, dashes or underscores`,
    );
  const paths = pathsFor(context);
  switch (action) {
    case "on":
    case "off": {
      const file = holdLowGpu(paths.path, {
        on: action === "on",
        ...(by === undefined ? {} : { holder: by }),
        now: values.now === true,
      });
      const holders = Object.keys(file.holders);
      context.log(
        holders.length
          ? `Low-GPU voice: on, for ${holders.join(", ")}`
          : "Low-GPU voice: off (unless GameMode runs as a call starts)",
      );
      context.log(
        values.now
          ? "A call going on switches now, after a short notice."
          : "A call going on switches when it ends.",
      );
      return EXIT_OK;
    }
    case "status":
    case undefined:
      printStatus(lowGpuStatus(paths), context, values.json === true);
      return EXIT_OK;
    case "models": {
      if (values.reset && positionals.length)
        throw new UsageError("--reset or PART=ID, not both");
      if (!values.reset && !positionals.length)
        throw new UsageError("models: PART=ID ..., or --reset");
      try {
        setLowGpuModels(
          paths.path,
          values.reset ? null : parseModels(positionals),
        );
      } catch (error) {
        if (error instanceof UsageError) throw error;
        throw new UsageError((error as Error).message);
      }
      printStatus(lowGpuStatus(paths), context, values.json === true);
      return EXIT_OK;
    }
    default:
      throw new UsageError(`unknown action: ${action}`);
  }
}

export function createVoiceCommand(): CliCommand {
  return {
    name: "voice",
    summary: "voice profiles: the low-GPU set while a game runs",
    actions: ["profile", "gaming"],
    flags: ["--by", "--now", "--reset", "--json"],
    help: () => HELP,
    async run(args, context) {
      if (wantsHelp(args)) {
        context.log(HELP);
        return EXIT_OK;
      }
      if (args[0] === "gaming")
        return runProfile(args.slice(1), context, GAMING_HOLDER);
      if (args[0] === "profile") {
        if (args[1] !== LOW_GPU_PROFILE)
          throw new UsageError(
            args[1]
              ? `unknown voice profile: ${args[1]} (there is ${LOW_GPU_PROFILE})`
              : `which profile: ${LOW_GPU_PROFILE}`,
          );
        return runProfile(args.slice(2), context);
      }
      throw new UsageError(
        args[0] ? `unknown voice command: ${args[0]}` : "profile or gaming",
      );
    },
  };
}
