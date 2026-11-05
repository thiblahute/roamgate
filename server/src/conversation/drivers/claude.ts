import { CLAUDE_CAPABILITIES } from "../../../../shared/agentChat";
import {
  DISMISSED_PERMISSION_MESSAGE,
  DISMISSED_QUESTION_MESSAGE,
} from "../../../../shared/review";
import { parseQuestions } from "../../review/agent-server";
import { holderEnvChanges } from "./claude-env";
import { claudeRewind } from "./claude-rewind";
import { createStreamParser, type StreamParserState } from "./claude-stream";
import type {
  DriverCodec,
  DriverPrompt,
  HolderStartCommand,
  PromptRequest,
  ProtocolDriver,
  StartOptions,
} from "./types";

/**
 * The long-lived headless claude for one session: stream-json both ways,
 * partial messages, the user's own messages echoed back once accepted, and
 * permissions asked over stdio. The user's hooks stay on. Prompt
 * suggestions are asked for: Claude Code still sends none when the user
 * turned them off (`promptSuggestionEnabled` in their config, or
 * CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).
 */
export function headlessClaudeArgs(
  sessionId: string,
  /** The pane's claude's own flags (terminalClaudeArgs): model, mode... */
  flags: string[] = [],
): string[] {
  return [
    ...headlessFlags(flags),
    "-p",
    "--resume",
    sessionId,
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
  ];
}

/** What the headless run sets itself, or has no use for. */
const NOT_HEADLESS = new Set(["--ide", "--verbose"]);

/**
 * The flags the pane's claude ran with (already only the kept ones, see
 * terminalClaudeArgs) that its headless run takes too: the model, the
 * permission mode, the directories and MCP configs the user gave it.
 */
export function headlessFlags(flags: string[]): string[] {
  return flags.filter((flag) => !NOT_HEADLESS.has(flag.split("=", 1)[0]!));
}

/**
 * What the pane holder is asked to run: claude resuming the session, in
 * its directory, with the headless environment.
 */
export function holderStartCommand(options: StartOptions): HolderStartCommand {
  const env = holderEnvChanges(options.apiKeyAnswer, options.paneId);
  const profile = options.profile;
  return {
    argv: [
      profile?.program ?? "claude",
      ...headlessClaudeArgs(options.sessionId, options.flags ?? []),
    ],
    cwd: options.cwd,
    ...env,
    // A profile's environment: set after the drop, its removals after the
    // API key policy (a profile with its own token never sends the pane's
    // key).
    ...(profile
      ? {
          set: { ...env.set, ...profile.env },
          ...(profile.unset.length ? { unset: [...profile.unset] } : {}),
        }
      : {}),
  };
}

function line(value: unknown): string {
  return JSON.stringify(value);
}

/** Claude's AskUserQuestion is a question card, not a permission. */
function questionsOf(request: PromptRequest) {
  if (request.tool_name !== "AskUserQuestion") return [];
  const input =
    request.input && typeof request.input === "object"
      ? (request.input as Record<string, unknown>)
      : {};
  return parseQuestions(JSON.stringify(input.questions ?? []));
}

function createClaudeCodec(): DriverCodec {
  const parser = createStreamParser();
  return {
    line: (text) => parser.line(text),
    save: () => parser.save(),
    restore: (state) => parser.restore(state as StreamParserState),

    message({ text, images, uuid, prelude }) {
      const blocks = images.map((image) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: image.media_type,
          data: image.data,
        },
      }));
      return [
        line({
          type: "user",
          uuid,
          message: {
            role: "user",
            content:
              blocks.length || prelude.length
                ? [
                    ...prelude.map((each) => ({ type: "text", text: each })),
                    ...(text ? [{ type: "text", text }] : []),
                    ...blocks,
                  ]
                : text,
          },
        }),
      ];
    },

    interrupt(requestId) {
      return [
        line({
          type: "control_request",
          request_id: requestId,
          request: { subtype: "interrupt" },
        }),
      ];
    },

    answer(request, answer) {
      const input =
        request.input && typeof request.input === "object"
          ? (request.input as Record<string, unknown>)
          : {};
      let response: Record<string, unknown>;
      if (answer && typeof answer === "object")
        response = {
          behavior: "allow",
          updatedInput: { ...input, answers: answer.answers },
        };
      else if (answer === "allow")
        response = { behavior: "allow", updatedInput: request.input };
      else if (answer === "always")
        response = {
          behavior: "allow",
          updatedInput: request.input,
          updatedPermissions: request.suggestions,
        };
      else
        response = {
          behavior: "deny",
          message:
            answer === "dismiss"
              ? questionsOf(request).length
                ? DISMISSED_QUESTION_MESSAGE
                : DISMISSED_PERMISSION_MESSAGE
              : answer === "deny"
                ? "The user said no from Roamgate"
                : "Nobody answered in Roamgate in time",
          interrupt: false,
        };
      return [
        line({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: request.request_id,
            response,
          },
        }),
      ];
    },

    request(kind, params, requestId) {
      return [
        line({
          type: "control_request",
          request_id: requestId,
          request: { subtype: kind, ...params },
        }),
      ];
    },
  };
}

/** Claude Code, headless: `claude -p` over stream-json. */
export const claudeProtocolDriver: ProtocolDriver = {
  agent: "claude",
  displayName: "Claude",
  capabilities: CLAUDE_CAPABILITIES,
  startCommand: holderStartCommand,
  createCodec: createClaudeCodec,

  promptOf(request): DriverPrompt {
    const questions = questionsOf(request);
    return {
      tool: request.tool_name,
      input: questions.length
        ? { question: questions[0]!.question }
        : request.input,
      canAlways: !questions.length && request.suggestions.length > 0,
      ...(questions.length ? { questions } : {}),
    };
  },

  inputKind(text) {
    try {
      const value = JSON.parse(text) as {
        type?: unknown;
        response?: { request_id?: unknown };
      };
      if (value.type === "user") return { kind: "user" };
      if (value.type === "control_response")
        return typeof value.response?.request_id === "string"
          ? { kind: "control_response", request_id: value.response.request_id }
          : { kind: "control_response" };
      if (value.type === "control_request") return { kind: "control_request" };
    } catch {
      // Written as is; the holder notes it as "other".
    }
    return { kind: "other" };
  },
  answerKind: "control_response",

  parseWrittenMessage(text) {
    let message: { uuid?: unknown; message?: { content?: unknown } };
    try {
      message = JSON.parse(text);
    } catch {
      return null;
    }
    const content = message.message?.content;
    return {
      ...(typeof message.uuid === "string" ? { uuid: message.uuid } : {}),
      text:
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .flatMap((block: { type?: unknown; text?: unknown }) =>
                  block?.type === "text" && typeof block.text === "string"
                    ? [block.text]
                    : [],
                )
                .join("\n\n")
            : "",
    };
  },

  rewind: claudeRewind,
};
