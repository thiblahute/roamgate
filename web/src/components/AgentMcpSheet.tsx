import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import type {
  AgentChatMcp,
  AgentChatMcpAction,
  AgentChatMcpRequest,
  AgentChatMcpResult,
  AgentChatMcpServer,
  AgentChatMcpSignIn,
  AgentChatMcpStatus,
} from "../../../shared/agentChat";
import "./AgentModelSheet.css";
import "./AgentMcpSheet.css";

const STATUS_LABEL: Record<AgentChatMcpStatus, string> = {
  connected: "Connected",
  failed: "Failed",
  "needs-auth": "Needs sign-in",
  pending: "Connecting...",
  disabled: "Disabled",
};

const ACTION_LABEL: Record<AgentChatMcpAction, string> = {
  authenticate: "Sign in",
  reconnect: "Reconnect",
  enable: "Enable",
  disable: "Disable",
};

/** How often the list is read again while something is under way. */
const POLL_MS = 2000;
/** After this long without an action the sheet stops reading by itself. */
const POLL_LIMIT_MS = 5 * 60_000;
/** From this many servers on, the sheet offers a filter. */
const FILTER_FROM = 6;

function withoutKey(
  record: Record<string, string>,
  key: string,
): Record<string, string> {
  const next = { ...record };
  delete next[key];
  return next;
}

/** The servers a filter keeps: by name, scope, transport or target. */
export function mcpSheetRows(
  servers: readonly AgentChatMcpServer[],
  query: string,
): AgentChatMcpServer[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...servers];
  return servers.filter((server) =>
    [server.name, server.scope, server.transport, server.target].some((field) =>
      field?.toLowerCase().includes(needle),
    ),
  );
}

/** "3 connected, 1 needs sign-in": what the list comes to. */
export function mcpSheetSummary(
  servers: readonly AgentChatMcpServer[],
): string {
  const statuses: AgentChatMcpStatus[] = [
    "connected",
    "needs-auth",
    "failed",
    "pending",
    "disabled",
  ];
  return statuses
    .flatMap((status) => {
      const count = servers.filter((each) => each.status === status).length;
      const said = STATUS_LABEL[status].toLowerCase().replace("...", "");
      return count ? [`${count} ${said}`] : [];
    })
    .join(", ");
}

/** What a row says of its tools; null when the agent gives no number. */
function toolsLabel(server: AgentChatMcpServer): string | null {
  const count = server.tools?.length ?? server.toolCount;
  if (count === undefined) return null;
  return `${count} tool${count === 1 ? "" : "s"}`;
}

/**
 * /mcp typed in a conversation-mode chat: the MCP servers of the session
 * with their state and what can be done to them. A sign-in opens the page
 * the agent gives; when that page ends on a redirect the agent's machine
 * cannot see (a phone, a remote host), its address is pasted back here.
 * The list is read again after every action, and by itself while a server
 * connects or a sign-in is under way.
 */
export function AgentMcpSheet({
  load,
  act,
  onClose,
  pollMs = POLL_MS,
}: {
  load: () => Promise<AgentChatMcp>;
  act: (request: AgentChatMcpRequest) => Promise<AgentChatMcpResult>;
  onClose: () => void;
  pollMs?: number;
}) {
  const [listed, setListed] = useState<AgentChatMcp | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [signIn, setSignIn] = useState<{
    server: string;
    page: AgentChatMcpSignIn;
  } | null>(null);
  const [pasted, setPasted] = useState("");
  const [pollUntil, setPollUntil] = useState(() => Date.now() + POLL_LIMIT_MS);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const liveRef = useRef(true);
  const readRef = useRef(0);

  const refresh = useCallback(async () => {
    const read = ++readRef.current;
    setLoading(true);
    try {
      const next = await loadRef.current();
      if (!liveRef.current || read !== readRef.current) return;
      setListed(next);
      setLoadError(null);
    } catch (error) {
      if (!liveRef.current || read !== readRef.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (liveRef.current && read === readRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    liveRef.current = true;
    void refresh();
    sheetRef.current?.focus();
    return () => {
      liveRef.current = false;
    };
  }, [refresh]);

  const servers = listed?.servers ?? [];
  const connecting = servers.some((each) => each.status === "pending");
  const waitingSignIn = signIn?.page.url
    ? servers.some(
        (each) => each.name === signIn.server && each.status !== "connected",
      )
    : false;

  // A sign-in that came back by itself shows as the server connecting.
  useEffect(() => {
    if (!signIn || !listed || waitingSignIn) return;
    const server = listed.servers.find((each) => each.name === signIn.server);
    if (server?.status !== "connected") return;
    setSignIn(null);
    setPasted("");
    setNotes((all) => ({ ...all, [signIn.server]: "Signed in." }));
  }, [listed, signIn, waitingSignIn]);

  useEffect(() => {
    if (
      !(connecting || waitingSignIn) ||
      busy ||
      loading ||
      Date.now() > pollUntil
    )
      return;
    const timer = setTimeout(() => void refresh(), pollMs);
    return () => clearTimeout(timer);
  }, [
    connecting,
    waitingSignIn,
    busy,
    loading,
    pollUntil,
    pollMs,
    refresh,
    listed,
  ]);

  const run = async (request: AgentChatMcpRequest) => {
    if (busy) return;
    const { server } = request;
    setBusy(`${server}:${request.action}`);
    setPollUntil(Date.now() + POLL_LIMIT_MS);
    setErrors((all) => withoutKey(all, server));
    setNotes((all) => withoutKey(all, server));
    const result = await act(request).catch(
      (error: unknown): AgentChatMcpResult => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    if (!liveRef.current) return;
    if (!result.ok) setErrors((all) => ({ ...all, [server]: result.reason }));
    else if (request.action === "authenticate") {
      if (result.signIn?.url) {
        setSignIn({ server, page: result.signIn });
        setPasted("");
      } else
        setNotes((all) => ({
          ...all,
          [server]: "No sign-in was needed.",
        }));
    } else {
      if (request.action === "finish-sign-in") {
        setSignIn(null);
        setPasted("");
        setNotes((all) => ({ ...all, [server]: "Signed in." }));
      }
      if (signIn?.server === server && request.action !== "finish-sign-in")
        setSignIn(null);
    }
    setBusy(null);
    await refresh();
  };

  const rows = mcpSheetRows(servers, query);
  const filtered = servers.length >= FILTER_FROM;

  return (
    <div
      className="agent-model-backdrop agent-mcp-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        className="agent-model-sheet agent-mcp-sheet"
        role="dialog"
        aria-label="MCP servers"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
      >
        <div className="agent-model-head">
          <strong>MCP servers</strong>
          <button
            type="button"
            className="agent-history-icon"
            aria-label="Refresh"
            disabled={!!busy}
            onClick={() => {
              setPollUntil(Date.now() + POLL_LIMIT_MS);
              void refresh();
            }}
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className="agent-history-icon"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
        {filtered ? (
          <input
            className="agent-model-filter"
            type="text"
            value={query}
            placeholder="Filter the servers"
            aria-label="Filter the servers"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
        {loadError ? (
          <p className="agent-model-refusal" role="alert">
            {loadError}
          </p>
        ) : null}
        {!listed && !loadError ? (
          <p className="agent-model-note" role="status">
            Asking for the servers...
          </p>
        ) : null}
        {listed && servers.length ? (
          <p className="agent-model-note agent-mcp-summary" role="status">
            {mcpSheetSummary(servers)}
          </p>
        ) : null}
        {listed && !servers.length ? (
          <p className="agent-model-note">This session has no MCP servers.</p>
        ) : null}
        {rows.length ? (
          <ul className="agent-mcp-list">
            {rows.map((server) => (
              <McpRow
                key={server.name}
                server={server}
                busy={busy}
                error={errors[server.name]}
                note={notes[server.name]}
                signIn={signIn?.server === server.name ? signIn.page : null}
                pasted={pasted}
                onPaste={setPasted}
                onAct={(action) => void run({ action, server: server.name })}
                onFinish={() =>
                  void run({
                    action: "finish-sign-in",
                    server: server.name,
                    url: pasted,
                  })
                }
                onCancelSignIn={() => {
                  setSignIn(null);
                  setPasted("");
                }}
              />
            ))}
          </ul>
        ) : listed && servers.length ? (
          <p className="agent-model-note">No server matches.</p>
        ) : null}
        {servers.length ? (
          <p className="agent-model-note agent-mcp-foot">
            Enable and Disable are kept for this project, in the terminal too.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function McpRow({
  server,
  busy,
  error,
  note,
  signIn,
  pasted,
  onPaste,
  onAct,
  onFinish,
  onCancelSignIn,
}: {
  server: AgentChatMcpServer;
  busy: string | null;
  error?: string;
  note?: string;
  signIn: AgentChatMcpSignIn | null;
  pasted: string;
  onPaste: (value: string) => void;
  onAct: (action: AgentChatMcpAction) => void;
  onFinish: () => void;
  onCancelSignIn: () => void;
}) {
  const meta = [
    server.scope,
    server.transport,
    server.target,
    server.version,
  ].filter(Boolean);
  const tools = toolsLabel(server);
  const running = busy?.startsWith(`${server.name}:`) ? busy : null;
  const noSignIn =
    server.status === "needs-auth" && !server.actions.includes("authenticate");
  return (
    <li className="agent-mcp-row" data-status={server.status}>
      <div className="agent-mcp-top">
        <span className="agent-mcp-dot" aria-hidden="true" />
        <span className="agent-mcp-name">{server.name}</span>
        <span className="agent-mcp-status">{STATUS_LABEL[server.status]}</span>
      </div>
      {meta.length ? (
        <div className="agent-mcp-meta">{meta.join(" \u00b7 ")}</div>
      ) : null}
      {server.error ? <p className="agent-mcp-error">{server.error}</p> : null}
      {noSignIn ? (
        <p className="agent-mcp-note">
          Sign in to this server from the agent's terminal.
        </p>
      ) : null}
      {tools ? (
        server.tools?.length ? (
          <details className="agent-mcp-tools">
            <summary>{tools}</summary>
            <ul>
              {server.tools.map((tool) => (
                <li key={tool.name} title={tool.description}>
                  <code>{tool.name}</code>
                  {tool.readOnly ? <span>read-only</span> : null}
                  {tool.destructive ? <span>destructive</span> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <div className="agent-mcp-meta">{tools}</div>
        )
      ) : null}
      {server.actions.length ? (
        <div className="agent-mcp-actions">
          {server.actions.map((action) => (
            <button
              key={action}
              type="button"
              disabled={!!busy}
              onClick={() => onAct(action)}
            >
              {running === `${server.name}:${action}`
                ? `${ACTION_LABEL[action]}...`
                : ACTION_LABEL[action]}
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <p className="agent-model-refusal agent-mcp-alert" role="alert">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className="agent-mcp-note" role="status">
          {note}
        </p>
      ) : null}
      {signIn?.url ? (
        <div className="agent-mcp-signin">
          <a href={signIn.url} target="_blank" rel="noopener noreferrer">
            Open the sign-in page
          </a>
          {signIn.redirects ? (
            <>
              <p className="agent-mcp-note">
                Once signed in, this shows the server connected. If the page
                ends on an address that does not load (localhost), copy that
                address and paste it here.
              </p>
              <input
                type="url"
                value={pasted}
                placeholder="http://localhost:.../callback?code=..."
                aria-label="The address the sign-in page ended on"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                onChange={(event) => onPaste(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && pasted.trim()) {
                    event.preventDefault();
                    onFinish();
                  }
                }}
              />
              <div className="agent-mcp-actions">
                <button
                  type="button"
                  disabled={!pasted.trim() || !!busy}
                  onClick={onFinish}
                >
                  Finish sign-in
                </button>
                <button type="button" onClick={onCancelSignIn}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <p className="agent-mcp-note">
              Connect it on that page, then press Reconnect here.
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}
