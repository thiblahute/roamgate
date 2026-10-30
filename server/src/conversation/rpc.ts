import type { HistoryWatcher } from "../agent/history-watch";
import type { ConversationService } from "./service";

export const AGENT_CHAT_METHODS = [
  "agent_chat.state",
  "agent_chat.subscribe",
  "agent_chat.unsubscribe",
  "agent_chat.send",
  "agent_chat.voice",
  "agent_chat.interrupt",
  "agent_chat.shell",
  "agent_chat.shell.stop",
  "agent_chat.rewind",
  "agent_chat.rewind.check",
  "agent_chat.queue.edit",
  "agent_chat.queue.remove",
  "agent_chat.interrupted.dismiss",
  "agent_chat.recover",
  "agent_chat.api_key.answer",
  "agent_chat.handover",
  "agent_chat.handover.cancel",
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
      return service.subscribe(ws, paneId);
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
    case "agent_chat.shell": {
      const command = textOf(params, "command");
      if (!command.trim() || command.length > 20_000)
        throw new Error("invalid command");
      const id = idOf(params, "id");
      return service.shell(paneId, { command, ...(id ? { id } : {}) });
    }
    case "agent_chat.shell.stop": {
      const id = idOf(params, "id");
      if (!id) throw new Error("id is required");
      return { stopped: service.stopShell(paneId, id) };
    }
    case "agent_chat.interrupt":
      return { interrupted: await service.interrupt(paneId) };
    case "agent_chat.rewind": {
      const uuid = idOf(params, "uuid");
      if (!uuid) throw new Error("uuid is required");
      const mode = params.mode;
      if (mode !== "both" && mode !== "conversation" && mode !== "code")
        throw new Error("mode is both, conversation or code");
      const lastSeen = idOf(params, "last_seen");
      return service.rewind(paneId, {
        uuid,
        mode,
        interrupt: params.interrupt === true,
        ...(lastSeen ? { lastSeen } : {}),
      });
    }
    case "agent_chat.rewind.check": {
      const uuid = idOf(params, "uuid");
      if (!uuid) throw new Error("uuid is required");
      return service.rewindCheck(paneId, uuid);
    }
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
    case "agent_chat.recover":
      return service.recover(paneId);
    case "agent_chat.api_key.answer": {
      const use = params.use;
      if (use !== "api_key" && use !== "login")
        throw new Error("use is api_key or login");
      return service.answerApiKey(paneId, use);
    }
    case "agent_chat.handover": {
      const to = params.to;
      if (to !== "conversation" && to !== "terminal")
        throw new Error("to is conversation or terminal");
      const sessionId = idOf(params, "session_id");
      const quitWriter = params.quit_writer;
      if (
        quitWriter !== undefined &&
        (typeof quitWriter !== "string" ||
          !quitWriter ||
          quitWriter.length > 200)
      )
        throw new Error("invalid quit_writer");
      return service.handover(paneId, to, {
        interrupt: params.interrupt === true,
        auto: params.auto === true,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(quitWriter ? { quit_writer: quitWriter } : {}),
      });
    }
    case "agent_chat.handover.cancel":
      return service.cancelHandover(paneId);
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
