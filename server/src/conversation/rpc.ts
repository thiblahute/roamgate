import type { HistoryWatcher } from "../agent/history-watch";
import type { AgentChatView, ConversationService } from "./service";

export const AGENT_CHAT_METHODS = [
  "agent_chat.state",
  "agent_chat.subscribe",
  "agent_chat.unsubscribe",
  "agent_chat.view",
  "agent_chat.send",
  "agent_chat.voice",
  "agent_chat.interrupt",
  "agent_chat.queue.edit",
  "agent_chat.queue.remove",
  "agent_chat.interrupted.dismiss",
  "agent_chat.handover",
  "agent_history.subscribe",
  "agent_history.unsubscribe",
] as const;

const METHODS = new Set<string>(AGENT_CHAT_METHODS);

export function isAgentChatMethod(method: string): boolean {
  return METHODS.has(method);
}

function paneOf(params: Record<string, unknown>): string {
  const pane = params.pane_id;
  if (typeof pane !== "string" || !pane || pane.length > 200)
    throw new Error("pane_id is required");
  return pane;
}

function textOf(params: Record<string, unknown>, field = "text"): string {
  const text = params[field];
  if (text === undefined) return "";
  if (typeof text !== "string" || text.length > 200_000)
    throw new Error(`invalid ${field}`);
  return text;
}

function idOf(
  params: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = params[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[\w-]{1,100}$/.test(value))
    throw new Error(`invalid ${field}`);
  return value;
}

function viewOf(params: Record<string, unknown>): AgentChatView | null {
  const view = params.view;
  if (view === undefined || view === null) return null;
  if (view !== "chat" && view !== "terminal")
    throw new Error("view is chat, terminal or null");
  return view;
}

function imagesOf(params: Record<string, unknown>): string[] {
  const images = params.images;
  if (images === undefined) return [];
  if (
    !Array.isArray(images) ||
    images.length > 20 ||
    images.some((path) => typeof path !== "string" || path.length > 4096)
  )
    throw new Error("invalid images");
  return images as string[];
}

/** The agent_chat.* and agent_history.(un)subscribe requests of one socket. */
export async function handleAgentChatRpc<Ws>(
  service: ConversationService<Ws>,
  history: HistoryWatcher<Ws> | null,
  ws: Ws,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const paneId = paneOf(params);
  switch (method) {
    case "agent_chat.state":
      return service.state(paneId);
    case "agent_chat.subscribe":
      return service.subscribe(
        ws,
        paneId,
        "view" in params ? viewOf(params) : undefined,
      );
    case "agent_chat.view":
      service.view(ws, paneId, viewOf(params));
      return { ok: true };
    case "agent_chat.unsubscribe":
      service.unsubscribe(ws, paneId);
      return { ok: true };
    case "agent_chat.send": {
      const uuid = idOf(params, "uuid");
      return service.send(paneId, {
        text: textOf(params),
        images: imagesOf(params),
        ...(uuid ? { uuid } : {}),
      });
    }
    case "agent_chat.voice": {
      const uuid = idOf(params, "uuid");
      return service.voice(paneId, {
        text: textOf(params),
        stop: params.stop === true,
        ...(uuid ? { uuid } : {}),
      });
    }
    case "agent_chat.interrupt":
      return { interrupted: await service.interrupt(paneId) };
    case "agent_chat.queue.edit": {
      const id = idOf(params, "id");
      if (!id) throw new Error("id is required");
      return { edited: service.editQueued(paneId, id, textOf(params)) };
    }
    case "agent_chat.queue.remove": {
      const id = idOf(params, "id");
      if (!id) throw new Error("id is required");
      return { removed: service.removeQueued(paneId, id) };
    }
    case "agent_chat.interrupted.dismiss":
      service.dismissInterrupted(paneId);
      return { ok: true };
    case "agent_chat.handover": {
      const to = params.to;
      if (to !== "conversation" && to !== "terminal")
        throw new Error("to is conversation or terminal");
      const sessionId = idOf(params, "session_id");
      return service.handover(paneId, to, {
        interrupt: params.interrupt === true,
        auto: params.auto === true,
        ws,
        ...(sessionId ? { session_id: sessionId } : {}),
      });
    }
    case "agent_history.subscribe":
      if (!history) throw new Error("History push is unavailable here");
      return history.subscribe(ws, params);
    case "agent_history.unsubscribe":
      history?.unsubscribe(ws, paneId);
      return { ok: true };
    default:
      throw new Error(`unknown method: ${method}`);
  }
}
