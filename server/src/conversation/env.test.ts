import { describe, expect, test } from "bun:test";
import { holderEnvChanges } from "./env";
import { headlessClaudeArgs, holderStartCommand } from "./headless";

/** What the holder does with the changes (see roamgate-hold's start). */
function applied(base: Record<string, string>): Record<string, string> {
  const changes = holderEnvChanges();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base))
    if (
      !changes.drop.includes(name) &&
      !changes.drop_prefixes.some((prefix) => name.startsWith(prefix))
    )
      env[name] = value;
  return { ...env, ...changes.set };
}

describe("headless environment", () => {
  test("drops outer Claude, Herdr and API key variables and marks itself", () => {
    expect(
      applied({
        PATH: "/bin",
        HOME: "/h",
        LANG: "C",
        TERM: "xterm",
        CLAUDECODE: "1",
        CLAUDE_PID: "12",
        CLAUDE_EFFORT: "high",
        CLAUDE_CODE_SESSION_ID: "abc",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        HERDR_PANE_ID: "p1",
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: "/s",
        ANTHROPIC_API_KEY: "sk",
        ANTHROPIC_AUTH_TOKEN: "t",
        CLAUDE_CONFIG_DIR: "/c",
      }),
    ).toEqual({
      PATH: "/bin",
      HOME: "/h",
      LANG: "C",
      TERM: "xterm",
      // Its own pane's: Herdr learns the session from its hook.
      HERDR_PANE_ID: "p1",
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/s",
      CLAUDE_CONFIG_DIR: "/c",
      ROAMGATE_HEADLESS: "1",
    });
  });
});

describe("headless command", () => {
  test("streams both ways, replays user messages, asks over stdio", () => {
    expect(headlessClaudeArgs("abc-1")).toEqual([
      "-p",
      "--resume",
      "abc-1",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--replay-user-messages",
      "--permission-prompt-tool",
      "stdio",
    ]);
  });

  test("the holder runs it in the session's directory", () => {
    const command = holderStartCommand({
      sessionId: "abc-1",
      cwd: "/home/me/it's",
    });
    expect(command).toMatchObject({
      argv: ["claude", ...headlessClaudeArgs("abc-1")],
      cwd: "/home/me/it's",
      set: { ROAMGATE_HEADLESS: "1" },
    });
    expect(command.drop).toContain("ANTHROPIC_API_KEY");
    expect(command.drop_prefixes).not.toContain("HERDR_");
  });
});
