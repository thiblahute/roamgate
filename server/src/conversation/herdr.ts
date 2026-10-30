import type { AgentChatOtherWriter } from "../../../shared/agentChat";
import { isRecord } from "../agent/session-utils";
import { conversationDrivers, driverForHerdrAgent } from "./drivers";

// Claude Code's terminal parsers live with its driver; re-exported here.
export {
  type ClaudeFooter,
  claudeBackgroundWork,
  claudeExitDialog,
  claudeFooter,
  claudePromptState,
  FOOTER_MIN_WIDTH,
  isClaudeProcess,
  type PromptBoxState,
  psHasHeadless,
  psInteractiveClaude,
  terminalClaudeArgs,
} from "./drivers/claude-tui";

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

/** Another writer on a session, as `writerElsewhere` finds it. */
export type WriterElsewhere = {
  /** Which, in plain words: for the log, and refusals that say no more. */
  text: string;
  /** In a pane of this Herdr: where it is, and what it does. */
  pane?: AgentChatOtherWriter;
};

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
  /** Presses keys in the pane (`pane.send_keys`): a menu's answer. */
  sendKeys(paneId: string, keys: string): Promise<void>;
  reportAgent(params: {
    paneId: string;
    state: HerdrAgentState;
    sessionId: string;
    message?: string;
    /** Herdr's name of the agent; claude when not given. */
    agent?: string;
  }): Promise<void>;
  releaseAgent(paneId: string, agent?: string): Promise<void>;
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
   * aside). Says which, and for a pane where it is and whether its agent
   * is idle; throws when the host cannot say.
   */
  writerElsewhere(
    paneId: string,
    sessionIds: readonly string[],
    exceptPids?: readonly number[],
  ): Promise<WriterElsewhere | null>;
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

function agentSessionId(agent: unknown): string | null {
  if (!isRecord(agent) || !isRecord(agent.agent_session)) return null;
  const value = agent.agent_session.value;
  return typeof value === "string" && value ? value : null;
}

/** Herdr's agent status as a writer's: done is idle at its prompt too. */
function writerStatus(
  agent: Record<string, unknown>,
): AgentChatOtherWriter["status"] {
  if (!agent.agent) return "unknown";
  switch (agent.agent_status) {
    case "idle":
    case "done":
      return "idle";
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    default:
      return "unknown";
  }
}

/** The name a record of `workspace.get` or `tab.get` carries, if any. */
function labelOf(
  result: unknown,
  key: "workspace" | "tab",
): { label: string; number?: number } | null {
  const record = isRecord(result) && isRecord(result[key]) ? result[key] : null;
  if (!record) return null;
  return {
    label: typeof record.label === "string" ? record.label.trim() : "",
    number: numberOr(record.number),
  };
}

/** The Herdr side of a runtime, over its client. */
export function createConversationHerdr(args: {
  call: HerdrCall;
  pidAlive: (pid: number) => Promise<boolean>;
  /** `ps -eo pid=,args=` on the pane's host; throws when it cannot run. */
  listProcesses: () => Promise<string>;
}): ConversationHerdr {
  let seq = Date.now();
  /** The pane's shell is at its prompt, no agent in front (unsure: no). */
  async function bareShell(paneId: string): Promise<boolean> {
    try {
      const info = parseProcessInfo(
        await args.call("pane.process_info", { pane_id: paneId }, 5000),
      );
      return (
        info.shell_pid !== undefined &&
        info.foreground_process_group_id === info.shell_pid &&
        !info.foreground_processes.some((process) =>
          conversationDrivers().some(({ terminal }) =>
            terminal.isAgentProcess(process),
          ),
        )
      );
    } catch {
      return false;
    }
  }
  /**
   * Another pane's writer, named as the sidebar does (the workspace's
   * label, the tab's unless it is its number); a name Herdr does not give
   * is left out.
   */
  async function describeWriter(
    paneId: string,
    name: string,
    agent: Record<string, unknown>,
  ): Promise<AgentChatOtherWriter> {
    const workspaceId =
      typeof agent.workspace_id === "string" ? agent.workspace_id : undefined;
    const tabId = typeof agent.tab_id === "string" ? agent.tab_id : undefined;
    const [workspace, tab] = await Promise.all([
      workspaceId
        ? args
            .call("workspace.get", { workspace_id: workspaceId }, 5000)
            .then((result) => labelOf(result, "workspace"))
            .catch(() => null)
        : null,
      tabId
        ? args
            .call("tab.get", { tab_id: tabId }, 5000)
            .then((result) => labelOf(result, "tab"))
            .catch(() => null)
        : null,
    ]);
    const tabLabel =
      tab?.label && tab.label !== String(tab.number)
        ? tab.label
        : tab?.number !== undefined
          ? `Tab ${tab.number}`
          : undefined;
    return {
      pane_id: paneId,
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      ...(tabId ? { tab_id: tabId } : {}),
      ...(workspace?.label ? { workspace_label: workspace.label } : {}),
      ...(tabLabel ? { tab_label: tabLabel } : {}),
      agent_name: name,
      status: writerStatus(agent),
    };
  }
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
      const text = (result: unknown) => {
        const read =
          isRecord(result) && isRecord(result.read) ? result.read : result;
        return isRecord(read) && typeof read.text === "string" ? read.text : "";
      };
      // With its styles: Claude's suggested next prompt is dim text in the
      // prompt box, which reads as a draft once the styles are gone.
      try {
        return text(
          await args.call(
            "agent.read",
            {
              target: paneId,
              source: "recent",
              lines: 40,
              format: "ansi",
              strip_ansi: false,
            },
            5000,
          ),
        );
      } catch (error) {
        if (!/invalid|unknown|format/i.test(String(error))) throw error;
      }
      // A Herdr without styled reads.
      return text(
        await args.call(
          "agent.read",
          { target: paneId, source: "detection", strip_ansi: true },
          5000,
        ),
      );
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
    async sendKeys(paneId, keys) {
      await args.call(
        "pane.send_keys",
        { pane_id: paneId, keys: [keys] },
        5000,
      );
    },
    async reportAgent(params) {
      seq += 1;
      await args.call(
        "pane.report_agent",
        {
          pane_id: params.paneId,
          source: HEADLESS_SOURCE,
          agent: params.agent ?? "claude",
          state: params.state,
          agent_session_id: params.sessionId,
          seq,
          ...(params.message ? { message: params.message } : {}),
        },
        5000,
      );
    },
    async releaseAgent(paneId, agent = "claude") {
      seq += 1;
      await args.call(
        "pane.release_agent",
        { pane_id: paneId, source: HEADLESS_SOURCE, agent, seq },
        5000,
      );
    },
    pidAlive: args.pidAlive,
    async headlessRunning(sessionIds) {
      const ps = await args.listProcesses();
      return conversationDrivers().some(({ terminal }) =>
        terminal.headlessProbe(ps, sessionIds),
      );
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
        if (!session || !sessionIds.includes(session)) continue;
        const otherPane = String(agent.pane_id);
        // Herdr keeps a pane's session once its agent has gone: a shell
        // back at its prompt writes nothing.
        if (!agent.agent && (await bareShell(otherPane))) continue;
        const name =
          driverForHerdrAgent(agent.agent)?.terminal.displayName ?? "Claude";
        return {
          text: `${name} runs this session in pane ${otherPane}`,
          pane: await describeWriter(otherPane, name, agent),
        };
      }
      const ps = await args.listProcesses();
      for (const { terminal } of conversationDrivers()) {
        const pid = terminal.interactiveWriter(ps, sessionIds, exceptPids);
        if (pid !== null)
          return {
            text: `${terminal.displayName} runs this session in another terminal (pid ${pid})`,
          };
      }
      return null;
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
