import type { VoiceSessionInfo } from "./voiceRoute";
import {
  type AgentAnswer,
  findAnswer,
  type QuestionAnswer,
  type VoiceQuestion,
} from "./voiceCompanion";

/**
 * What the voice companion can do for the user, in one place: the calls
 * it makes (useVoiceChat) go through these, and a future MCP server for a
 * phone's Claude app could offer the same as tools. Each is small, takes
 * plain data and says what happened.
 */
export type VoiceActions = {
  /** The agent sessions the user may name, with their status. */
  listSessions(): VoiceSessionInfo[];
  /** An agent's last answer heard on the call (`agent` named loosely). */
  lastAnswer(agent?: string): AgentAnswer | null;
  /**
   * Gives the user's words, as said, to a session: the one the call talks
   * to when `session` is omitted or is it.
   */
  forward(words: string, session?: string): Promise<"sent" | "moved">;
  /** The question waiting for the user's answer, if any. */
  pendingQuestion(): VoiceQuestion | null;
  /** Answers it with one of its choices, or the words said, as said. */
  answerQuestion(
    question: VoiceQuestion,
    answer: QuestionAnswer,
  ): Promise<boolean>;
};

export function createVoiceActions(deps: {
  sessions: () => VoiceSessionInfo[];
  current: () => string;
  /** Sends to the session the call talks to. */
  send: (words: string) => Promise<void>;
  /** Moves the call to another session, which gets the words first. */
  moveTo: (session: string, words: string) => void;
  question: () => VoiceQuestion | null;
  answer: (question: VoiceQuestion, answer: QuestionAnswer) => Promise<boolean>;
}): VoiceActions {
  return {
    listSessions: deps.sessions,
    lastAnswer: (agent) => findAnswer(agent),
    async forward(words, session) {
      if (!session || session === deps.current()) {
        await deps.send(words);
        return "sent";
      }
      deps.moveTo(session, words);
      return "moved";
    },
    pendingQuestion: deps.question,
    answerQuestion: deps.answer,
  };
}
