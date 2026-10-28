import type { AgentPermissionPrompt } from "../../shared/review";
import { agentHistoryCacheKey, cachedAgentHistory } from "./agentHistoryCache";
import type { PaneJumpEntry } from "./paneJump";
import { paneAgentPrompt } from "./review";

const WAITS_ON_CHARS = 160;

function oneLine(text: string) {
  const line = text
    .split("\n")
    .map((each) => each.replace(/[#*_`>]/g, "").trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > WAITS_ON_CHARS
    ? `${line.slice(0, WAITS_ON_CHARS - 1)}…`
    : line;
}

/**
 * What each agent needing the user waits on, from what the page already has:
 * the question or permission its hook asked Roamgate, else its last message
 * in the chat history this browser keeps; nothing is fetched for it.
 */
export function withWaitsOn(
  entries: PaneJumpEntry[],
  activeConnectionId: string | null,
  prompts: ReadonlyMap<string, AgentPermissionPrompt[]>,
): PaneJumpEntry[] {
  return entries.map((entry) => {
    if (!entry.needsYou) return entry;
    const connectionId = entry.connectionId ?? activeConnectionId;
    let waitsOn: string | undefined;
    if (entry.needsYou === "blocked") {
      const prompt = paneAgentPrompt(prompts, connectionId, entry.paneId);
      waitsOn = prompt
        ? (oneLine(prompt.questions?.[0]?.question ?? "") ??
          `${prompt.tool}: ${prompt.summary}`)
        : "Asking you something";
    } else {
      const messages =
        cachedAgentHistory(
          agentHistoryCacheKey(connectionId, entry.paneId, entry.agent),
        )?.history?.messages ?? [];
      const last = [...messages]
        .reverse()
        .find(
          (message) =>
            message.kind === "message" && message.role === "assistant",
        );
      waitsOn =
        (last && oneLine(last.text)) ?? "Finished since you last looked";
    }
    return waitsOn ? { ...entry, waitsOn } : entry;
  });
}
