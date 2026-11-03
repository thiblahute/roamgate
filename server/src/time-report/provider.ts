import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuiTimeReportSettings } from "../config/gui-settings";

/**
 * Runs the time-report provider (docs/time-report.md): the configured
 * command with the operation appended, a JSON body on stdin, one JSON
 * document on stdout. One process per operation, from an empty directory,
 * killed at `timeout_seconds`. Never retried here: a timed out `submit` is
 * previewed again by the user.
 */
export type ProviderResult = {
  /** Parsed stdout; null when it was empty or not JSON. */
  value: unknown;
};

/** A failed run: the provider's `{error, code}`, or what went wrong. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode: number | null,
    /** stdout of a failed run, for `submit`'s partial SubmitResult. */
    readonly partial: unknown = null,
  ) {
    super(message);
  }
}

export type Spawn = (
  argv: string[],
  options: { cwd: string; stdin: string; timeoutMs: number },
) => Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}>;

const OUTPUT_LIMIT = 16 * 1024 * 1024;

const EXIT_CODES: Record<number, string> = {
  1: "error",
  2: "invalid",
  3: "not_found",
  4: "conflict",
  5: "forbidden",
  6: "upstream",
};

async function readLimited(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return "";
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > OUTPUT_LIMIT)
      throw new ProviderError("The provider printed too much.", "error", null);
  }
  return text + decoder.decode();
}

export const spawnProvider: Spawn = async (argv, options) => {
  // Its own process group, so a timeout ends whatever it started too.
  const grouped = process.platform !== "win32";
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: grouped,
  });
  const kill = () => {
    try {
      if (grouped) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      kill();
      resolve("timeout");
    }, options.timeoutMs);
  });
  try {
    child.stdin.write(options.stdin);
    await child.stdin.end();
  } catch {
    // A provider that does not read stdin closed it: its exit tells.
  }
  const done = Promise.all([
    readLimited(child.stdout),
    readLimited(child.stderr),
    child.exited,
  ]);
  try {
    const outcome = await Promise.race([done, deadline]);
    if (outcome === "timeout") {
      // Pipes a grandchild still holds are not waited for.
      done.catch(() => undefined);
      return { code: null, stdout: "", stderr: "", timedOut: true };
    }
    const [stdout, stderr, code] = outcome;
    return { code, stdout, stderr, timedOut };
  } catch (error) {
    kill();
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** The provider's error from stderr, when it printed one. */
function providerError(
  stderr: string,
): { error: string; code?: string } | null {
  const lines = stderr.trim().split("\n").reverse();
  for (const line of lines) {
    const value = parseJson(line);
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { error?: unknown }).error === "string"
    )
      return value as { error: string; code?: string };
  }
  return null;
}

export async function runProvider(
  settings: GuiTimeReportSettings,
  args: readonly string[],
  stdin: unknown,
  spawn: Spawn = spawnProvider,
): Promise<unknown> {
  const cwd = await mkdtemp(join(tmpdir(), "roamgate-time-report-"));
  try {
    const result = await spawn([...settings.command, ...args], {
      cwd,
      stdin: stdin === undefined ? "" : JSON.stringify(stdin),
      timeoutMs: settings.timeout_seconds * 1000,
    });
    if (result.timedOut)
      throw new ProviderError(
        `The provider did not answer within ${settings.timeout_seconds} seconds.`,
        "timeout",
        null,
      );
    if (result.code !== 0) {
      const error = providerError(result.stderr);
      const code =
        error?.code ??
        (result.code === null ? "error" : (EXIT_CODES[result.code] ?? "error"));
      throw new ProviderError(
        error?.error ??
          (result.stderr.trim().split("\n").at(-1)?.slice(0, 500) ||
            `The provider exited with ${result.code}.`),
        code,
        result.code,
        parseJson(result.stdout),
      );
    }
    const value = parseJson(result.stdout);
    if (value === null)
      throw new ProviderError(
        "The provider printed no JSON.",
        "error",
        result.code,
      );
    return value;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const message =
      (error as NodeJS.ErrnoException)?.code === "ENOENT"
        ? `The provider command was not found: ${settings.command[0]}`
        : `The provider could not run: ${(error as Error).message}`;
    throw new ProviderError(message, "error", null);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
