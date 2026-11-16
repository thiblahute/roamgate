import type { ClaudeModPane } from "../agent/claude-mod";
import {
  type ClaudeModDelivery,
  promptPaneAgent,
} from "../conversation/prompt-pane";
import type { LimitConnection, LimitPane } from "./scheduler";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** What the resumer needs of a connection's runtime. */
export type LimitRuntime = {
  id: string;
  herdr: {
    call(
      method: string,
      params: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<unknown>;
  };
  conversation: {
    ownedPanes(): {
      pane_id: string;
      session_id: string;
      phase: string;
      agent_status: string;
      agent: string;
    }[];
    prompt(paneId: string, text: string): Promise<boolean>;
  };
  transcriptTail: (paneId: string) => Promise<string | null>;
  /** The connection's Claude mods: exact status, and delivery. */
  claudeMod?: ClaudeModDelivery & {
    pane(paneId: string): ClaudeModPane | null;
  };
};

/**
 * A connection (local or SSH) as the resumer sees it: the panes running
 * a Claude session, from Herdr's agent list and conversation mode's own
 * (an asleep conversation is idle there), and delivery the way review
 * comments go: conversation mode's queue, which wakes an asleep process,
 * else typed into the terminal's Claude through Herdr's agent.prompt.
 */
export function limitConnection(runtime: LimitRuntime): LimitConnection {
  return {
    id: runtime.id,
    async panes(): Promise<LimitPane[]> {
      const listed = await runtime.herdr.call("agent.list", {}, 10_000);
      const agents =
        isRecord(listed) && Array.isArray(listed.agents) ? listed.agents : [];
      const owned = runtime.conversation.ownedPanes();
      const ownedIds = new Set(owned.map((each) => each.pane_id));
      const panes: LimitPane[] = [];
      for (const agent of agents) {
        if (!isRecord(agent) || typeof agent.pane_id !== "string") continue;
        if (ownedIds.has(agent.pane_id) || agent.agent !== "claude") continue;
        const session = isRecord(agent.agent_session)
          ? agent.agent_session
          : null;
        if (session?.kind !== "id" || typeof session.value !== "string")
          continue;
        // A live Claude mod knows when the turn really ended.
        const mod = runtime.claudeMod?.pane(agent.pane_id);
        panes.push({
          paneId: agent.pane_id,
          sessionId: mod?.session_id || session.value,
          owner: "terminal",
          status: mod
            ? mod.status
            : typeof agent.agent_status === "string"
              ? agent.agent_status
              : "",
        });
      }
      for (const pane of owned) {
        // Being handed over: neither side may be typed into meanwhile.
        if (pane.phase !== "conversation" || pane.agent !== "claude") continue;
        panes.push({
          paneId: pane.pane_id,
          sessionId: pane.session_id,
          owner: "conversation",
          status: pane.agent_status,
        });
      }
      return panes;
    },
    transcriptTail: (paneId) => runtime.transcriptTail(paneId),
    async deliver(pane, text) {
      await promptPaneAgent(runtime, pane.paneId, text, "limit-resume");
    },
  };
}
