import type {
  AgentChatRewindCheck,
  AgentChatRewindMode,
  AgentChatRewindResult,
} from "../../../shared/agentChat";
import type { conversationDriver } from "./drivers";
import type { LeaseStore } from "./lease";
import type { ConversationSession } from "./session";

/**
 * Rewinds in conversation mode, for a runtime: the session conversation
 * mode owns rewinds (ConversationSession.rewind); the terminal does its
 * own, and its transcript says what a rewind could do to the code.
 */
export function createServiceRewind(deps: {
  leases: LeaseStore;
  sessions: Map<string, ConversationSession>;
  sessionFor: (paneId: string) => ConversationSession;
  driverOf: (paneId: string) => ReturnType<typeof conversationDriver>;
  /** The pane session's transcript (null: unknown); none: never read. */
  readTranscript?: (paneId: string) => Promise<string | null>;
  /** The notice of a turn cut short goes. */
  clearInterrupted: (paneId: string) => void;
  closed: () => boolean;
}) {
  const { leases, sessions } = deps;
  return {
    /**
     * Rewinds the session conversation mode owns to before one of the
     * user's messages (ConversationSession.rewind); the terminal does its
     * own.
     */
    async rewind(
      paneId: string,
      input: {
        uuid: string;
        lastSeen?: string;
        mode: AgentChatRewindMode;
        interrupt?: boolean;
      },
    ): Promise<AgentChatRewindResult> {
      const lease = leases.get(paneId);
      if (deps.closed() || !lease || lease.phase !== "conversation")
        return {
          ok: false,
          reason: lease
            ? "This session is being handed over; try again shortly"
            : "The terminal owns this session",
        };
      const result = await deps.sessionFor(paneId).rewind(input);
      // What was cut short is rewound away, or restored.
      if (result.ok && input.mode !== "code") deps.clearInterrupted(paneId);
      return result;
    },
    /**
     * What a rewind to before `uuid` could do to the code, from the pane's
     * transcript: for the sheet, before the user picks. The terminal's
     * session is read the same way.
     */
    async rewindCheck(
      paneId: string,
      uuid: string,
    ): Promise<AgentChatRewindCheck> {
      const session = sessions.get(paneId);
      if (session) return session.rewindCheck(uuid);
      if (deps.closed() || !deps.readTranscript) return { code: "unknown" };
      try {
        const rewind = deps.driverOf(paneId).protocol.rewind;
        if (!rewind) return { code: "unknown" };
        const transcript = await deps.readTranscript(paneId);
        // Without a session: the terminal's transcript, read the same way.
        return rewind.checkTranscript(transcript, uuid);
      } catch {
        return { code: "unknown" };
      }
    },
  };
}
