import type {
  AgentChatNextPrompt,
  AgentChatStreamedText,
} from "../../../shared/agentChat";
import type { PromptRequest } from "./drivers/types";

/**
 * What a session's lines left it in, saved with where they end in the
 * holder's log: a runtime after this one (a Roamgate restart) takes it up
 * there and reads only the lines after, instead of every line of the
 * process again.
 */
export type ConversationResumeState = {
  version: 1;
  turn: boolean;
  compacting: boolean;
  activity: string | null;
  last_block: "text" | "thinking" | "tool_use" | null;
  tools: string[];
  tasks: string[];
  /** Permissions and questions not answered yet: asked again. */
  prompts: PromptRequest[];
  next_prompt: AgentChatNextPrompt | null;
  /** The reply text of the turn that runs, for a browser that reloads. */
  streamed: AgentChatStreamedText[];
  turn_uuid: string | null;
  respawned_for_queue: boolean;
  taken: string[];
  recent: [string, { text: string; images: string[] }][];
  /** The driver's codec state (DriverCodec.save). */
  parser: unknown;
};

/** Past this, a saved state is not kept: its lines are read again. */
const MAX_RESUME_BYTES = 1024 * 1024;

/** A saved state as it was written, or null when it is not one. */
export function resumeStateOf(value: unknown): ConversationResumeState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<ConversationResumeState>;
  if (
    state.version !== 1 ||
    typeof state.turn !== "boolean" ||
    !Array.isArray(state.tools) ||
    !Array.isArray(state.tasks) ||
    !Array.isArray(state.prompts) ||
    !Array.isArray(state.streamed) ||
    !Array.isArray(state.taken) ||
    !Array.isArray(state.recent) ||
    !state.parser ||
    typeof state.parser !== "object"
  )
    return null;
  return state as ConversationResumeState;
}

/** The state to save, or null when it is too large to keep. */
export function keptResumeState(
  state: ConversationResumeState,
): ConversationResumeState | null {
  // A huge reply so far: its lines are read again instead.
  return JSON.stringify(state).length > MAX_RESUME_BYTES ? null : state;
}
