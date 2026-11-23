/**
 * The CLI pass-through (contract/wire/core-channel.md): a command of a
 * family the owners table gives to Rust runs in the core binary, with the
 * same arguments, its output going through the CLI's own.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dataRoot } from "../config/data-paths";
import { isStandaloneBinary } from "../config/standalone";
import { readOwners } from "./owners";
import { cliFamilyOf, FAMILIES, type Families } from "./protocol";

export type PassThroughContext = {
  version: string;
  runtime: {
    platform: string;
    homeDir: string;
    appDataDir?: string;
    execPath: string;
    argv: readonly string[];
    env: Record<string, string | undefined>;
  };
  log: (message: string) => void;
  error: (message: string) => void;
};

export type RunCore = (
  argv: string[],
  env: Record<string, string | undefined>,
  output: { out: (line: string) => void; err: (line: string) => void },
) => Promise<number>;

/** Forwards a stream's lines; the last one even without its newline. */
async function forwardLines(
  stream: ReadableStream<Uint8Array>,
  line: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      line(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer) line(buffer);
}

const defaultRunCore: RunCore = async (argv, env, output) => {
  const child = Bun.spawn(argv, {
    env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  await Promise.all([
    forwardLines(child.stdout, output.out),
    forwardLines(child.stderr, output.err),
  ]);
  return (await child.exited) ?? 1;
};

/**
 * Runs `roamgate <command> <args>` in the core binary when the owners
 * table gives the command's family to Rust: its exit code, or null when
 * the Bun CLI runs it itself.
 */
export async function passThroughToCore(
  command: string,
  args: readonly string[],
  context: PassThroughContext,
  deps: { families?: Families; runCore?: RunCore } = {},
): Promise<number | null> {
  const family = cliFamilyOf(command, deps.families ?? FAMILIES);
  if (!family) return null;
  const { runtime } = context;
  const runtimeDir = join(
    dataRoot(runtime.homeDir, runtime.platform, runtime.appDataDir),
    "runtime",
  );
  const table = readOwners(runtimeDir);
  if (table.owners[family] !== "rust") return null;
  const bin = runtime.env.ROAMGATE_CORE_BIN || table.core;
  if (!bin || !existsSync(bin)) {
    context.error(
      `roamgate: the ${family} family is given to Rust, but no core binary was found (ROAMGATE_CORE_BIN, or the owners table's core); running ${command} here.`,
    );
    return null;
  }
  const env: Record<string, string | undefined> = {
    ...runtime.env,
    ROAMGATE_CLI_EXEC: runtime.execPath,
    ROAMGATE_CLI_VERSION: context.version,
    ROAMGATE_CLI_STANDALONE: isStandaloneBinary(runtime) ? "1" : "0",
  };
  delete env.ROAMGATE_CORE_BIN;
  return (deps.runCore ?? defaultRunCore)([bin, command, ...args], env, {
    out: context.log,
    err: context.error,
  });
}
