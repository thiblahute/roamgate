import { randomUUID } from "node:crypto";
import type { AgentChatEvent, AgentChatShell } from "../../../shared/agentChat";
import {
  BASH_OUTPUT_LIMIT,
  bashModeTexts,
  truncateBashOutput,
} from "../../../shared/bashMode";
import type { ShellRun, ShellRunner } from "./shell";

const MAX_SHELLS = 20;

/**
 * The `!` lines typed in conversation-mode chats (Claude Code's bash
 * mode): run on the pane's host, their output streamed to the chat, and
 * given to Claude with the next message.
 */
export function createChatShells(deps: {
  /** Runs a line on the pane's host; none: they are refused. */
  runShell?: ShellRunner;
  /**
   * The directory of the session conversation mode owns in the pane;
   * throws when it owns none.
   */
  cwdOf: (paneId: string) => string;
  emit: (paneId: string, event: AgentChatEvent) => void;
  log: (message: string, fields?: Record<string, unknown>) => void;
}) {
  const { emit, log } = deps;
  // The `!` lines of each pane that Claude has not read yet, and the runs
  // of those still running.
  const shells = new Map<string, AgentChatShell[]>();
  const shellRuns = new Map<string, ShellRun>();
  const shellTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // What each one printed, a little past the cap: what Claude reads is cut
  // from it, saying how many lines were left out.
  const shellOutput = new Map<string, { stdout: string; stderr: string }>();

  /** A `!` line's progress to the browsers: output at most every 100 ms. */
  function emitShell(paneId: string, shell: AgentChatShell, now = false) {
    const timer = shellTimers.get(shell.id);
    if (!now) {
      if (timer) return;
      shellTimers.set(
        shell.id,
        setTimeout(() => {
          shellTimers.delete(shell.id);
          emit(paneId, { type: "shell", shell: { ...shell } });
        }, 100),
      );
      return;
    }
    if (timer) clearTimeout(timer);
    shellTimers.delete(shell.id);
    emit(paneId, { type: "shell", shell: { ...shell } });
  }

  /**
   * The `!` lines done since the last message, for the next one, as Claude
   * Code's bash mode gives them to Claude: each stream cut at its cap.
   */
  function takeShells(paneId: string) {
    const done = (shells.get(paneId) ?? []).filter(
      (each) => each.status !== "running",
    );
    if (!done.length) return null;
    return {
      texts: done.flatMap((each) => {
        const printed = shellOutput.get(each.id) ?? each;
        return bashModeTexts({
          command: each.command,
          stdout: truncateBashOutput(printed.stdout).text,
          stderr: truncateBashOutput(
            each.error ? `${printed.stderr}${each.error}` : printed.stderr,
          ).text,
        });
      }),
      commit() {
        const sent = new Set(done.map((each) => each.id));
        for (const id of sent) shellOutput.delete(id);
        shells.set(
          paneId,
          (shells.get(paneId) ?? []).filter((each) => !sent.has(each.id)),
        );
        for (const each of done)
          emitShell(paneId, { ...each, delivered: true }, true);
      },
    };
  }

  /**
   * Runs a `!` line typed in the chat (Claude Code's bash mode) on the
   * pane's host, in the session's directory: its output streams to the
   * chat, and Claude reads it with the next message.
   */
  function runShell(paneId: string, input: { command: string; id?: string }) {
    if (!deps.runShell)
      throw new Error("Shell lines are unavailable on this connection");
    const cwd = deps.cwdOf(paneId);
    const list = shells.get(paneId) ?? [];
    if (input.id && list.some((each) => each.id === input.id))
      return { id: input.id };
    if (list.length >= MAX_SHELLS)
      throw new Error(
        `${MAX_SHELLS} commands wait for Claude: send a message first`,
      );
    const shell: AgentChatShell = {
      id: input.id ?? randomUUID(),
      command: input.command,
      status: "running",
      stdout: "",
      stderr: "",
      truncated: false,
      exit_code: null,
      cwd,
      started_at: new Date().toISOString(),
    };
    shells.set(paneId, [...list, shell]);
    emitShell(paneId, shell, true);
    let run: ShellRun;
    try {
      run = deps.runShell({
        cwd,
        command: input.command,
        onOutput: (output) => {
          shellOutput.set(shell.id, {
            stdout: output.stdout,
            stderr: output.stderr,
          });
          shell.stdout = output.stdout.slice(0, BASH_OUTPUT_LIMIT);
          shell.stderr = output.stderr.slice(0, BASH_OUTPUT_LIMIT);
          shell.truncated =
            output.truncated ||
            output.stdout.length > BASH_OUTPUT_LIMIT ||
            output.stderr.length > BASH_OUTPUT_LIMIT;
          emitShell(paneId, shell);
        },
      });
    } catch (error) {
      finishShell(paneId, shell, "failed", null, error);
      return { id: shell.id };
    }
    shellRuns.set(shell.id, run);
    void run.done.then(
      ({ code, stopped }) =>
        finishShell(paneId, shell, stopped ? "stopped" : "done", code),
      (error: unknown) => finishShell(paneId, shell, "failed", null, error),
    );
    return { id: shell.id };
  }

  function finishShell(
    paneId: string,
    shell: AgentChatShell,
    status: AgentChatShell["status"],
    code: number | null,
    error?: unknown,
  ) {
    shellRuns.delete(shell.id);
    shell.status = status;
    shell.exit_code = code;
    shell.finished_at = new Date().toISOString();
    if (error !== undefined)
      shell.error =
        error instanceof Error ? error.message : "The command could not run";
    log("shell line ended", { pane: paneId, status, code });
    emitShell(paneId, shell, true);
  }

  function stopShell(paneId: string, id: string) {
    const run = shellRuns.get(id);
    if (!run || !shells.get(paneId)?.some((each) => each.id === id))
      return false;
    run.stop();
    return true;
  }

  return {
    run: runShell,
    stop: stopShell,
    take: takeShells,
    /** The pane's lines Claude has not read yet, copies. */
    list: (paneId: string): AgentChatShell[] =>
      (shells.get(paneId) ?? []).map((each) => ({ ...each })),
    /** Whether one of the pane's lines still runs. */
    running: (paneId: string) =>
      (shells.get(paneId) ?? []).some((shell) => shell.status === "running"),
    /** The connection closes: its `!` lines end with it. */
    dispose() {
      for (const run of shellRuns.values()) run.stop();
      for (const timer of shellTimers.values()) clearTimeout(timer);
    },
  };
}
