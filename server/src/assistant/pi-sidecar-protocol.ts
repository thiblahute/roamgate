/**
 * The Pi sidecar's wire (contract/wire/pi-sidecar.md): JSON-RPC 2.0, one
 * compact JSON message per line, over the sidecar's stdin and stdout. Its
 * pure parts are held to contract/vectors/pi-sidecar.json, which
 * roamgate-pi's tests read too.
 */
import { isRecord } from "../agent/session-utils";
import { UnsupportedPlatformError } from "../connections/unix-only";
import { AssistantUserError } from "./errors";

/** The wire's version, checked by `initialize`. */
export const PI_SIDECAR_PROTOCOL = 1;
/** Names the sidecar's executable; unset, Pi runs inside the Bun server. */
export const PI_SIDECAR_ENV = "ROAMGATE_PI_SIDECAR";
/** A line longer than this is refused: the channel's own frame limit. */
export const PI_SIDECAR_MAX_LINE = 64 * 1024 * 1024;
/** The sidecar exits after this long with nothing in flight. */
export const PI_SIDECAR_IDLE_MS = 5 * 60_000;

/** An error the sidecar gave: its message, and whether it is a user's. */
export const ERROR_CODE = -32000;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_REQUEST = -32600;
export const PARSE_ERROR = -32700;

export type Id = number | string;
export type WireError = {
  code: number;
  message: string;
  data?: { user?: boolean };
};
export type Message =
  | { kind: "request"; id: Id; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "result"; id: Id; result: unknown }
  | { kind: "error"; id: Id | null; error: WireError };

/** The run callbacks a parent may leave out, each changing what Pi does. */
export const RUN_CALLBACKS = [
  "checkpoint",
  "replace",
  "thinking",
  "sources",
  "steered",
] as const;
/** The tool handlers of a run; `read` is always there. */
export const RUN_HANDLERS = [
  "read",
  "propose",
  "task",
  "notify",
  "show",
  "arrange",
  "threads",
  "archive",
] as const;

/** The message of one line, or null for a line that is not one (logged). */
export function parseLine(line: string): Message | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.jsonrpc !== "2.0") return null;
  const id = value.id;
  const validId =
    typeof id === "string" || (typeof id === "number" && Number.isInteger(id));
  if (typeof value.method === "string") {
    const params = value.params ?? null;
    if (id === undefined)
      return { kind: "notification", method: value.method, params };
    if (!validId) return null;
    return { kind: "request", id: id as Id, method: value.method, params };
  }
  if ("result" in value && validId)
    return { kind: "result", id: id as Id, result: value.result };
  if (isRecord(value.error) && (validId || id === null)) {
    const error = value.error;
    if (typeof error.code !== "number" || typeof error.message !== "string")
      return null;
    return {
      kind: "error",
      id: (id as Id | null) ?? null,
      error: {
        code: error.code,
        message: error.message,
        ...(isRecord(error.data) && typeof error.data.user === "boolean"
          ? { data: { user: error.data.user } }
          : {}),
      },
    };
  }
  return null;
}

/** One message as its line, without the newline. */
export function encodeMessage(message: Message): string {
  switch (message.kind) {
    case "request":
      return JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        method: message.method,
        params: message.params,
      });
    case "notification":
      return JSON.stringify({
        jsonrpc: "2.0",
        method: message.method,
        params: message.params,
      });
    case "result":
      return JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: message.result ?? null,
      });
    case "error":
      return JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: message.error,
      });
  }
}

/**
 * The wire error of a thrown value: its message, and `user` when the
 * assistant shows that message as it is (AssistantUserError, an
 * unsupported platform).
 */
export function errorToWire(error: unknown): WireError {
  const user =
    error instanceof AssistantUserError ||
    error instanceof UnsupportedPlatformError;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Pi sidecar failure";
  return { code: ERROR_CODE, message, ...(user ? { data: { user } } : {}) };
}

/** The error to throw for a wire error, of the class it was thrown as. */
export function wireToError(error: WireError): Error {
  return error.data?.user
    ? new AssistantUserError(error.message)
    : new Error(error.message);
}

/** The wire error's class name, for the vectors. */
export function wireErrorKind(error: WireError): string {
  return wireToError(error) instanceof AssistantUserError ? "user" : "error";
}

/**
 * How to start the sidecar the variable names: a `.ts` or `.js` file runs
 * with Bun (the running one when the server runs from source), anything
 * else is the executable itself. Empty or unset: none.
 */
export function sidecarCommand(
  value: string | undefined,
  bun: string,
): string[] | null {
  const path = value?.trim();
  if (!path) return null;
  return /\.[cm]?[jt]s$/.test(path) ? [bun, path] : [path];
}
