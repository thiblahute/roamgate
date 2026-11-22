import { createInterface } from "node:readline/promises";
import {
  CUSTOM_MODEL,
  formatBytes,
  NO_MODEL,
  requirementHolds,
  startingChoices,
  VOICE_COMPONENTS,
  type VoiceChoices,
  type VoiceComponent,
  type VoiceHardware,
  type VoiceSetupJob,
  type VoiceSetupState,
  type VoiceTier,
} from "../../../shared/voiceSetup";
import { dataRoot } from "../config/data-paths";
import { detectHardware, systemProbe } from "../voice/voice-hardware";
import { voiceConfigPath } from "../voice/voice-helper";
import {
  defaultHelperPath,
  defaultModelsDir,
  normalizeChoices,
} from "../voice/voice-models";
import {
  installVoiceModels,
  removeUnusedModels,
  setupPlan,
  type VoiceSetupDeps,
  voiceSetupState,
} from "../voice/voice-setup";
import {
  type CliCommand,
  type CliContext,
  displayPath,
  EXIT_FAILURE,
  EXIT_OK,
  parseCommandArgs,
  printJson,
  UsageError,
  wantsHelp,
} from "./command";

const FLAG_OF: Record<VoiceComponent, string> = {
  speech: "speech",
  reread: "reread",
  tts: "tts",
  stock_voices: "stock-voices",
  speaker: "speaker",
  turn: "turn",
  text_turn: "text-turn",
};

const HELP = `Usage: roamgate setup voice [list | remove-unused] [options]

Set up voice chat's models: detect the GPU, memory and CPU, propose models
for each part of the voice helper, download them (resumed, checksums
checked) into the models directory and point voice.json at them. Run it
again to change a model, switch tier, or free disk.

Actions:
  (none)            choose the models, download them, write voice.json
  list              show the hardware, the models and what is installed
  remove-unused     delete the models in the models directory voice.json
                    no longer uses, and unfinished downloads

Options:
  --tier heavy|light   start from this tier's models (default: the
                       hardware's, keeping what voice.json uses)
  --speech ID          speech recognition
  --reread ID|none     Whisper reading Parakeet's English again
  --tts ID             the reading voice
  --stock-voices ID|none
  --speaker ID|none    who speaks
  --turn ID|none       end of turn, from the voice
  --text-turn ID|none  end of turn, from the words
  --helper PATH        the voice helper voice.json names
  --verify             check the checksums of files already in place
  --yes, -y            no questions: the choices as given
  --json               list as JSON

\`roamgate setup voice list\` shows each part's model ids.`;

export type SetupCommandDeps = {
  /** The hardware, detected on this machine by default. */
  hardware?: () => VoiceHardware;
  /** Asks a question on the terminal; null when there is no terminal. */
  ask?: ((question: string) => Promise<string>) | null;
  /** Overrides for tests: the catalog, fetch, free space. */
  setup?: Partial<VoiceSetupDeps>;
};

function terminalAsk(): ((question: string) => Promise<string>) | null {
  if (!process.stdin.isTTY) return null;
  return async (question) => {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await prompt.question(question);
    } finally {
      prompt.close();
    }
  };
}

function setupDeps(
  context: CliContext,
  deps: SetupCommandDeps,
): VoiceSetupDeps {
  const { homeDir, platform, appDataDir } = context.runtime;
  return {
    hardware: deps.hardware ?? (() => detectHardware(systemProbe())),
    modelsDir: defaultModelsDir(homeDir, platform, appDataDir),
    configPath: voiceConfigPath(dataRoot(homeDir, platform, appDataDir)),
    helperPath: defaultHelperPath(homeDir, platform, appDataDir),
    ...deps.setup,
  };
}

function describeHardware(hardware: VoiceHardware): string[] {
  const lines = [
    `System: ${hardware.osName ?? hardware.platform} (${hardware.arch})`,
    `CPU: ${hardware.cpu.model}, ${hardware.cpu.cores} threads`,
    `Memory: ${formatBytes(hardware.ramBytes)}`,
  ];
  for (const gpu of hardware.gpus)
    lines.push(
      `GPU: ${gpu.name}${gpu.vramBytes ? `, ${formatBytes(gpu.vramBytes)}${gpu.unifiedMemory ? " shared" : ""}` : ""}${gpu.computeCapability ? `, compute ${gpu.computeCapability}` : ""}`,
    );
  if (!hardware.gpus.length) lines.push("GPU: none found");
  lines.push(
    `Runs the GPU models with: ${hardware.acceleration === "cpu" ? "the CPU" : hardware.acceleration.toUpperCase()}`,
  );
  if (hardware.note) lines.push(hardware.note);
  return lines;
}

function optionLine(
  state: VoiceSetupState,
  component: VoiceComponent,
  id: string,
): string {
  if (id === NO_MODEL) return "none";
  if (id === CUSTOM_MODEL) return "as voice.json has it";
  const option = state.components
    .find((entry) => entry.id === component)
    ?.options.find((entry) => entry.id === id);
  return option ? `${option.name} (${formatBytes(option.sizeBytes)})` : id;
}

function listState(context: CliContext, state: VoiceSetupState) {
  for (const line of describeHardware(state.hardware)) context.log(line);
  context.log(`Proposed tier: ${state.tier}`);
  context.log(`Models: ${displayPath(state.modelsDir, context.runtime)}`);
  context.log(
    `Helper: ${displayPath(state.helper.path, context.runtime)}${state.helper.found ? "" : " (not found: build it with voice/helper/linux/build.sh, or cargo build --release in voice/helper)"}`,
  );
  if (state.freeBytes !== undefined)
    context.log(`Free disk: ${formatBytes(state.freeBytes)}`);
  if (state.configError) context.log(`voice.json: ${state.configError}`);
  for (const component of state.components) {
    context.log("");
    context.log(
      `${component.title} (--${FLAG_OF[component.id]}): ${component.description}`,
    );
    for (const option of component.options) {
      const marks = [
        state.current[component.id] === option.id ? "in use" : "",
        state.recommended.heavy[component.id] === option.id ? "heavy" : "",
        state.recommended.light[component.id] === option.id ? "light" : "",
        option.installed ? "downloaded" : "",
      ].filter(Boolean);
      context.log(
        `  ${option.id.padEnd(24)} ${option.name}, ${formatBytes(option.sizeBytes)}, ${option.runsOn === "any" ? "GPU or CPU" : option.runsOn.toUpperCase()}${marks.length ? ` [${marks.join(", ")}]` : ""}`,
      );
      context.log(`  ${"".padEnd(24)} ${option.speed}`);
    }
    if (component.optional) context.log(`  ${"none".padEnd(24)} without it`);
  }
  if (state.unused.length) {
    context.log("");
    context.log("Unused (roamgate setup voice remove-unused):");
    for (const model of state.unused)
      context.log(
        `  ${model.name}, ${formatBytes(model.sizeBytes)}: ${displayPath(model.path, context.runtime)}`,
      );
  }
}

/** Asks each part's model, Enter keeping the one proposed. */
async function askChoices(
  context: CliContext,
  state: VoiceSetupState,
  choices: VoiceChoices,
  ask: (question: string) => Promise<string>,
): Promise<VoiceChoices> {
  let chosen = { ...choices };
  for (const component of state.components) {
    chosen = normalizeChoices(chosen);
    const proposed = chosen[component.id];
    if (!requirementHolds(component.requires, chosen)) continue;
    const options = component.options.filter((option) =>
      requirementHolds(option.requires, chosen),
    );
    const ids = [
      ...options.map((option) => option.id),
      ...(component.optional ? [NO_MODEL] : []),
      ...(proposed === CUSTOM_MODEL ? [CUSTOM_MODEL] : []),
    ];
    context.log("");
    context.log(`${component.title}: ${component.description}`);
    ids.forEach((id, index) => {
      const option = options.find((entry) => entry.id === id);
      const detail = option
        ? `${option.speed}${option.installed ? ", downloaded" : ""}`
        : "";
      context.log(
        `  ${index + 1}. ${optionLine(state, component.id, id)}${detail ? `: ${detail}` : ""}${id === proposed ? "  <-" : ""}`,
      );
    });
    for (let tries = 0; tries < 5; tries += 1) {
      const answer = (
        await ask(`Choice [${Math.max(1, ids.indexOf(proposed ?? "") + 1)}]: `)
      ).trim();
      if (!answer) break;
      const picked = ids[Number(answer) - 1] ?? ids.find((id) => id === answer);
      if (picked) {
        chosen[component.id] = picked;
        break;
      }
      context.log(`  1 to ${ids.length}, or Enter to keep it.`);
    }
  }
  return normalizeChoices(chosen);
}

function progressLine(job: VoiceSetupJob): string {
  const percent = job.totalBytes
    ? Math.floor((job.doneBytes * 100) / job.totalBytes)
    : 100;
  const speed = job.bytesPerSecond
    ? `, ${formatBytes(job.bytesPerSecond)}/s`
    : "";
  return `${percent}% of ${formatBytes(job.totalBytes)}${speed}${job.current ? `: ${job.current}` : ""}`;
}

async function runSetup(
  args: string[],
  context: CliContext,
  deps: SetupCommandDeps,
): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    args,
    {
      tier: { type: "string" },
      speech: { type: "string" },
      reread: { type: "string" },
      tts: { type: "string" },
      "stock-voices": { type: "string" },
      speaker: { type: "string" },
      turn: { type: "string" },
      "text-turn": { type: "string" },
      helper: { type: "string" },
      verify: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      json: { type: "boolean" },
    },
    1,
  );
  const action = positionals[0];
  if (action !== undefined && action !== "list" && action !== "remove-unused")
    throw new UsageError(`unknown action: ${action}`);
  if (
    values.tier !== undefined &&
    values.tier !== "heavy" &&
    values.tier !== "light"
  )
    throw new UsageError("--tier is heavy or light");
  const setup = setupDeps(context, deps);
  const state = voiceSetupState(setup);

  if (action === "list") {
    if (values.json) printJson(context, state);
    else listState(context, state);
    return EXIT_OK;
  }
  if (action === "remove-unused") {
    if (!state.unused.length) {
      context.log("Nothing unused in the models directory.");
      return EXIT_OK;
    }
    for (const model of state.unused)
      context.log(
        `${model.name}, ${formatBytes(model.sizeBytes)}: ${displayPath(model.path, context.runtime)}`,
      );
    const ask = deps.ask === undefined ? terminalAsk() : deps.ask;
    if (!values.yes) {
      if (!ask) throw new UsageError("--yes is needed without a terminal");
      if (!/^y(es)?$/i.test((await ask("Delete them? [y/N] ")).trim()))
        return EXIT_OK;
    }
    const { freedBytes } = removeUnusedModels("all", setup);
    context.log(`Freed ${formatBytes(freedBytes)}.`);
    return EXIT_OK;
  }

  for (const line of describeHardware(state.hardware)) context.log(line);
  let choices = startingChoices(state, values.tier as VoiceTier | undefined);
  for (const component of VOICE_COMPONENTS) {
    const value = values[FLAG_OF[component] as keyof typeof values];
    if (typeof value === "string") choices[component] = value;
  }
  try {
    choices = normalizeChoices(choices);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const ask = deps.ask === undefined ? terminalAsk() : deps.ask;
  if (!values.yes && ask) {
    context.log(
      `\nProposed: the ${values.tier ?? state.tier} tier. Enter keeps each choice.`,
    );
    choices = await askChoices(context, state, choices, ask);
  }
  const plan = setupPlan(choices, setup);
  const total = plan.downloads.reduce((sum, file) => sum + file.size, 0);
  context.log("");
  for (const component of state.components)
    if (choices[component.id] !== undefined)
      context.log(
        `${component.title}: ${optionLine(state, component.id, choices[component.id] as string)}`,
      );
  context.log(
    total
      ? `To download: ${formatBytes(total)} into ${displayPath(setup.modelsDir, context.runtime)}`
      : "Everything is downloaded already.",
  );
  if (!values.yes) {
    if (!ask) throw new UsageError("--yes is needed without a terminal");
    const answer = (
      await ask(
        total
          ? "Download and write voice.json? [Y/n] "
          : "Write voice.json? [Y/n] ",
      )
    ).trim();
    if (/^n(o)?$/i.test(answer)) return EXIT_OK;
  }
  let lastLine = 0;
  let lastPercent = -1;
  const abort = new AbortController();
  const onSignal = () => abort.abort(new Error("interrupted"));
  process.once("SIGINT", onSignal);
  try {
    const { patch } = await installVoiceModels(choices, setup, {
      signal: abort.signal,
      verify: values.verify === true,
      ...(values.helper ? { helper: values.helper } : {}),
      onProgress: (job) => {
        if (job.state !== "downloading" || !job.totalBytes) return;
        const percent = Math.floor((job.doneBytes * 100) / job.totalBytes);
        const now = Date.now();
        if (
          percent !== lastPercent &&
          (now - lastLine >= 2000 || percent === 100)
        ) {
          lastLine = now;
          lastPercent = percent;
          context.log(progressLine(job));
        }
      },
    });
    context.log(
      `Wrote ${displayPath(setup.configPath, context.runtime)}: ${Object.keys(patch).join(", ") || "nothing changed"}.`,
    );
  } catch (error) {
    if (abort.signal.aborted) {
      context.error(
        "Stopped: run it again to resume where the download stopped.",
      );
      return EXIT_FAILURE;
    }
    throw error;
  } finally {
    process.off("SIGINT", onSignal);
  }
  const after = voiceSetupState(setup);
  if (!after.helper.found)
    context.log(
      `The voice helper is not at ${displayPath(after.helper.path, context.runtime)} yet: build it (voice/helper/linux/build.sh on Linux) and install it there, or pass --helper.`,
    );
  context.log(
    "A running voice helper keeps the models it loaded until it stops: `roamgate service restart` loads the new ones now.",
  );
  if (after.unused.length)
    context.log(
      `${after.unused.length} unused model(s), ${formatBytes(after.unused.reduce((sum, model) => sum + model.sizeBytes, 0))}: \`roamgate setup voice remove-unused\` frees them.`,
    );
  return EXIT_OK;
}

export function createSetupCommand(deps: SetupCommandDeps = {}): CliCommand {
  return {
    name: "setup",
    summary: "set up voice chat: detect the hardware, download its models",
    actions: ["voice"],
    flags: [
      "--tier",
      ...VOICE_COMPONENTS.map((component) => `--${FLAG_OF[component]}`),
      "--helper",
      "--verify",
      "--yes",
      "--json",
    ],
    help: () => HELP,
    async run(args, context) {
      if (wantsHelp(args)) {
        context.log(HELP);
        return EXIT_OK;
      }
      if (args[0] !== "voice")
        throw new UsageError(
          args[0] ? `unknown setup: ${args[0]}` : "what to set up: voice",
        );
      return runSetup(args.slice(1), context, deps);
    },
  };
}
