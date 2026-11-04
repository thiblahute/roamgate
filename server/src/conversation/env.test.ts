import { describe, expect, test } from "bun:test";
import { holderEnvChanges } from "./env";
import { headlessClaudeArgs, holderStartCommand } from "./headless";

/** What the holder does with the changes (see roamgate-hold's start). */
function applied(
  base: Record<string, string>,
  paneId?: string,
): Record<string, string> {
  const changes = holderEnvChanges(undefined, paneId);
  const env: Record<string, string> = {};
  for (const [name, alias] of Object.entries(changes.copy))
    if (base[name] !== undefined) env[alias] = base[name];
  for (const [name, value] of Object.entries(base))
    if (
      !changes.drop.includes(name) &&
      !changes.drop_prefixes.some((prefix) => name.startsWith(prefix))
    )
      env[name] = value;
  return { ...env, ...changes.set };
}

describe("headless environment", () => {
  test("drops outer Claude and Herdr hook variables, marks itself, keeps checkpoints", () => {
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
        HERDR_WORKSPACE_ID: "w1",
        ANTHROPIC_API_KEY: "sk",
        ANTHROPIC_AUTH_TOKEN: "t",
        CLAUDE_CONFIG_DIR: "/c",
      }),
    ).toEqual({
      PATH: "/bin",
      HOME: "/h",
      LANG: "C",
      TERM: "xterm",
      // Herdr's hook must not claim the pane: Roamgate reports it.
      HERDR_WORKSPACE_ID: "w1",
      // The review client still tells its pane and Herdr server.
      ROAMGATE_PANE_ID: "p1",
      ROAMGATE_HERDR_SOCKET_PATH: "/s",
      // Claude Code uses it in the terminal too, without asking.
      ANTHROPIC_AUTH_TOKEN: "t",
      CLAUDE_CONFIG_DIR: "/c",
      ROAMGATE_HEADLESS: "1",
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "1",
    });
  });
});

describe("the pane, under Roamgate's names", () => {
  test("is set from the start command too, for a holder that does not copy", () => {
    expect(applied({ PATH: "/bin" }, "w1:p1")).toMatchObject({
      ROAMGATE_PANE_ID: "w1:p1",
    });
    expect(
      holderStartCommand({ sessionId: "s", cwd: "/w", paneId: "w1:p1" }).set,
    ).toMatchObject({ ROAMGATE_PANE_ID: "w1:p1" });
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
      "--prompt-suggestions",
      "true",
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
      set: {
        ROAMGATE_HEADLESS: "1",
        CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "1",
      },
    });
    expect(command.drop_prefixes).not.toContain("HERDR_");
  });

  test("the API key goes as Claude Code's answer says (an older holder drops it)", () => {
    const command = holderStartCommand({ sessionId: "abc-1", cwd: "/w" });
    expect(command.drop).toContain("ANTHROPIC_API_KEY");
    expect(command.api_key).toEqual({ policy: "claude_config" });
    expect(
      holderStartCommand({
        sessionId: "abc-1",
        cwd: "/w",
        apiKeyAnswer: "approve",
      }).api_key,
    ).toEqual({ policy: "claude_config", answer: "approve" });
  });

  test("it keeps the flags the pane's claude ran with (model, mode, directories)", () => {
    const command = holderStartCommand({
      sessionId: "abc-1",
      cwd: "/w",
      flags: [
        "--model",
        "haiku",
        "--permission-mode",
        "plan",
        "--add-dir",
        "/a",
        "/b",
        "--ide",
        "--verbose",
      ],
    });
    expect(command.argv).toEqual([
      "claude",
      "--model",
      "haiku",
      "--permission-mode",
      "plan",
      "--add-dir",
      "/a",
      "/b",
      ...headlessClaudeArgs("abc-1"),
    ]);
  });
});
