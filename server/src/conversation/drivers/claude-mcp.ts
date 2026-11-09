import type {
  AgentChatMcpAction,
  AgentChatMcpServer,
  AgentChatMcpStatus,
  AgentChatMcpTool,
} from "../../../../shared/agentChat";
import { isRecord } from "../../agent/session-utils";
import type { ControlAnswer, McpDriver } from "./types";

/**
 * Claude Code's MCP servers over its control protocol: `mcp_status` lists
 * them, `mcp_reconnect` and `mcp_toggle` act on one, `mcp_authenticate`
 * starts a sign-in and answers the page to open. A disabled server stays
 * so for the project, in Claude Code's own settings and terminal too.
 *
 * `mcp_authenticate` answers `callbackExpected` for an OAuth server: the
 * page redirects to a port on the machine Claude runs on, and Claude
 * connects the server by itself when the browser gets there. From
 * elsewhere (a phone) the address the browser lands on is given back with
 * `mcp_oauth_callback_url`, after which the server stays as it was until
 * `mcp_reconnect`. A claude.ai connector is connected on claude.ai
 * (`callbackExpected` false): `mcp_reconnect` once that is done.
 */

const STATUSES = new Set<string>([
  "connected",
  "failed",
  "needs-auth",
  "pending",
  "disabled",
]);

/** The transports `mcp_authenticate` signs in to. */
const SIGN_IN_TRANSPORTS = new Set(["http", "sse", "claudeai-proxy"]);

/** Past this, what a server or Claude says is cut. */
const MAX_TEXT = 400;

function text(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  return trimmed.length > MAX_TEXT
    ? `${trimmed.slice(0, MAX_TEXT - 3)}...`
    : trimmed;
}

function claudeMcpTool(value: unknown): AgentChatMcpTool | null {
  if (!isRecord(value)) return null;
  const name = text(value.name);
  if (!name) return null;
  const description = text(value.description);
  const annotations = isRecord(value.annotations) ? value.annotations : {};
  return {
    name,
    ...(description ? { description } : {}),
    ...(annotations.readOnly === true ? { readOnly: true } : {}),
    ...(annotations.destructive === true ? { destructive: true } : {}),
  };
}

/** The host of a URL: what it says of a server without its secrets. */
function urlHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).host || undefined;
  } catch {
    return undefined;
  }
}

/** What a row shows of where a server lives: never args, env or headers. */
function claudeMcpTarget(row: Record<string, unknown>): string | undefined {
  // A claude.ai connector is reached through Anthropic's proxy: no target.
  if (row.transport === "claudeai-proxy") return undefined;
  const config = isRecord(row.config) ? row.config : {};
  const host = text(row.urlHost) ?? urlHost(config.url);
  if (host) return host;
  if (typeof config.command !== "string") return undefined;
  return text(config.command.split(/[\\/]/).pop());
}

function claudeMcpActions(
  status: AgentChatMcpStatus,
  transport: string | undefined,
  sessionProxied: boolean,
): AgentChatMcpAction[] {
  if (status === "pending") return [];
  if (status === "disabled") return ["enable"];
  const signIn =
    (status === "needs-auth" || status === "failed") &&
    !sessionProxied &&
    transport !== undefined &&
    SIGN_IN_TRANSPORTS.has(transport);
  return [
    ...(signIn ? (["authenticate"] as const) : []),
    "reconnect",
    "disable",
  ];
}

/** One row of `mcp_status`; null when unusable. */
export function claudeMcpRow(value: unknown): AgentChatMcpServer | null {
  if (!isRecord(value)) return null;
  const name = text(value.name);
  if (!name) return null;
  const said = typeof value.status === "string" ? value.status : "";
  const known = STATUSES.has(said);
  const status = (known ? said : "failed") as AgentChatMcpStatus;
  const config = isRecord(value.config) ? value.config : {};
  const transport = text(value.transport) ?? text(config.type);
  const scope = text(value.source) ?? text(value.scope);
  const target = claudeMcpTarget(value);
  const info = isRecord(value.serverInfo) ? value.serverInfo : {};
  const version = [text(info.name), text(info.version)]
    .filter(Boolean)
    .join(" ");
  const error =
    text(value.error) ?? (known ? undefined : `Unknown status: ${said}`);
  const tools = Array.isArray(value.tools)
    ? value.tools.flatMap((tool) => {
        const parsed = claudeMcpTool(tool);
        return parsed ? [parsed] : [];
      })
    : undefined;
  return {
    name,
    status,
    ...(scope ? { scope } : {}),
    ...(transport
      ? { transport: transport === "claudeai-proxy" ? "claude.ai" : transport }
      : {}),
    ...(target ? { target } : {}),
    ...(version ? { version } : {}),
    ...(error ? { error } : {}),
    ...(tools ? { tools } : {}),
    ...(typeof value.toolCount === "number"
      ? { toolCount: value.toolCount }
      : {}),
    actions: claudeMcpActions(status, transport, value.sessionProxied === true),
  };
}

/** Why Claude did not do it; null when it did. */
function refusal(answer: ControlAnswer): { ok: false; reason: string } | null {
  if (!answer) return { ok: false, reason: "Claude did not answer in time" };
  return answer.error ? { ok: false, reason: answer.error } : null;
}

export const claudeMcp: McpDriver = {
  async status(context) {
    const answer = await context.control("mcp_status", {});
    const refused = refusal(answer);
    if (refused) return refused;
    const rows = answer?.response?.mcpServers;
    if (!Array.isArray(rows))
      return { ok: false, reason: "Claude sent no list of servers" };
    return {
      ok: true,
      servers: rows.flatMap((row) => {
        const parsed = claudeMcpRow(row);
        return parsed ? [parsed] : [];
      }),
    };
  },

  async act(context, request) {
    const serverName = request.server;
    switch (request.action) {
      case "reconnect":
        return (
          refusal(await context.control("mcp_reconnect", { serverName })) ?? {
            ok: true,
          }
        );
      case "enable":
      case "disable":
        return (
          refusal(
            await context.control("mcp_toggle", {
              serverName,
              enabled: request.action === "enable",
            }),
          ) ?? { ok: true }
        );
      case "authenticate": {
        const answer = await context.control("mcp_authenticate", {
          serverName,
        });
        const refused = refusal(answer);
        if (refused) return refused;
        const url = answer?.response?.authUrl;
        if (url === undefined || url === null)
          return { ok: true, signIn: { url: null, redirects: false } };
        if (typeof url !== "string" || !/^https?:\/\//i.test(url))
          return { ok: false, reason: "Claude sent no sign-in page to open" };
        return {
          ok: true,
          signIn: {
            url,
            redirects: answer?.response?.callbackExpected === true,
          },
        };
      }
      case "finish-sign-in": {
        const refused = refusal(
          await context.control("mcp_oauth_callback_url", {
            serverName,
            callbackUrl: request.url,
          }),
        );
        if (refused) return refused;
        // Signed in, but Claude leaves the server as it was until asked.
        const reconnected = refusal(
          await context.control("mcp_reconnect", { serverName }),
        );
        return reconnected
          ? {
              ok: false,
              reason: `Signed in, but it did not reconnect: ${reconnected.reason}`,
            }
          : { ok: true };
      }
    }
  },
};
