import { isRecord } from "../agent/session-utils";

export type PaneProcess = {
  pid: number;
  argv?: string[];
  argv0?: string;
  cmdline?: string;
  cwd?: string;
};

export type PaneProcessInfo = {
  shell_pid?: number;
  foreground_process_group_id?: number;
  foreground_processes: PaneProcess[];
};

export type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";

/**
 * What a handover needs from Herdr and the host. Every call that changes
 * something in a pane is here, so tests drive a fake and nothing reaches a
 * real Herdr server.
 */
export type ConversationHerdr = {
  /** `agent.get` for the pane: its agent record, null when it has none. */
  agentGet(paneId: string): Promise<Record<string, unknown> | null>;
  /** The screen as Herdr's agent detection reads it. */
  readDetection(paneId: string): Promise<string>;
  processInfo(paneId: string): Promise<PaneProcessInfo>;
  /** Types the text and Enter into the agent (`agent.prompt`). */
  prompt(paneId: string, text: string): Promise<void>;
  /** Types the text into the pane's shell (`pane.send_text`). */
  sendText(paneId: string, text: string): Promise<void>;
  reportAgent(params: {
    paneId: string;
    state: HerdrAgentState;
    sessionId: string;
    message?: string;
  }): Promise<void>;
  releaseAgent(paneId: string): Promise<void>;
  /** Whether a pid still runs on the pane's host. */
  pidAlive(pid: number): Promise<boolean>;
  /**
   * Whether a headless claude resumed with one of these session ids runs
   * on the pane's host, whoever started it (an earlier Roamgate, an SSH
   * client that went away). Throws when the host cannot say.
   */
  headlessRunning(sessionIds: readonly string[]): Promise<boolean>;
  /** Whether the pane still exists (false once Herdr says not found). */
  paneExists(paneId: string): Promise<boolean>;
  /**
   * Another writer on these sessions, outside this pane, if any: a pane
   * Herdr maps to one of them (a `claude --continue`, the /resume picker),
   * or an interactive `claude --resume <id>` on the host (`exceptPids`
   * aside). Says which; throws when the host cannot say.
   */
  writerElsewhere(
    paneId: string,
    sessionIds: readonly string[],
    exceptPids?: readonly number[],
  ): Promise<string | null>;
};

export const HEADLESS_SOURCE = "roamgate:headless";

type HerdrCall = (
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * What a Herdr event means for conversation leases: a closed pane takes its
 * lease (and headless process) with it, and a closed tab or workspace sends
 * the service to look for leases whose pane is gone. Herdr spells event names
 * with dots in subscriptions and with underscores on the wire (`pane_closed`),
 * so both are accepted.
 */
export function conversationCloseEvent(
  event: unknown,
): { paneId: string } | "sweep" | null {
  if (!event || typeof event !== "object") return null;
  const name = (event as { event?: unknown }).event;
  if (typeof name !== "string") return null;
  const normalized = name.replace("_", ".");
  if (normalized === "pane.closed") {
    const paneId = (event as { data?: { pane_id?: unknown } }).data?.pane_id;
    return typeof paneId === "string" ? { paneId } : "sweep";
  }
  if (normalized === "tab.closed" || normalized === "workspace.closed")
    return "sweep";
  return null;
}

export function parseProcessInfo(result: unknown): PaneProcessInfo {
  const info =
    isRecord(result) && isRecord(result.process_info)
      ? result.process_info
      : isRecord(result)
        ? result
        : {};
  const processes = Array.isArray(info.foreground_processes)
    ? info.foreground_processes.flatMap((item): PaneProcess[] => {
        if (!isRecord(item) || typeof item.pid !== "number") return [];
        return [
          {
            pid: item.pid,
            ...(Array.isArray(item.argv)
              ? { argv: item.argv.filter((part) => typeof part === "string") }
              : {}),
            ...(typeof item.argv0 === "string" ? { argv0: item.argv0 } : {}),
            ...(typeof item.cmdline === "string"
              ? { cmdline: item.cmdline }
              : {}),
            ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
          },
        ];
      })
    : [];
  return {
    shell_pid: numberOr(info.shell_pid),
    foreground_process_group_id: numberOr(info.foreground_process_group_id),
    foreground_processes: processes,
  };
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `ps -eo pid=,args=` lists a headless claude on one of these
 * sessions: its argv resumes the id and streams JSON. Matched by argv, not
 * by a recorded pid, which another process may have taken since.
 */
export function psHasHeadless(
  psOutput: string,
  sessionIds: readonly string[],
): boolean {
  const ids = sessionIds.filter(Boolean);
  if (!ids.length) return false;
  const resume = new RegExp(
    `--resume['"\\s]+(?:${ids.map(escapeRegExp).join("|")})(?![\\w-])`,
  );
  return psOutput
    .split("\n")
    .some((line) => line.includes("stream-json") && resume.test(line));
}

/**
 * Whether `ps -eo pid=,args=` lists an interactive claude resuming one of
 * these sessions (not a headless one: those stream JSON), other than the
 * given pids. Its pid, if so.
 */
export function psInteractiveClaude(
  psOutput: string,
  sessionIds: readonly string[],
  exceptPids: readonly number[] = [],
): number | null {
  const ids = sessionIds.filter(Boolean);
  if (!ids.length) return null;
  const resume = new RegExp(
    `(?:--resume|-r)(?:=|['"\\s]+)(?:${ids.map(escapeRegExp).join("|")})(?![\\w-])`,
  );
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const args = match[2]!;
    if (exceptPids.includes(pid) || args.includes("stream-json")) continue;
    if (!/(?:^|[\s/])claude(?:\.exe)?(?:\s|$)|claude-code/.test(args)) continue;
    if (resume.test(args)) return pid;
  }
  return null;
}

function agentSessionId(agent: unknown): string | null {
  if (!isRecord(agent) || !isRecord(agent.agent_session)) return null;
  const value = agent.agent_session.value;
  return typeof value === "string" && value ? value : null;
}

/** The Herdr side of a runtime, over its client. */
export function createConversationHerdr(args: {
  call: HerdrCall;
  pidAlive: (pid: number) => Promise<boolean>;
  /** `ps -eo pid=,args=` on the pane's host; throws when it cannot run. */
  listProcesses: () => Promise<string>;
}): ConversationHerdr {
  let seq = Date.now();
  return {
    async agentGet(paneId) {
      try {
        const result = await args.call("agent.get", { target: paneId }, 5000);
        return isRecord(result) && isRecord(result.agent) ? result.agent : null;
      } catch (error) {
        if (/agent_not_found|not found/i.test(String(error))) return null;
        throw error;
      }
    },
    async readDetection(paneId) {
      const result = await args.call(
        "agent.read",
        { target: paneId, source: "detection", strip_ansi: true },
        5000,
      );
      const read =
        isRecord(result) && isRecord(result.read) ? result.read : result;
      return isRecord(read) && typeof read.text === "string" ? read.text : "";
    },
    async processInfo(paneId) {
      return parseProcessInfo(
        await args.call("pane.process_info", { pane_id: paneId }, 5000),
      );
    },
    async prompt(paneId, text) {
      await args.call("agent.prompt", { target: paneId, text }, 5000);
    },
    async sendText(paneId, text) {
      await args.call("pane.send_text", { pane_id: paneId, text }, 5000);
    },
    async reportAgent(params) {
      seq += 1;
      await args.call(
        "pane.report_agent",
        {
          pane_id: params.paneId,
          source: HEADLESS_SOURCE,
          agent: "claude",
          state: params.state,
          agent_session_id: params.sessionId,
          seq,
          ...(params.message ? { message: params.message } : {}),
        },
        5000,
      );
    },
    async releaseAgent(paneId) {
      seq += 1;
      await args.call(
        "pane.release_agent",
        { pane_id: paneId, source: HEADLESS_SOURCE, agent: "claude", seq },
        5000,
      );
    },
    pidAlive: args.pidAlive,
    async headlessRunning(sessionIds) {
      return psHasHeadless(await args.listProcesses(), sessionIds);
    },
    async paneExists(paneId) {
      try {
        await args.call("pane.get", { pane_id: paneId }, 5000);
        return true;
      } catch (error) {
        if (/not[_ ]found|no such pane|unknown pane/i.test(String(error)))
          return false;
        throw error;
      }
    },
    async writerElsewhere(paneId, sessionIds, exceptPids = []) {
      const listed = await args.call("agent.list", {}, 5000);
      const agents =
        isRecord(listed) && Array.isArray(listed.agents) ? listed.agents : [];
      for (const agent of agents) {
        if (!isRecord(agent) || agent.pane_id === paneId) continue;
        const session = agentSessionId(agent);
        if (session && sessionIds.includes(session))
          return `Claude runs this session in pane ${String(agent.pane_id)}`;
      }
      const pid = psInteractiveClaude(
        await args.listProcesses(),
        sessionIds,
        exceptPids,
      );
      return pid === null
        ? null
        : `Claude runs this session in another terminal (pid ${pid})`;
    },
  };
}

/** A local pid check: signal 0 tells whether it exists. */
export function localPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return Promise.resolve(true);
  } catch (error) {
    return Promise.resolve((error as NodeJS.ErrnoException).code === "EPERM");
  }
}

/** Whether a foreground process is an interactive Claude Code. */
export function isClaudeProcess(process: PaneProcess): boolean {
  const parts = [process.argv0 ?? "", ...(process.argv ?? [])];
  // The pane holder's headless child (it streams JSON) is no TUI.
  if (
    parts.includes("stream-json") ||
    (process.cmdline ?? "").includes("stream-json")
  )
    return false;
  if (parts.some((part) => /(?:^|\/)claude(?:\.exe)?$/.test(part))) return true;
  return /(?:^|[\s/])claude(?:\s|$)|@anthropic-ai\/claude-code/.test(
    process.cmdline ?? "",
  );
}

/**
 * How each of claude's flags that a resumed TUI should keep takes values:
 * none, one, or several (up to the next flag).
 */
const KEPT_FLAGS: Record<string, 0 | 1 | "*"> = {
  "--model": 1,
  "--permission-mode": 1,
  "--dangerously-skip-permissions": 0,
  "--allow-dangerously-skip-permissions": 0,
  "--add-dir": "*",
  "--mcp-config": "*",
  "--strict-mcp-config": 0,
  "--settings": 1,
  "--setting-sources": 1,
  "--agent": 1,
  "--effort": 1,
  "--fallback-model": 1,
  "--append-system-prompt": 1,
  "--system-prompt": 1,
  "--allowedTools": "*",
  "--allowed-tools": "*",
  "--disallowedTools": "*",
  "--disallowed-tools": "*",
  "--plugin-dir": "*",
  "--ide": 0,
  "--verbose": 0,
};

/**
 * The flags the pane's claude ran with that its resumed TUI keeps (model,
 * permission mode, directories, MCP configs...). Anything else (a session
 * to resume, a prompt, an unknown flag) is left out.
 */
export function terminalClaudeArgs(process: PaneProcess): string[] {
  const argv = process.argv ?? [];
  let at = -1;
  for (let index = 0; index < argv.length; index += 1)
    if (/(?:^|\/)claude(?:\.exe)?$|claude-code\/cli\.m?js$/.test(argv[index]!))
      at = index;
  const rest = argv.slice(at + 1);
  const kept: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    const [flag, inline] = arg.split(/=(.*)/s, 2) as [string, string?];
    const arity = KEPT_FLAGS[flag];
    if (arity === undefined) continue;
    if (inline !== undefined) {
      if (arity !== 0) kept.push(arg);
      continue;
    }
    kept.push(arg);
    if (arity === 1) {
      const value = rest[index + 1];
      if (value === undefined) kept.pop();
      else {
        kept.push(value);
        index += 1;
      }
    } else if (arity === "*")
      while (index + 1 < rest.length && !rest[index + 1]!.startsWith("-")) {
        kept.push(rest[index + 1]!);
        index += 1;
      }
  }
  return kept;
}

export type PromptBoxState = {
  box: "empty" | "draft" | "missing";
  vim: "insert" | "normal" | "none";
};

const BORDER = /^[\s\u2502\u2503|]+|[\s\u2502\u2503|]+$/g;
const RULE =
  /^\s*[\u2500\u2501\u2550\u256d\u256e\u256f\u2570\u2514\u2518\u250c\u2510]{3,}/;

/**
 * Claude's prompt box and vim mode from Herdr's detection text: the last
 * line with the prompt mark, and what follows it up to the box's rule.
 */
export function claudePromptState(text: string): PromptBoxState {
  const lines = text.split("\n");
  let at = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^\s*[\u2502\u2503|]?\s*\u276f/.test(lines[index]!)) {
      at = index;
      break;
    }
  }
  const vim = /--\s*INSERT\s*--/.test(text)
    ? "insert"
    : /--\s*(?:NORMAL|VISUAL)[^-\n]*--/.test(text)
      ? "normal"
      : "none";
  if (at < 0) return { box: "missing", vim };
  const first = lines[at]!.replace(/^\s*[\u2502\u2503|]?\s*\u276f/, "").replace(
    BORDER,
    "",
  );
  if (first) return { box: "draft", vim };
  for (const line of lines.slice(at + 1)) {
    if (RULE.test(line)) break;
    if (line.replace(BORDER, "")) return { box: "draft", vim };
  }
  return { box: "empty", vim };
}
