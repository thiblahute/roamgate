import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { sshCommandArgv, sshReadCommandArgv } from "../bridge/ssh-command";
import { gitShellCommandArgv } from "../workspace/git-shell";
import type { GlabContext } from "./gitlab";

/**
 * Running glab and gh on the checkout's host, and turning their API
 * answers into what the review reads: patches, commits and files.
 */

const TIMEOUT_MS = 30_000;

type Output = { code: number; stdout: string; stderr: string };

/** A removed checkout runs its command from home. */
function cwdOf(context: GlabContext): string {
  return existsSync(context.root) ? context.root : homedir();
}

/**
 * A forge CLI on the checkout's host, with `env` set and `unset` removed;
 * code 127 when it is not installed. Only a read may be `retrySafe`: a cold
 * SSH retry of a write could make it twice, such as a second pending
 * comment.
 */
export async function runForgeCli(
  context: GlabContext,
  argv: string[],
  options: {
    env: Record<string, string>;
    retrySafe: boolean;
    tag: string;
    unset?: readonly string[];
  },
): Promise<Output> {
  const { env, unset = [] } = options;
  if (context.host) {
    const without = unset.length
      ? `env ${unset.map((name) => `-u ${name}`).join(" ")} `
      : "";
    // `glab api` names its project: a removed checkout runs it from home.
    const command = `{ cd ${context.shQuote(context.root)} 2>/dev/null || cd; } && ${without}${Object.entries(
      env,
    )
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")} ${argv.map(context.shQuote).join(" ")}`;
    return context.runProcessWithCodeTimeout(
      options.retrySafe
        ? sshReadCommandArgv(context.host, command, [], options.tag)
        : sshCommandArgv(context.host, command, [], options.tag),
      TIMEOUT_MS,
    );
  }
  // A missing cwd fails the spawn with ENOENT too, as a missing CLI would.
  try {
    return await context.runProcessWithCodeTimeout(argv, TIMEOUT_MS, {
      cwd: cwdOf(context),
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !unset.includes(name)),
        ),
        ...env,
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { code: 127, stdout: "", stderr: "" };
    throw error;
  }
}

/** gh on the checkout's host (see runForgeCli for `retrySafe`). */
export function spawnGh(
  context: GlabContext,
  argv: string[],
  retrySafe: boolean,
): Promise<Output> {
  return runForgeCli(context, argv, {
    env: { GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
    retrySafe,
    tag: "forge.github",
  });
}

/** A read-only shell script on the checkout's host. */
export function runForgeScript(
  context: GlabContext,
  script: string,
  tag: string,
  options: { cwd?: boolean } = {},
): Promise<Output> {
  return context.runProcessWithCodeTimeout(
    context.host
      ? sshReadCommandArgv(context.host, script, [], tag)
      : gitShellCommandArgv(script),
    TIMEOUT_MS,
    context.host || !options.cwd ? undefined : { cwd: cwdOf(context) },
  );
}

/** The last lines of a failed CLI's output, for its error. */
export function cliError(forge: string, text: string): Error {
  const message = (text || `${forge} request failed`)
    .trim()
    .split("\n")
    .slice(-3)
    .join(" ")
    .slice(0, 300);
  return new Error(`${forge}: ${message}`);
}

/**
 * The JSON values printed back to back, as `glab api --paginate` and
 * `gh api --paginate` print their pages: each top-level array or object is
 * cut out by its brackets, skipping those inside strings, and parsed on its
 * own.
 */
export function parseJsonPages(text: string): unknown[] {
  const values: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      // A bare string or number on its own is not a page.
      if (depth === 0) return [JSON.parse(text)];
      inString = true;
    } else if (char === "[" || char === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (char === "]" || char === "}") {
      depth--;
      if (depth < 0) throw new Error("GitLab: malformed answer");
      if (depth === 0) values.push(JSON.parse(text.slice(start, i + 1)));
    } else if (depth === 0 && !/\s/.test(char)) return [JSON.parse(text)];
  }
  if (depth !== 0 || inString) throw new Error("GitLab: truncated answer");
  return values;
}

/** A changed file as a forge's API lists it; no patch when it is binary. */
export type ApiFile = {
  oldPath: string;
  newPath: string;
  added: boolean;
  deleted: boolean;
  patch?: string;
};

/** The files' changes as one unified patch. */
export function apiFilesPatch(files: ApiFile[]): string {
  return files
    .map((file) => {
      const header = `diff --git a/${file.oldPath} b/${file.newPath}`;
      if (file.patch === undefined)
        return [header, "Binary files differ"].join("\n");
      return [
        header,
        `--- ${file.added ? "/dev/null" : `a/${file.oldPath}`}`,
        `+++ ${file.deleted ? "/dev/null" : `b/${file.newPath}`}`,
        file.patch.replace(/\n$/, ""),
      ].join("\n");
    })
    .join("\n");
}

/** A commit message's subject and body. */
export function commitFromMessage(message: string): {
  subject: string;
  body: string;
} {
  const [subject = "", ...rest] = message.split("\n");
  return { subject, body: rest.join("\n").trim() };
}

/** A file's text from a forge's base64 `content`. */
export function base64File(forge: string, content: unknown): string {
  if (typeof content !== "string") throw new Error(`${forge} returned no file`);
  return Buffer.from(content, "base64").toString("utf8");
}
